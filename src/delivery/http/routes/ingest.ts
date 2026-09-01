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
 * `moveKcal`, `exerciseMin` and `steps` are deliberately absent from this list:
 * at 07:30 those can honestly be zero.
 */
const ZERO_MEANS_ABSENT: ReadonlySet<Reading> = new Set(["sleepH", "hrv", "rhr"]);

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
 * Runs the phone's raw samples through the import's own rollup.
 *
 * One logic, two producers. The watch writes a sleep sample per stage, and a
 * Shortcut cannot sum them — Calculate Statistics works on sample values, and a
 * sleep sample's value is a stage name, not a duration. Taking the latest
 * sample instead would report 0.3 hours for a seven-hour night: not missing
 * data, but confidently wrong. Sending them raw also inherits the overlapping-
 * source resolution the phone could never do.
 */
export async function readSamples(raw: unknown): Promise<SampleResult> {
  const ignored: { field: string; reason: string }[] = [];
  if (!Array.isArray(raw)) return { days: [], ignored };

  const entries: ExportEntry[] = [];
  for (const [i, s] of (raw as PhoneSample[]).entries()) {
    const type = typeof s?.type === "string" ? s.type : null;
    const start = typeof s?.startDate === "string" ? toAppleDate(s.startDate) : null;
    const end = typeof s?.endDate === "string" ? toAppleDate(s.endDate) : null;
    if (!type || !start || !end) {
      ignored.push({ field: `samples[${i}]`, reason: "hiányzó vagy értelmezhetetlen típus/dátum" });
      continue;
    }

    let value = typeof s.value === "string" ? s.value : String(s.value ?? "");
    if (type === "SleepAnalysis") {
      const stage = normaliseSleepValue(value);
      if (!stage) {
        ignored.push({ field: `samples[${i}]`, reason: `ismeretlen alvás-fázis: ${value}` });
        continue;
      }
      value = stage;
    }

    entries.push({
      kind: "record", type, value,
      unit: typeof s.unit === "string" ? s.unit : null,
      startDate: start, endDate: end,
      source: typeof s.source === "string" ? s.source : "iPhone",
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
        // The Shortcut only ever sends the six readings above; the history
        // columns are exclusively filled by the Apple Health import.
        asleepMin: null,
        inBedMin: null,
        coreMin: null,
        remMin: null,
        deepMin: null,
        awakenings: null,
        vo2max: null,
        hrRecovery: null,
        walkingHr: null,
        basalKcal: null,
        flights: null,
        dietKcal: null,
        dietProteinG: null,
        dietCarbsG: null,
        dietFatG: null,
      },
      fields,
      now,
    );

    const samples = await readSamples(fields.samples);
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
