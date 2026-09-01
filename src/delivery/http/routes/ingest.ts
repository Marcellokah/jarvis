import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { HealthRepo } from "../../../infra/db/repositories/health.ts";
import type { Logger } from "../../../infra/logger.ts";
import { isoDate, TZ } from "../../../shared/dates.ts";
import { rollup, DAILY } from "../../../infra/health-export/rollup.ts";
import type { ExportEntry } from "../../../infra/health-export/reader.ts";
import { toAppleDate, normaliseSleepValue, normalisePhoneNumber } from "../../../core/health/phone-samples.ts";

/**
 * Apple Health has no server-side API, so the iOS Shortcut pushes a snapshot
 * here immediately before requesting the brief.
 *
 * Every reading is independent. Rejecting the whole request over one bad field
 * used to throw away the good ones with it, which is exactly backwards: the
 * phone gets one attempt each morning, and a missing HRV must not cost you the
 * others. A field that cannot be believed is dropped and named in the reply.
 */
const READING = {
  sleepH: z.coerce.number().min(0).max(24),
  hrv: z.coerce.number().min(0).max(500),
  rhr: z.coerce.number().min(20).max(200),
  moveKcal: z.coerce.number().min(0).max(10_000),
  exerciseMin: z.coerce.number().min(0).max(1440),
  steps: z.coerce.number().int().min(0).max(200_000),
  vo2max: z.coerce.number().min(10).max(90),
  hrRecovery: z.coerce.number().min(0).max(100),
  walkingHr: z.coerce.number().min(40).max(200),
  walkingSpeed: z.coerce.number().min(0).max(12),
  stepLengthCm: z.coerce.number().min(0).max(200),
  doubleSupportPct: z.coerce.number().min(0).max(100),
  asymmetryPct: z.coerce.number().min(0).max(100),
  steadinessPct: z.coerce.number().min(0).max(100),
  sixMinWalkM: z.coerce.number().min(0).max(2000),
  stairUpMs: z.coerce.number().min(0).max(5),
  stairDownMs: z.coerce.number().min(0).max(5),
  distanceKm: z.coerce.number().min(0).max(300),
  basalKcal: z.coerce.number().min(0).max(10_000),
  // Not in the brief's field list, but required by the "flights" column the
  // upsert now writes and by the zero-is-real-reading test below: a day with
  // no stairs climbed is a fact, so this needs its own range like `steps`.
  //
  // 1000 was rejected in review as tighter than the brief's own rule: a range
  // must exclude only what is physically impossible, not merely unusual, and
  // dedicated stair-climbing challenges genuinely log four-figure flight
  // counts in a day. 100,000 is comfortably past any real record (even one
  // flight every 10 seconds, nonstop, would not reach it in 24 hours) while
  // still catching obviously bogus data.
  flights: z.coerce.number().int().min(0).max(100_000),
  standMin: z.coerce.number().min(0).max(1440),
  dietKcal: z.coerce.number().min(0).max(20_000),
  dietProteinG: z.coerce.number().min(0).max(1000),
  dietCarbsG: z.coerce.number().min(0).max(2000),
  dietFatG: z.coerce.number().min(0).max(1000),
} as const;

type Reading = keyof typeof READING;

/**
 * Readings where zero means "Health had no sample", not a measurement.
 *
 * When a `Find Health Samples` step finds nothing, Shortcuts substitutes 0
 * rather than leaving the field out. Nobody sleeps zero hours or has a resting
 * heart rate of zero — but the brief believed it, and told you your recovery
 * was poor on the strength of a reading that was never taken.
 *
 * `steps`, `moveKcal`, `exerciseMin`, `flights`, `distanceKm` and `standMin`
 * are deliberately absent from this list: at 07:30 those can honestly be zero.
 */
const ZERO_MEANS_ABSENT: ReadonlySet<Reading> = new Set([
  "sleepH", "hrv", "rhr",
  "vo2max", "hrRecovery", "walkingHr", "basalKcal",
  "walkingSpeed", "stepLengthCm", "doubleSupportPct", "asymmetryPct",
  "steadinessPct", "sixMinWalkM", "stairUpMs", "stairDownMs",
  "dietKcal", "dietProteinG", "dietCarbsG", "dietFatG",
]);

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export interface ReadResult {
  values: Partial<Record<Reading, number>>;
  accepted: Reading[];
  ignored: { field: string; reason: string }[];
}

/** Exported for tests: each reading stands or falls on its own. */
export function readSnapshot(body: Record<string, unknown>): ReadResult {
  const values: Partial<Record<Reading, number>> = {};
  const accepted: Reading[] = [];
  const ignored: { field: string; reason: string }[] = [];

  for (const field of Object.keys(READING) as Reading[]) {
    const raw = body[field];

    // Absent, null, or the empty string a Shortcut sends for a missing sample.
    if (raw === undefined || raw === null || raw === "") continue;

    if (ZERO_MEANS_ABSENT.has(field) && Number(raw) === 0) {
      ignored.push({ field, reason: "0 — nincs mérés, nem nulla érték" });
      continue;
    }

    const parsed = READING[field].safeParse(raw);
    if (!parsed.success) {
      ignored.push({ field, reason: parsed.error.issues[0]?.message ?? "érvénytelen" });
      continue;
    }

    values[field] = parsed.data;
    accepted.push(field);
  }

  return { values, accepted, ignored };
}

interface PhoneSample {
  type?: unknown; value?: unknown; unit?: unknown;
  startDate?: unknown; endDate?: unknown; source?: unknown;
}

export interface SampleResult {
  /** Day -> column -> value, ready for fillGaps. */
  days: { date: string; values: Record<string, number> }[];
  ignored: { field: string; reason: string }[];
}

/**
 * What a Shortcut actually puts in a JSON array field, unpacked.
 *
 * Shortcuts cannot splice a list variable into a JSON array. Asked to, it
 * renders the whole list as ONE string — its items joined by newlines, each
 * item its own JSON object. Measured, not assumed: the first live run stored
 * `samples` as a one-element array whose element was 45 newline-separated
 * objects.
 *
 * So the phone can send its night in exactly one shape, and this is where that
 * shape becomes the array the rest of the function expects. A real array of
 * objects passes through untouched — the phone is not the only possible caller,
 * and a caller that can send proper JSON should not be punished for it.
 *
 * A line that does not parse is dropped and named, never guessed at: a
 * half-read night would file stages against the wrong minutes.
 */
function unpackSamples(
  raw: unknown, ignored: { field: string; reason: string }[],
): unknown[] | null {
  if (typeof raw === "string") return unpackSamples([raw], ignored);
  if (!Array.isArray(raw)) return null;

  return raw.flatMap((item, i) => {
    if (typeof item !== "string") return [item];
    return item.split("\n").flatMap((line, j) => {
      const text = line.trim();
      if (text === "") return [];
      try {
        return [JSON.parse(text) as unknown];
      } catch {
        ignored.push({ field: `samples[${i}].${j}`, reason: "értelmezhetetlen JSON sor" });
        return [];
      }
    });
  });
}

/**
 * Runs the phone's raw SLEEP samples — and its per-source day totals — through
 * the import's own rollup.
 *
 * One logic, two producers. For sleep, because the watch writes a sample per
 * stage and a Shortcut cannot sum them: Calculate Statistics works on sample
 * values, and a sleep sample's value is a stage name, not a duration. Taking
 * the latest sample instead would report 0.3 hours for a seven-hour night: not
 * missing data, but confidently wrong. Sending them raw also inherits the
 * overlapping-source resolution the phone could never do.
 *
 * For the accumulating counters, because `Find Health Samples` returns the RAW
 * samples of EVERY source and `Calculate Statistics: Sum` adds them all
 * together — the iPhone and the Watch both record the same walk. Measured on
 * 2026-09-01: the evening run sent 21,401 steps against Health's 6,645, and
 * 1,684 active kcal against 856. Every `Sum` field was inflated; the `Average`
 * fields were fine, because averaging duplicates barely moves the number.
 *
 * The fix is not a new rule but the rollup's existing one. Shortcuts CAN filter
 * `Find Health Samples` by `Source`, so the phone queries each counter type
 * once per source and sends one aggregate per (type, source) pair. Fed to the
 * rollup those land in its `accum` map, which keeps accumulating types
 * separated BY source and picks the largest single source instead of adding
 * them. The phone's number thereby becomes the same KIND of number as the
 * import's, rather than a different one — which is the whole point, and the
 * reason nothing is forked here.
 *
 * This is also why a real `source` is now REQUIRED rather than invented. The
 * refusal that used to stand here — that this path has no source of its own to
 * report, so it would have to make one up — remains exactly right for a caller
 * that has none: collapsing several sources into one fabricated name re-creates
 * the 81,272-step days the rollup's own comment describes, and a sourceless
 * total is precisely what produced the 21,401. A real source name in the
 * payload is what lifts the objection, so an entry without one is still
 * refused, by name.
 *
 * `unit` must equal the type's own unit in `DAILY`, for the same reason the
 * rollup skips a record whose unit is not its own: a silently rescaled number
 * that still looks plausible is the worst thing this import can produce, and
 * this path must not become the hole in that rule. The phone cannot report
 * Health's display unit, so it declares what it believes it is sending and the
 * server's job is to refuse a declared mismatch — never to convert.
 *
 * The value itself is normalised before the rollup sees it, and refused rather
 * than coerced when it cannot be read: the phone writes decimals in its own
 * locale (a comma), and an empty value means the source recorded nothing of
 * that type rather than zero of it. Both are handled at this boundary because
 * the rollup reads values with `Number()`, which turns the first into NaN and
 * the second into a real 0 that then competes as a per-source total.
 *
 * `agg: "avg"` types stay refused here. They are not broken: a Shortcut
 * averages a quantity type perfectly well, and the direct `READING` fields
 * already carry every one of them. Accepting them here would only open a second
 * route to one column for no gain. Every other type is refused and named too.
 */
export async function readSamples(raw: unknown): Promise<SampleResult> {
  const ignored: { field: string; reason: string }[] = [];
  const unpacked = unpackSamples(raw, ignored);
  if (unpacked === null) return { days: [], ignored };
  raw = unpacked;

  const entries: ExportEntry[] = [];
  // Counted rather than reported one by one: a Shortcut that wires the wrong
  // type in here sends hundreds of them, and hundreds of identical lines would
  // bury the rest of the reply instead of naming the mistake.
  const refusedTypes = new Map<string, number>();
  // Counted, never named one by one. The Shortcut asks every counter type of
  // every source, so most (type, source) pairs are legitimately empty EVERY
  // night — the iPhone records no ActiveEnergyBurned, no AppleStandTime and no
  // dietary data at all. Naming each would bury the rest of the reply exactly
  // the way `refusedTypes` above describes, and would train the owner to stop
  // reading it. One line saying how many is enough to notice the day the
  // Shortcut goes quiet altogether.
  let emptyAggregates = 0;

  for (const [i, s] of (raw as PhoneSample[]).entries()) {
    const type = typeof s?.type === "string" ? s.type : null;
    const start = typeof s?.startDate === "string" ? toAppleDate(s.startDate) : null;
    const end = typeof s?.endDate === "string" ? toAppleDate(s.endDate) : null;
    if (!type || !start || !end) {
      ignored.push({ field: `samples[${i}]`, reason: "hiányzó vagy értelmezhetetlen típus/dátum" });
      continue;
    }

    if (type !== "SleepAnalysis") {
      const spec = DAILY[type];
      // `avg` types are refused with everything else the rollup does not store.
      // They already reach their column through the direct `READING` fields —
      // a Shortcut averages a quantity type perfectly well, and duplicated
      // samples barely move a mean — so a second route here would buy nothing
      // and give one column two writers to reason about.
      if (!spec || spec.agg !== "sum") {
        refusedTypes.set(type, (refusedTypes.get(type) ?? 0) + 1);
        continue;
      }

      // Trimmed, because the source name is the rollup's grouping key: a stray
      // space would split one device into two and defeat the pick.
      const source = typeof s.source === "string" ? s.source.trim() : "";
      if (source === "") {
        ignored.push({
          field: `samples[${i}]`,
          reason: `${type}: forrás nélküli napi összeg nem fogadható el`,
        });
        continue;
      }

      // The declared unit, checked against ours rather than converted. The
      // rollup applies the same rule to the import's records; naming the
      // expected unit here is what lets a half-built Shortcut be fixed.
      const unit = typeof s.unit === "string" ? s.unit : null;
      if (unit !== spec.unit) {
        ignored.push({
          field: `samples[${i}]`,
          reason: `${type}: nem várt egység (${unit ?? "hiányzik"}), várt: ${spec.unit}`,
        });
        continue;
      }

      // A missing `value` key is a half-wired Shortcut step, not an empty
      // aggregate — named, because it is a mistake somebody has to fix.
      const rawValue = typeof s.value === "string" ? s.value.trim()
        : typeof s.value === "number" ? String(s.value)
        : null;
      if (rawValue === null) {
        ignored.push({ field: `samples[${i}]`, reason: `${type}: hiányzó érték` });
        continue;
      }

      // An empty value means this source recorded nothing of this type, which
      // is not a measurement and must never become one. `Number("")` is 0, and
      // the rollup's `Number.isFinite` check waves that 0 through as a real
      // per-source total — so on 2026-09-01 the iPhone's empty
      // ActiveEnergyBurned entered the pick as a genuine zero, and with the
      // Watch's comma-formatted 1198,36 lost to the parse above it was the only
      // candidate left. The day was stored as move_kcal = 0.
      //
      // A source that has samples and genuinely sums to zero is a different
      // thing and still arrives as "0", which is a real reading and is kept.
      if (rawValue === "") { emptyAggregates += 1; continue; }

      // The phone's locale renders decimals with a comma. Translated here at
      // the boundary rather than in the rollup, whose correctness must not
      // depend on the phone's path growing — and refused by name when the shape
      // is not the unambiguous one, never guessed at.
      const value = normalisePhoneNumber(rawValue);
      if (value === null) {
        ignored.push({
          field: `samples[${i}]`,
          reason: `${type}: értelmezhetetlen szám (${rawValue})`,
        });
        continue;
      }

      entries.push({
        kind: "record", type,
        // Still text: the rollup parses and range-checks the value itself. What
        // changed is only that the text is now guaranteed to be a shape
        // `Number()` reads the same way this boundary read it.
        value,
        unit, startDate: start, endDate: end, source,
      });
      continue;
    }

    const rawValue = typeof s.value === "string" ? s.value : String(s.value ?? "");
    const value = normaliseSleepValue(rawValue);
    if (!value) {
      ignored.push({ field: `samples[${i}]`, reason: `ismeretlen alvás-fázis: ${rawValue}` });
      continue;
    }

    entries.push({
      kind: "record", type, value,
      unit: typeof s.unit === "string" ? s.unit : null,
      startDate: start, endDate: end,
      // Sleep is an interval type: the rollup unions the spans and only uses
      // the source name to mark the day as contested, so a stand-in name here
      // cannot change a single stored minute.
      source: typeof s.source === "string" ? s.source : "iPhone",
    });
  }

  if (emptyAggregates > 0) {
    ignored.push({
      field: "samples",
      reason: `üres napi összeg, mérés nélkül eldobva: ${emptyAggregates} (nem nulla érték)`,
    });
  }

  for (const [type, n] of [...refusedTypes].sort(([a], [b]) => a.localeCompare(b))) {
    ignored.push({
      field: "samples",
      reason: `nyersen csak alvás és napi számláló küldhető: ${type} (${n}) — közvetlen mezőként küldd`,
    });
  }

  if (entries.length === 0) return { days: [], ignored };

  const result = await rollup((async function* () { for (const e of entries) yield e; })());
  // The rollup's own skipped map carries types it does not store and unit
  // mismatches. Surfacing them here is what keeps a dropped column visible.
  for (const [reason, n] of Object.entries(result.skipped)) {
    ignored.push({ field: "samples", reason: `${reason} (${n})` });
  }
  return { days: result.days, ignored };
}

export function registerIngestRoutes(
  app: FastifyInstance,
  deps: { health: HealthRepo; briefs: BriefService; clock: Clock; logger: Logger },
): void {
  app.post("/api/ingest/health", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "bad_request", detail: "a törzs egy JSON objektum legyen" });
    }
    const fields = body as Record<string, unknown>;

    const { values, accepted, ignored } = readSnapshot(fields);

    const now = deps.clock.now();
    const parsedDate = dateField.safeParse(fields.date);
    const date = parsedDate.success ? parsedDate.data : isoDate(now, TZ);

    // The samples path runs BEFORE the upsert, because its verdict on sleep has
    // to be in hand before the upsert writes a sleep number of its own.
    //
    // Both halves of one request can carry sleep for the same day: samples land
    // on the wake-up day, which is the very date this request writes. The
    // rollup's number is the better one — a Shortcut cannot sum sleep stages
    // (see `readSamples`), so the direct field is at best one sample of the
    // night, and taking the latest sample reports 0.3 hours for a seven-hour
    // one. So wherever sample-derived sleep exists for this date, the direct
    // field steps aside and says so.
    //
    // `sleepH` is not removed from `READING`: until the Shortcut is rebuilt it
    // is the only sleep the system gets, and with iPhone-only tracking a single
    // sample covers the whole night, so it is correct today. Samples are simply
    // the better source whenever they exist.
    const samples = await readSamples(fields.samples);

    // The question is about the stored DAY, not about this request alone: the
    // samples may have arrived in an earlier post this morning. `sleep_h` is
    // the one sleep column the upsert does not force to null, and the upsert is
    // incoming-wins — so a second post carrying `sleepH` and no usable samples
    // would otherwise overwrite the rollup's 7.2 and leave 0.3 sitting beside
    // an `asleep_min` of 430.
    //
    // `asleep_min` is the marker for that, and it needs no provenance column:
    // it can only ever have come from the samples path — the upsert below
    // writes it as null on purpose, and the rollup never produces `sleep_h`
    // without it — so a row holding one holds a night some rollup resolved,
    // whether that ran earlier this morning or during a past import. A row
    // WITHOUT one holds, at most, a `sleep_h` a direct field left there.
    const stored = deps.health.forDate(date);
    const storedFromSamples = stored?.asleepMin != null;
    const sampleSleepH = samples.days
      .find((day) => day.date === date)?.values.sleep_h;
    const sleepFromSamples = storedFromSamples || sampleSleepH !== undefined;
    if (sleepFromSamples && values.sleepH !== undefined) {
      delete values.sleepH;
      const at = accepted.indexOf("sleepH");
      if (at !== -1) accepted.splice(at, 1);
      ignored.push({
        field: "sleepH",
        reason: "a nyers alvás-mintákból számolt érték került be helyette",
      });
    }

    // The sleep this request establishes for its own date — and the reason the
    // samples reach the row twice, as `sleep_h` here and as the whole night's
    // columns in the fillGaps loop below.
    //
    // That looks redundant and is not. `fillGaps` is existing-wins for every
    // column, so it cannot correct a `sleep_h` an earlier post left behind, and
    // it must not be allowed to: the monthly import writes through that same
    // method, and it must never rewrite a night the phone established. The
    // distinction is the caller rather than the column — only the phone's own
    // request runs an upsert, and the upsert is incoming-wins — so the samples
    // path expresses "this night is mine" by putting its number there.
    //
    // Concretely, the case that was open: a 07:30 post carries `sleepH: 0.3`
    // and its samples step failed, so the row gets 0.3. The 07:35 re-run
    // carries good samples, so its own `sleepH` is dropped just above — and
    // without this line `fillGaps` would skip the rollup's 7.2 and leave the
    // 0.3 beside an `asleep_min` of 430.
    //
    // `storedFromSamples` keeps it narrow. A row that already holds
    // `asleep_min` holds a coherent night: its hours and its stage minutes came
    // out of one rollup run, and replacing only the hours would split the pair
    // — so there this stands aside and the night that is there stays whole.
    const sleepH = !storedFromSamples && sampleSleepH !== undefined
      ? sampleSleepH
      : values.sleepH ?? null;

    if (ignored.length > 0) {
      // Visible on purpose: a Shortcut step that silently stopped producing a
      // value looks identical to a quiet night otherwise.
      deps.logger.warn({ ignored, accepted }, "health snapshot had unusable readings");
    }

    deps.health.upsert(
      {
        date,
        sleepH,
        hrv: values.hrv ?? null,
        rhr: values.rhr ?? null,
        moveKcal: values.moveKcal ?? null,
        exerciseMin: values.exerciseMin ?? null,
        steps: values.steps ?? null,
        // Sleep-stage columns come only from the raw-sample path below, via
        // fillGaps — a Shortcut cannot compute stage durations itself (see
        // readSamples). They still have to be listed here, even as null: an
        // upsert that omitted them from its column list would let a later
        // post's ON CONFLICT overwrite what fillGaps had already written.
        asleepMin: null,
        inBedMin: null,
        coreMin: null,
        remMin: null,
        deepMin: null,
        awakenings: null,
        vo2max: values.vo2max ?? null,
        hrRecovery: values.hrRecovery ?? null,
        walkingHr: values.walkingHr ?? null,
        basalKcal: values.basalKcal ?? null,
        flights: values.flights ?? null,
        dietKcal: values.dietKcal ?? null,
        dietProteinG: values.dietProteinG ?? null,
        dietCarbsG: values.dietCarbsG ?? null,
        dietFatG: values.dietFatG ?? null,
        distanceKm: values.distanceKm ?? null,
        standMin: values.standMin ?? null,
        walkingSpeed: values.walkingSpeed ?? null,
        stepLengthCm: values.stepLengthCm ?? null,
        doubleSupportPct: values.doubleSupportPct ?? null,
        asymmetryPct: values.asymmetryPct ?? null,
        steadinessPct: values.steadinessPct ?? null,
        sixMinWalkM: values.sixMinWalkM ?? null,
        stairUpMs: values.stairUpMs ?? null,
        stairDownMs: values.stairDownMs ?? null,
      },
      fields,
      now,
    );

    for (const day of samples.days) {
      // fillGaps, not upsert: the phone's samples must not overwrite what the
      // import already established for an older day.
      //
      // The per-source day counters ride the same loop, deliberately without a
      // precedence rule of their own: a same-evening re-run therefore keeps the
      // first run's total, which is at most the few minutes between the two
      // runs short. That is the accepted trade — see `ACCUMULATES_OVER_DAY` in
      // the health repo for why no writer here can be trusted to correct
      // another's counter, only to fill a hole it left.
      deps.health.fillGaps(day.date, day.values, now);
    }

    // Today's numbers just changed, so the cached brief is stale — but there is
    // nothing to do about it here. Deleting it used to be how this route said
    // so, but that left a window where no brief existed for today at all, and
    // a request landing in it could fall back to a brief from another date
    // entirely. Instead, brief-service's own freshness check now compares this
    // snapshot's `ingested_at` against the cached brief's `generated_at` and
    // treats the brief as stale on its own — no deletion needed, and nothing
    // reads this route's response anyway. Regenerating eagerly here would also
    // spend a Groq call nobody sees, and a separate `npm run brief` invocation
    // (which runs with `force: true` in its own process) cannot join an
    // in-flight generation started here — the two together can push ~11,400
    // tokens into one minute against Groq's 6,000/minute ceiling and draw a
    // 429. The next GET rebuilds on demand.

    return reply.code(202).send({
      ok: true, date, regenerating: false, accepted, ignored: [...ignored, ...samples.ignored],
    });
  });
}
