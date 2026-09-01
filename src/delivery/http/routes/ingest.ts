import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { HealthRepo } from "../../../infra/db/repositories/health.ts";
import type { Logger } from "../../../infra/logger.ts";
import { isoDate, TZ } from "../../../shared/dates.ts";
import { rollup } from "../../../infra/health-export/rollup.ts";
import type { ExportEntry } from "../../../infra/health-export/reader.ts";
import { toAppleDate, normaliseSleepValue } from "../../../core/health/phone-samples.ts";

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
 * Runs the phone's raw SLEEP samples through the import's own rollup.
 *
 * One logic, two producers — for sleep, and for sleep only. The watch writes a
 * sleep sample per stage, and a Shortcut cannot sum them: Calculate Statistics
 * works on sample values, and a sleep sample's value is a stage name, not a
 * duration. Taking the latest sample instead would report 0.3 hours for a
 * seven-hour night: not missing data, but confidently wrong. Sending them raw
 * also inherits the overlapping-source resolution the phone could never do.
 *
 * Every other type is refused here and named in `ignored`. Nothing needs to
 * send them — a Shortcut sums or averages a quantity type perfectly well, and
 * the direct `READING` fields exist for exactly that. Accepting them would be
 * actively dangerous: this path has no source of its own to report, so it
 * would have to invent one, and the rollup keeps accumulating types separated
 * BY source precisely so it can pick one instead of adding them. Collapsing
 * two sources into one fabricated name re-creates the 81,272-step days the
 * rollup's own comment describes.
 */
export async function readSamples(raw: unknown): Promise<SampleResult> {
  const ignored: { field: string; reason: string }[] = [];
  if (!Array.isArray(raw)) return { days: [], ignored };

  const entries: ExportEntry[] = [];
  // Counted rather than reported one by one: a Shortcut that wires the wrong
  // type in here sends hundreds of them, and hundreds of identical lines would
  // bury the rest of the reply instead of naming the mistake.
  const refusedTypes = new Map<string, number>();

  for (const [i, s] of (raw as PhoneSample[]).entries()) {
    const type = typeof s?.type === "string" ? s.type : null;
    const start = typeof s?.startDate === "string" ? toAppleDate(s.startDate) : null;
    const end = typeof s?.endDate === "string" ? toAppleDate(s.endDate) : null;
    if (!type || !start || !end) {
      ignored.push({ field: `samples[${i}]`, reason: "hiányzó vagy értelmezhetetlen típus/dátum" });
      continue;
    }

    if (type !== "SleepAnalysis") {
      refusedTypes.set(type, (refusedTypes.get(type) ?? 0) + 1);
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

  for (const [type, n] of [...refusedTypes].sort(([a], [b]) => a.localeCompare(b))) {
    ignored.push({
      field: "samples",
      reason: `csak alvás-minta küldhető nyersen: ${type} (${n}) — közvetlen mezőként küldd`,
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
    // to be in hand before the upsert freezes the phone's number.
    //
    // The two writes have opposite precedence on purpose. Sleep is a reading
    // that is final when taken, so it sits outside `ACCUMULATES_OVER_DAY` and
    // the phone owns it: `upsert` is incoming-wins for it, `fillGaps` is
    // existing-wins. Sleep samples land on the wake-up day, the very date this
    // request writes — so a request carrying both would keep `sleepH` and
    // silently drop the rollup's value, with nothing to show for it. Wherever
    // sample-derived sleep exists for this date, the direct field steps aside
    // and says so.
    //
    // `sleepH` is not removed from `READING`: until the Shortcut is rebuilt it
    // is the only sleep the system gets, and with iPhone-only tracking a single
    // sample covers the whole night, so it is correct today. Samples are simply
    // the better source whenever they exist.
    const samples = await readSamples(fields.samples);

    // The question is about the stored DAY, not about this request. `sleep_h`
    // is the one sleep column the upsert does not force to null, and for a
    // final-when-taken column the upsert is incoming-wins — so a second post
    // the same morning carrying `sleepH` and no usable samples would overwrite
    // the rollup's 7.2 and leave 0.3 sitting beside an `asleep_min` of 430.
    // Reversing the two writes does not help: `fillGaps` is existing-wins for
    // the same column and would skip the value already there. Neither half of
    // that depends on how the day totals are settled — every column this path
    // can produce is a sleep column, and none of them accumulate over a day.
    //
    // `asleep_min` is the marker. It can only ever have come from the samples
    // path — the upsert below writes it as null on purpose — so a row that has
    // one already holds sample-derived sleep, whether it arrived earlier this
    // morning or from a past import.
    const stored = deps.health.forDate(date);
    const sleepFromSamples = stored?.asleepMin != null || samples.days.some(
      (day) => day.date === date && day.values.sleep_h !== undefined,
    );
    if (sleepFromSamples && values.sleepH !== undefined) {
      delete values.sleepH;
      const at = accepted.indexOf("sleepH");
      if (at !== -1) accepted.splice(at, 1);
      ignored.push({
        field: "sleepH",
        reason: "a nyers alvás-mintákból számolt érték került be helyette",
      });
    }

    if (ignored.length > 0) {
      // Visible on purpose: a Shortcut step that silently stopped producing a
      // value looks identical to a quiet night otherwise.
      deps.logger.warn({ ignored, accepted }, "health snapshot had unusable readings");
    }

    deps.health.upsert(
      {
        date,
        sleepH: values.sleepH ?? null,
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
