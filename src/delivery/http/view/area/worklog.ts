import { escapeHtml } from "../../markdown.ts";
import { hu, duration } from "../format.ts";
import type { WorkoutRow } from "../../../../infra/health-export/rollup.ts";

export const OLDAL_MERET = 50;

/** How many pages `total` workouts make, never fewer than one. */
function oldalak(total: number): number {
  return Math.max(1, Math.ceil(total / OLDAL_MERET));
}

/**
 * A 1-based page number from the query string, or the first page.
 *
 * Everything unusable falls back to page one rather than to a 404: the log
 * EXISTS, and only the request was meaningless. A 404 would say the page is
 * not there; an empty table would say there are no workouts, and there are
 * 2392 of them. `Number` is deliberately not enough on its own — it accepts
 * "1.5", "1e3" and " " (which becomes 0), so the integer and range checks
 * are what actually do the work here.
 */
export function parseOldal(raw: string | undefined, total: number): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "") return 1;
  if (!Number.isInteger(n) || n < 1 || n > oldalak(total)) return 1;
  return n;
}

/**
 * The pager: plain links, no JavaScript.
 *
 * Only the neighbours that exist are drawn. A "next" link on the last page
 * would land on an empty table, and an empty table in a log of 2392 workouts
 * reads as "there are none".
 */
function pager(oldal: number, total: number): string {
  const last = oldalak(total);
  if (last === 1) return "";
  const prev = oldal > 1
    ? `<a href="/terulet/terheles/naplo?oldal=${oldal - 1}">← előző</a>`
    : "";
  const next = oldal < last
    ? `<a href="/terulet/terheles/naplo?oldal=${oldal + 1}">következő →</a>`
    : "";
  return `<nav class="lapozo">${prev}`
    + `<span class="halk">${hu(oldal)} / ${hu(last)} · ${hu(total)} edzés</span>`
    + `${next}</nav>`;
}

export function worklogBody(
  rows: readonly WorkoutRow[], oldal: number, total: number,
): string {
  if (total === 0) {
    return `<section><h2>Edzésnapló</h2>`
      + `<p class="halk">Nincs rögzített edzés.</p></section>`;
  }
  const body = rows.map((w, i) => [
    `<tr class="live" style="--i:${Math.min(i, 7)}">`,
    `<td>${escapeHtml(w.date)}</td>`,
    // The stored instant is UTC; only its clock time is shown, which is what
    // "when did I start" means to a reader looking at their own day.
    `<td class="ev"><span class="note">${escapeHtml(w.startedAt.slice(11, 16))}</span></td>`,
    `<td>${escapeHtml(w.type)}</td>`,
    `<td class="value">${escapeHtml(duration(w.durationMin))}</td>`,
    `<td class="ev">${w.energyKcal === null
      ? `<span class="halk">nincs mérés</span>`
      : `${hu(w.energyKcal)} kcal`}</td>`,
    `<td class="ev"><span class="note">${escapeHtml(w.source)}</span></td>`,
    "</tr>",
  ].join("")).join("");

  return `<section><h2>Edzésnapló</h2><table>${body}</table>`
    + `${pager(oldal, total)}</section>`;
}
