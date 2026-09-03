import { escapeHtml, renderMarkdown } from "../../markdown.ts";

/**
 * The one figure that says how an area is doing, with what it is measured
 * against.
 *
 * `value` is `null` when the figure could not be computed at all — not zero,
 * not a dash. The distinction is the whole point: a load ratio of 0,00× and
 * "not enough history to compare against" look identical as numbers and mean
 * opposite things.
 */
export interface LeadFigure {
  label: string;
  /** Already formatted for a person — null when it could not be measured. */
  value: string | null;
  /** What the figure is measured against, in words. */
  against: string;
  /** What to say instead of a number. Used only when `value` is null. */
  missing: string;
}

export function leadBand(f: LeadFigure): string {
  const measured = f.value !== null;
  return [
    `<section class="vezeto${measured ? "" : " hianyzik"}">`,
    `<span class="cimke">${escapeHtml(f.label)}</span>`,
    `<span class="szam">${escapeHtml(measured ? f.value! : f.missing)}</span>`,
    `<span class="halk">${escapeHtml(f.against)}</span>`,
    "</section>",
  ].join("");
}

/** One series, its sparkline, and the window its detail page should open at. */
export interface SeriesTile {
  column: string;
  label: string;
  days: number;
  /** The already-rendered sparkline SVG — the view layer never queries. */
  chart: string;
}

/**
 * The area's series as a row of tiles, each linking to its own detail page.
 *
 * An empty band renders as nothing rather than as a heading with a void under
 * it: a "Mozgás" title with no content is missing data that does not look
 * missing.
 */
export function seriesBand(title: string, tiles: readonly SeriesTile[]): string {
  if (tiles.length === 0) return "";
  const items = tiles.map((t) =>
    `<a class="csempe" href="/szamok/${encodeURIComponent(t.column)}?tart=${t.days}">`
    + `<span class="cimke">${escapeHtml(t.label)}</span>${t.chart}</a>`,
  ).join("");
  return `<section><h2>${escapeHtml(title)}</h2><div class="csempek">${items}</div></section>`;
}

export interface AreaAnalysis { markdown: string; createdAt: string }

/**
 * The area's own analysis, dated.
 *
 * The date is not decoration. `latestPerDomain()` mixes vintages by design —
 * a failed run leaves the other domains' last successes in place — so it is
 * the only thing telling the reader how old this finding actually is.
 *
 * An area with no analysis says so and names the command, rather than
 * promising one later: this project's shell has carried no "coming soon"
 * since F1. An area that has no analysis DOMAIN at all (nutrition, until S8
 * builds one) does not call this function — its band is absent, not empty.
 */
export function analysisBand(a: AreaAnalysis | undefined): string {
  if (a === undefined) {
    return "<section><h2>Elemzés</h2>"
      + `<p class="halk">Még nem futott mélyelemzés erre a területre. `
      + `Indítsd: <code>npm run analyze</code></p></section>`;
  }
  return `<section><h2>Elemzés · ${escapeHtml(a.createdAt.slice(0, 10))}</h2>`
    + `${renderMarkdown(a.markdown)}</section>`;
}
