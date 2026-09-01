import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { ChatService } from "../../../core/chat.ts";
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

const body = z.object({ question: z.string().trim().min(1).max(2000) });

export function registerPageRoutes(app: FastifyInstance, deps: PageDeps): void {
  app.get("/", async (_request, reply) => {
    const now = deps.clock.now();

    // Each piece fails on its own. The page's job is to show what exists, and
    // a missing brief must not take the analyses and the numbers with it.
    let briefMarkdown: string | null = null;
    try {
      briefMarkdown = (await deps.briefs.get(now, { wait: false })).markdown;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without a brief");
    }

    const data: PageData = {
      dateLabel: huLongDate(now, TZ),
      briefMarkdown,
      analyses: deps.analyses.latestPerDomain().map((a) => ({
        domain: a.domain, markdown: a.markdown, createdAt: a.createdAt,
      })),
      metricsRows: deps.metricsRows(),
      history: deps.conversations.recent(WEB_CHAT_ID, 20),
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
