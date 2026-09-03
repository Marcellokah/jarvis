import { escapeHtml } from "../../markdown.ts";
import { hu } from "../format.ts";
import {
  analysisBand, leadBand, seriesBand,
  type AreaAnalysis, type SeriesTile,
} from "./frame.ts";
import type { Metric } from "../../../../core/analysis/stats.ts";

export interface RecoveryData {
  /** Recent HRV against its own 90-day baseline, in standard deviations. */
  deviation: { sigma: number; n7: number; n90: number } | null;
  sleepByYear: readonly { year: string; days: number; withSleep: number }[];
  stages: { core: Metric; rem: Metric; deep: Metric };
  awakenings: Metric;
  tiles: readonly SeriesTile[];
  analysis: AreaAnalysis | undefined;
}

/**
 * One metric as a row: value, or the absence of one, plus its evidence.
 *
 * `value === null` never renders as zero. "0 perc of REM sleep" and "REM
 * sleep was never measured" are opposite claims that would look identical.
 */
function metricRow(label: string, m: Metric, unit: string, digits: number, i: number): string {
  const measured = m.value !== null;
  const pct = Math.min(100, Math.max(0, m.coverage * 100));
  return [
    `<tr class="${measured ? "live" : "dead"}" style="--i:${i}">`,
    `<td>${escapeHtml(label)}</td>`,
    `<td class="value">${measured ? `${hu(m.value!, digits)}${unit}` : "nincs mérés"}</td>`,
    `<td class="ev"><span class="rail${measured ? "" : " dead"}" style="--fill:${pct.toFixed(1)}%"></span>`,
    `<span class="note">${hu(m.n)} nap · ${Math.floor(pct)}% lefedettség (${escapeHtml(m.window)})</span></td>`,
    "</tr>",
  ].join("");
}

/**
 * Sleep coverage per year — the loudest missing-data block on the site.
 *
 * This is the one figure that explains why every sleep number elsewhere is
 * thin, and the year-by-year shape is what tells the story a single total
 * cannot: the coverage fell away, it did not simply start late. A year with
 * zero measured nights gets the dead rail rather than a rail filled to 0% —
 * a 0% bar reads as a measurement that went badly, and no measurement is not
 * a bad measurement.
 */
function sleepBlock(rows: readonly { year: string; days: number; withSleep: number }[]): string {
  if (rows.length === 0) {
    return `<section><h2>Alvás lefedettsége</h2>`
      + `<p class="halk">Nincs alvás-előzmény.</p></section>`;
  }
  const body = rows.map((r, i) => {
    const raw = r.days === 0 ? 0 : (r.withSleep / r.days) * 100;
    // Currently unreachable — withSleep never exceeds days — but clamped for
    // symmetry with metricRow's own rail, which guards the same shape.
    const pct = Math.min(100, Math.max(0, raw));
    const measured = r.withSleep > 0;
    return [
      `<tr class="${measured ? "live" : "dead"}" style="--i:${i}">`,
      `<td>${escapeHtml(r.year)}</td>`,
      `<td class="value">${hu(r.withSleep)} / ${hu(r.days)} nap</td>`,
      `<td class="ev"><span class="rail${measured ? "" : " dead"}" style="--fill:${pct.toFixed(1)}%"></span>`,
      `<span class="note">${Math.floor(pct)}% lefedettség</span></td>`,
      "</tr>",
    ].join("");
  }).join("");
  return `<section><h2>Alvás lefedettsége</h2><table>${body}</table></section>`;
}

export function recoveryBody(d: RecoveryData): string {
  const lead = leadBand({
    label: "HRV az alapvonalához",
    value: d.deviation === null
      ? null
      : `${d.deviation.sigma > 0 ? "+" : ""}${hu(d.deviation.sigma, 2)} σ`,
    against: d.deviation === null
      ? "7 napos átlag a 90 napos alapvonalhoz mérve"
      : `7 nap ${hu(d.deviation.n7)} mérése a 90 nap ${hu(d.deviation.n90)} méréséhez mérve`,
    missing: "nincs elég mérés",
  });

  const stages = [
    metricRow("Mély alvás", d.stages.deep, " perc", 0, 0),
    metricRow("REM", d.stages.rem, " perc", 0, 1),
    metricRow("Alap alvás", d.stages.core, " perc", 0, 2),
    metricRow("Ébredés", d.awakenings, "", 1, 3),
  ].join("");

  return [
    lead,
    seriesBand("Regeneráció", d.tiles),
    sleepBlock(d.sleepByYear),
    `<section><h2>Fázisok és ébredés</h2><table>${stages}</table></section>`,
    analysisBand(d.analysis),
  ].join("");
}
