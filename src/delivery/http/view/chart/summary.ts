import { slopePer30d } from "../../../../core/analysis/stats.ts";
import type { Series } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

/**
 * Which way the series is going, in one clause — or nothing at all.
 *
 * The spec asks the written summary to name the direction, and for a reader
 * who never sees the picture (a screen reader, or this same string quoted
 * back in a Telegram reply) it is the only access to the shape there is.
 *
 * The slope is the aggregation layer's own least-squares fit over REAL day
 * gaps, not over array positions — the series are full of holes, and treating
 * a 35-day hole as one step would invent a trend out of the hole itself. It
 * is then graded against the series' OWN spread rather than against an
 * absolute number of units, because "0.4 per 30 days" is a steep VO2max
 * trend and an invisible step-count one, and one fixed threshold cannot be
 * right for both.
 *
 * Under three measurements, or on a series with no spread to grade against,
 * there is no trend to state and the clause is simply absent — the same rule
 * the rest of this system follows: say nothing rather than something the data
 * does not carry.
 */
function trendWords(series: Series): string | null {
  const slope = slopePer30d(series.points);
  if (slope === null) return null;
  const spread = series.max - series.min;
  if (spread === 0) return "a trend vízszintes";
  const share = Math.abs(slope) / spread;
  if (share < 0.1) return "a trend vízszintes";
  const direction = slope > 0 ? "emelkedő" : "csökkenő";
  return share < 0.35 ? `a trend enyhén ${direction}` : `a trend ${direction}`;
}

/**
 * The one written form of a chart, used by every renderer that has one.
 *
 * The sparkline, the large plot and the detail page's paragraph all answer
 * the same question and used to answer it in three slightly different
 * shapes — one carried the day count, one did not, none carried the trend
 * the spec describes. A reader comparing the row's chart with the page it
 * links to would have been told two different things about one series.
 *
 * The caller prefixes the metric's label where the surrounding text does not
 * already carry it: the detail page has it in its own heading, the SVG
 * summaries do not.
 */
export function chartSummary(series: Series, spec: SeriesSpec): string {
  // Floor, not round, exactly as the numbers table does it: 364 days out of
  // 365 must never round up into a claim of completeness.
  const parts = [
    `${series.totalDays} nap: ${series.points.length} mérés, `
    + `${Math.floor(series.coverage * 100)}% lefedettség`,
  ];
  if (series.points.length > 0) parts.push(`${spec.format(series.min)}–${spec.format(series.max)}`);
  const trend = trendWords(series);
  if (trend !== null) parts.push(trend);
  return parts.join(", ");
}
