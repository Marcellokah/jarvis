import type { HealthRepo, HealthSnapshot } from "../../infra/db/repositories/health.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { CalendarService } from "../../infra/calendar/service.ts";
import { mean, stdDev, shiftDay, dayGap, type Point } from "../analysis/stats.ts";
import { annotate, baselineFor, hu } from "./annotate.ts";

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

/**
 * The floor under every bucketed average.
 *
 * During the measurement the weekday breakdown printed "szombat: 4.4 (n=2)"
 * -- a mean of two nights, formatted exactly like a mean of thirty. The
 * system already carries floors for this elsewhere (`MIN_N7`/`MIN_N90` in
 * notify/candidates.ts, `config.analysis.minCorrelationN`); a question that
 * feeds a model has no business being looser than a threshold that merely
 * decides whether to send a push.
 */
export const MIN_BUCKET_N = 5;

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
          .map(([n, v]) => `${n}=${hu(v!)}`);
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

  elteresek: {
    usage: "elteresek(mutato, ablak_nap) — mely napok lógnak ki az ablakban, szórásban kifejezve",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);
      const window = Number(args.ablak_nap ?? 90);
      const points = seriesOf(ctx, metric, shiftDay(ctx.today, -(window - 1)), ctx.today);
      if (points.length < MIN_BUCKET_N) {
        return `${metric}: nincs elég mérés az ablakban (n=${points.length}, kell ${MIN_BUCKET_N})`;
      }
      const values = points.map((p) => p.value);
      const m = mean(values)!;
      const sd = stdDev(values);
      if (sd === null || sd === 0) return `${metric}: minden érték azonos, nincs eltérés`;

      const out = points
        .map((p) => ({ ...p, z: (p.value - m) / sd }))
        .filter((p) => Math.abs(p.z) >= 1.5)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
        .slice(0, 12);

      const head = `${metric}: átlag ${hu(m)}, szórás ${hu(sd)}, n=${points.length}`;
      return out.length === 0
        ? `${head}\n  nincs kiugró nap 1,5 szóráson túl`
        : `${head}\n` + out.map((p) =>
            `  ${p.date}  ${hu(p.value)}  ${p.z >= 0 ? "+" : "−"}${hu(Math.abs(p.z))}σ`).join("\n");
    },
  },

  hasonlo_napok: {
    usage: "hasonlo_napok(datum, mutato, k) — a k legközelebbi nap ugyanabban a mutatóban",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);
      const date = String(args.datum ?? "");
      const k = boundedInt(args, "k", 5, 1, 20);
      if (typeof k === "string") return k;

      const anchor = ctx.health.forDate(date)?.[METRICS[metric]] as number | null | undefined;
      if (anchor === null || anchor === undefined) {
        return `${date}: nincs ${metric} érték, amihez hasonlítani lehetne`;
      }
      const others = seriesOf(ctx, metric, HISTORY_START, ctx.today).filter((p) => p.date !== date);
      if (others.length === 0) return `nincs másik nap ${metric} méréssel`;

      return others
        .map((p) => ({ ...p, gap: Math.abs(p.value - anchor) }))
        .sort((a, b) => a.gap - b.gap)
        .slice(0, k)
        .map((p) => `  ${p.date}  ${metric}=${hu(p.value)}`)
        .join("\n");
    },
  },

  mi_lett_utana: {
    usage: "mi_lett_utana(datum, napok) — a rákövetkező napok kimenetei",
    async run(args, ctx) {
      const date = String(args.datum ?? "");
      const days = boundedInt(args, "napok", 3, 1, 14);
      if (typeof days === "string") return days;
      const rows: string[] = [];
      for (let i = 1; i <= days; i++) {
        const day = shiftDay(date, i);
        const snapshot = ctx.health.forDate(day);
        if (!snapshot) { rows.push(`  ${day}  nincs adat`); continue; }
        const workouts = ctx.workouts.forDate(day);
        const bits = (Object.keys(METRICS) as MetricName[])
          .map((n) => [n, snapshot[METRICS[n]] as number | null] as const)
          .filter(([, v]) => v !== null)
          .map(([n, v]) => `${n}=${hu(v!)}`);
        rows.push(`  ${day}  ${bits.join(" ") || "üres"}  edzés=${workouts.length}`);
      }
      return rows.join("\n");
    },
  },

  ritmus: {
    usage: "ritmus(mutato, bontas) — átlag a hét napjai (\"hetnap\") vagy hónapok (\"honap\") szerint",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);
      const by = String(args.bontas ?? "hetnap");
      if (by !== "hetnap" && by !== "honap") {
        return `ismeretlen bontás "${by}" — hetnap vagy honap`;
      }
      const points = seriesOf(ctx, metric, shiftDay(ctx.today, -364), ctx.today);
      if (points.length === 0) return `${metric}: nincs mérés az elmúlt évben`;

      const names = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
      const buckets = new Map<string, number[]>();
      for (const p of points) {
        const key = by === "honap"
          ? p.date.slice(0, 7)
          : names[new Date(`${p.date}T12:00:00Z`).getUTCDay()]!;
        const list = buckets.get(key) ?? [];
        list.push(p.value);
        buckets.set(key, list);
      }

      // A thin bucket is named, not averaged. A mean of two nights formatted
      // like a mean of thirty is the most quietly misleading thing this
      // question could produce.
      return [...buckets].map(([key, values]) => values.length < MIN_BUCKET_N
        ? `  ${key}: kevés mérés (n=${values.length}, kell ${MIN_BUCKET_N})`
        : `  ${key}: ${hu(mean(values)!)} (n=${values.length})`).join("\n");
    },
  },

  edzesek: {
    usage: "edzesek(tol, ig) — edzések egy tartományban: típus, hossz",
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      const rows = ctx.workouts.between(from, to);
      if (rows.length === 0) return `${from} → ${to}: nincs edzés`;
      return rows.slice(0, 40)
        .map((w) => `  ${w.date}  ${w.type}  ${Math.round(w.durationMin)} perc`)
        .join("\n");
    },
  },

  naptar: {
    usage: "naptar(tol, ig) — naptári események egy tartományban",
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      // An unconfigured calendar reads as empty, and "no events" is a very
      // different claim from "no calendar". Saying which one it is stops the
      // model concluding the owner had a free day.
      let events;
      try {
        events = await ctx.calendar.listEvents(new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`));
      } catch (err) {
        return `a naptár nincs bekötve: ${err instanceof Error ? err.message : String(err)}`;
      }
      // healthCheck only on the empty result, not on every call: an
      // unconfigured calendar returns [] without throwing, so emptiness is
      // the only case that is ambiguous — and on a working CalDAV account
      // this would otherwise be a second network round trip every step.
      if (events.length === 0) {
        const check = await ctx.calendar.healthCheck();
        return check.ok
          ? `${from} → ${to}: nincs esemény`
          : `a naptár nincs bekötve: ${check.detail ?? "ismeretlen ok"}`;
      }
      return events.slice(0, 40)
        .map((e) => `  ${e.start.slice(0, 16).replace("T", " ")}  ${e.title}`)
        .join("\n");
    },
  },
};

function unknownMetric(args: Record<string, unknown>): string {
  return `ismeretlen mutató "${String(args.mutato)}" — válassz ezek közül: ${Object.keys(METRICS).join(", ")}`;
}

/**
 * A bounded integer argument, or the text that says why it is not one.
 *
 * `Number("sok")` is NaN, and NaN silently survives every clamp — reaching
 * `slice(0, NaN)` and `i <= NaN`, both of which yield nothing. An empty
 * observation reads to the model as "no data" rather than "bad argument",
 * which is the one thing every question here must never do.
 */
function boundedInt(
  args: Record<string, unknown>, key: string, fallback: number, min: number, max: number,
): number | string {
  const raw = args[key];
  if (raw === undefined) return fallback;
  // `Number(null)` is 0 -- a silently "valid" number that hides a value the
  // model plainly did not omit -- so null is refused explicitly rather than
  // handed to Number() alongside every other missing-value case.
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    return `érvénytelen "${key}" argumentum: "${String(raw)}" — egész szám kell, ${min} és ${max} között`;
  }
  return Math.min(Math.max(Math.trunc(n), min), max);
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
