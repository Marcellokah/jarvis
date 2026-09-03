import type { Series } from "./series.ts";

export interface Bucket {
  min: number; max: number; median: number; n: number;
  /**
   * The first and last day this column actually holds a measurement on.
   *
   * Read off the column's own points rather than reconstructed from the
   * column index: inverting the placement fraction means rounding twice, and
   * the rounded end of column i then equals the rounded start of column i+1,
   * so every readout claimed a day that belonged to its neighbour. The points
   * know their own dates; nothing has to be derived.
   */
  from: string; to: string;
}

/**
 * Which column a day falls into — the one placement rule.
 *
 * It stays private on purpose. `plot.ts` used to import it to decide where a
 * gap's far end lands and break the line there, and that was the bug: a
 * column index and a drawn band are two different roundings of the same gap,
 * and they disagree. The line is now tested against the band's own geometry,
 * so nothing outside this file has any business placing a day in a column.
 */
function columnOf(series: Series, day: number, columns: number): number {
  const span = series.toDay - series.fromDay;
  const t = span === 0 ? 0 : (day - series.fromDay) / span;
  return Math.min(columns - 1, Math.max(0, Math.floor(t * columns)));
}

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

  const collected: { date: string; value: number }[][] =
    Array.from({ length: columns }, () => []);

  // A single-day window has no span to divide by; `columnOf` lands everything
  // in the first column rather than in a NaN one.
  for (const p of series.points) collected[columnOf(series, p.day, columns)]!.push(p);

  for (const [i, pts] of collected.entries()) {
    if (pts.length === 0) continue;
    // `series.points` is already sorted by day, and the loop above preserves
    // that order per column — so the first and last entry are the column's
    // own date range, with no second sort.
    const sorted = [...pts].sort((a, b) => a.value - b.value);
    out[i] = {
      min: sorted[0]!.value,
      max: sorted.at(-1)!.value,
      median: sorted[Math.floor((sorted.length - 1) / 2)]!.value,
      n: pts.length,
      from: pts[0]!.date,
      to: pts.at(-1)!.date,
    };
  }
  return out;
}
