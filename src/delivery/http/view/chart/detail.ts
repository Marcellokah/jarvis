import { escapeHtml } from "../../markdown.ts";
import { chartSummary } from "./summary.ts";
import type { Series } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

export interface Tartomany { key: string; days: number; label: string }

/**
 * The longest window this page will honour, in days.
 *
 * `mind`'s 4000 days is not a cap on how far back the chart can reach — it is
 * the input to `addDays` that computes the window's lower bound, and the route
 * then clamps that bound to the day the history itself begins, so a `mind`
 * readout never divides its coverage by days that could not have been
 * measured. It is also the ceiling on a hand-written `?tart=` day count,
 * because an unbounded one would let a URL ask for a million-day window.
 */
const MAX_DAYS = 4000;

/** The three windows the detail page offers by name. */
export const TARTOMANYOK: readonly Tartomany[] = [
  { key: "30", days: 30, label: "30 nap" },
  { key: "365", days: 365, label: "1 év" },
  { key: "mind", days: MAX_DAYS, label: "minden" },
];

/**
 * A window from the query string: one of the three named ones, any plain day
 * count — or, failing both, one year.
 *
 * The plain day count exists because the Számok rows link here carrying their
 * OWN window: "HRV (7 nap)" is computed over 7 days and "Alvás (90 nap)" over
 * 90, and those numbers are real information about the row. Reading only the
 * three named keys meant four of the seven row links silently landed on a
 * 365-day chart while the URL still said `tart=7` and the nav marked "1 év" —
 * a link that did not go where it said it went. Rather than throw the row's
 * window away, the page accepts it and shows it.
 *
 * An unknown or missing `tart` falls back to one year — and never throws. A
 * range comes straight off the query string, so it can be anything: an old
 * bookmark, a hand-edited URL, a typo. None of those are the server's fault,
 * and none of them may take the page down; the fallback is silent on purpose.
 */
export function parseRange(raw: string | undefined): Tartomany {
  const named = TARTOMANYOK.find((t) => t.key === raw);
  if (named !== undefined) return named;
  const days = Number(raw);
  if (Number.isInteger(days) && days >= 1 && days <= MAX_DAYS) {
    return { key: String(days), days, label: `${days} nap` };
  }
  return TARTOMANYOK[1]!;
}

/**
 * The range selector: one link per window, the active one marked for both eye
 * and screen reader.
 *
 * A window that is not one of the three named ones — a row's own 7 or 90 days
 * — joins the list in its place on the scale rather than replacing one of
 * them, so the reader can see where they landed AND still reach the others.
 */
function rangeNav(column: string, active: Tartomany): string {
  const windows = TARTOMANYOK.some((t) => t.key === active.key)
    ? [...TARTOMANYOK]
    : [...TARTOMANYOK, active].sort((a, b) => a.days - b.days);
  const links = windows.map((t) => {
    const isActive = t.key === active.key;
    return `<a href="/szamok/${encodeURIComponent(column)}?tart=${encodeURIComponent(t.key)}" class="tartomany"`
      + `${isActive ? ' aria-current="page"' : ""}>${escapeHtml(t.label)}</a>`;
  }).join("");
  return `<nav class="tartomanyok">${links}</nav>`;
}

/**
 * The detail page's body: title, range selector, the chart, and its text
 * summary underneath.
 *
 * The picture already carries that summary in its own `aria-label` (see
 * `plot.ts`), but that label lives inside the SVG's accessible name, not the
 * page's text — a reader who copies the page, a screen reader that does not
 * announce SVG titles the same way everywhere, or this owner skimming on a
 * phone all want it as plain text on the page too. It is the identical string
 * (minus the metric's name, which the heading right above already carries),
 * from the same function the two renderers use.
 */
export function detailBody(spec: SeriesSpec, series: Series, active: Tartomany, chart: string): string {
  return [
    "<section>",
    `<h2>${escapeHtml(spec.label)}</h2>`,
    rangeNav(spec.column, active),
    chart,
    `<p class="osszegzes">${escapeHtml(chartSummary(series, spec))}</p>`,
    "</section>",
  ].join("");
}
