/**
 * Statistical primitives for the aggregation layer.
 *
 * Everything here is pure and returns `null` rather than a number it cannot
 * justify. That is the project's rule stated in arithmetic: a mean of nothing
 * is not zero, and a standard deviation of one sample is not stability.
 */

/** A dated observation. `date` is a plain YYYY-MM-DD label, not an instant. */
export interface Point {
  date: string;
  value: number;
}

/** A windowed statistic, always travelling with the evidence behind it. */
export interface Metric {
  value: number | null;
  /** How many days inside the window actually had a reading. */
  n: number;
  /** `n` divided by the window length, 0..1. */
  coverage: number;
  /** Human label for the window, e.g. "28d". */
  window: string;
}

const DAY_MS = 86_400_000;

/**
 * Calendar arithmetic on date labels.
 *
 * Built on UTC deliberately: these are labels for days, not moments, so a
 * local-time shift across a daylight-saving boundary would move the wrong day.
 */
export function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function dayGap(from: string, to: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / DAY_MS);
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation. Null below two values — one has no spread. */
export function stdDev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Least-squares slope, scaled to 30 days.
 *
 * Per-day slopes are unreadable at this scale ("-0.023 VO2max/day" says
 * nothing); per-month is the unit a person actually thinks in. The regression
 * runs on real day gaps rather than array positions, because the series are
 * full of holes and treating a 40-day gap as one step would invent a trend.
 */
export function slopePer30d(points: readonly Point[]): number | null {
  if (points.length < 3) return null;
  const origin = points[0]!.date;
  const xs = points.map((p) => dayGap(origin, p.date));
  const ys = points.map((p) => p.value);
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 30;
}

/** Pearson correlation. Null below three pairs, or when either side is flat. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ma = mean(a)!;
  const mb = mean(b)!;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * Mean of the points inside a window of `days` ending on `end` (inclusive).
 *
 * Missing days are skipped, never counted as zero — a day with no step count
 * is a day the phone was off, not a day without walking. `coverage` is what
 * keeps that honest downstream.
 */
export function windowed(
  points: readonly Point[],
  end: string,
  days: number,
  window: string,
): Metric {
  const first = shiftDay(end, -(days - 1));
  const inside = points.filter((p) => p.date >= first && p.date <= end);
  return {
    value: mean(inside.map((p) => p.value)),
    n: inside.length,
    coverage: inside.length / days,
    window,
  };
}
