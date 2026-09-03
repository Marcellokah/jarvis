import type { Metrics } from "../analysis/aggregate.ts";
import { aggregate } from "../analysis/aggregate.ts";
import type { AnalysisRepo } from "../../infra/db/repositories/analyses.ts";
import type { ConversationRepo, Turn } from "../../infra/db/repositories/conversations.ts";
import type { HealthRepo } from "../../infra/db/repositories/health.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { MealRepo } from "../../infra/db/repositories/meals.ts";
import type { SubscriptionMonthRepo } from "../../infra/db/repositories/subscription-months.ts";
import type { BriefService } from "../brief-service.ts";
import type { Clock } from "../../infra/clock.ts";
import type { Logger } from "../../infra/logger.ts";
import { isoDate, TZ } from "../../shared/dates.ts";

/** How many months of training history survive the trim. */
const MONTHS_KEPT = 12;

export interface AskContext {
  today: string;
  /** Null when today's brief could not be produced — the question still stands. */
  briefMarkdown: string | null;
  analyses: { domain: string; summary: string; createdAt: string }[];
  metrics: Metrics;
  history: Turn[];
}

export interface AskContextDeps {
  health: HealthRepo;
  workouts: WorkoutRepo;
  meals: MealRepo;
  subscriptionMonths: SubscriptionMonthRepo;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  briefs: BriefService;
  clock: Clock;
  logger: Logger;
  /** How many previous turns of the thread the model sees. */
  historyDepth: number;
}

/** Rounds to two decimals, leaving null alone. */
function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

/**
 * Walks the metrics rounding every number, leaving null untouched.
 *
 * The null case is the reason this is hand-written rather than a blanket
 * `JSON.parse(JSON.stringify(...))` pass: turning an absent measurement into 0
 * would undo every guard the aggregation layer puts in place.
 */
function roundDeep<T>(value: T): T {
  if (typeof value === "number") return round2(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(roundDeep) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = roundDeep(v);
  return out as T;
}

/**
 * The context's view of the statistics.
 *
 * The full `Metrics` object is too large for a question: `physical.byMonth`
 * carries a row per month since 2019 and runs to roughly 4,985 characters on
 * its own — more than the statistics it accompanies, against a 6,000
 * token/minute ceiling. The analysis still gets the whole picture; only the
 * question's view is trimmed.
 */
export function trimMetrics(m: Metrics): Metrics {
  const trimmed: Metrics = {
    ...m,
    physical: { ...m.physical, byMonth: m.physical.byMonth.slice(-MONTHS_KEPT) },
  };
  return roundDeep(trimmed);
}

export async function buildAskContext(
  deps: AskContextDeps,
  chatId: string,
  signal: AbortSignal,
): Promise<AskContext> {
  const now = deps.clock.now();
  const today = isoDate(now, TZ);

  // A brief that will not come must not cost the answer: the history alone
  // answers most questions, and the day is only one part of the context.
  //
  // `cached`, never `get`: a question must not trigger a brief generation.
  // That would be a second Groq call in the same minute, against a 6,000
  // token/minute ceiling, for something the question did not ask for.
  //
  // An empty brief is treated as no brief. Rendering the "there is a brief"
  // branch around nothing would be missing data that does not look missing.
  let briefMarkdown: string | null = null;
  try {
    const brief = deps.briefs.cached(now);
    briefMarkdown = brief && brief.markdown.trim() !== "" ? brief.markdown : null;
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "no brief for the ask context");
  }
  signal.throwIfAborted();

  const metrics = trimMetrics(aggregate({
    today,
    snapshots: deps.health.between("1970-01-01", today),
    workouts: deps.workouts.between("1970-01-01", today),
    months: deps.subscriptionMonths.months().map((month) => ({
      month, subs: deps.subscriptionMonths.forMonth(month),
    })),
    plan: [0, 1, 2, 3, 4, 5, 6].flatMap((w) => deps.meals.forWeekday(w)),
  }));

  return {
    today,
    briefMarkdown,
    analyses: deps.analyses.latestPerDomain().map((a) => ({
      domain: a.domain, summary: a.summary, createdAt: a.createdAt,
    })),
    metrics,
    history: deps.conversations.recent(chatId, deps.historyDepth),
  };
}

const ROLE_LABEL: Record<Turn["role"], string> = { user: "Te", assistant: "Jarvis" };

export function renderAskPrompt(ctx: AskContext, question: string): string {
  const parts: string[] = [`Mai dátum: ${ctx.today}`, ""];

  parts.push(ctx.analyses.length === 0
    ? "Még nem készült mélyelemzés — erről a területről nem tudsz nyilatkozni, és ne következtess elemzést a nyers számokból."
    : [
      "A legutóbbi mélyelemzés összegzései, területenként, a keletkezés dátumával:",
      ...ctx.analyses.map((a) => `- [${a.domain}, ${a.createdAt.slice(0, 10)}] ${a.summary}`),
      "",
      "Egy régebbi megállapítás lehet, hogy már nem áll. A dátumot vedd figyelembe,",
      "és ha egy elemzés régi, mondd ki, hogy azóta nem készült új.",
    ].join("\n"));

  parts.push("", "A friss statisztikák. A havi bontásból csak az **utolsó tizenkét hónap**");
  parts.push("látszik — a korábbi hónapok léteznek, csak nincsenek itt, tehát ne olvasd");
  parts.push("adathiánynak. Minden metrika mellett ott van, hány napból származik (`n`)");
  parts.push("és mekkora a lefedettség; a `null` azt jelenti, hogy nincs mérés.");
  parts.push("", JSON.stringify(ctx.metrics));

  parts.push("", ctx.briefMarkdown === null
    ? "Ma nem készült briefing, tehát a mai napról csak a fenti számok alapján nyilatkozz."
    : `A mai briefing:\n\n${ctx.briefMarkdown}`);

  if (ctx.history.length > 0) {
    parts.push("", "A beszélgetés eddig:");
    for (const turn of ctx.history) parts.push(`${ROLE_LABEL[turn.role]}: ${turn.content}`);
  }

  parts.push(
    "",
    "Válaszolj magyarul, tömören, a persona szerint. Csak a fenti adatokra támaszkodj,",
    "és ha valamit nem tudsz belőlük, mondd ki ahelyett, hogy kitalálnád. Ha egy",
    "állításod mérésen alapul, tedd oda, hány napból.",
    "",
    "A kérdés:",
    question,
  );

  return parts.join("\n");
}
