import { escapeHtml } from "../markdown.ts";
import type { Metric } from "../../../core/analysis/stats.ts";
import type { Metrics } from "../../../core/analysis/aggregate.ts";

export interface MetricRow {
  label: string;
  /** Already formatted for a person — "nincs mérés" where there is none. */
  value: string;
  detail: string;
  /**
   * 0..1 of the window that was actually measured, or null where the row has
   * no window to be measured over (a ratio, a trend, a monthly total).
   *
   * Carried as a number rather than left inside `detail`, because the page
   * draws it: a rail that fills to a figure parsed back out of prose would be
   * decoration, and this one has to be true.
   */
  coverage: number | null;
}

/**
 * One readout row: label, value, and the rail that says how much of it is real.
 *
 * A row with no coverage figure gets no rail at all rather than an empty one —
 * a ratio computed from two windows has no single window to be complete over,
 * and drawing a 0% rail there would claim it was measured badly rather than
 * not measured at all.
 */
// Exported alongside `numbersBody` (not just used internally): the "Számok"
// band is one row per metric, and any code that wants to assemble its own
// table from a subset or a differently-ordered list of rows — rather than
// the whole-body `numbersBody` — needs the row renderer itself, not just
// the finished table.
export function readout(r: MetricRow, i: number): string {
  const measured = r.coverage !== null && r.coverage > 0;
  const pct = r.coverage === null ? 0 : Math.min(100, Math.max(0, r.coverage * 100));
  const rail = r.coverage === null
    ? ""
    : `<span class="rail${measured ? "" : " dead"}" style="--fill:${pct.toFixed(1)}%"></span>`;

  return [
    `<tr class="${measured || r.coverage === null ? "live" : "dead"}" style="--i:${i}">`,
    `<td>${escapeHtml(r.label)}</td>`,
    `<td class="value">${escapeHtml(r.value)}</td>`,
    `<td class="ev">${rail}<span class="note">${escapeHtml(r.detail)}</span></td>`,
    "</tr>",
  ].join("");
}

const hu = (n: number, digits = 0) =>
  n.toLocaleString("hu-HU", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * One row per metric, formatted for a person.
 *
 * A missing measurement reads "nincs mérés" and never 0 — the whole system is
 * built on that distinction, and a table is where it would be easiest to lose.
 * The detail column always carries the evidence: how many days, what coverage.
 */
function row(label: string, m: Metric, digits = 0, unit = ""): MetricRow {
  // Floor, not round: 364 days out of 365 rounds up to "100%", and this table
  // is the one place the owner reads coverage. Only genuine completeness may
  // claim it — incomplete data must never look complete.
  const pct = Math.floor(m.coverage * 100);
  return {
    label,
    value: m.value === null ? "nincs mérés" : `${hu(m.value, digits)}${unit}`,
    detail: `${m.n} nap · ${pct}% lefedettség (${m.window})`,
    coverage: m.coverage,
  };
}

export function metricsRowsFrom(m: Metrics): MetricRow[] {
  const rows: MetricRow[] = [
    {
      label: "Terhelési arány",
      value: m.physical.loadRatio === null ? "nincs alap" : hu(m.physical.loadRatio, 2),
      detail: "28 napos napi átlag a 365 naposhoz mérve",
      // Two windows compared, so there is no single one to be complete over.
      coverage: null,
    },
    row("Lépés (7 nap)", m.physical.steps.d7),
    row("Lépés (365 nap)", m.physical.steps.d365),
    row("VO2max", m.physical.vo2max, 1),
    row("Nyugalmi pulzus", m.physical.rhr, 1, " bpm"),
    row("HRV (7 nap)", m.recovery.hrv.d7, 1, " ms"),
    row("HRV (90 nap)", m.recovery.hrv.d90, 1, " ms"),
    row("Alvás (90 nap)", m.recovery.asleepMin.d90, 0, " perc"),
  ];

  const trend = (label: string, slope: number | null, unit: string) => {
    if (slope === null) return;
    rows.push({
      label: `${label} trendje`,
      value: `${slope > 0 ? "+" : ""}${hu(slope, 2)}${unit}`,
      detail: "30 naponta, 365 napos ablakon",
      coverage: null,
    });
  };
  trend("VO2max", m.physical.vo2max.slopePer30d, "");
  trend("Nyugalmi pulzus", m.physical.rhr.slopePer30d, " bpm");

  rows.push({
    label: "Előfizetések",
    value: m.finance.months.at(-1) === undefined
      ? "nincs adat"
      : `${hu(m.finance.months.at(-1)!.totalHuf)} Ft`,
    detail: `${m.finance.months.length} rögzített hónap`,
    // Subscriptions are entered, not measured; a coverage rail would be a lie.
    coverage: null,
  });

  return rows;
}

export function numbersBody(rows: readonly MetricRow[]): string {
  return `<section><h2>Számok</h2><table>${rows.map(readout).join("")}</table></section>`;
}
