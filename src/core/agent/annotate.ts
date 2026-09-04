import { mean, stdDev, shiftDay, type Point } from "../analysis/stats.ts";

/**
 * The second defence.
 *
 * The measurement that produced this plan had a 9B model look at
 * `hrv=203.59` -- the highest reading in a four-year history, 9.7 standard
 * deviations from its own baseline -- and write "HRV normális" in its
 * reasoning. Nothing in the observation told it otherwise: a bare number
 * carries no scale.
 *
 * So the code does not decide what is interesting; it labels what the model
 * sees. A value that arrives already carrying its distance from the owner's
 * own baseline cannot casually be called ordinary.
 */
export interface Baseline {
  mean: number;
  sd: number;
  n: number;
  allTimeMax: number;
  allTimeMin: number;
}

/**
 * Below this many measurements there is no baseline worth quoting.
 *
 * Same floor `aggregate()` uses for its 90-day windows: a sigma computed from
 * a handful of days is a number with a false air of authority, and this whole
 * module exists to stop exactly that.
 */
export const MIN_BASELINE_N = 20;

export function baselineFor(points: readonly Point[], end: string, days: number): Baseline | null {
  const first = shiftDay(end, -(days - 1));
  const inside = points.filter((p) => p.date >= first && p.date <= end).map((p) => p.value);
  if (inside.length < MIN_BASELINE_N) return null;

  const m = mean(inside);
  const sd = stdDev(inside);
  if (m === null || sd === null || sd === 0) return null;

  const all = points.map((p) => p.value);
  return {
    mean: m, sd, n: inside.length,
    allTimeMax: Math.max(...all),
    allTimeMin: Math.min(...all),
  };
}

/**
 * Hungarian decimal comma, at most one decimal.
 *
 * Exported because `questions.ts` formats the same numbers for the same two
 * readers — a model and the owner — and two copies of a number formatter is
 * how "203.6" and "203,6" end up in the same observation.
 */
export const hu = (x: number): string =>
  (Math.round(x * 10) / 10).toString().replace(".", ",");

export function annotate(value: number, base: Baseline | null): string {
  if (base === null) return `${hu(value)} (nincs elég mérés a viszonyításhoz)`;

  const sigma = (value - base.mean) / base.sd;
  const marks = [`${sigma >= 0 ? "+" : "−"}${hu(Math.abs(sigma))}σ`];
  if (value >= base.allTimeMax) marks.push("minden idők maximuma");
  if (value <= base.allTimeMin) marks.push("minden idők minimuma");

  return `${hu(value)} (${marks.join(", ")})`;
}
