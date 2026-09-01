import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import { MAX_QUESTION_CHARS, type ChatService } from "../../../core/chat.ts";
import type { AnalysisRepo } from "../../../infra/db/repositories/analyses.ts";
import type { ConversationRepo } from "../../../infra/db/repositories/conversations.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";
import { huLongDate, TZ } from "../../../shared/dates.ts";
import { renderPage, type MetricRow, type PageData } from "../page.ts";

/** The web page is one thread; Telegram chats are their own. */
export const WEB_CHAT_ID = "web";

export interface PageDeps {
  briefs: BriefService;
  chat: ChatService;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  metricsRows: () => MetricRow[];
  clock: Clock;
  logger: Logger;
}

const body = z.object({ question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

export function registerPageRoutes(app: FastifyInstance, deps: PageDeps): void {
  app.get("/", async (_request, reply) => {
    const now = deps.clock.now();

    // Each piece fails on its own. The page's job is to show what exists, and
    // a missing brief must not take the analyses and the numbers with it —
    // nor a failing seven-year `aggregate()` take the brief.

    // `cached`, never `get`: opening the page must not start a brief
    // generation. Every module plus a Groq synthesis, up to 45 seconds, for a
    // page the owner only wanted to read — and one more call against a 6,000
    // token/minute ceiling that the next question then has to share.
    //
    // Empty-after-trim counts as absent: an empty "Briefing" heading is
    // missing data that does not look missing.
    let briefMarkdown: string | null = null;
    try {
      const brief = deps.briefs.cached(now);
      briefMarkdown = brief && brief.markdown.trim() !== "" ? brief.markdown : null;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without a brief");
    }

    let analyses: PageData["analyses"] = [];
    try {
      analyses = deps.analyses.latestPerDomain().map((a) => ({
        domain: a.domain, markdown: a.markdown, createdAt: a.createdAt,
      }));
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without the analyses");
    }

    let metricsRows: MetricRow[] = [];
    try {
      metricsRows = deps.metricsRows();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without the numbers");
    }

    let history: PageData["history"] = [];
    try {
      history = deps.conversations.recent(WEB_CHAT_ID, 20);
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without the thread");
    }

    // `chat.available()` is deliberately not wrapped: it only asks the secrets
    // store for a key, and `keychainSecrets` already swallows its own errors
    // and answers undefined. There is nothing here for it to throw.
    const data: PageData = {
      dateLabel: huLongDate(now, TZ),
      briefMarkdown,
      analyses,
      metricsRows,
      history,
      chatAvailable: await deps.chat.available(),
    };

    return reply.type("text/html; charset=utf-8").send(renderPage(data));
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
