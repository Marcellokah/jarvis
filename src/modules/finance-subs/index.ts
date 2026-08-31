import type { JarvisModule, ModuleContext, ModuleResult, ActionItem } from "../../core/module.ts";
import {
  createSubscriptionRepo, type BillingCycle,
} from "../../infra/db/repositories/subscriptions.ts";
import { daysBetween, isoDate } from "../../shared/dates.ts";

export interface RenewalAlert {
  name: string;
  amountHuf: number;
  cycle: BillingCycle;
  renewsOn: string;
  daysUntil: number;
  cancelUrl: string | null;
  /** No recorded use in a long time — a candidate to drop. */
  unused: boolean;
  daysSinceUse: number | null;
}

export interface FinanceData {
  alerts: RenewalAlert[];
  monthlyTotalHuf: number;
  annualTotalHuf: number;
  unused: { name: string; amountHuf: number; daysSinceUse: number; cancelUrl: string | null }[];
  subscriptionCount: number;
}

export interface FinanceConfig {
  enabled: boolean;
  /** Alert when a renewal is exactly this many days out. */
  alertDaysBefore: readonly number[];
  /** No recorded use in this many days flags it as a cancellation candidate. */
  unusedAfterDays: number;
}

const CYCLE_MONTHS: Record<BillingCycle, number> = { monthly: 1, quarterly: 3, annual: 12 };
const CYCLE_LABEL: Record<BillingCycle, string> = { monthly: "havi", quarterly: "negyedéves", annual: "éves" };

export function financeAndSubs(cfg: FinanceConfig): JarvisModule<FinanceData> {
  return {
    name: "FinanceAndSubs",
    title: "💰 Pénzügy & Előfizetések",
    enabled: cfg.enabled,
    schedule: "daily",

    async execute(ctx: ModuleContext): Promise<ModuleResult<FinanceData> | null> {
      const subs = createSubscriptionRepo(ctx.db).listActive();
      if (subs.length === 0) return null;

      const today = isoDate(ctx.now, ctx.tz);
      const alerts: RenewalAlert[] = [];
      const unused: FinanceData["unused"] = [];
      let monthlyTotal = 0;

      for (const sub of subs) {
        monthlyTotal += sub.amountHuf / CYCLE_MONTHS[sub.cycle];

        const renewsOn = nextOccurrence(sub.nextRenewal, sub.cycle, today);
        const daysUntil = daysBetween(ctx.now, new Date(`${renewsOn}T12:00:00Z`), ctx.tz);
        const daysSinceUse = sub.lastUsedAt
          ? daysBetween(new Date(`${sub.lastUsedAt}T12:00:00Z`), ctx.now, ctx.tz)
          : null;
        const isUnused = daysSinceUse !== null && daysSinceUse >= cfg.unusedAfterDays;

        if (isUnused) {
          unused.push({
            name: sub.name, amountHuf: sub.amountHuf,
            daysSinceUse, cancelUrl: sub.cancelUrl,
          });
        }

        if (cfg.alertDaysBefore.includes(daysUntil)) {
          alerts.push({
            name: sub.name, amountHuf: sub.amountHuf, cycle: sub.cycle,
            renewsOn, daysUntil, cancelUrl: sub.cancelUrl,
            unused: isUnused, daysSinceUse,
          });
        }
      }

      alerts.sort((a, b) => a.daysUntil - b.daysUntil);

      // Nothing renewing and nothing idle: the monthly total on its own is not
      // worth a section every single morning.
      if (alerts.length === 0 && unused.length === 0) return null;

      return {
        data: {
          alerts,
          monthlyTotalHuf: Math.round(monthlyTotal),
          annualTotalHuf: Math.round(monthlyTotal * 12),
          unused,
          subscriptionCount: subs.length,
        },
        actions: buildActions(alerts),
        // A renewal you notice the day after has already taken the money.
        priority: alerts.some((a) => a.daysUntil <= 3) ? "critical" : "normal",
        dedupeKeys: alerts.map((a) => `renewal:${a.name}:${a.renewsOn}`),
      };
    },

    renderPlain(result): string {
      const { alerts, monthlyTotalHuf, unused, subscriptionCount } = result.data;
      const lines: string[] = [];

      if (alerts.length > 0) {
        lines.push("**Közelgő megújulás:**");
        for (const a of alerts) {
          const when = a.daysUntil === 0 ? "MA" : a.daysUntil === 1 ? "holnap" : `${a.daysUntil} nap múlva`;
          const idle = a.unused ? ` — ⚠️ ${a.daysSinceUse} napja nem használtad` : "";
          lines.push(`- **${a.name}** · ${huf(a.amountHuf)} (${CYCLE_LABEL[a.cycle]}) · ${when}${idle}`);
        }
      }

      if (unused.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("**Kihasználatlan:**");
        for (const u of unused) {
          lines.push(`- ${u.name} · ${huf(u.amountHuf)} · ${u.daysSinceUse} napja nem használt`);
        }
      }

      if (lines.length > 0) lines.push("");
      lines.push(`_${subscriptionCount} aktív előfizetés · ${huf(monthlyTotalHuf)}/hó_`);

      return lines.join("\n");
    },

    async healthCheck(ctx) {
      const n = createSubscriptionRepo(ctx.db).count();
      return n > 0
        ? { ok: true, detail: `${n} aktív előfizetés` }
        : { ok: false, detail: "üres subscriptions tábla — futtasd: npm run seed" };
    },
  };
}

function buildActions(alerts: RenewalAlert[]): ActionItem[] {
  const actions: ActionItem[] = [];

  for (const alert of alerts) {
    if (alert.unused && alert.cancelUrl) {
      // Offer a reminder the evening before, while cancelling is still free.
      const remindOn = new Date(`${alert.renewsOn}T00:00:00Z`);
      remindOn.setUTCDate(remindOn.getUTCDate() - 1);
      const day = remindOn.toISOString().slice(0, 10);

      actions.push({
        id: `cancel:${alert.name}:${alert.renewsOn}`,
        kind: "proposal",
        text: `Mondd le: ${alert.name} (${alert.daysSinceUse} napja nem használt, ${huf(alert.amountHuf)})`,
        proposal: {
          title: `Lemondás: ${alert.name}`,
          start: `${day}T18:00:00+02:00`,
          end: `${day}T18:15:00+02:00`,
          notes: `Megújul ${alert.renewsOn}-én, ${huf(alert.amountHuf)}.\n${alert.cancelUrl}`,
        },
      });
    } else if (alert.daysUntil <= 1) {
      actions.push({
        id: `renewal:${alert.name}:${alert.renewsOn}`,
        kind: "checkbox",
        text: `${alert.name} megújul ${alert.daysUntil === 0 ? "ma" : "holnap"} — ${huf(alert.amountHuf)}`,
      });
    }
  }

  return actions;
}

/**
 * Rolls a stored renewal date forward to the next occurrence at or after
 * `today`, so a date entered once in the YAML keeps working for years without
 * anyone editing it.
 */
export function nextOccurrence(stored: string, cycle: BillingCycle, today: string): string {
  const step = CYCLE_MONTHS[cycle];
  const [y, m, d] = stored.split("-").map(Number) as [number, number, number];

  let date = new Date(Date.UTC(y, m - 1, d));
  let guard = 0;
  while (date.toISOString().slice(0, 10) < today && guard++ < 600) {
    // Anchor on the original day-of-month so a month-end date cannot drift
    // forward: 31 Jan + 1 month must be 28 Feb, and then 31 Mar — not 3 Mar.
    const next = new Date(date);
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + step);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(d, lastDay));
    date = next;
  }
  return date.toISOString().slice(0, 10);
}

const huf = (n: number) => `${n.toLocaleString("hu-HU")} Ft`;
