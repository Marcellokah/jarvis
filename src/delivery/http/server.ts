import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { BriefService } from "../../core/brief-service.ts";
import type { ProposalService } from "../../core/proposals.ts";
import type { ChatService } from "../../core/chat.ts";
import type { JarvisModule } from "../../core/module.ts";
import type { RunnerDeps } from "../../core/runner.ts";
import type { Clock } from "../../infra/clock.ts";
import type { HealthRepo } from "../../infra/db/repositories/health.ts";
import type { AnalysisRepo } from "../../infra/db/repositories/analyses.ts";
import type { ConversationRepo } from "../../infra/db/repositories/conversations.ts";
import type { Logger } from "../../infra/logger.ts";
import type { Metrics } from "../../core/analysis/aggregate.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { MealRepo } from "../../infra/db/repositories/meals.ts";
import type { SubscriptionRepo } from "../../infra/db/repositories/subscriptions.ts";
import { bearerAuth, chatAuth, pageAuth } from "./auth.ts";
import { registerBriefRoutes } from "./routes/brief.ts";
import { registerIngestRoutes } from "./routes/ingest.ts";
import { registerActionRoutes } from "./routes/actions.ts";
import { registerStatusRoutes } from "./routes/status.ts";
import { registerPageRoutes } from "./routes/page.ts";
import { registerAreaRoutes } from "./routes/areas.ts";
import { registerWriteRoutes } from "./routes/writes.ts";

export interface ServerDeps {
  token: string;
  briefs: BriefService;
  proposals: ProposalService;
  chat: ChatService;
  health: HealthRepo;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  workouts: WorkoutRepo;
  meals: MealRepo;
  subscriptions: SubscriptionRepo;
  metrics: () => Metrics;
  modules: readonly JarvisModule[];
  runner: RunnerDeps;
  clock: Clock;
  logger: Logger;
}

/**
 * The path Fastify's router actually dispatches to — `find-my-way` decodes
 * percent-escapes before matching, so this has to as well or the auth hook
 * below is checking a different string than the one that gets routed.
 *
 * Query string stripped first, exactly the way the router itself splits
 * `url` before decoding the path portion, so `%3F` inside a path segment is
 * never mistaken for the real `?`. `null` means "could not make sense of
 * this" (a lone `%`, a truncated escape, hex bytes that are not valid UTF-8)
 * — callers must treat that as matching no known route, not as any
 * particular one. In practice `find-my-way` already rejects exactly that
 * input with its own 400 before a request carrying it ever reaches this
 * hook, so `null` is a defensive backstop for this app, not the thing
 * standing between an attacker and a route today.
 */
function decodedPath(url: string): string | null {
  const raw = url.split("?")[0] ?? url;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  /**
   * Form bodies, without a dependency.
   *
   * Fastify parses JSON and nothing else out of the box: an
   * `application/x-www-form-urlencoded` POST answers 415 even with an empty
   * body, which is exactly what a browser sends for a button-only form. This
   * is `@fastify/formbody`'s whole job, in four lines of built-in
   * `URLSearchParams` — and this project takes no new runtime dependency.
   */
  app.addContentTypeParser(
    "application/x-www-form-urlencoded", { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  // The tailnet is the perimeter, but a Shortcut stuck in a retry loop would
  // still rebuild the brief on every request.
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    allowList: (request) => request.url === "/healthz",
  });

  // Every registered route Fastify actually dispatches to, gathered from the
  // router itself via the `onRoute` hook rather than copied into a list by
  // hand here. Nothing but bookkeeping — the auth decision below never
  // consults it — but the test suite reads it to assert every route the app
  // really has is guarded, so a new route can never silently slip past that
  // check the way a hand-maintained allow list could.
  const registeredRoutes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (routeOptions) => {
    for (const method of ([] as string[]).concat(routeOptions.method)) {
      registeredRoutes.push({ method, url: routeOptions.url });
    }
  });
  app.decorate("registeredRoutes", registeredRoutes);

  /**
   * The one path that needs no token at all: a liveness probe cannot carry
   * one, and it hands back nothing but `{ ok: true }`.
   *
   * Deliberately not `/api/…`: this app has exactly one public path, and
   * spelling it out here — instead of pattern-matching a prefix the way
   * `/api/` is matched below — means adding a route can never accidentally
   * land in "public" by sharing a prefix with this one.
   */
  const PUBLIC_ROUTES = new Set(["/healthz"]);

  // Bearer auth guards /api/*; every other path defaults to full page auth —
  // opt-OUT (name it in `PUBLIC_ROUTES` to open it) rather than opt-IN, so a
  // route this file has never heard of is guarded the moment it is
  // registered elsewhere, not just the two page routes that happen to exist
  // today. `/`, `/szamok`, and whatever `routes/page.ts` grows next all carry
  // the brief, the analyses, the numbers or the whole thread — more, in one
  // response, than any single `/api/` route hands out. The server binds to
  // 127.0.0.1, but `deploy/README.md` documents a `tailscale serve` that
  // proxies the whole origin — protection cannot depend on which of those
  // happens to be switched on today.
  //
  // `/api/chat` takes the cookie too: it is the page's own fetch, and the page
  // is already proving itself with that cookie one request earlier. Every
  // other `/api/*` route is called by a Shortcut or a script, which sends a
  // header and never a cookie, so those stay bearer-only.
  const auth = bearerAuth(deps.token);
  const chat = chatAuth(deps.token);
  const page = pageAuth(deps.token);
  app.addHook("onRequest", async (request, reply) => {
    const route = decodedPath(request.url);
    // `find-my-way` decodes percent-escapes before it matches a route (so
    // `GET /%73zamok` dispatches to the `/szamok` handler), but `request.url`
    // stays exactly as the client sent it. Comparing that raw string against
    // `/szamok` let an escaped path sail through unguarded — this hook has to
    // see what the router sees. A path that fails to decode (a lone `%`, a
    // truncated escape) matches nothing below and falls to the strictest
    // guard, `pageAuth` — the safe reading of a byte sequence this cannot
    // make sense of.
    if (route !== null && PUBLIC_ROUTES.has(route)) return;
    if (route === "/api/chat") { await chat(request, reply); return; }
    if (route !== null && route.startsWith("/api/")) { await auth(request, reply); return; }
    await page(request, reply);
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
      // The path only, never the full URL. `GET /?token=…` is how the page is
      // first opened, and `deploy/README.md` tells the owner to tail this log
      // — logging the query string would write the bearer token to disk in
      // plaintext, in the one file most likely to be read out loud.
      url: route,
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
  registerWriteRoutes(app, {
    proposals: deps.proposals, clock: deps.clock, logger: deps.logger,
  });
  const pageDeps = {
    briefs: deps.briefs, chat: deps.chat, analyses: deps.analyses,
    conversations: deps.conversations, health: deps.health,
    workouts: deps.workouts, meals: deps.meals, subscriptions: deps.subscriptions,
    metrics: deps.metrics, clock: deps.clock, logger: deps.logger,
  };
  registerPageRoutes(app, pageDeps);
  registerAreaRoutes(app, pageDeps);

  return app;
}
