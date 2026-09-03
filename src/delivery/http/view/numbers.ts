import { escapeHtml } from "../markdown.ts";
import { hu } from "./format.ts";
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
  /**
   * The one history column and window this row was computed over, or null
   * where there is none.
   *
   * Only a row backed by a real daily column can carry a chart: a ratio of
   * two windows (the load ratio), a trend, or a monthly subscription total
   * has no single column to draw and no window to draw it over. This is what
   * decides whether the row's label becomes a link to its own detail page —
   * a link into a chart that cannot exist would promise a measurement the
   * system does not have.
   */
  series: { column: string; days: number } | null;
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
export function readout(r: MetricRow, i: number, chart: string): string {
  const measured = r.coverage !== null && r.coverage > 0;
  const pct = r.coverage === null ? 0 : Math.min(100, Math.max(0, r.coverage * 100));
  const rail = r.coverage === null
    ? ""
    : `<span class="rail${measured ? "" : " dead"}" style="--fill:${pct.toFixed(1)}%"></span>`;

  // Only a row with a real daily column earns a link into its own detail
  // page — see `MetricRow.series` for why a row without one never does.
  const label = r.series === null
    ? escapeHtml(r.label)
    : `<a href="/szamok/${encodeURIComponent(r.series.column)}?tart=${r.series.days}">${escapeHtml(r.label)}</a>`;

  return [
    `<tr class="${measured || r.coverage === null ? "live" : "dead"}" style="--i:${i}">`,
    `<td>${label}</td>`,
    `<td class="value">${escapeHtml(r.value)}</td>`,
    `<td class="ev">${rail}<span class="note">${escapeHtml(r.detail)}</span></td>`,
    `<td class="chart">${chart}</td>`,
    "</tr>",
  ].join("");
}


/**
 * One row per metric, formatted for a person.
 *
 * A missing measurement reads "nincs mérés" and never 0 — the whole system is
 * built on that distinction, and a table is where it would be easiest to lose.
 * The detail column always carries the evidence: how many days, what coverage.
 */
/**
 * `column` is given only for a row backed by a real daily history column —
 * see `MetricRow.series`. `days` is read out of the metric's own window
 * label ("7d", "90d", "365d") rather than passed separately, so the two can
 * never drift apart the way a second hard-coded number could.
 */
function row(label: string, m: Metric, digits = 0, unit = "", column?: string): MetricRow {
  // Floor, not round: 364 days out of 365 rounds up to "100%", and this table
  // is the one place the owner reads coverage. Only genuine completeness may
  // claim it — incomplete data must never look complete.
  const pct = Math.floor(m.coverage * 100);
  // An unreadable window label does not stay inside its own row: the /szamok
  // route takes `Math.max` over every row's `days` to size one shared history
  // query, and `Math.max(NaN, ...)` is NaN — so a single window that is not
  // shaped `Nd` used to erase EVERY sparkline on the page rather than just
  // this row's. A row whose window cannot be read loses its own chart and its
  // own link, and nothing else does.
  const days = Number.parseInt(m.window, 10);
  const chartable = Number.isInteger(days) && days > 0;
  return {
    label,
    value: m.value === null ? "nincs mérés" : `${hu(m.value, digits)}${unit}`,
    detail: `${m.n} nap · ${pct}% lefedettség (${m.window})`,
    coverage: m.coverage,
    series: column === undefined || !chartable ? null : { column, days },
  };
}

export function metricsRowsFrom(m: Metrics): MetricRow[] {
  const rows: MetricRow[] = [
    {
      label: "Terhelési arány",
      value: m.physical.loadRatio === null ? "nincs alap" : hu(m.physical.loadRatio, 2),
      detail: "28 napos napi átlag a 365 naposhoz mérve",
      // Two windows compared, so there is no single one to be complete over —
      // and no single column either, so this row never gets a chart.
      coverage: null,
      series: null,
    },
    row("Lépés (7 nap)", m.physical.steps.d7, 0, "", "steps"),
    row("Lépés (365 nap)", m.physical.steps.d365, 0, "", "steps"),
    row("VO2max", m.physical.vo2max, 1, "", "vo2max"),
    row("Nyugalmi pulzus", m.physical.rhr, 1, " bpm", "rhr"),
    row("HRV (7 nap)", m.recovery.hrv.d7, 1, " ms", "hrv"),
    row("HRV (90 nap)", m.recovery.hrv.d90, 1, " ms", "hrv"),
    row("Alvás (90 nap)", m.recovery.asleepMin.d90, 0, " perc", "asleep_min"),
  ];

  const trend = (label: string, slope: number | null, unit: string) => {
    if (slope === null) return;
    rows.push({
      label: `${label} trendje`,
      value: `${slope > 0 ? "+" : ""}${hu(slope, 2)}${unit}`,
      detail: "30 naponta, 365 napos ablakon",
      // A slope over a window is not a value at any single day in it — no
      // column to draw and no rail to fill.
      coverage: null,
      series: null,
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
    // Subscriptions are entered, not measured; a coverage rail would be a lie,
    // and a monthly total has no daily column to chart either.
    coverage: null,
    series: null,
  });

  return rows;
}

/**
 * One row per metric, plus whatever chart the caller already built for it.
 *
 * `charts` is keyed by `label` rather than by `series.column`: two rows can
 * share a column at different windows (e.g. two "Lépés" windows both key off
 * "steps"), so the label — already unique per row — is the only key that
 * picks out the right chart for the right row.
 */
export function numbersBody(rows: readonly MetricRow[], charts: ReadonlyMap<string, string>): string {
  return `<section><h2>Számok</h2><table>${
    rows.map((r, i) => readout(r, i, charts.get(r.label) ?? "")).join("")
  }</table></section>`;
}
