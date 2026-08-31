import type { JarvisModule, ModuleContext, ModuleResult, ActionItem } from "../../core/module.ts";
import { createMealRepo, type MealSlot, type PlannedMeal } from "../../infra/db/repositories/meals.ts";
import { createHealthRepo, type HealthSnapshot } from "../../infra/db/repositories/health.ts";
import { addDays, dayOfWeek, isoDate } from "../../shared/dates.ts";

/** Nominal meal times, used to work backwards to a defrost deadline. */
const MEAL_TIME: Record<MealSlot, number> = { reggeli: 7, ebed: 12.5, vacsora: 19 };
const MEAL_LABEL: Record<MealSlot, string> = { reggeli: "Reggeli", ebed: "Ebéd", vacsora: "Vacsora" };

export interface DefrostTask {
  item: string;
  meal: MealSlot;
  /** ISO instant by which it must leave the freezer. */
  takeOutBy: string;
  /** Which day the meal itself is on. */
  mealDate: string;
  /** Hours until the meal is served. */
  hoursLeft: number;
  /** The freezer deadline has already passed — take it out now, not later. */
  overdue: boolean;
}

export interface HealthMealData {
  health: (HealthSnapshot & { stale: boolean }) | null;
  readiness: { verdict: "jó" | "közepes" | "gyenge"; reason: string } | null;
  today: PlannedMeal[];
  proteinTargetG: number | null;
  defrost: DefrostTask[];
}

export interface HealthMealConfig {
  enabled: boolean;
  /**
   * How far ahead to look for freezer deadlines. Must cover the gap until the
   * next brief: this is a once-a-day delivery, so anything becoming due before
   * tomorrow morning has to be said today or it is never said at all.
   */
  defrostHorizonH: number;
}

export function healthAndMealPrep(cfg: HealthMealConfig): JarvisModule<HealthMealData> {
  return {
    name: "HealthAndMealPrep",
    title: "🥦 Egészség & Meal Prep",
    enabled: cfg.enabled,
    schedule: "daily",

    async execute(ctx: ModuleContext): Promise<ModuleResult<HealthMealData> | null> {
      const meals = createMealRepo(ctx.db);
      const health = createHealthRepo(ctx.db);
      const today = isoDate(ctx.now, ctx.tz);

      const todaysMeals = meals.forWeekday(dayOfWeek(ctx.now, ctx.tz));
      const snapshot = health.forDate(today) ?? health.latest(today);
      const stale = snapshot !== undefined && snapshot.date !== today;

      const defrost = findDefrostTasks(ctx, meals, cfg.defrostHorizonH);

      // Nothing planned and no health data is a genuinely empty day, not a failure.
      if (todaysMeals.length === 0 && !snapshot && defrost.length === 0) return null;

      const data: HealthMealData = {
        health: snapshot ? { ...snapshot, stale } : null,
        readiness: snapshot && !stale ? assessReadiness(snapshot) : null,
        today: todaysMeals,
        proteinTargetG: sumProtein(todaysMeals),
        defrost,
      };

      const actions: ActionItem[] = defrost.map((task) => ({
        id: `defrost:${task.mealDate}:${task.meal}`,
        kind: "checkbox",
        text: task.overdue
          ? `MOST vedd ki a fagyasztóból: ${task.item} (már csúszik, ${task.hoursLeft} óra múlva kell)`
          : `Vedd ki a fagyasztóból: ${task.item} (${MEAL_LABEL[task.meal].toLowerCase()}, ${task.hoursLeft} óra múlva kell)`,
      }));

      return {
        data,
        actions,
        // A defrost deadline you miss cannot be recovered later in the day.
        priority: defrost.length > 0 ? "critical" : "normal",
      };
    },

    renderPlain(result): string {
      const { health, readiness, today, proteinTargetG, defrost } = result.data;
      const lines: string[] = [];

      if (health) {
        const bits: string[] = [];
        if (health.sleepH != null) bits.push(`alvás ${fmt(health.sleepH)} óra`);
        if (health.hrv != null) bits.push(`HRV ${fmt(health.hrv)} ms`);
        if (health.rhr != null) bits.push(`nyugalmi pulzus ${fmt(health.rhr)}`);
        if (health.exerciseMin != null) bits.push(`edzés ${fmt(health.exerciseMin)} perc`);
        if (bits.length > 0) {
          lines.push(`**Tegnap:** ${bits.join(" · ")}${health.stale ? ` _(${health.date} adata)_` : ""}`);
        }
        if (readiness) lines.push(`**Regeneráció:** ${readiness.verdict} — ${readiness.reason}`);
      } else {
        lines.push("_Nincs friss Apple Watch adat._");
      }

      if (today.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("**Mai étkezések:**");
        for (const meal of today) {
          const macros = meal.proteinG != null ? ` _(${meal.proteinG} g fehérje)_` : "";
          lines.push(`- ${MEAL_LABEL[meal.meal]}: ${meal.item}${macros}`);
        }
        if (proteinTargetG != null) lines.push(`- Napi fehérje terv: **${proteinTargetG} g**`);
      }

      if (defrost.length > 0) {
        lines.push("");
        lines.push(
          defrost.length === 1
            ? "**Kiolvasztás ma:**"
            : `**Kiolvasztás ma (${defrost.length} tétel):**`,
        );
        for (const task of defrost) {
          const when = `${task.hoursLeft} óra múlva kell (${MEAL_LABEL[task.meal].toLowerCase()})`;
          lines.push(
            task.overdue
              ? `- **${task.item}** — ${when}, a kiolvasztás már csúszik`
              : `- ${task.item} — ${when}`,
          );
        }
      }

      return lines.join("\n");
    },

    async healthCheck(ctx) {
      const count = createMealRepo(ctx.db).count();
      return count > 0
        ? { ok: true, detail: `${count} tervezett étkezés` }
        : { ok: false, detail: "üres meal_plan tábla — futtasd: npm run seed" };
    },
  };
}

/**
 * Every freezer deadline that lands before the next morning brief, plus any
 * already overdue whose meal has not happened yet.
 *
 * Dropping overdue tasks was the original mistake: a 12-hour lead time on a
 * 12:30 lunch means the deadline was 00:30 that morning, so the one reminder
 * that actually matters is the one arriving late.
 */
function findDefrostTasks(
  ctx: ModuleContext,
  meals: ReturnType<typeof createMealRepo>,
  horizonH: number,
): DefrostTask[] {
  const tasks: DefrostTask[] = [];
  const nowMs = ctx.now.getTime();
  const horizonMs = nowMs + horizonH * 3_600_000;

  // Three days is enough for any sane lead time to reach back into today.
  for (const dayOffset of [0, 1, 2, 3]) {
    const day = addDays(ctx.now, dayOffset);
    const date = isoDate(day, ctx.tz);

    for (const meal of meals.forWeekday(dayOfWeek(day, ctx.tz))) {
      if (!meal.needsDefrost) continue;

      const mealAt = localInstant(date, MEAL_TIME[meal.meal], ctx.tz);
      // The meal is over; nothing to take out for it any more.
      if (mealAt.getTime() <= nowMs) continue;

      const takeOutBy = new Date(mealAt.getTime() - meal.defrostLeadH * 3_600_000);
      // Still far enough out that the next brief will catch it in time.
      if (takeOutBy.getTime() > horizonMs) continue;

      tasks.push({
        item: meal.item,
        meal: meal.meal,
        takeOutBy: takeOutBy.toISOString(),
        mealDate: date,
        hoursLeft: Math.max(0, Math.round((mealAt.getTime() - nowMs) / 3_600_000)),
        overdue: takeOutBy.getTime() < nowMs,
      });
    }
  }

  // Overdue first, then by how soon the deadline bites.
  return tasks.sort((a, b) =>
    Number(b.overdue) - Number(a.overdue) || Date.parse(a.takeOutBy) - Date.parse(b.takeOutBy),
  );
}

/** Turns 'YYYY-MM-DD' + a local hour into a real instant, honouring DST. */
function localInstant(date: string, hour: number, tz: string): Date {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const naive = Date.parse(`${date}T${pad(h)}:${pad(m)}:00Z`);
  // Ask what UTC-clock time that wall-clock reading corresponds to in `tz`.
  const offsetMs = tzOffsetMs(new Date(naive), tz);
  return new Date(naive - offsetMs);
}

function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - at.getTime();
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function sumProtein(meals: PlannedMeal[]): number | null {
  const values = meals.map((m) => m.proteinG).filter((v): v is number => v != null);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
}

/**
 * Deliberately a transparent rule, not a model. You can read it, argue with it,
 * and change the thresholds. Baseline-relative scoring lands in Phase 2.
 */
function assessReadiness(s: HealthSnapshot): { verdict: "jó" | "közepes" | "gyenge"; reason: string } {
  const sleep = s.sleepH;
  if (sleep == null) return { verdict: "közepes", reason: "nincs alvás adat" };
  if (sleep >= 7.5) return { verdict: "jó", reason: `${fmt(sleep)} óra alvás — mehet a nehéz edzés` };
  if (sleep >= 6) return { verdict: "közepes", reason: `${fmt(sleep)} óra alvás — normál terhelés` };
  return { verdict: "gyenge", reason: `${fmt(sleep)} óra alvás — ma inkább könnyű mozgás` };
}
