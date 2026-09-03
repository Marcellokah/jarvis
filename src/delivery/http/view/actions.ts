import { escapeHtml } from "../markdown.ts";

export interface ActionRow {
  id: string;
  kind: "checkbox" | "proposal";
  text: string;
  /** The module's own title, or its raw name when no module matches. */
  modul: string;
  /**
   * Already-worded detail lines for a proposal — when it starts, where, and
   * its note. Empty for a checkbox.
   *
   * A button that writes to the calendar needs more beside it than a title:
   * these are the lines a person reads BEFORE accepting.
   */
  reszletek: readonly string[];
}

export interface UndoableWrite {
  eventUid: string;
  title: string;
  startsAt: string;
  calendar: string;
}

export interface ActionsData {
  /** Open actions grouped by day, newest day first. */
  napok: readonly { date: string; items: readonly ActionRow[] }[];
  undoable: readonly UndoableWrite[];
}

/**
 * One button, as its own form.
 *
 * A form rather than a link because this changes state, and a prefetching
 * browser or a link checker fires GETs on its own. The action id travels in
 * the path, so the form carries no fields at all.
 */
function gomb(action: string, label: string): string {
  return `<form class="muvelet" method="post" action="${action}">`
    + `<button type="submit">${escapeHtml(label)}</button></form>`;
}

function sor(r: ActionRow): string {
  const muveletek = r.kind === "checkbox"
    ? gomb(`/teendo/${encodeURIComponent(r.id)}/kesz`, "Kész")
    : gomb(`/teendo/${encodeURIComponent(r.id)}/elfogad`, "Elfogadom")
      + gomb(`/teendo/${encodeURIComponent(r.id)}/elutasit`, "Elutasítom");

  const reszletek = r.reszletek.length === 0
    ? ""
    : `<p class="halk">${r.reszletek.map((d) => escapeHtml(d)).join(" · ")}</p>`;

  return [
    `<div class="teendo">`,
    `<div class="mit"><span class="cimke">${escapeHtml(r.modul)}</span>`,
    `<span class="szoveg">${escapeHtml(r.text)}</span>${reszletek}</div>`,
    `<div class="muveletek">${muveletek}</div>`,
    "</div>",
  ].join("");
}

/**
 * The two write bands: what is still open, and what can still be undone.
 *
 * Each is absent rather than empty when it has nothing to say — an "Teendők"
 * heading with a void beneath it is missing data that does not look missing.
 */
export function actionsBody(d: ActionsData): string {
  const teendok = d.napok.length === 0 ? "" : [
    "<section><h2>Teendők</h2>",
    d.napok.map((nap) =>
      `<h3>${escapeHtml(nap.date)}</h3><div class="teendok">`
      + `${nap.items.map(sor).join("")}</div>`).join(""),
    "</section>",
  ].join("");

  const vissza = d.undoable.length === 0 ? "" : [
    "<section><h2>Visszavonható</h2><div class=\"teendok\">",
    d.undoable.map((w) => [
      `<div class="teendo">`,
      `<div class="mit"><span class="cimke">${escapeHtml(w.calendar)}</span>`,
      `<span class="szoveg">${escapeHtml(w.title)}</span>`,
      `<p class="halk">${escapeHtml(w.startsAt)}</p></div>`,
      `<div class="muveletek">`,
      gomb(`/naptar/${encodeURIComponent(w.eventUid)}/visszavon`, "Visszavonom"),
      "</div></div>",
    ].join("")).join(""),
    "</div></section>",
  ].join("");

  return `${teendok}${vissza}`;
}

/**
 * What each write error says to the reader, and how loudly.
 *
 * The list is closed on purpose: the code arrives in the query string, which
 * anybody can write, so anything not on this list renders nothing rather than
 * being echoed back onto the page.
 *
 * `already_resolved` is absent from the list deliberately, not by oversight.
 * It is what a double tap produces, and the state the reader wanted already
 * holds — an alarm that fires when nothing is wrong is exactly the kind of
 * indicator this project refuses everywhere else.
 */
const HIBAK: Record<string, { szoveg: string; riaszt: boolean }> = {
  calendar_failed: {
    szoveg: "Nem sikerült a naptárba írni. A teendő nyitva maradt, újra megpróbálhatod.",
    riaszt: true,
  },
  not_found: { szoveg: "Ez a teendő már nincs meg.", riaszt: false },
  wrong_kind: { szoveg: "Ez a művelet nem erre a fajta teendőre való.", riaszt: false },
};

export function errorBand(code: string | undefined): string {
  const hiba = code === undefined ? undefined : HIBAK[code];
  if (hiba === undefined) return "";
  return `<p class="hibasav${hiba.riaszt ? " riaszt" : ""}">${escapeHtml(hiba.szoveg)}</p>`;
}
