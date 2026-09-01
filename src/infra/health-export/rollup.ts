import type { ExportEntry } from "./reader.ts";

/**
 * How a column's value was reconciled when several sources recorded it.
 *
 * Apple's export is raw: iPhone, Watch and third-party apps all write their own
 * samples for the same minutes, and Health only de-duplicates for display. The
 * rollup has to do it itself — and when it does, the number stored is the
 * result of a decision, not a measurement. That is worth being able to see.
 */
export interface Provenance {
  /** 'union': overlapping intervals merged. 'pick': one source's total kept. */
  resolution: "union" | "pick";
  /** Every source that recorded this column on this day, sorted. */
  sources: string[];
  /** For 'pick', the source whose total was kept. */
  chosen?: string;
}

export interface DailyValues {
  /** YYYY-MM-DD, already local: the export carries the offset it was recorded in. */
  date: string;
  values: Record<string, number>;
  /**
   * Only the columns more than one source recorded — empty on an ordinary day.
   * Present exactly when the value above came out of a de-duplication decision.
   */
  contested: Record<string, Provenance>;
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
 *
 * `unit` is the unit we store the column in. Apple writes a unit on every
 * quantity record and it follows the phone's locale and Health's display
 * settings — kJ instead of kcal, mi instead of km. Nothing here converts: a
 * silently rescaled number that still looks plausible is the worst thing this
 * import can produce. A record whose unit is not ours is counted as skipped
 * instead, so the import's own output names it.
 *
 * Exported so the invariant test can verify HISTORY_COLUMNS stays in sync.
 */
export const DAILY: Record<string, { column: string; agg: "sum" | "avg"; unit: string }> = {
  RestingHeartRate: { column: "rhr", agg: "avg", unit: "count/min" },
  HeartRateVariabilitySDNN: { column: "hrv", agg: "avg", unit: "ms" },
  VO2Max: { column: "vo2max", agg: "avg", unit: "mL/min·kg" },
  WalkingHeartRateAverage: { column: "walking_hr", agg: "avg", unit: "count/min" },
  HeartRateRecoveryOneMinute: { column: "hr_recovery", agg: "avg", unit: "count/min" },
  ActiveEnergyBurned: { column: "move_kcal", agg: "sum", unit: "kcal" },
  BasalEnergyBurned: { column: "basal_kcal", agg: "sum", unit: "kcal" },
  StepCount: { column: "steps", agg: "sum", unit: "count" },
  AppleExerciseTime: { column: "exercise_min", agg: "sum", unit: "min" },
  FlightsClimbed: { column: "flights", agg: "sum", unit: "count" },
  DietaryEnergyConsumed: { column: "diet_kcal", agg: "sum", unit: "kcal" },
  DietaryProtein: { column: "diet_protein_g", agg: "sum", unit: "g" },
  DietaryCarbohydrates: { column: "diet_carbs_g", agg: "sum", unit: "g" },
  DietaryFatTotal: { column: "diet_fat_g", agg: "sum", unit: "g" },
  DistanceWalkingRunning: { column: "distance_km", agg: "sum", unit: "km" },
  AppleStandTime: { column: "stand_min", agg: "sum", unit: "min" },
  WalkingSpeed: { column: "walking_speed", agg: "avg", unit: "km/hr" },
  WalkingStepLength: { column: "step_length_cm", agg: "avg", unit: "cm" },
  WalkingDoubleSupportPercentage: { column: "double_support_pct", agg: "avg", unit: "%" },
  WalkingAsymmetryPercentage: { column: "asymmetry_pct", agg: "avg", unit: "%" },
  AppleWalkingSteadiness: { column: "steadiness_pct", agg: "avg", unit: "%" },
  SixMinuteWalkTestDistance: { column: "six_min_walk_m", agg: "avg", unit: "m" },
  StairAscentSpeed: { column: "stair_up_ms", agg: "avg", unit: "m/s" },
  StairDescentSpeed: { column: "stair_down_ms", agg: "avg", unit: "m/s" },
};

const STAGE: Record<string, string> = {
  HKCategoryValueSleepAnalysisAsleepCore: "core_min",
  HKCategoryValueSleepAnalysisAsleepREM: "rem_min",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep_min",
};

/**
 * Interval columns holding a count of separate intervals rather than minutes.
 * One awakening recorded by two sources is still one awakening.
 */
const COUNT_COLUMNS: ReadonlySet<string> = new Set(["awakenings"]);

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

interface Span { from: number; to: number; source: string }

/** Overlapping and touching intervals collapsed into one, in start order. */
function union(spans: Span[]): { from: number; to: number }[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];

  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ from: s.from, to: s.to });
  }
  return merged;
}

function nested<V>(
  outer: Map<string, Map<string, V>>, day: string, column: string, make: () => V,
): V {
  let inner = outer.get(day);
  if (!inner) { inner = new Map(); outer.set(day, inner); }
  let value = inner.get(column);
  if (value === undefined) { value = make(); inner.set(column, value); }
  return value;
}

export async function rollup(entries: AsyncIterable<ExportEntry>): Promise<RollupResult> {
  // Accumulating types stay separated by source, so one can be chosen at the
  // end. Adding them together is what produced 81,272-step days and nineteen-
  // hour nights: every source's raw samples cover the same real-world minutes.
  const accum = new Map<string, Map<string, Map<string, { total: number; n: number }>>>();
  // Point measurements, averaged across every source. Deliberately not
  // de-duplicated: a mean of two sources' resting heart rates is still a
  // resting heart rate. Only addition and interval-summing can manufacture a
  // number that could not physically have happened, and that is the hazard
  // the source handling here exists for.
  const means = new Map<string, Map<string, { total: number; n: number }>>();
  // Interval types, kept raw until the end and then unioned.
  const spans = new Map<string, Map<string, Span[]>>();

  const workouts: WorkoutRow[] = [];
  const skipped: Record<string, number> = {};
  let from: string | undefined;
  let to: string | undefined;

  const drop = (key: string) => { skipped[key] = (skipped[key] ?? 0) + 1; };
  const seen = (day: string) => {
    if (!from || day < from) from = day;
    if (!to || day > to) to = day;
  };

  const addSpan = (day: string, column: string, span: Span) => {
    nested(spans, day, column, () => [] as Span[]).push(span);
    seen(day);
  };

  for await (const e of entries) {
    // Read but not trusted — counted here so the import reports it rather than
    // letting it look like data that never existed.
    if (e.kind === "dropped") { drop(e.reason); continue; }

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
      seen(started.day);
      continue;
    }

    if (e.type === "SleepAnalysis") {
      const start = parseAppleDate(e.startDate);
      const end = parseAppleDate(e.endDate);
      if (!Number.isFinite(start.ms) || !Number.isFinite(end.ms) || end.ms < start.ms) {
        drop("SleepAnalysis: értelmezhetetlen időtartam");
        continue;
      }
      // The day you woke up on, not the day you lay down.
      const day = end.day;
      const span: Span = { from: start.ms, to: end.ms, source: e.source };

      if (e.value === "HKCategoryValueSleepAnalysisInBed") {
        addSpan(day, "in_bed_min", span);
      } else if (e.value === "HKCategoryValueSleepAnalysisAwake") {
        addSpan(day, "awakenings", span);
      } else {
        // Core, REM, Deep and Unspecified all count as asleep; only the three
        // named stages also get their own column.
        addSpan(day, "asleep_min", span);
        const stage = STAGE[e.value];
        if (stage) addSpan(day, stage, span);
      }
      continue;
    }

    const spec = DAILY[e.type];
    if (!spec) { drop(e.type); continue; }

    if (e.unit !== spec.unit) {
      drop(`${e.type}: nem várt egység (${e.unit ?? "hiányzik"})`);
      continue;
    }

    const value = Number(e.value);
    if (!Number.isFinite(value)) { drop(e.type); continue; }

    const day = parseAppleDate(e.startDate).day;
    if (spec.agg === "avg") {
      const acc = nested(means, day, spec.column, () => ({ total: 0, n: 0 }));
      acc.total += value;
      acc.n += 1;
    } else {
      const bySource = nested(
        accum, day, spec.column, () => new Map<string, { total: number; n: number }>(),
      );
      const acc = bySource.get(e.source) ?? { total: 0, n: 0 };
      acc.total += value;
      acc.n += 1;
      bySource.set(e.source, acc);
    }
    seen(day);
  }

  const dates = [...new Set([...accum.keys(), ...means.keys(), ...spans.keys()])].sort();

  const days: DailyValues[] = dates.map((date) => {
    const values: Record<string, number> = {};
    const contested: Record<string, Provenance> = {};

    for (const [column, acc] of means.get(date) ?? []) {
      values[column] = Math.round((acc.total / acc.n) * 100) / 100;
    }

    for (const [column, bySource] of accum.get(date) ?? []) {
      // One source per day per type. Ordering by total keeps the source that
      // recorded the most of it that day: a phone left on the desk all morning
      // has a real but partial count, and taking the larger of two partial
      // views is the one rule that never invents movement that did not happen.
      // Record count then name break ties, so the choice is deterministic.
      const ranked = [...bySource.entries()].sort(
        (a, b) => b[1].total - a[1].total || b[1].n - a[1].n || a[0].localeCompare(b[0]),
      );
      const [chosen, acc] = ranked[0]!;
      values[column] = Math.round(acc.total * 1000) / 1000;
      if (ranked.length > 1) {
        contested[column] = {
          resolution: "pick",
          chosen,
          sources: ranked.map(([source]) => source).sort(),
        };
      }
    }

    for (const [column, list] of spans.get(date) ?? []) {
      // Two sources recording 23:00-07:00 is eight hours, not sixteen.
      const merged = union(list);
      values[column] = COUNT_COLUMNS.has(column)
        ? merged.length
        : Math.round(merged.reduce((total, m) => total + (m.to - m.from), 0) / 60_000);

      const sources = [...new Set(list.map((s) => s.source))].sort();
      if (sources.length > 1) contested[column] = { resolution: "union", sources };
    }

    // The existing brief reads sleep in hours; keep it derived rather than
    // stored twice from two sources.
    if (values.asleep_min !== undefined) {
      values.sleep_h = Math.round((values.asleep_min / 60) * 10) / 10;
      // sleep_h is the column the brief actually reads and comments on, so it
      // must carry the same "this came out of a decision" mark as its source.
      if (contested.asleep_min) contested.sleep_h = contested.asleep_min;
    }
    return { date, values, contested };
  });

  return {
    days,
    workouts,
    skipped,
    range: from && to ? { from, to } : null,
  };
}
