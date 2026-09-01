import type { Db } from "../index.ts";

/**
 * Every column the import is allowed to write.
 *
 * The names come from the rollup's own configuration, not from user input —
 * but they are interpolated into SQL, and a boundary that is only safe by
 * convention stops being safe the first time someone extends the rollup.
 */
export const HISTORY_COLUMNS: ReadonlySet<string> = new Set([
  "sleep_h", "hrv", "rhr", "move_kcal", "exercise_min", "steps",
  "asleep_min", "in_bed_min", "core_min", "rem_min", "deep_min", "awakenings",
  "vo2max", "hr_recovery", "walking_hr", "basal_kcal", "flights",
  "diet_kcal", "diet_protein_g", "diet_carbs_g", "diet_fat_g",
  "distance_km", "stand_min", "walking_speed", "step_length_cm",
  "double_support_pct", "asymmetry_pct", "steadiness_pct", "six_min_walk_m",
  "stair_up_ms", "stair_down_ms",
]);

export interface HealthSnapshot {
  date: string;
  sleepH: number | null;
  hrv: number | null;
  rhr: number | null;
  moveKcal: number | null;
  exerciseMin: number | null;
  steps: number | null;
  asleepMin: number | null;
  inBedMin: number | null;
  coreMin: number | null;
  remMin: number | null;
  deepMin: number | null;
  awakenings: number | null;
  vo2max: number | null;
  hrRecovery: number | null;
  walkingHr: number | null;
  basalKcal: number | null;
  flights: number | null;
  dietKcal: number | null;
  dietProteinG: number | null;
  dietCarbsG: number | null;
  dietFatG: number | null;
  /** When this snapshot was written — used to tell a brief it was generated
   *  from stale numbers, not just to know what the numbers were. */
  ingestedAt: string;
}

export interface HealthRepo {
  /**
   * Writes what the phone posted, without erasing what it did not send.
   *
   * The route accepts an explicit `date`, and the import fills the same rows —
   * so a post for a day the import already filled used to blank every column
   * the Shortcut left out. COALESCE closes the other direction of the guard
   * `fillGaps` provides. Nothing is lost by it: the route already separates
   * "no sample" from "measured zero", so a null arriving here means the
   * reading genuinely was not taken.
   */
  upsert(snapshot: Omit<HealthSnapshot, "ingestedAt">, raw: unknown, now: Date): void;
  latest(onOrBefore: string): HealthSnapshot | undefined;
  forDate(date: string): HealthSnapshot | undefined;
  /** Most recent `days` snapshots strictly before `date`, for baselines. */
  baseline(date: string, days: number): HealthSnapshot[];
  /** Every snapshot in an inclusive date range, oldest first. */
  between(from: string, to: string): HealthSnapshot[];
  /**
   * Writes only the columns that are currently NULL.
   *
   * This is what lets a monthly re-import run without thought: today's row
   * already holds what the phone posted this morning, and the export must not
   * replace it. COALESCE says exactly that, declaratively — no provenance
   * tracking needed.
   */
  fillGaps(date: string, values: Record<string, number>, now: Date): void;
}

interface Row {
  date: string;
  sleep_h: number | null;
  hrv: number | null;
  rhr: number | null;
  move_kcal: number | null;
  exercise_min: number | null;
  steps: number | null;
  asleep_min: number | null;
  in_bed_min: number | null;
  core_min: number | null;
  rem_min: number | null;
  deep_min: number | null;
  awakenings: number | null;
  vo2max: number | null;
  hr_recovery: number | null;
  walking_hr: number | null;
  basal_kcal: number | null;
  flights: number | null;
  diet_kcal: number | null;
  diet_protein_g: number | null;
  diet_carbs_g: number | null;
  diet_fat_g: number | null;
  ingested_at: string;
}

const toSnapshot = (r: Row): HealthSnapshot => ({
  date: r.date,
  sleepH: r.sleep_h,
  hrv: r.hrv,
  rhr: r.rhr,
  moveKcal: r.move_kcal,
  exerciseMin: r.exercise_min,
  steps: r.steps,
  asleepMin: r.asleep_min,
  inBedMin: r.in_bed_min,
  coreMin: r.core_min,
  remMin: r.rem_min,
  deepMin: r.deep_min,
  awakenings: r.awakenings,
  vo2max: r.vo2max,
  hrRecovery: r.hr_recovery,
  walkingHr: r.walking_hr,
  basalKcal: r.basal_kcal,
  flights: r.flights,
  dietKcal: r.diet_kcal,
  dietProteinG: r.diet_protein_g,
  dietCarbsG: r.diet_carbs_g,
  dietFatG: r.diet_fat_g,
  ingestedAt: r.ingested_at,
});

export function createHealthRepo(db: Db): HealthRepo {
  return {
    upsert(s, raw, now) {
      db.run(
        `INSERT INTO health_snapshots
           (date, sleep_h, hrv, rhr, move_kcal, exercise_min, steps, raw_json, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET
           sleep_h      = COALESCE(excluded.sleep_h, health_snapshots.sleep_h),
           hrv          = COALESCE(excluded.hrv, health_snapshots.hrv),
           rhr          = COALESCE(excluded.rhr, health_snapshots.rhr),
           move_kcal    = COALESCE(excluded.move_kcal, health_snapshots.move_kcal),
           exercise_min = COALESCE(excluded.exercise_min, health_snapshots.exercise_min),
           steps        = COALESCE(excluded.steps, health_snapshots.steps),
           raw_json     = excluded.raw_json,
           ingested_at  = excluded.ingested_at`,
        s.date, s.sleepH, s.hrv, s.rhr, s.moveKcal, s.exerciseMin, s.steps,
        JSON.stringify(raw), now.toISOString(),
      );
    },

    latest(onOrBefore) {
      const row = db.get<Row>(
        "SELECT * FROM health_snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1",
        onOrBefore,
      );
      return row ? toSnapshot(row) : undefined;
    },

    forDate(date) {
      const row = db.get<Row>("SELECT * FROM health_snapshots WHERE date = ?", date);
      return row ? toSnapshot(row) : undefined;
    },

    baseline(date, days) {
      return db
        .all<Row>(
          "SELECT * FROM health_snapshots WHERE date < ? ORDER BY date DESC LIMIT ?",
          date, days,
        )
        .map(toSnapshot);
    },

    between(from, to) {
      // The aggregation layer works over ranges; `baseline` answers "the last
      // N days", which is a different question and cannot express a range.
      return db.all<Row>(
        "SELECT * FROM health_snapshots WHERE date >= ? AND date <= ? ORDER BY date",
        from, to,
      ).map(toSnapshot);
    },

    fillGaps(date, values, now) {
      const columns = Object.keys(values);
      if (columns.length === 0) return;

      for (const c of columns) {
        if (!HISTORY_COLUMNS.has(c)) throw new Error(`Unknown column: ${c}`);
      }

      const placeholders = columns.map(() => "?").join(", ");
      const keep = columns
        .map((c) => `${c} = COALESCE(health_snapshots.${c}, excluded.${c})`)
        .join(", ");

      db.run(
        `INSERT INTO health_snapshots (date, ${columns.join(", ")}, ingested_at)
         VALUES (?, ${placeholders}, ?)
         ON CONFLICT (date) DO UPDATE SET ${keep}`,
        date, ...columns.map((c) => values[c]!), now.toISOString(),
      );
    },
  };
}
