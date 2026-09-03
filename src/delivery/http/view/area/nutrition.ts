import { escapeHtml } from "../../markdown.ts";
import { hu } from "../format.ts";
import { analysisBand, leadBand, seriesBand, type AreaAnalysis, type EarlierAnalysis, type SeriesTile } from "./frame.ts";
import type { PlannedMeal } from "../../../../infra/db/repositories/meals.ts";

export interface NutritionData {
  /** How many days carry a kcal figure — what `actual.kcal`'s mean rests on. */
  measuredDays: number;
  /**
   * How many days carry a protein figure — what `actual.proteinG`'s mean
   * rests on.
   *
   * Kept apart from `measuredDays`: a day can log calories without protein,
   * so the two counts differ, and labelling the protein row with the kcal
   * count would state a sample size the protein mean does not actually rest
   * on — the same failure this page's own `planTotal` comment forbids for
   * the planned row.
   */
  measuredProteinDays: number;
  /** The day the most recent intake was recorded on, or null. */
  lastDate: string | null;
  /** Mean measured intake per day — null where nothing was measured. */
  actual: { kcal: number | null; proteinG: number | null };
  plan: readonly PlannedMeal[];
  tiles: readonly SeriesTile[];
  /** This area's own analysis, or undefined when none has run yet. */
  analysis: AreaAnalysis | undefined;
  /** Earlier `nutrition` analyses, newest first, the current one excluded. */
  earlier: readonly EarlierAnalysis[];
}

const NAPOK = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
const ETKEZESEK: { key: PlannedMeal["meal"]; label: string }[] = [
  { key: "reggeli", label: "Reggeli" },
  { key: "ebed", label: "Ebéd" },
  { key: "vacsora", label: "Vacsora" },
];

/**
 * A day's planned total — or nothing, when any item on it is unpriced.
 *
 * `protein_g` and `kcal` are both nullable. Summing only the items that
 * happen to carry a figure would put a partial number where a day's plan
 * belongs, and a partial number in a total's position reads as the total.
 */
function planTotal(items: readonly PlannedMeal[], key: "kcal" | "proteinG"): number | null {
  if (items.length === 0) return null;
  let sum = 0;
  for (const item of items) {
    const v = item[key];
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

function planTable(plan: readonly PlannedMeal[]): string {
  if (plan.length === 0) {
    return `<section><h2>Heti étrend</h2><p class="halk">Nincs heti étrend.</p></section>`;
  }
  // Weekdays in the order a week is lived, Monday first — the column holds
  // 0..6 with 0 as Sunday, which is the storage order, not the reading order.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const header = `<tr><td></td>${ETKEZESEK.map(({ label }) => `<td>${label}</td>`).join("")}<td class="ev">Összesen</td></tr>`;
  const rows = order.map((weekday, i) => {
    const items = plan.filter((p) => p.weekday === weekday);
    if (items.length === 0) return "";
    const cells = ETKEZESEK.map(({ key }) => {
      const it = items.find((p) => p.meal === key);
      if (it === undefined) return `<td class="halk">—</td>`;
      const defrost = it.needsDefrost
        ? ` <span class="halk">(kiolvasztás ${hu(it.defrostLeadH)} óra)</span>`
        : "";
      return `<td>${escapeHtml(it.item)}${defrost}</td>`;
    }).join("");
    const kcal = planTotal(items, "kcal");
    const protein = planTotal(items, "proteinG");
    const total = kcal === null || protein === null
      ? `<span class="halk">nincs adat</span>`
      : `${hu(kcal)} kcal · ${hu(protein)} g`;
    return `<tr class="live" style="--i:${i}"><td>${escapeHtml(NAPOK[weekday]!)}</td>`
      + `${cells}<td class="ev">${total}</td></tr>`;
  }).join("");
  return `<section><h2>Heti étrend</h2><table>${header}${rows}</table></section>`;
}

/**
 * Plan and reality side by side — two numbers, not a verdict.
 *
 * Reading the comparison is S8's job, once a nutrition analysis exists. This
 * band only puts the planned daily mean next to the measured one and says how
 * many days the measured side rests on.
 *
 * The planned row must disclose its sample size too: a mean over a subset
 * presented under a "weekly plan" label reads as the whole plan's average,
 * which confidently states the wrong number — the class of missing data this
 * page has always refused.
 */
function comparison(d: NutritionData): string {
  let plannedValue: number | null = null;
  let plannedDays = 0;
  if (d.plan.length > 0) {
    const order = [0, 1, 2, 3, 4, 5, 6];
    const totals = order
      .map((w) => planTotal(d.plan.filter((p) => p.weekday === w), "kcal"))
      .filter((v): v is number => v !== null);
    plannedDays = totals.length;
    if (totals.length > 0) {
      plannedValue = totals.reduce((a, b) => a + b, 0) / totals.length;
    }
  }

  const plannedNote = plannedDays === 0
    ? "nincs teljes terv"
    : `a heti étrend ${hu(plannedDays)} teljes napjából`;

  const cell = (v: number | null, unit: string) =>
    v === null ? `<span class="halk">nincs adat</span>` : `${hu(v)}${unit}`;

  return [
    `<section><h2>Terv és valóság</h2><table>`,
    `<tr class="live" style="--i:0"><td>Tervezett napi kalória</td>`,
    `<td class="value">${cell(plannedValue, " kcal")}</td>`,
    `<td class="ev"><span class="note">${plannedNote}</span></td></tr>`,
    `<tr class="${d.actual.kcal === null ? "dead" : "live"}" style="--i:1"><td>Mért napi kalória</td>`,
    `<td class="value">${cell(d.actual.kcal, " kcal")}</td>`,
    `<td class="ev"><span class="note">${hu(d.measuredDays)} mért nap átlaga</span></td></tr>`,
    `<tr class="${d.actual.proteinG === null ? "dead" : "live"}" style="--i:2"><td>Mért napi fehérje</td>`,
    `<td class="value">${cell(d.actual.proteinG, " g")}</td>`,
    `<td class="ev"><span class="note">${hu(d.measuredProteinDays)} mért nap átlaga</span></td></tr>`,
    `</table></section>`,
  ].join("");
}

/**
 * The nutrition area — the same four bands as the other three areas.
 *
 * F3 deliberately shipped this page without an analysis band: no `nutrition`
 * domain existed yet, and an empty band or a "coming soon" note in its place
 * would have been missing data that does not look missing. S8 built that
 * domain, so the requirement F3 deferred is now met, not dropped.
 */
export function nutritionBody(d: NutritionData): string {
  const lead = leadBand({
    label: "Mért napok",
    value: d.measuredDays === 0 ? null : hu(d.measuredDays),
    against: d.lastDate === null
      ? "bevitel rögzítve"
      : `bevitel rögzítve · legutóbb ${d.lastDate}`,
    missing: "nincs mérés",
  });

  return [
    lead,
    seriesBand("Bevitel", d.tiles),
    comparison(d),
    planTable(d.plan),
    analysisBand(d.analysis, d.earlier),
  ].join("");
}
