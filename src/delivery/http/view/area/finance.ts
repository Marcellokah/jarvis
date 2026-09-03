import { escapeHtml } from "../../markdown.ts";
import { hu, huFt } from "../format.ts";
import { analysisBand, leadBand, type AreaAnalysis } from "./frame.ts";
import { bars, type BarRow } from "../chart/bars.ts";
import type { Subscription } from "../../../../infra/db/repositories/subscriptions.ts";

export interface FinanceData {
  months: readonly { month: string; totalHuf: number; activeCount: number }[];
  monthOverMonth: {
    from: string; to: string; deltaHuf: number;
    changes: readonly { name: string; fromHuf: number | null; toHuf: number | null }[];
  } | null;
  /** The latest month × 12, or null below `minMonths` recorded months. */
  annualisedHuf: number | null;
  minMonths: number;
  subscriptions: readonly Subscription[];
  /** Today, so the view can say "in N days" without reading a clock itself. */
  today: string;
  analysis: AreaAnalysis | undefined;
}

const FORINT = { label: "Havi teher", format: (v: number) => huFt(v) };

const CIKLUS: Record<string, string> = {
  monthly: "havi", quarterly: "negyedéves", annual: "éves",
};

/** Whole days between two ISO dates, positive when `to` is in the future. */
function daysUntil(today: string, to: string): number | null {
  const a = Date.parse(`${today}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function renewalCell(today: string, next: string): string {
  const days = daysUntil(today, next);
  if (days === null) return `<span class="halk">nincs adat</span>`;
  const when = days < 0 ? `${hu(-days)} napja` : `${hu(days)} nap múlva`;
  return `${escapeHtml(next)} <span class="halk">(${when})</span>`;
}

function subTable(d: FinanceData): string {
  if (d.subscriptions.length === 0) {
    return `<section><h2>Előfizetések</h2>`
      + `<p class="halk">Nincs rögzített előfizetés.</p></section>`;
  }
  const body = d.subscriptions.map((s, i) => [
    `<tr class="${s.active ? "live" : "dead"}" style="--i:${i}">`,
    `<td>${escapeHtml(s.name)}`,
    s.category ? ` <span class="halk">${escapeHtml(s.category)}</span>` : "",
    `</td>`,
    `<td class="value">${huFt(s.amountHuf)}</td>`,
    `<td class="ev"><span class="note">${escapeHtml(CIKLUS[s.cycle] ?? s.cycle)}</span></td>`,
    `<td class="ev">${renewalCell(d.today, s.nextRenewal)}</td>`,
    // "nincs adat", never "soha": the field is only written when something
    // records a use, so its absence says nothing about whether the service
    // was used.
    `<td class="ev">${s.lastUsedAt === null
      ? `<span class="halk">nincs adat</span>`
      : escapeHtml(s.lastUsedAt.slice(0, 10))}</td>`,
    "</tr>",
  ].join("")).join("");
  return `<section><h2>Előfizetések</h2><table>${body}</table></section>`;
}

export function financeBody(d: FinanceData): string {
  const latest = d.months.at(-1);
  const delta = d.monthOverMonth === null
    ? "hónapról hónapra nincs mihez mérni"
    : `${d.monthOverMonth.deltaHuf === 0 ? "változatlan" : `${d.monthOverMonth.deltaHuf > 0 ? "+" : ""}${huFt(d.monthOverMonth.deltaHuf)}`}`
      + ` ${d.monthOverMonth.from} óta`;

  const lead = leadBand({
    label: "Havi teher",
    value: latest === undefined ? null : huFt(latest.totalHuf),
    against: latest === undefined ? "rögzített előfizetési hónap" : delta,
    missing: "nincs rögzített hónap",
  });

  // Only the recorded months. A month before the record began is not a zero
  // column — it is not on the chart at all, which is why the rows carry real
  // numbers and never a null: the caller has nothing to put there.
  const monthRows: BarRow[] = d.months.map((m) => ({ label: m.month, value: m.totalHuf }));
  const chart = d.months.length === 0
    ? ""
    : `<section><h2>Havi teher</h2>${bars(monthRows, FORINT)}</section>`;

  // The threshold is not a formatting choice: multiplying one observed month
  // by twelve turns a month of evidence into a year of spending. Below it the
  // honest answer is that there is not yet enough history to project from.
  const annual = `<section><h2>Évesített teher</h2><p class="${d.annualisedHuf === null ? "halk" : ""}">`
    + (d.annualisedHuf === null
      ? `nincs elég hónap az évesítéshez (${hu(d.months.length)} a ${hu(d.minMonths)}-ból)`
      : escapeHtml(huFt(d.annualisedHuf)))
    + "</p></section>";

  return [lead, chart, subTable(d), annual, analysisBand(d.analysis, [])].join("");
}
