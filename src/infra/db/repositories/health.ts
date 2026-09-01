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
  distanceKm: number | null;
  standMin: number | null;
  walkingSpeed: number | null;
  stepLengthCm: number | null;
  doubleSupportPct: number | null;
  asymmetryPct: number | null;
  steadinessPct: number | null;
  sixMinWalkM: number | null;
  stairUpMs: number | null;
  stairDownMs: number | null;
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
  /** The most recent day holding a value in `column`, or null. */
  lastDateWith(column: string): string | null;
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
  distance_km: number | null;
  stand_min: number | null;
  walking_speed: number | null;
  step_length_cm: number | null;
  double_support_pct: number | null;
  asymmetry_pct: number | null;
  steadiness_pct: number | null;
  six_min_walk_m: number | null;
  stair_up_ms: number | null;
  stair_down_ms: number | null;
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
  distanceKm: r.distance_km,
  standMin: r.stand_min,
  walkingSpeed: r.walking_speed,
  stepLengthCm: r.step_length_cm,
  doubleSupportPct: r.double_support_pct,
  asymmetryPct: r.asymmetry_pct,
  steadinessPct: r.steadiness_pct,
  sixMinWalkM: r.six_min_walk_m,
  stairUpMs: r.stair_up_ms,
  stairDownMs: r.stair_down_ms,
  ingestedAt: r.ingested_at,
});

export function createHealthRepo(db: Db): HealthRepo {
  return {
    upsert(s, raw, now) {
      db.run(
        `INSERT INTO health_snapshots
           (date, sleep_h, hrv, rhr, move_kcal, exercise_min, steps,
            asleep_min, in_bed_min, core_min, rem_min, deep_min, awakenings,
            vo2max, hr_recovery, walking_hr, basal_kcal, flights,
            diet_kcal, diet_protein_g, diet_carbs_g, diet_fat_g,
            distance_km, stand_min, walking_speed, step_length_cm,
            double_support_pct, asymmetry_pct, steadiness_pct, six_min_walk_m,
            stair_up_ms, stair_down_ms,
            raw_json, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET
           sleep_h            = COALESCE(excluded.sleep_h, health_snapshots.sleep_h),
           hrv                = COALESCE(excluded.hrv, health_snapshots.hrv),
           rhr                = COALESCE(excluded.rhr, health_snapshots.rhr),
           move_kcal          = COALESCE(excluded.move_kcal, health_snapshots.move_kcal),
           exercise_min       = COALESCE(excluded.exercise_min, health_snapshots.exercise_min),
           steps              = COALESCE(excluded.steps, health_snapshots.steps),
           asleep_min         = COALESCE(excluded.asleep_min, health_snapshots.asleep_min),
           in_bed_min         = COALESCE(excluded.in_bed_min, health_snapshots.in_bed_min),
           core_min           = COALESCE(excluded.core_min, health_snapshots.core_min),
           rem_min            = COALESCE(excluded.rem_min, health_snapshots.rem_min),
           deep_min           = COALESCE(excluded.deep_min, health_snapshots.deep_min),
           awakenings         = COALESCE(excluded.awakenings, health_snapshots.awakenings),
           vo2max             = COALESCE(excluded.vo2max, health_snapshots.vo2max),
           hr_recovery        = COALESCE(excluded.hr_recovery, health_snapshots.hr_recovery),
           walking_hr         = COALESCE(excluded.walking_hr, health_snapshots.walking_hr),
           basal_kcal         = COALESCE(excluded.basal_kcal, health_snapshots.basal_kcal),
           flights            = COALESCE(excluded.flights, health_snapshots.flights),
           diet_kcal          = COALESCE(excluded.diet_kcal, health_snapshots.diet_kcal),
           diet_protein_g     = COALESCE(excluded.diet_protein_g, health_snapshots.diet_protein_g),
           diet_carbs_g       = COALESCE(excluded.diet_carbs_g, health_snapshots.diet_carbs_g),
           diet_fat_g         = COALESCE(excluded.diet_fat_g, health_snapshots.diet_fat_g),
           distance_km        = COALESCE(excluded.distance_km, health_snapshots.distance_km),
           stand_min          = COALESCE(excluded.stand_min, health_snapshots.stand_min),
           walking_speed      = COALESCE(excluded.walking_speed, health_snapshots.walking_speed),
           step_length_cm     = COALESCE(excluded.step_length_cm, health_snapshots.step_length_cm),
           double_support_pct = COALESCE(excluded.double_support_pct, health_snapshots.double_support_pct),
           asymmetry_pct      = COALESCE(excluded.asymmetry_pct, health_snapshots.asymmetry_pct),
           steadiness_pct     = COALESCE(excluded.steadiness_pct, health_snapshots.steadiness_pct),
           six_min_walk_m     = COALESCE(excluded.six_min_walk_m, health_snapshots.six_min_walk_m),
           stair_up_ms        = COALESCE(excluded.stair_up_ms, health_snapshots.stair_up_ms),
           stair_down_ms      = COALESCE(excluded.stair_down_ms, health_snapshots.stair_down_ms),
           raw_json           = excluded.raw_json,
           ingested_at        = excluded.ingested_at`,
        s.date, s.sleepH, s.hrv, s.rhr, s.moveKcal, s.exerciseMin, s.steps,
        s.asleepMin, s.inBedMin, s.coreMin, s.remMin, s.deepMin, s.awakenings,
        s.vo2max, s.hrRecovery, s.walkingHr, s.basalKcal, s.flights,
        s.dietKcal, s.dietProteinG, s.dietCarbsG, s.dietFatG,
        s.distanceKm, s.standMin, s.walkingSpeed, s.stepLengthCm,
        s.doubleSupportPct, s.asymmetryPct, s.steadinessPct, s.sixMinWalkM,
        s.stairUpMs, s.stairDownMs,
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

    lastDateWith(column) {
      // The same allowlist fillGaps uses. A column name is not user input
      // today, but the guard costs nothing and the alternative is a hole.
      if (!HISTORY_COLUMNS.has(column)) throw new Error(`Unknown column: ${column}`);
      return db.get<{ date: string }>(
        `SELECT date FROM health_snapshots WHERE ${column} IS NOT NULL ORDER BY date DESC LIMIT 1`,
      )?.date ?? null;
    },
  };
}
