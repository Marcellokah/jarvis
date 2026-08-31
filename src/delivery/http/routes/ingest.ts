import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { HealthRepo } from "../../../infra/db/repositories/health.ts";
import type { Logger } from "../../../infra/logger.ts";
import { isoDate, TZ } from "../../../shared/dates.ts";

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
      },
      fields,
      now,
    );

    // Today's numbers just changed, so the cached brief is stale. Start the
    // rebuild now; the Shortcut's GET moments later joins this same promise
    // instead of waiting for a second, serial generation.
    const regeneration = deps.briefs.regenerate(now);
    regeneration.catch((err) => deps.logger.warn({ err: String(err) }, "background regeneration failed"));

    return reply.code(202).send({ ok: true, date, regenerating: true, accepted, ignored });
  });
}
