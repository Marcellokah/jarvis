import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import { MAX_QUESTION_CHARS, type ChatService } from "../../../core/chat.ts";
import type { AnalysisRepo } from "../../../infra/db/repositories/analyses.ts";
import type { ConversationRepo } from "../../../infra/db/repositories/conversations.ts";
import type { HealthRepo } from "../../../infra/db/repositories/health.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";
import { huLongDate, isoDate, TZ } from "../../../shared/dates.ts";
import { readChannels, summarise } from "../view/channels.ts";
import { layout, type NavState } from "../view/shell.ts";
import { todayBody } from "../view/today.ts";
import { numbersBody, type MetricRow } from "../view/numbers.ts";

/** The web page is one thread; Telegram chats are their own. */
export const WEB_CHAT_ID = "web";

export interface PageDeps {
  briefs: BriefService;
  chat: ChatService;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  health: HealthRepo;
  metricsRows: () => MetricRow[];
  clock: Clock;
  logger: Logger;
}

const body = z.object({ question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

/** "2 órája" — a brief kora emberi szavakkal, vagy null, ha nincs brief. */
function ageWords(from: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes} perce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} órája`;
  return `${Math.round(hours / 24)} napja`;
}

/**
 * The nav lamps, assembled the same way on every page.
 *
 * `/` was the only route when this was written inline; `/szamok` makes it the
 * second, so it moves here rather than being copied. Each source keeps its
 * own try/catch, exactly as `/` originally wrote them: a failing analyses
 * repo must dim the "Elemzés" lamp, never take the whole page down.
 */
async function navState(deps: PageDeps, now: Date): Promise<NavState> {
  let hasBrief = false;
  try {
    const brief = deps.briefs.cached(now);
    hasBrief = brief !== null && brief.markdown.trim() !== "";
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "nav indicator fell back to dark");
  }

  let hasAnalysis = false;
  try {
    hasAnalysis = deps.analyses.latestPerDomain().length > 0;
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "nav indicator fell back to dark");
  }

  // `available()` is a `SecretResolver` read under the hood, and nothing
  // guarantees an arbitrary resolver swallows its own errors the way the
  // keychain one happens to — a throw here must dim the "Kérdés" lamp, not
  // 500 every page that shows it.
  let chatAvailable = false;
  try {
    chatAvailable = await deps.chat.available();
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "nav indicator fell back to dark");
  }

  return {
    ma: hasBrief,
    elemzes: hasAnalysis,
    kerdes: chatAvailable,
  };
}

export function registerPageRoutes(app: FastifyInstance, deps: PageDeps): void {
  app.get("/", async (_request, reply) => {
    const now = deps.clock.now();
    const today = isoDate(now, TZ);

    // Each piece fails on its own. The page's job is to show what exists, and
    // a missing brief must not take today's readings with it.

    // `cached`, never `get`: opening the page must not start a brief
    // generation — every module plus a Groq synthesis, up to 45 seconds, for a
    // page the owner only wanted to read.
    let briefMarkdown: string | null = null;
    let briefAge: string | null = null;
    try {
      const brief = deps.briefs.cached(now);
      if (brief && brief.markdown.trim() !== "") {
        briefMarkdown = brief.markdown;
        briefAge = ageWords(brief.generatedAt, now);
      }
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without a brief");
    }

    let snapshot = undefined;
    let lastSeen: string | null = null;
    try {
      snapshot = deps.health.forDate(today);
      if (snapshot === undefined) lastSeen = deps.health.latest(today)?.date ?? null;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without today's readings");
    }

    const readings = readChannels(snapshot, now);

    return reply.type("text/html; charset=utf-8").send(layout({
      section: "ma",
      dateLabel: huLongDate(now, TZ),
      briefAge,
      channels: summarise(readings),
      nav: await navState(deps, now),
      body: todayBody({
        briefMarkdown,
        readings,
        lastSeen,
        writtenAge: snapshot ? ageWords(snapshot.ingestedAt, now) : null,
      }),
    }));
  });

  app.get("/szamok", async (_request, reply) => {
    const now = deps.clock.now();
    const today = isoDate(now, TZ);

    // Same status-strip inputs as `/`: the brief's age and today's channel
    // readings appear on every page, not just the one that shows the brief
    // itself.
    let briefAge: string | null = null;
    try {
      const brief = deps.briefs.cached(now);
      if (brief && brief.markdown.trim() !== "") briefAge = ageWords(brief.generatedAt, now);
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without a brief age");
    }

    let snapshot = undefined;
    try {
      snapshot = deps.health.forDate(today);
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without today's readings");
    }

    // The aggregate the rows are built from touches every table the app has;
    // a corrupt row or a bad query must dim the numbers, not the page.
    let metricsRows: MetricRow[] = [];
    try {
      metricsRows = deps.metricsRows();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its metrics");
    }

    return reply.type("text/html; charset=utf-8").send(layout({
      section: "szamok",
      dateLabel: huLongDate(now, TZ),
      briefAge,
      channels: summarise(readChannels(snapshot, now)),
      nav: await navState(deps, now),
      body: numbersBody(metricsRows),
    }));
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = body.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", detail: "a `question` mező kötelező" });
    }

    try {
      // The page waits on this request, so the deadline lives here rather than
      // in the browser: a hung call must free the connection, not hold it open
      // until the client gives up with nothing to show.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      try {
        const answer = await deps.chat.ask(WEB_CHAT_ID, parsed.data.question, controller.signal);
        return reply.send({ answer });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Named, not swallowed: a question that silently produced nothing looks
      // exactly like a question nobody asked.
      deps.logger.warn({ err: String(err) }, "chat question failed");
      return reply.code(502).send({ error: "chat_failed", detail: String(err) });
    }
  });
}
