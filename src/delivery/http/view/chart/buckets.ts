import type { Series } from "./series.ts";

export interface Bucket { min: number; max: number; median: number; n: number }

/**
 * A pixel column's worth of measurements — its range, not its average.
 *
 * 2718 points on an 800-pixel chart is 3.4 points per pixel: pointless detail
 * and 30-40 KB of path data. But averaging is not the answer. An average hides
 * the spikes — one 200 ms HRV night in a year of 50s vanishes without trace —
 * and averaging ACROSS a hole invents a number for days that were never
 * measured. A min-max band with the median inside shows what actually
 * happened, spread included, and invents nothing.
 *
 * A column no measurement falls into stays `null`. It must never inherit its
 * neighbour: that is the same lie as interpolating, one pixel wide.
 */
export function bucketise(series: Series, columns: number): (Bucket | null)[] {
  const out: (Bucket | null)[] = new Array(columns).fill(null);
  if (columns <= 0 || series.points.length === 0) return out;

  const span = series.toDay - series.fromDay;
  const collected: number[][] = Array.from({ length: columns }, () => []);

  for (const p of series.points) {
    // A single-day window has no span to divide by; everything lands in the
    // first column rather than in a NaN one.
    const t = span === 0 ? 0 : (p.day - series.fromDay) / span;
    const i = Math.min(columns - 1, Math.max(0, Math.floor(t * columns)));
    collected[i]!.push(p.value);
  }

  for (const [i, vals] of collected.entries()) {
    if (vals.length === 0) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    out[i] = {
      min: sorted[0]!,
      max: sorted.at(-1)!,
      median: sorted[Math.floor((sorted.length - 1) / 2)]!,
      n: vals.length,
    };
  }
  return out;
}
