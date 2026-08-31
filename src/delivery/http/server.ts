import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { BriefService } from "../../core/brief-service.ts";
import type { ProposalService } from "../../core/proposals.ts";
import type { JarvisModule } from "../../core/module.ts";
import type { RunnerDeps } from "../../core/runner.ts";
import type { Clock } from "../../infra/clock.ts";
import type { HealthRepo } from "../../infra/db/repositories/health.ts";
import type { Logger } from "../../infra/logger.ts";
import { bearerAuth } from "./auth.ts";
import { registerBriefRoutes } from "./routes/brief.ts";
import { registerIngestRoutes } from "./routes/ingest.ts";
import { registerActionRoutes } from "./routes/actions.ts";
import { registerStatusRoutes } from "./routes/status.ts";

export interface ServerDeps {
  token: string;
  briefs: BriefService;
  proposals: ProposalService;
  health: HealthRepo;
  modules: readonly JarvisModule[];
  runner: RunnerDeps;
  clock: Clock;
  logger: Logger;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  // The tailnet is the perimeter, but a Shortcut stuck in a retry loop would
  // still rebuild the brief on every request.
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    allowList: (request) => request.url === "/healthz",
  });

  // Bearer auth guards /api/* only; /healthz stays open so a liveness probe
  // never needs the token.
  const auth = bearerAuth(deps.token);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) await auth(request, reply);
  });

  /**
   * One line per request, and a record of the last authenticated call.
   *
   * Fastify's own logger is off (it is far too chatty for a service that
   * handles a handful of requests a day), which left successful requests
   * invisible — the failure mode where the morning brief simply never arrives
   * looked exactly like a quiet, healthy night.
   */
  app.addHook("onResponse", async (request, reply) => {
    const route = request.url.split("?")[0] ?? request.url;
    const entry = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    };

    // The liveness probe would bury the one request a day that matters.
    if (route === "/healthz") deps.logger.debug(entry, "request");
    else deps.logger.info(entry, "request");
  });

  app.setErrorHandler(async (error: Error & { statusCode?: number }, _request, reply) => {
    deps.logger.error({ err: error.message, stack: error.stack }, "request failed");
    await reply.code(error.statusCode ?? 500).send({ error: "internal_error" });
  });

  registerStatusRoutes(app, { modules: deps.modules, runner: deps.runner, clock: deps.clock });
  registerBriefRoutes(app, { briefs: deps.briefs, clock: deps.clock });
  registerIngestRoutes(app, {
    health: deps.health, briefs: deps.briefs, clock: deps.clock, logger: deps.logger,
  });
  registerActionRoutes(app, { proposals: deps.proposals, clock: deps.clock });

  return app;
}
