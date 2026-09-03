import type { HealthSnapshot } from "../../infra/db/repositories/health.ts";
import type { WorkoutRow } from "../../infra/health-export/rollup.ts";
import type { MonthlySubscription } from "../../infra/db/repositories/subscription-months.ts";
import type { PlannedMeal } from "../../infra/db/repositories/meals.ts";
import {
  dayGap, shiftDay, slopePer30d, stdDev, windowed, type Metric, type Point,
} from "./stats.ts";

export interface AggregateInput {
  /** YYYY-MM-DD, the day every window ends on. */
  today: string;
  snapshots: readonly HealthSnapshot[];
  workouts: readonly WorkoutRow[];
  months: readonly { month: string; subs: readonly MonthlySubscription[] }[];
  /**
   * The weekly meal plan.
   *
   * The planned protein is what the measured intake is compared against —
   * there is no body weight anywhere in this database, so a per-kilogram
   * claim would have to be invented. The plan is the honest yardstick: it is
   * what this person decided to eat.
   */
  plan: readonly PlannedMeal[];
}

export interface TrendMetric extends Metric {
  slopePer30d: number | null;
}

export interface PhysicalMetrics {
  byMonth: { month: string; hours: number; sessions: number; strength: number }[];
  /** 28-day daily average training minutes over the 365-day daily average. */
  loadRatio: number | null;
  strengthPerWeek28d: number | null;
  vo2max: TrendMetric;
  rhr: TrendMetric;
  hrRecovery: TrendMetric;
  steps: { d7: Metric; d28: Metric; d90: Metric; d365: Metric };
}

export interface RecoveryMetrics {
  hrv: { d7: Metric; d28: Metric; d90: Metric; d365: Metric };
  /** Recent HRV against its own 90-day baseline, in standard deviations. */
  hrvDeviation: { sigma: number; n7: number; n90: number } | null;
  asleepMin: { d28: Metric; d90: Metric; d365: Metric };
  stages: { core: Metric; rem: Metric; deep: Metric };
  awakenings: Metric;
  sleepByYear: { year: string; days: number; withSleep: number }[];
}

export interface FinanceMetrics {
  months: { month: string; totalHuf: number; activeCount: number }[];
  monthOverMonth: {
    from: string;
    to: string;
    deltaHuf: number;
    changes: { name: string; fromHuf: number | null; toHuf: number | null }[];
  } | null;
  /**
   * The latest month multiplied by twelve. Null below
   * `MIN_MONTHS_TO_ANNUALISE` recorded months.
   */
  annualisedHuf: number | null;
}

export interface NutritionMetrics {
  /** Days carrying an intake figure at all. */
  measuredDays: number;
  /** Days from the first intake to `today` inclusive — the honest denominator. */
  windowDays: number;
  lastDate: string | null;
  /** The longest unbroken run of measured days, and the day it ended on. */
  longestStreak: { days: number; endedOn: string } | null;
  kcal: Metric;
  proteinG: Metric;
  balance: {
    /** Mean daily `diet − (basal + move)`, or null with no day carrying all three. */
    mean: number | null;
    n: number;
    over: number;
    under: number;
    /** Days with intake dropped because a burn term was missing. */
    dropped: number;
  };
  /** Planned daily protein from the weekly plan — null when no day is fully priced. */
  plannedProteinG: number | null;
  plannedKcal: number | null;
}

/**
 * How many recorded months an annual projection needs.
 *
 * The subscriptions table was created in S2 and earlier months are
 * deliberately not reconstructed, so the history starts short. Multiplying a
 * single observed month by twelve turns one number into a confident annual
 * figure — a year of spending claimed from a month of evidence. Half a year
 * is the point where the latest month is a sample of a pattern rather than
 * the whole of what is known. Under it the honest answer is that there is
 * not yet enough history to project from.
 */
const MIN_MONTHS_TO_ANNUALISE = 6;

export interface Metrics {
  today: string;
  physical: PhysicalMetrics;
  recovery: RecoveryMetrics;
  finance: FinanceMetrics;
  nutrition: NutritionMetrics;
}

const STRENGTH = "TraditionalStrengthTraining";

/** Pulls one nullable column out as dated points, dropping the days without it. */
function series(snapshots: readonly HealthSnapshot[], key: keyof HealthSnapshot): Point[] {
  const out: Point[] = [];
  for (const s of snapshots) {
    const v = s[key];
    if (typeof v === "number") out.push({ date: s.date, value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function trend(points: Point[], today: string, days: number, window: string): TrendMetric {
  const first = shiftDay(today, -(days - 1));
  const inside = points.filter((p) => p.date >= first && p.date <= today);
  return { ...windowed(points, today, days, window), slopePer30d: slopePer30d(inside) };
}

/** Total training minutes per day, so a day with three sessions counts once. */
function minutesByDay(workouts: readonly WorkoutRow[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const w of workouts) byDay.set(w.date, (byDay.get(w.date) ?? 0) + w.durationMin);
  return byDay;
}

function dailyAverageMinutes(
  byDay: Map<string, number>, today: string, days: number,
): { avg: number; daysWithTraining: number } {
  const first = shiftDay(today, -(days - 1));
  let total = 0;
  let n = 0;
  for (const [date, minutes] of byDay) {
    if (date >= first && date <= today) { total += minutes; n++; }
  }
  // Divided by the window, not by the days trained: rest days are part of the
  // load, and dividing by sessions would make training less often look harder.
  return { avg: total / days, daysWithTraining: n };
}

export function aggregate(input: AggregateInput): Metrics {
  const { today, snapshots, workouts, months, plan } = input;

  // ---- physical ----------------------------------------------------------
  const byDay = minutesByDay(workouts);
  const acute = dailyAverageMinutes(byDay, today, 28);
  const chronic = dailyAverageMinutes(byDay, today, 365);

  // A ratio needs a prior baseline to compare against. The baseline is training
  // days in the 365-day window *excluding* the most recent 28 days being measured.
  // Without at least 28 prior training days, there is nothing to be "relative to".
  const baselineDays = chronic.daysWithTraining - acute.daysWithTraining;
  const loadRatio = baselineDays >= 28 && chronic.avg > 0
    ? acute.avg / chronic.avg
    : null;

  const monthly = new Map<string, { hours: number; sessions: number; strength: number }>();
  for (const w of workouts) {
    const month = w.date.slice(0, 7);
    const cur = monthly.get(month) ?? { hours: 0, sessions: 0, strength: 0 };
    cur.hours += w.durationMin / 60;
    cur.sessions += 1;
    if (w.type === STRENGTH) cur.strength += 1;
    monthly.set(month, cur);
  }
  const byMonth = [...monthly.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({
      month, hours: Math.round(v.hours * 10) / 10, sessions: v.sessions, strength: v.strength,
    }));

  const first28 = shiftDay(today, -27);
  const strength28 = workouts.filter(
    (w) => w.type === STRENGTH && w.date >= first28 && w.date <= today,
  ).length;

  const steps = series(snapshots, "steps");

  // ---- recovery ----------------------------------------------------------
  const hrv = series(snapshots, "hrv");
  const hrv7 = windowed(hrv, today, 7, "7d");
  const hrv90 = windowed(hrv, today, 90, "90d");
  const first90 = shiftDay(today, -89);
  const sd90 = stdDev(
    hrv.filter((p) => p.date >= first90 && p.date <= today).map((p) => p.value),
  );
  // A sigma figure is the loudest number in the recovery prompt, so it has to
  // be the best-evidenced one. `stdDev` will return a spread from two samples
  // and `windowed` a 7-day mean from one reading, which together could ship a
  // headline "+3.4σ" resting on a single measurement against two. Below these
  // thresholds there is no deviation to report — not a small one, not a
  // caveated one. Above them it travels with both sample sizes, so the reader
  // never sees the number without the evidence behind it.
  const hrvDeviation = hrv7.value !== null && hrv90.value !== null
    && hrv7.n >= 3 && hrv90.n >= 20
    && sd90 !== null && sd90 > 0
    ? { sigma: (hrv7.value - hrv90.value) / sd90, n7: hrv7.n, n90: hrv90.n }
    : null;

  const yearly = new Map<string, { days: number; withSleep: number }>();
  for (const s of snapshots) {
    const year = s.date.slice(0, 4);
    const cur = yearly.get(year) ?? { days: 0, withSleep: 0 };
    cur.days += 1;
    if (typeof s.asleepMin === "number") cur.withSleep += 1;
    yearly.set(year, cur);
  }
  const sleepByYear = [...yearly.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, v]) => ({ year, ...v }));

  const asleep = series(snapshots, "asleepMin");

  // ---- finance -----------------------------------------------------------
  const ordered = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const financeMonths = ordered.map((m) => {
    const active = m.subs.filter((s) => s.active);
    return {
      month: m.month,
      totalHuf: active.reduce((a, s) => a + s.amountHuf, 0),
      activeCount: active.length,
    };
  });

  let monthOverMonth: FinanceMetrics["monthOverMonth"] = null;
  if (ordered.length >= 2) {
    const prev = ordered[ordered.length - 2]!;
    const curr = ordered[ordered.length - 1]!;
    const amountOf = (subs: readonly MonthlySubscription[], name: string) => {
      const hit = subs.find((s) => s.name === name && s.active);
      return hit ? hit.amountHuf : null;
    };
    const names = [...new Set([...prev.subs, ...curr.subs].map((s) => s.name))].sort();
    const changes = names
      .map((name) => ({
        name, fromHuf: amountOf(prev.subs, name), toHuf: amountOf(curr.subs, name),
      }))
      .filter((c) => c.fromHuf !== c.toHuf);
    const totalOf = (month: string) =>
      financeMonths.find((m) => m.month === month)!.totalHuf;
    monthOverMonth = {
      from: prev.month, to: curr.month,
      deltaHuf: totalOf(curr.month) - totalOf(prev.month),
      changes,
    };
  }

  const latestTotal = financeMonths.length >= MIN_MONTHS_TO_ANNUALISE
    ? financeMonths.at(-1)!.totalHuf
    : null;

  // ---- nutrition -----------------------------------------------------------
  const intake = snapshots
    .filter((s) => typeof s.dietKcal === "number")
    .sort((a, b) => a.date.localeCompare(b.date));
  const lastIntakeDate = intake.at(-1)?.date ?? null;
  const firstIntakeDate = intake[0]?.date ?? null;
  // Days since the FIRST intake, not the whole history: nothing was skipped
  // before the phone started reporting it, and dividing by the full history
  // would turn "we only started logging in September" into "you log one day
  // in thirty-six".
  const windowDays = firstIntakeDate === null ? 0 : dayGap(firstIntakeDate, today) + 1;

  let longestStreak: NutritionMetrics["longestStreak"] = null;
  let streak = 0;
  let previousIntakeDate: string | null = null;
  for (const s of intake) {
    streak = previousIntakeDate !== null && dayGap(previousIntakeDate, s.date) === 1
      ? streak + 1
      : 1;
    if (longestStreak === null || streak > longestStreak.days) {
      longestStreak = { days: streak, endedOn: s.date };
    }
    previousIntakeDate = s.date;
  }

  // A day is only usable when it carries intake AND both burn terms. A
  // missing `moveKcal` is not a day without movement, and counting it as zero
  // would overstate the surplus by however much was actually burned.
  let balanceSum = 0;
  let balanceN = 0;
  let over = 0;
  let under = 0;
  let dropped = 0;
  for (const s of intake) {
    if (typeof s.basalKcal !== "number" || typeof s.moveKcal !== "number") {
      dropped++;
      continue;
    }
    const diff = s.dietKcal! - (s.basalKcal + s.moveKcal);
    balanceSum += diff;
    balanceN++;
    if (diff > 0) over++;
    else if (diff < 0) under++;
  }

  // A planned day counts only when every one of its items is fully priced —
  // carrying BOTH kcal and protein — regardless of which figure is being
  // totalled. A meal missing just its protein still makes the day's kcal
  // total a partial sum standing where the day's real total belongs, so it
  // is dropped from both, not only from the field it happens to be missing.
  // Items are grouped by weekday first, so one unpriced item drops the whole
  // day rather than being smuggled in as a partial total.
  const byWeekday = new Map<number, PlannedMeal[]>();
  for (const p of plan) {
    const items = byWeekday.get(p.weekday);
    if (items) items.push(p); else byWeekday.set(p.weekday, [p]);
  }
  const fullyPricedDays = [...byWeekday.values()].filter(
    (items) => items.every((m) => typeof m.kcal === "number" && typeof m.proteinG === "number"),
  );
  function plannedTotal(key: "kcal" | "proteinG"): number | null {
    if (fullyPricedDays.length === 0) return null;
    const dayTotals = fullyPricedDays.map(
      (items) => items.reduce((a, m) => a + (m[key] as number), 0),
    );
    return Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length);
  }

  const nutrition: NutritionMetrics = {
    measuredDays: intake.length,
    windowDays,
    lastDate: lastIntakeDate,
    longestStreak,
    kcal: windowed(series(snapshots, "dietKcal"), today, Math.max(1, windowDays), `${windowDays}d`),
    proteinG: windowed(series(snapshots, "dietProteinG"), today, Math.max(1, windowDays), `${windowDays}d`),
    balance: { mean: balanceN === 0 ? null : Math.round(balanceSum / balanceN), n: balanceN, over, under, dropped },
    plannedProteinG: plannedTotal("proteinG"),
    plannedKcal: plannedTotal("kcal"),
  };

  return {
    today,
    physical: {
      byMonth,
      loadRatio,
      strengthPerWeek28d: workouts.length > 0 ? strength28 / 4 : null,
      vo2max: trend(series(snapshots, "vo2max"), today, 365, "365d"),
      rhr: trend(series(snapshots, "rhr"), today, 365, "365d"),
      hrRecovery: trend(series(snapshots, "hrRecovery"), today, 365, "365d"),
      steps: {
        d7: windowed(steps, today, 7, "7d"),
        d28: windowed(steps, today, 28, "28d"),
        d90: windowed(steps, today, 90, "90d"),
        d365: windowed(steps, today, 365, "365d"),
      },
    },
    recovery: {
      hrv: {
        d7: hrv7,
        d28: windowed(hrv, today, 28, "28d"),
        d90: hrv90,
        d365: windowed(hrv, today, 365, "365d"),
      },
      hrvDeviation,
      asleepMin: {
        d28: windowed(asleep, today, 28, "28d"),
        d90: windowed(asleep, today, 90, "90d"),
        d365: windowed(asleep, today, 365, "365d"),
      },
      stages: {
        core: windowed(series(snapshots, "coreMin"), today, 90, "90d"),
        rem: windowed(series(snapshots, "remMin"), today, 90, "90d"),
        deep: windowed(series(snapshots, "deepMin"), today, 90, "90d"),
      },
      awakenings: windowed(series(snapshots, "awakenings"), today, 90, "90d"),
      sleepByYear,
    },
    finance: {
      months: financeMonths,
      monthOverMonth,
      annualisedHuf: latestTotal === null ? null : latestTotal * 12,
    },
    nutrition,
  };
}
