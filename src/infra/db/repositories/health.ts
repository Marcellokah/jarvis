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

/**
 * Columns whose value is only complete once the day is over.
 *
 * These are the day totals and day averages: they keep changing until
 * midnight. The Shortcut's evening run fires at 23:55, so its number is always
 * five minutes short — and that near-miss used to freeze permanently, because
 * the import could never correct it. Everything absent from this set is the
 * opposite kind of reading: an HRV or an RHR taken at 07:30 is final the
 * moment it is taken, and the export's whole-day average of it is a different,
 * less useful number than the one the brief wants.
 *
 * Hence the single rule both writers below obey, inverted between them:
 * a measurement that is final when taken belongs to whoever took it;
 * a measurement that accumulates over a day belongs to whoever saw the
 * whole day.
 */
export const ACCUMULATES_OVER_DAY: ReadonlySet<string> = new Set([
  "steps", "distance_km", "move_kcal", "basal_kcal", "exercise_min",
  "flights", "stand_min",
  "diet_kcal", "diet_protein_g", "diet_carbs_g", "diet_fat_g",
  "walking_hr", "walking_speed", "step_length_cm",
  "double_support_pct", "asymmetry_pct", "stair_up_ms", "stair_down_ms",
]);

const incomingWins = (c: string) => `${c} = COALESCE(excluded.${c}, health_snapshots.${c})`;
const existingWins = (c: string) => `${c} = COALESCE(health_snapshots.${c}, excluded.${c})`;

/** The phone took the reading, so it wins — unless the day was still running. */
const upsertAssignment = (c: string) =>
  ACCUMULATES_OVER_DAY.has(c) ? existingWins(c) : incomingWins(c);

/** The import saw the whole day, so it wins exactly where that is what counts. */
const fillGapsAssignment = (c: string) =>
  ACCUMULATES_OVER_DAY.has(c) ? incomingWins(c) : existingWins(c);

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
   * the Shortcut left out. COALESCE closes that. Nothing is lost by it: the
   * route already separates "no sample" from "measured zero", so a null
   * arriving here means the reading genuinely was not taken.
   *
   * Where a value already exists, `ACCUMULATES_OVER_DAY` decides who keeps it:
   * the phone wins on its own morning readings, and yields on the day totals
   * its 23:55 run could only ever have seen five minutes short.
   */
  upsert(snapshot: Omit<HealthSnapshot, "ingestedAt">, raw: unknown, now: Date): void;
  latest(onOrBefore: string): HealthSnapshot | undefined;
  forDate(date: string): HealthSnapshot | undefined;
  /** Most recent `days` snapshots strictly before `date`, for baselines. */
  baseline(date: string, days: number): HealthSnapshot[];
  /** Every snapshot in an inclusive date range, oldest first. */
  between(from: string, to: string): HealthSnapshot[];
  /**
   * The import's write: it fills holes, and corrects the day totals.
   *
   * This is what lets a monthly re-import run without thought. For a reading
   * that was final when taken, today's row already holds the better number —
   * the one the phone measured this morning — and the export must not replace
   * it, so only a NULL is filled. For a column in `ACCUMULATES_OVER_DAY` the
   * export's month-end figure is by definition the more complete one, so it
   * overwrites. Declarative either way — no provenance tracking needed.
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

/**
 * Every snapshot column paired with the field that fills it, in bind order.
 *
 * The INSERT, its placeholders, the ON CONFLICT assignments and the bound
 * values are all derived from this one list, so a column can no longer be
 * written in one of the four places and forgotten in the others.
 */
const SNAPSHOT_FIELDS: readonly (readonly [string, Exclude<keyof HealthSnapshot, "date" | "ingestedAt">])[] = [
  ["sleep_h", "sleepH"],
  ["hrv", "hrv"],
  ["rhr", "rhr"],
  ["move_kcal", "moveKcal"],
  ["exercise_min", "exerciseMin"],
  ["steps", "steps"],
  ["asleep_min", "asleepMin"],
  ["in_bed_min", "inBedMin"],
  ["core_min", "coreMin"],
  ["rem_min", "remMin"],
  ["deep_min", "deepMin"],
  ["awakenings", "awakenings"],
  ["vo2max", "vo2max"],
  ["hr_recovery", "hrRecovery"],
  ["walking_hr", "walkingHr"],
  ["basal_kcal", "basalKcal"],
  ["flights", "flights"],
  ["diet_kcal", "dietKcal"],
  ["diet_protein_g", "dietProteinG"],
  ["diet_carbs_g", "dietCarbsG"],
  ["diet_fat_g", "dietFatG"],
  ["distance_km", "distanceKm"],
  ["stand_min", "standMin"],
  ["walking_speed", "walkingSpeed"],
  ["step_length_cm", "stepLengthCm"],
  ["double_support_pct", "doubleSupportPct"],
  ["asymmetry_pct", "asymmetryPct"],
  ["steadiness_pct", "steadinessPct"],
  ["six_min_walk_m", "sixMinWalkM"],
  ["stair_up_ms", "stairUpMs"],
  ["stair_down_ms", "stairDownMs"],
];

// date + every snapshot column + raw_json + ingested_at.
const UPSERT_SQL = `INSERT INTO health_snapshots
           (date, ${SNAPSHOT_FIELDS.map(([c]) => c).join(", ")}, raw_json, ingested_at)
         VALUES (${new Array(SNAPSHOT_FIELDS.length + 3).fill("?").join(", ")})
         ON CONFLICT (date) DO UPDATE SET
           ${SNAPSHOT_FIELDS.map(([c]) => upsertAssignment(c)).join(",\n           ")},
           raw_json = excluded.raw_json,
           ingested_at = excluded.ingested_at`;

export function createHealthRepo(db: Db): HealthRepo {
  return {
    upsert(s, raw, now) {
      db.run(
        UPSERT_SQL,
        s.date,
        ...SNAPSHOT_FIELDS.map(([, field]) => s[field]),
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
      const assignments = columns.map(fillGapsAssignment).join(", ");

      db.run(
        `INSERT INTO health_snapshots (date, ${columns.join(", ")}, ingested_at)
         VALUES (?, ${placeholders}, ?)
         ON CONFLICT (date) DO UPDATE SET ${assignments}`,
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
