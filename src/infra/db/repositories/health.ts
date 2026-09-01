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
 * Columns that count something up as the day runs, and are only whole at
 * midnight: a step is added to today's total, an HRV reading is not.
 *
 * This is the one distinction both writers below turn on, and the rule it
 * expresses is: a measurement that is final when taken belongs to whoever took
 * it; a measurement that accumulates over a day belongs to whoever wrote last,
 * because they saw more of the day. For a counter, "later" and "more complete"
 * are the same fact — the 23:59 re-run of a failed 23:55 post, and the monthly
 * export, are both simply the last writer with the fullest view.
 *
 * Only genuine counters belong here. A day AVERAGE is not an accumulation, and
 * this is not a matter of taste: `walking_hr`, `walking_speed`,
 * `step_length_cm`, `double_support_pct`, `asymmetry_pct`, `stair_up_ms` and
 * `stair_down_ms` all come out of the rollup's `agg: "avg"` path — the very
 * same unweighted mean that produces `hrv`, `rhr` and `vo2max`, which nobody
 * would put in this set. Adding a sample to a mean does not make it more
 * complete, it makes it a different number, and a whole-day mean is not the
 * reading the brief asks about. `walking_hr` is the plainest case of all:
 * `WalkingHeartRateAverage` is one sample Apple has already computed for the
 * day, so it does not change through the day at all.
 */
export const ACCUMULATES_OVER_DAY: ReadonlySet<string> = new Set([
  "steps", "distance_km", "move_kcal", "basal_kcal", "exercise_min",
  "flights", "stand_min",
  "diet_kcal", "diet_protein_g", "diet_carbs_g", "diet_fat_g",
]);

const incomingWins = (c: string) => `${c} = COALESCE(excluded.${c}, health_snapshots.${c})`;
const existingWins = (c: string) => `${c} = COALESCE(health_snapshots.${c}, excluded.${c})`;

/**
 * The phone's post always wins, whatever kind of column it is.
 *
 * Both halves of the rule point the same way here, which is why this needs no
 * split: the phone took the final-when-taken readings itself, and for a day
 * total a second post is a later look at the same counter — the 23:59 re-run
 * of a failed 23:55 run saw four more minutes of the day, not fewer.
 */
const upsertAssignment = incomingWins;

/**
 * The import fills holes, and owns the counters — it wrote last and saw most.
 *
 * It must never touch a final-when-taken column that already has a value: the
 * export's whole-day mean of an HRV is a different number from the one the
 * phone measured at 07:30, not a better one.
 */
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
   * Where a value already exists, this post wins it. That holds for both kinds
   * of column at once: the phone took the final-when-taken readings, and for a
   * day total the newer post is simply the later look at a running counter.
   * The two daily runs send disjoint fields, so in practice they do not even
   * contend — but a re-run of a failed run does, and there the newer number is
   * the fuller one.
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
   * import is the last writer and saw the most of the day, so it overwrites.
   * Declarative either way — no provenance tracking needed.
   *
   * That second half is only true of days the export saw whole. The export's
   * own last day is partial by construction, so the import strips its counters
   * before calling this — see `withoutPartialDayTotals`.
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
 *
 * Exported so the invariant test can hold it against `HISTORY_COLUMNS`:
 * dropping a row here still typechecks, and would silently change that
 * column's write behaviour rather than break anything visible.
 */
export const SNAPSHOT_FIELDS: readonly (readonly [string, Exclude<keyof HealthSnapshot, "date" | "ingestedAt">])[] = [
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
