import type { HealthRepo, HealthSnapshot } from "../../infra/db/repositories/health.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { CalendarService } from "../../infra/calendar/service.ts";
import { mean, stdDev, shiftDay, dayGap, type Point } from "../analysis/stats.ts";
import { annotate, baselineFor, hu, type Baseline } from "./annotate.ts";
import { isoTime, TZ } from "../../shared/dates.ts";

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

/**
 * An observation, and whether it is evidence.
 *
 * The falsification gate used to check only the NAME of the step a finding
 * cited. A name is not a result: `elteresek({mutato: "nincs_ilyen"})` and
 * `nap({datum: "1999-01-01"})` are both real questions from the closed menu,
 * both come back having read nothing, and both used to unlock a finding.
 *
 * The line is not "is the string non-empty" but "did this observation
 * constrain the world?". A question that read 41 nights and found none of
 * them unusual constrains it; a question that could not find a metric, a
 * row, a calendar or a usable argument does not.
 */
export interface QuestionResult {
  observation: string;
  evidence: boolean;
}

/** The question read measurements: this answer can test a claim. */
const evidence = (observation: string): QuestionResult => ({ observation, evidence: true });

/**
 * The question found nothing to read: this answer can test nothing.
 *
 * Every absence-of-data, unusable-argument and missing-instrument path goes
 * through here, and the gate refuses a `cafolat` that names one.
 */
const nothing = (observation: string): QuestionResult => ({ observation, evidence: false });

export interface Question {
  /** One menu line, as the model reads it. */
  usage: string;
  run(args: Record<string, unknown>, ctx: QuestionContext): Promise<QuestionResult>;
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

/** How many outliers `elteresek` prints before it says how many it left out. */
const MAX_OUTLIERS = 12;

const HISTORY_START = "1970-01-01";

/**
 * Convert a local date string to a UTC Date at local midnight.
 *
 * Without timezone correction, querying for "2026-09-04" uses UTC midnight,
 * which in Budapest (UTC+2 in summer, UTC+1 in winter) is actually 02:00 or
 * 01:00 local time. This silently drops events between local 00:00 and the
 * UTC boundary, and pulls in events from the next day. The model then gets
 * wrong answers about what was in the calendar.
 */
function localDateToUTC(dateStr: string, tz: string = TZ): Date {
  // Start with UTC midnight of the date string.
  let utcDate = new Date(`${dateStr}T00:00:00Z`);

  // Check what local time this UTC instant represents in the target timezone.
  const localTime = isoTime(utcDate, tz);

  // If it's not 00:00 local, calculate the offset and adjust back to get
  // the UTC instant that actually represents local midnight.
  if (localTime !== "00:00") {
    const parts = localTime.split(":");
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const offsetMs = (hours * 60 + minutes) * 60 * 1000;
    utcDate = new Date(utcDate.getTime() - offsetMs);
  }

  return utcDate;
}

export function metricOf(args: Record<string, unknown>): MetricName | null {
  const raw = String(args.mutato ?? "");
  return raw in METRICS ? raw as MetricName : null;
}

export function seriesOf(ctx: QuestionContext, metric: MetricName, from: string, to: string): Point[] {
  return ctx.health.between(from, to)
    .map((s) => ({ date: s.date, value: s[METRICS[metric]] as number | null }))
    .filter((p): p is Point => p.value !== null);
}

/**
 * One 90-day baseline per metric, computed once for a whole question.
 *
 * The baseline is "the last 90 days ending today" — it does not depend on
 * which day is being rendered — so a range question computes this once and
 * annotates every day against it. That is what makes annotating a 60-day
 * range affordable: nine history reads for the whole answer, not nine per
 * day.
 */
function baselines(ctx: QuestionContext): Record<MetricName, Baseline | null> {
  const out = {} as Record<MetricName, Baseline | null>;
  for (const name of Object.keys(METRICS) as MetricName[]) {
    out[name] = baselineFor(seriesOf(ctx, name, HISTORY_START, ctx.today), ctx.today, 90);
  }
  return out;
}

/**
 * Every measured field of one day, each carrying its distance from its own
 * baseline. `null` when the row exists but holds no measurement at all.
 */
function describeDay(
  snapshot: HealthSnapshot, bases: Record<MetricName, Baseline | null>,
): string | null {
  const bits: string[] = [];
  for (const name of Object.keys(METRICS) as MetricName[]) {
    const value = snapshot[METRICS[name]] as number | null;
    if (value === null) continue;
    bits.push(`${name}=${annotate(value, bases[name])}`);
  }
  return bits.length > 0 ? bits.join(" ") : null;
}

export const QUESTIONS: Record<QuestionName, Question> = {
  nap: {
    usage: "nap(datum) — egy nap teljes képe, minden mérés a saját alapvonalához viszonyítva",
    async run(args, ctx) {
      const date = String(args.datum ?? "");
      const snapshot = ctx.health.forDate(date);
      // No row is the absence of a measurement, not a measurement of absence:
      // nothing here distinguishes "that day was not lived" from "the import
      // never ran", so it cannot test a claim.
      if (!snapshot) return nothing(`${date}: nincs sor az adatbázisban`);
      const workouts = ctx.workouts.forDate(date);
      const measured = describeDay(snapshot, baselines(ctx));
      const text = `${date}: ${measured ?? "a sor létezik, de minden mezője üres"}\n`
        + `  edzés: ${workouts.length
          ? workouts.map((w) => `${w.type} ${Math.round(w.durationMin)} perc`).join(", ")
          : "nincs"}`;
      return measured === null && workouts.length === 0 ? nothing(text) : evidence(text);
    },
  },

  napok: {
    usage: `napok(tol, ig) — egy tartomány egyben, legfeljebb ${MAX_RANGE_DAYS} nap`,
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      if (dayGap(from, to) > MAX_RANGE_DAYS) {
        // The range was refused before it was read: nothing was measured.
        return nothing(`a tartomány túl hosszú — egy lépés legfeljebb ${MAX_RANGE_DAYS} nap`);
      }
      const rows = ctx.health.between(from, to);
      if (rows.length === 0) return nothing(`${from} → ${to}: nincs egyetlen sor sem`);
      // Annotated, not bare. This is the question the ten-step budget nudges
      // the model towards, and printing the +9,7σ all-time maximum as a plain
      // "hrv=203,6" is precisely the failure the annotation defence exists to
      // stop -- the measured one, where a 9B model read that number and wrote
      // "HRV normális".
      const bases = baselines(ctx);
      return evidence(rows.map((s) => {
        const workouts = ctx.workouts.forDate(s.date);
        return `  ${s.date}  ${describeDay(s, bases) ?? "üres"}  edzés=${workouts.length}`;
      }).join("\n"));
    },
  },

  lefedettseg: {
    usage: "lefedettseg(mutato) — hány mérés van, mikortól, és hol vannak szünetek",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return nothing(unknownMetric(args));

      const all = seriesOf(ctx, metric, HISTORY_START, ctx.today);
      if (all.length === 0) return nothing(`${metric}: soha nem mért`);

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

      return evidence(`${metric}: ${all.length} mérés, ${dates[0]} → ${dates.at(-1)}\n`
        + `  utolsó 90 nap: ${last90.length} mérés\n`
        + `  évenként: ${[...byYear].map(([y, n]) => `${y}=${n}`).join(" ")}\n`
        + `  a jelenlegi megszakítatlan sorozat kezdete: ${runStart}`
        + (beforeRun ? `; az azt megelőző utolsó mérés: ${beforeRun}` : "; előtte semmi"));
    },
  },

  elteresek: {
    usage: "elteresek(mutato, ablak_nap) — mely napok lógnak ki az ablakban, szórásban kifejezve",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return nothing(unknownMetric(args));
      const window = Number(args.ablak_nap ?? 90);
      const points = seriesOf(ctx, metric, shiftDay(ctx.today, -(window - 1)), ctx.today);
      if (points.length < MIN_BUCKET_N) {
        return nothing(
          `${metric}: nincs elég mérés az ablakban (n=${points.length}, kell ${MIN_BUCKET_N})`);
      }
      const values = points.map((p) => p.value);
      const m = mean(values)!;
      const sd = stdDev(values);
      // Evidence, not an empty answer: `stdDev` only returns null below two
      // points, which the floor above already excluded, so this branch means
      // n>=5 readings were taken and every one of them was identical. That is
      // a measured fact about the metric, and a strong one.
      if (sd === null || sd === 0) return evidence(`${metric}: minden érték azonos, nincs eltérés`);

      const outliers = points
        .map((p) => ({ ...p, z: (p.value - m) / sd }))
        .filter((p) => Math.abs(p.z) >= 1.5)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      const shown = outliers.slice(0, MAX_OUTLIERS);

      const head = `${metric}: átlag ${hu(m)}, szórás ${hu(sd)}, n=${points.length}`;
      // "Nothing stands out" is evidence: the window WAS read, and every day
      // in it was ordinary. That is exactly the answer that can kill a claim
      // about an anomaly.
      if (shown.length === 0) return evidence(`${head}\n  nincs kiugró nap 1,5 szóráson túl`);
      const lines = shown.map((p) =>
        `  ${p.date}  ${hu(p.value)}  ${p.z >= 0 ? "+" : "−"}${hu(Math.abs(p.z))}σ`).join("\n");
      // Same honesty rule `edzesek` and `naptar` already follow: a list cut
      // short without saying so reads as a complete one.
      return evidence(shown.length < outliers.length
        ? `${head}\n${lines}\n… és még ${outliers.length - shown.length} kiugró nap az ablakban`
        : `${head}\n${lines}`);
    },
  },

  hasonlo_napok: {
    usage: "hasonlo_napok(datum, mutato, k) — a k legközelebbi nap ugyanabban a mutatóban",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return nothing(unknownMetric(args));
      const date = String(args.datum ?? "");
      const k = boundedInt(args, "k", 5, 1, 20);
      if (typeof k === "string") return nothing(k);

      const anchor = ctx.health.forDate(date)?.[METRICS[metric]] as number | null | undefined;
      if (anchor === null || anchor === undefined) {
        return nothing(`${date}: nincs ${metric} érték, amihez hasonlítani lehetne`);
      }
      const others = seriesOf(ctx, metric, HISTORY_START, ctx.today).filter((p) => p.date !== date);
      if (others.length === 0) return nothing(`nincs másik nap ${metric} méréssel`);

      // One baseline for the one metric, so the nearest days arrive carrying
      // their own distance from it. Without it this question answers "which
      // days were similar" with bare numbers -- and a cluster of bare numbers
      // around an extreme reads as a cluster of ordinary days.
      const base = baselineFor(seriesOf(ctx, metric, HISTORY_START, ctx.today), ctx.today, 90);
      return evidence(others
        .map((p) => ({ ...p, gap: Math.abs(p.value - anchor) }))
        .sort((a, b) => a.gap - b.gap)
        .slice(0, k)
        .map((p) => `  ${p.date}  ${metric}=${annotate(p.value, base)}`)
        .join("\n"));
    },
  },

  mi_lett_utana: {
    usage: "mi_lett_utana(datum, napok) — a rákövetkező napok kimenetei",
    async run(args, ctx) {
      const date = String(args.datum ?? "");
      const days = boundedInt(args, "napok", 3, 1, 14);
      if (typeof days === "string") return nothing(days);
      const bases = baselines(ctx);
      const rows: string[] = [];
      let measured = 0;
      for (let i = 1; i <= days; i++) {
        const day = shiftDay(date, i);
        const snapshot = ctx.health.forDate(day);
        if (!snapshot) { rows.push(`  ${day}  nincs adat`); continue; }
        const workouts = ctx.workouts.forDate(day);
        const described = describeDay(snapshot, bases);
        if (described !== null || workouts.length > 0) measured++;
        rows.push(`  ${day}  ${described ?? "üres"}  edzés=${workouts.length}`);
      }
      // A column of "nincs adat" lines is not an outcome: the days after the
      // anchor were simply never recorded, so nothing here can test a claim
      // about what followed.
      const text = rows.join("\n");
      return measured > 0 ? evidence(text) : nothing(text);
    },
  },

  ritmus: {
    usage: "ritmus(mutato, bontas) — átlag a hét napjai (\"hetnap\") vagy hónapok (\"honap\") szerint",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return nothing(unknownMetric(args));
      const by = String(args.bontas ?? "hetnap");
      if (by !== "hetnap" && by !== "honap") {
        return nothing(`ismeretlen bontás "${by}" — hetnap vagy honap`);
      }
      const points = seriesOf(ctx, metric, shiftDay(ctx.today, -364), ctx.today);
      if (points.length === 0) return nothing(`${metric}: nincs mérés az elmúlt évben`);

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
      const text = [...buckets].map(([key, values]) => values.length < MIN_BUCKET_N
        ? `  ${key}: kevés mérés (n=${values.length}, kell ${MIN_BUCKET_N})`
        : `  ${key}: ${hu(mean(values)!)} (n=${values.length})`).join("\n");
      // The floor decides this too. If every bucket is below it, the answer
      // is a list of counts with every average deliberately withheld -- the
      // whole point of MIN_BUCKET_N is that those are not numbers to reason
      // from, so they are not numbers to falsify with either.
      const usable = [...buckets.values()].some((v) => v.length >= MIN_BUCKET_N);
      return usable ? evidence(text) : nothing(text);
    },
  },

  edzesek: {
    usage: "edzesek(tol, ig) — edzések egy tartományban: típus, hossz",
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      const rows = ctx.workouts.between(from, to);
      // An empty workout range cannot tell "trained nothing" from "nothing was
      // imported" -- there is no health check on this source the way there is
      // on the calendar -- so it is not something a claim can be killed with.
      if (rows.length === 0) return nothing(`${from} → ${to}: nincs edzés`);
      const displayed = rows.slice(0, 40);
      const lines = displayed
        .map((w) => `  ${w.date}  ${w.type}  ${Math.round(w.durationMin)} perc`)
        .join("\n");
      // Notify the model if the result was truncated so it can ask for a narrower range.
      if (displayed.length < rows.length) {
        return evidence(`${lines}\n… és még ${rows.length - displayed.length} edzés a tartományban`);
      }
      return evidence(lines);
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
        // Convert local dates to UTC boundaries that respect the system timezone.
        const fromUTC = localDateToUTC(from);
        const toUTC = localDateToUTC(to);
        // Shift toUTC to the end of the day (23:59:59 in the local timezone).
        const endOfDay = new Date(toUTC.getTime() + 24 * 60 * 60 * 1000 - 1000);
        events = await ctx.calendar.listEvents(fromUTC, endOfDay);
      } catch (err) {
        return nothing(`a naptár nincs bekötve: ${err instanceof Error ? err.message : String(err)}`);
      }
      // healthCheck only on the empty result, not on every call: an
      // unconfigured calendar returns [] without throwing, so emptiness is
      // the only case that is ambiguous — and on a working CalDAV account
      // this would otherwise be a second network round trip every step.
      if (events.length === 0) {
        const check = await ctx.calendar.healthCheck();
        // The one empty answer in this file that IS evidence. A working
        // calendar reporting no events is a measured absence: the instrument
        // was confirmed alive and it saw nothing. An unconfigured one is the
        // instrument missing, which measures nothing at all.
        return check.ok
          ? evidence(`${from} → ${to}: nincs esemény`)
          : nothing(`a naptár nincs bekötve: ${check.detail ?? "ismeretlen ok"}`);
      }
      const displayed = events.slice(0, 40);
      const lines = displayed
        .map((e) => `  ${e.start.slice(0, 16).replace("T", " ")}  ${e.title}`)
        .join("\n");
      // Notify the model if the result was truncated so it can ask for a narrower range.
      if (displayed.length < events.length) {
        return evidence(`${lines}\n… és még ${events.length - displayed.length} esemény a tartományban`);
      }
      return evidence(lines);
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
export const MENU_TEXT: string = [
  ...(Object.keys(QUESTIONS) as QuestionName[]).map((n) => QUESTIONS[n].usage),
  "hipotezis(allitas) — rögzíted, mit gondolsz az okról; kötelező a kesz előtt",
  "kerdezz(szoveg) — visszakérdezel a tulajdonosnak; lezárja a nyomozást",
  "kesz(megallapitas, tamaszkodik, cafolat) — kimondod a megállapítást; lezárja a nyomozást",
].join("\n");

/**
 * Runs one question. An unknown name or a bad argument returns text, never
 * throws: the loop feeds it back as an observation and the model can correct
 * itself. A thrown error would end an investigation over a typo.
 */
export async function runQuestion(
  name: string, args: Record<string, unknown>, ctx: QuestionContext,
): Promise<QuestionResult> {
  // `Object.hasOwn`, not `in`. `QUESTIONS` is a plain object literal, so
  // `"constructor" in QUESTIONS` is true, and so are "toString", "valueOf"
  // and "__proto__". Under `in` those names reached bracket access, came back
  // as inherited functions with no `run`, and produced "a kérdés hibára
  // futott" -- an observation on the transcript, and therefore a nameable
  // step number for the falsification gate. The gate uses the same test, and
  // the two must agree on what counts as a question.
  if (!Object.hasOwn(QUESTIONS, name)) {
    return nothing(
      `ismeretlen kérdés "${name}" — válassz a menüből: ${Object.keys(QUESTIONS).join(", ")}`);
  }
  const question = (QUESTIONS as Record<string, Question>)[name]!;
  try {
    return await question.run(args, ctx);
  } catch (err) {
    return nothing(`a kérdés hibára futott: ${err instanceof Error ? err.message : String(err)}`);
  }
}
