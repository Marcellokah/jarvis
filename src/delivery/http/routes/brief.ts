import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { Clock } from "../../../infra/clock.ts";
import { toPlainText } from "../../../core/renderer.ts";

const query = z.object({
  format: z.enum(["text", "md", "json"]).default("text"),
  wait: z.coerce.number().min(0).max(120).optional(),
  force: z.coerce.boolean().default(false),
});

export function registerBriefRoutes(
  app: FastifyInstance,
  deps: { briefs: BriefService; clock: Clock },
): void {
  /** The Apple Shortcut's target. Defaults to plain text — iOS notifications do not render markdown. */
  app.get("/api/morning-brief", async (request, reply) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", issues: parsed.error.issues });
    }
    const { format, wait, force } = parsed.data;

    const brief = await deps.briefs.get(deps.clock.now(), {
      waitSeconds: wait,
      wait: wait === 0 ? false : undefined,
      force,
    });

    reply.header("x-jarvis-synthesizer", brief.synthesizer);
    reply.header("x-jarvis-cached", String(brief.fromCache));
    reply.header("x-jarvis-generated-at", brief.generatedAt);

    if (format === "json") {
      return reply.send({
        date: brief.date,
        generatedAt: brief.generatedAt,
        synthesizer: brief.synthesizer,
        fromCache: brief.fromCache,
        durationMs: brief.durationMs,
        markdown: brief.markdown,
        text: toPlainText(brief.markdown),
        actions: brief.actions.map((a) => ({ id: a.id, kind: a.kind, text: a.text, status: a.status })),
      });
    }

    const body = format === "md" ? brief.markdown : toPlainText(brief.markdown);
    return reply.type("text/plain; charset=utf-8").send(body);
  });
}
