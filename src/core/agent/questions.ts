import type { HealthRepo, HealthSnapshot } from "../../infra/db/repositories/health.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { CalendarService } from "../../infra/calendar/service.ts";
import { shiftDay, dayGap, type Point } from "../analysis/stats.ts";
import { annotate, baselineFor } from "./annotate.ts";

/**
 * The closed menu.
 *
 * The model never writes SQL. It picks one of these by name, with arguments,
 * and the code runs it. Two reasons, both measured rather than assumed: the
 * step choice is already reliable in a small model, so free tool access buys
 * nothing where it would cost safety; and a closed set is testable one entry
 * at a time, against real data.
 */
export const METRICS = {
  alvas: "sleepH", hrv: "hrv", nyugalmi_pulzus: "rhr", lepes: "steps",
  edzesperc: "exerciseMin", melyalvas: "deepMin", rem: "remMin",
  ebredes: "awakenings", vo2max: "vo2max",
} as const;

export type MetricName = keyof typeof METRICS;

export interface QuestionContext {
  health: HealthRepo;
  workouts: WorkoutRepo;
  calendar: CalendarService;
  /** The day the investigation is anchored to; "today" for every relative window. */
  today: string;
}

export type QuestionName =
  | "elteresek" | "nap" | "napok" | "hasonlo_napok" | "mi_lett_utana"
  | "ritmus" | "naptar" | "edzesek" | "lefedettseg";

export interface Question {
  /** One menu line, as the model reads it. */
  usage: string;
  run(args: Record<string, unknown>, ctx: QuestionContext): Promise<string>;
}

/** A whole range in one step is capped: one observation must not fill the context. */
export const MAX_RANGE_DAYS = 60;

const HISTORY_START = "1970-01-01";

export function metricOf(args: Record<string, unknown>): MetricName | null {
  const raw = String(args.mutato ?? "");
  return raw in METRICS ? raw as MetricName : null;
}

export function seriesOf(ctx: QuestionContext, metric: MetricName, from: string, to: string): Point[] {
  return ctx.health.between(from, to)
    .map((s) => ({ date: s.date, value: s[METRICS[metric]] as number | null }))
    .filter((p): p is Point => p.value !== null);
}

/** Every measured field of one day, each carrying its distance from its own baseline. */
function describeDay(ctx: QuestionContext, snapshot: HealthSnapshot): string {
  const bits: string[] = [];
  for (const name of Object.keys(METRICS) as MetricName[]) {
    const value = snapshot[METRICS[name]] as number | null;
    if (value === null) continue;
    const base = baselineFor(seriesOf(ctx, name, HISTORY_START, ctx.today), ctx.today, 90);
    bits.push(`${name}=${annotate(value, base)}`);
  }
  return bits.join(" ") || "a sor létezik, de minden mezője üres";
}

export const QUESTIONS: Record<QuestionName, Question> = {
  nap: {
    usage: "nap(datum) — egy nap teljes képe, minden mérés a saját alapvonalához viszonyítva",
    async run(args, ctx) {
      const date = String(args.datum ?? "");
      const snapshot = ctx.health.forDate(date);
      if (!snapshot) return `${date}: nincs sor az adatbázisban`;
      const workouts = ctx.workouts.forDate(date);
      return `${date}: ${describeDay(ctx, snapshot)}\n`
        + `  edzés: ${workouts.length
          ? workouts.map((w) => `${w.type} ${Math.round(w.durationMin)} perc`).join(", ")
          : "nincs"}`;
    },
  },

  napok: {
    usage: `napok(tol, ig) — egy tartomány egyben, legfeljebb ${MAX_RANGE_DAYS} nap`,
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      if (dayGap(from, to) > MAX_RANGE_DAYS) {
        return `a tartomány túl hosszú — egy lépés legfeljebb ${MAX_RANGE_DAYS} nap`;
      }
      const rows = ctx.health.between(from, to);
      if (rows.length === 0) return `${from} → ${to}: nincs egyetlen sor sem`;
      return rows.map((s) => {
        const workouts = ctx.workouts.forDate(s.date);
        const bits = (Object.keys(METRICS) as MetricName[])
          .map((n) => [n, s[METRICS[n]] as number | null] as const)
          .filter(([, v]) => v !== null)
          .map(([n, v]) => `${n}=${v}`);
        return `  ${s.date}  ${bits.join(" ") || "üres"}  edzés=${workouts.length}`;
      }).join("\n");
    },
  },

  lefedettseg: {
    usage: "lefedettseg(mutato) — hány mérés van, mikortól, és hol vannak szünetek",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);

      const all = seriesOf(ctx, metric, HISTORY_START, ctx.today);
      if (all.length === 0) return `${metric}: soha nem mért`;

      const dates = all.map((p) => p.date);
      const last90 = dates.filter((d) => d >= shiftDay(ctx.today, -89));

      // The run and the gap before it, not just the counts.
      //
      // Counts alone cannot show that a metric started being measured four
      // days ago after a four-month silence -- and in the measurement that
      // produced this plan, that break WAS the answer to "why is today's
      // reading unlike every earlier one". Without it the model is left to
      // invent a physiological story.
      let runStart = dates.at(-1)!;
      for (let i = dates.length - 1; i > 0; i--) {
        if (shiftDay(dates[i]!, -1) !== dates[i - 1]) break;
        runStart = dates[i - 1]!;
      }
      const beforeRun = dates.filter((d) => d < runStart).at(-1);

      const byYear = new Map<string, number>();
      for (const d of dates) byYear.set(d.slice(0, 4), (byYear.get(d.slice(0, 4)) ?? 0) + 1);

      return `${metric}: ${all.length} mérés, ${dates[0]} → ${dates.at(-1)}\n`
        + `  utolsó 90 nap: ${last90.length} mérés\n`
        + `  évenként: ${[...byYear].map(([y, n]) => `${y}=${n}`).join(" ")}\n`
        + `  a jelenlegi megszakítatlan sorozat kezdete: ${runStart}`
        + (beforeRun ? `; az azt megelőző utolsó mérés: ${beforeRun}` : "; előtte semmi");
    },
  },

  // Filled in by Task 4.
  elteresek: notYet("elteresek"),
  hasonlo_napok: notYet("hasonlo_napok"),
  mi_lett_utana: notYet("mi_lett_utana"),
  ritmus: notYet("ritmus"),
  // Filled in by Task 5.
  naptar: notYet("naptar"),
  edzesek: notYet("edzesek"),
};

function notYet(name: string): Question {
  return {
    usage: `${name} — még nincs implementálva`,
    async run() { return `${name}: még nincs implementálva`; },
  };
}

function unknownMetric(args: Record<string, unknown>): string {
  return `ismeretlen mutató "${String(args.mutato)}" — válassz ezek közül: ${Object.keys(METRICS).join(", ")}`;
}

/** The menu as the model reads it. Built from the questions themselves so the two cannot drift. */
export const MENU_TEXT: string =
  (Object.keys(QUESTIONS) as QuestionName[]).map((n) => QUESTIONS[n].usage).join("\n");

/**
 * Runs one question. An unknown name or a bad argument returns text, never
 * throws: the loop feeds it back as an observation and the model can correct
 * itself. A thrown error would end an investigation over a typo.
 */
export async function runQuestion(
  name: string, args: Record<string, unknown>, ctx: QuestionContext,
): Promise<string> {
  const question = (QUESTIONS as Record<string, Question | undefined>)[name];
  if (!question) {
    return `ismeretlen kérdés "${name}" — válassz a menüből: ${Object.keys(QUESTIONS).join(", ")}`;
  }
  try {
    return await question.run(args, ctx);
  } catch (err) {
    return `a kérdés hibára futott: ${err instanceof Error ? err.message : String(err)}`;
  }
}
