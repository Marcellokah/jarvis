import { escapeHtml, renderMarkdown } from "../../markdown.ts";
import type { AreaAnalysis } from "./frame.ts";

export interface HubCard {
  href: string;
  title: string;
  /** The area's own headline figure, already formatted — null when absent. */
  figure: string | null;
  /**
   * One sentence about the area.
   *
   * Normally the domain analysis's own `summary`. Nutrition has no analysis
   * domain (S8 will add one), so its card carries a measured line of its own
   * instead — a card with something true to say is not a missing-data state.
   */
  note: string;
  /** The ISO date the note's source carries, or null when it has none. */
  noteDate: string | null;
}

export interface HubData {
  synthesis: AreaAnalysis | undefined;
  cards: readonly HubCard[];
}

/**
 * The way into the four areas, and the only page that carries the synthesis.
 *
 * Not an empty click-through: the nav has four slots and there are eight
 * pages behind them, so this page has to earn its place. It does that by
 * being where the cross-domain analysis lives and where each area states its
 * headline figure — which is also the fastest read on the whole site.
 */
export function hubBody(d: HubData): string {
  const synthesis = d.synthesis === undefined
    ? ""
    : `<section><h2>Összegzés · ${escapeHtml(d.synthesis.createdAt.slice(0, 10))}</h2>`
      + `${renderMarkdown(d.synthesis.markdown)}</section>`;

  const cards = d.cards.map((c) => [
    // hrefs are this module's own literal route strings (e.g. "/terulet/terheles"), never caller-supplied
    `<a class="kartya${c.figure === null ? " hianyzik" : ""}" href="${c.href}">`,
    `<span class="cimke">${escapeHtml(c.title)}</span>`,
    `<span class="szam">${escapeHtml(c.figure ?? "nincs adat")}</span>`,
    `<span class="halk">${escapeHtml(c.note)}</span>`,
    c.noteDate === null ? "" : `<span class="kor">${escapeHtml(c.noteDate)}</span>`,
    "</a>",
  ].join("")).join("");

  return `${synthesis}<section><div class="kartyak">${cards}</div></section>`;
}
