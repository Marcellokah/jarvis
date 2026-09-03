import { escapeHtml } from "../../markdown.ts";
import { hu } from "../format.ts";
import { bars, type BarRow } from "../chart/bars.ts";
import {
  analysisBand, leadBand, seriesBand,
  type AreaAnalysis, type SeriesTile,
} from "./frame.ts";
import type { WorkoutTypeTotal } from "../../../../infra/db/repositories/workouts.ts";
import type { WorkoutRow } from "../../../../infra/health-export/rollup.ts";

export interface LoadData {
  loadRatio: number | null;
  strengthPerWeek28d: number | null;
  byMonth: readonly { month: string; hours: number; sessions: number; strength: number }[];
  byType: readonly WorkoutTypeTotal[];
  /** The most recent sessions, newest first. */
  recent: readonly WorkoutRow[];
  tiles: readonly SeriesTile[];
  analysis: AreaAnalysis | undefined;
}

const ORAK = { label: "Edzésóra", format: (v: number) => `${hu(v, 1)} óra` };

/** "1 óra 32 perc" — minutes are what the record holds, hours are what a person reads. */
function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return h === 0 ? `${m} perc` : `${h} óra ${m} perc`;
}

/**
 * A type's calorie total, with how much of it is actually measured.
 *
 * `energy_kcal` is nullable and a great many walks arrive without one, so
 * three different things have to stay distinguishable: no session carried a
 * figure (no measurement), some did (a total, plus how many it rests on), and
 * all did (just the total).
 */
function kcalCell(t: WorkoutTypeTotal): string {
  if (t.kcal === null) return `<span class="halk">nincs mérés</span>`;
  const total = `${hu(t.kcal)} kcal`;
  if (t.kcalFrom === t.sessions) return total;
  return `${total} <span class="halk">(${t.kcalFrom} alkalomból)</span>`;
}

function typeTable(rows: readonly WorkoutTypeTotal[]): string {
  if (rows.length === 0) return "";
  const body = rows.map((t, i) => [
    `<tr class="live" style="--i:${i}">`,
    `<td>${escapeHtml(t.type)}</td>`,
    `<td class="value">${hu(t.sessions)}</td>`,
    `<td class="value">${hu(t.minutes / 60, 1)} óra</td>`,
    `<td class="ev">${kcalCell(t)}</td>`,
    `<td class="ev"><span class="note">${escapeHtml(t.lastDate)}</span></td>`,
    "</tr>",
  ].join("")).join("");
  return `<section><h2>Típusok</h2><table>${body}</table></section>`;
}

function recentTable(rows: readonly WorkoutRow[]): string {
  // An empty table with a heading is missing data that does not look missing.
  if (rows.length === 0) {
    return `<section><h2>Legutóbbi edzések</h2>`
      + `<p class="halk">Nincs rögzített edzés.</p></section>`;
  }
  const body = rows.map((w, i) => [
    `<tr class="live" style="--i:${i}">`,
    `<td>${escapeHtml(w.date)}</td>`,
    `<td>${escapeHtml(w.type)}</td>`,
    `<td class="value">${escapeHtml(duration(w.durationMin))}</td>`,
    `<td class="ev">${w.energyKcal === null
      ? `<span class="halk">nincs mérés</span>`
      : `${hu(w.energyKcal)} kcal`}</td>`,
    "</tr>",
  ].join("")).join("");
  return `<section><h2>Legutóbbi edzések</h2><table>${body}</table>`
    + `<p><a href="/terulet/terheles/naplo">Teljes napló →</a></p></section>`;
}

export function loadBody(d: LoadData): string {
  const lead = leadBand({
    label: "Terhelési arány",
    value: d.loadRatio === null ? null : `${hu(d.loadRatio, 2)}×`,
    against: "28 napos napi átlag edzésperc a 365 naposhoz mérve",
    missing: "nincs elég előzmény",
  });

  // The strength count rides with the monthly chart rather than getting its
  // own: two bar charts stacked on one time axis are harder to read than one
  // chart and one number.
  const strength = d.strengthPerWeek28d === null
    ? ""
    : `<p class="halk">Erősítés: ${hu(d.strengthPerWeek28d, 1)} alkalom hetente `
      + `(28 napos ablak).</p>`;

  const monthRows: BarRow[] = d.byMonth.map((m) => ({ label: m.month, value: m.hours }));
  const monthly = d.byMonth.length === 0
    ? ""
    : `<section><h2>Havi edzésóra</h2>${bars(monthRows, ORAK)}${strength}</section>`;

  return [
    lead,
    seriesBand("Mozgás", d.tiles),
    monthly,
    typeTable(d.byType),
    recentTable(d.recent),
    analysisBand(d.analysis),
  ].join("");
}
