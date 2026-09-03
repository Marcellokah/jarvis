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

export interface EarlierAnalysis {
  createdAt: string;
  /** One paragraph — the field the next analysis run reads back. */
  summary: string;
}

/**
 * How many earlier analyses the disclosure shows.
 *
 * Past this the list stops being a history and becomes an archive, and an
 * archive wants its own place rather than a fold on a page about today.
 */
const ELOZMENY_MAX = 5;

/**
 * The earlier analyses for one domain, collapsed.
 *
 * A native `<details>`, with no JavaScript: the browser already has a
 * disclosure widget, and a scripted accordion would be more code and worse
 * keyboard reach for the same thing.
 *
 * The `<summary>` names the count rather than saying "Korábbiak", because a
 * neutral label does not tell the reader whether opening it is worth it. It
 * names how many are SHOWN, not how many exist — a label promising nine over
 * a list of five is the same class of confidently-wrong number this project
 * refuses everywhere else.
 *
 * Nothing at all when there is no history: an empty disclosure would promise
 * something behind it.
 */
export function historyBlock(earlier: readonly EarlierAnalysis[]): string {
  const shown = earlier.slice(0, ELOZMENY_MAX);
  if (shown.length === 0) return "";
  const items = shown.map((e) => [
    `<div class="tetel">`,
    `<span class="kor">${escapeHtml(e.createdAt.slice(0, 10))}</span>`,
    `<p>${escapeHtml(e.summary)}</p>`,
    "</div>",
  ].join("")).join("");
  return `<details class="elozmeny"><summary>${shown.length} korábbi elemzés</summary>`
    + `${items}</details>`;
}

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
export function analysisBand(
  a: AreaAnalysis | undefined,
  earlier: readonly EarlierAnalysis[],
): string {
  const elozmeny = historyBlock(earlier);
  if (a === undefined) {
    return "<section><h2>Elemzés</h2>"
      + `<p class="halk">Még nem futott mélyelemzés erre a területre. `
      + `Indítsd: <code>npm run analyze</code></p>${elozmeny}</section>`;
  }
  return `<section><h2>Elemzés · ${escapeHtml(a.createdAt.slice(0, 10))}</h2>`
    + `${renderMarkdown(a.markdown)}${elozmeny}</section>`;
}
