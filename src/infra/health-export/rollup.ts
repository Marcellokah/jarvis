import type { ExportEntry } from "./reader.ts";

export interface DailyValues {
  /** YYYY-MM-DD, already local: the export carries the offset it was recorded in. */
  date: string;
  values: Record<string, number>;
}

export interface WorkoutRow {
  date: string;
  type: string;
  /** ISO instant, the natural key together with type. */
  startedAt: string;
  durationMin: number;
  energyKcal: number | null;
  source: string;
}

export interface RollupResult {
  days: DailyValues[];
  workouts: WorkoutRow[];
  /** Types deliberately not stored, with counts — so the import can report them. */
  skipped: Record<string, number>;
  range: { from: string; to: string } | null;
}

/**
 * The fifteen types worth keeping, of the forty-seven the export contains.
 *
 * `sum` is for what accumulates through a day (steps, calories eaten); `avg` is
 * for point measurements taken more than once (resting heart rate). Everything
 * absent from this map is skipped: handwashing events, headphone volume and
 * gait asymmetry are not what a morning assistant reasons about.
 */
const DAILY: Record<string, { column: string; agg: "sum" | "avg" }> = {
  RestingHeartRate: { column: "rhr", agg: "avg" },
  HeartRateVariabilitySDNN: { column: "hrv", agg: "avg" },
  VO2Max: { column: "vo2max", agg: "avg" },
  WalkingHeartRateAverage: { column: "walking_hr", agg: "avg" },
  HeartRateRecoveryOneMinute: { column: "hr_recovery", agg: "avg" },
  ActiveEnergyBurned: { column: "move_kcal", agg: "sum" },
  BasalEnergyBurned: { column: "basal_kcal", agg: "sum" },
  StepCount: { column: "steps", agg: "sum" },
  AppleExerciseTime: { column: "exercise_min", agg: "sum" },
  FlightsClimbed: { column: "flights", agg: "sum" },
  DietaryEnergyConsumed: { column: "diet_kcal", agg: "sum" },
  DietaryProtein: { column: "diet_protein_g", agg: "sum" },
  DietaryCarbohydrates: { column: "diet_carbs_g", agg: "sum" },
  DietaryFatTotal: { column: "diet_fat_g", agg: "sum" },
};

const STAGE: Record<string, string> = {
  HKCategoryValueSleepAnalysisAsleepCore: "core_min",
  HKCategoryValueSleepAnalysisAsleepREM: "rem_min",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep_min",
};

/**
 * '2026-03-01 23:10:00 +0100' -> a local day and an instant.
 *
 * The export is not ISO 8601, but it carries the offset it was recorded in —
 * so the first ten characters are already the local calendar day, with no
 * conversion. That is also the honest answer when you travel: the day you
 * actually lived.
 */
function parseAppleDate(s: string): { day: string; ms: number } {
  const day = s.slice(0, 10);
  const iso = `${day}T${s.slice(11, 19)}${s.slice(20, 23)}:${s.slice(23, 25)}`;
  return { day, ms: Date.parse(iso) };
}

const minutes = (fromMs: number, toMs: number) => Math.round((toMs - fromMs) / 60_000);

export async function rollup(entries: AsyncIterable<ExportEntry>): Promise<RollupResult> {
  const sums = new Map<string, Record<string, number>>();
  const counts = new Map<string, Record<string, number>>();
  const workouts: WorkoutRow[] = [];
  const skipped: Record<string, number> = {};
  let from: string | undefined;
  let to: string | undefined;

  const bump = (day: string, column: string, value: number) => {
    const s = sums.get(day) ?? {};
    const c = counts.get(day) ?? {};
    s[column] = (s[column] ?? 0) + value;
    c[column] = (c[column] ?? 0) + 1;
    sums.set(day, s);
    counts.set(day, c);
    if (!from || day < from) from = day;
    if (!to || day > to) to = day;
  };

  for await (const e of entries) {
    if (e.kind === "workout") {
      const started = parseAppleDate(e.startDate);
      workouts.push({
        date: started.day,
        type: e.type,
        startedAt: new Date(started.ms).toISOString(),
        durationMin: e.durationMin,
        energyKcal: e.energyKcal,
        source: e.source,
      });
      if (!from || started.day < from) from = started.day;
      if (!to || started.day > to) to = started.day;
      continue;
    }

    if (e.type === "SleepAnalysis") {
      const start = parseAppleDate(e.startDate);
      const end = parseAppleDate(e.endDate);
      // The day you woke up on, not the day you lay down.
      const day = end.day;
      const mins = minutes(start.ms, end.ms);

      if (e.value === "HKCategoryValueSleepAnalysisInBed") {
        bump(day, "in_bed_min", mins);
      } else if (e.value === "HKCategoryValueSleepAnalysisAwake") {
        bump(day, "awakenings", 1);
      } else {
        // Core, REM, Deep and Unspecified all count as asleep; only the three
        // named stages also get their own column.
        bump(day, "asleep_min", mins);
        const stage = STAGE[e.value];
        if (stage) bump(day, stage, mins);
      }
      continue;
    }

    const spec = DAILY[e.type];
    if (!spec) {
      skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }

    const value = Number(e.value);
    if (!Number.isFinite(value)) {
      skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }
    bump(parseAppleDate(e.startDate).day, spec.column, value);
  }

  const days: DailyValues[] = [...sums.keys()].sort().map((date) => {
    const s = sums.get(date)!;
    const c = counts.get(date)!;
    const values: Record<string, number> = {};

    for (const [column, total] of Object.entries(s)) {
      const spec = Object.values(DAILY).find((d) => d.column === column);
      values[column] = spec?.agg === "avg"
        ? Math.round((total / c[column]!) * 100) / 100
        : total;
    }

    // The existing brief reads sleep in hours; keep it derived rather than
    // stored twice from two sources.
    if (values.asleep_min !== undefined) {
      values.sleep_h = Math.round((values.asleep_min / 60) * 10) / 10;
    }
    return { date, values };
  });

  return {
    days,
    workouts,
    skipped,
    range: from && to ? { from, to } : null,
  };
}
