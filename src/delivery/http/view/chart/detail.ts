import { escapeHtml } from "../../markdown.ts";
import type { Series } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

/**
 * The three windows the detail page lets a reader choose between.
 *
 * `mind`'s 4000 days is not a cap on how far back the chart can reach — it
 * is the input to `addDays` that computes the window's lower bound. This
 * owner's history starts in 2019, so 4000 days back from today already
 * covers all of it, with headroom for years yet to come; it is not a limit
 * that would ever truncate real data.
 */
export const TARTOMANYOK: readonly { key: string; days: number; label: string }[] = [
  { key: "30", days: 30, label: "30 nap" },
  { key: "365", days: 365, label: "1 év" },
  { key: "mind", days: 4000, label: "minden" },
];

/**
 * An unknown or missing `tart` falls back to one year — and never throws.
 *
 * A range comes straight off the query string, so it can be anything: an old
 * bookmark, a hand-edited URL, a typo. None of those are the server's fault,
 * and none of them may take the page down — the fallback is silent on
 * purpose, the same way `parseRange`'s caller never learns whether the raw
 * value was valid or missing.
 */
export function parseRange(raw: string | undefined): { key: string; days: number; label: string } {
  return TARTOMANYOK.find((t) => t.key === raw) ?? TARTOMANYOK[1]!;
}

/** The range selector: one link per window, the active one marked for both eye and screen reader. */
function rangeNav(column: string, active: string): string {
  const links = TARTOMANYOK.map((t) => {
    const isActive = t.key === active;
    return `<a href="/szamok/${encodeURIComponent(column)}?tart=${t.key}" class="tartomany"`
      + `${isActive ? ' aria-current="page"' : ""}>${escapeHtml(t.label)}</a>`;
  }).join("");
  return `<nav class="tartomanyok">${links}</nav>`;
}

/**
 * The text summary under the chart.
 *
 * The picture already carries this exact information in its own
 * `aria-label` (see `plot.ts`), but that label lives inside the SVG's
 * accessible name, not the page's text — a reader who copies the page, a
 * screen reader that does not announce SVG titles the same way everywhere,
 * or this owner skimming on a phone all want it as plain text on the page
 * too, not only reachable by hovering or tabbing into the graphic.
 */
function summary(spec: SeriesSpec, series: Series): string {
  const range = series.points.length === 0 ? "" : `, ${spec.format(series.min)}–${spec.format(series.max)}`;
  return `${series.totalDays} nap: ${series.points.length} mérés, `
    + `${Math.floor(series.coverage * 100)}% lefedettség${range}`;
}

/** The detail page's body: title, range selector, the chart, and its text summary underneath. */
export function detailBody(spec: SeriesSpec, series: Series, active: string, chart: string): string {
  return [
    "<section>",
    `<h2>${escapeHtml(spec.label)}</h2>`,
    rangeNav(spec.column, active),
    chart,
    `<p class="osszegzes">${escapeHtml(summary(spec, series))}</p>`,
    "</section>",
  ].join("");
}
