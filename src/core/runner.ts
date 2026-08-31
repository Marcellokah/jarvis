import type { JarvisModule, ModuleContext, ModuleOutcome, ModuleResult } from "./module.ts";
import type { Db } from "../infra/db/index.ts";
import type { Fetcher } from "../infra/http-client.ts";
import type { Logger } from "../infra/logger.ts";
import type { SecretResolver } from "../infra/secrets.ts";
import type { CalendarService } from "../infra/calendar/service.ts";
import type { SeenStore } from "../infra/db/repositories/seen.ts";
import { createModuleCache } from "../infra/db/repositories/cache.ts";
import type { Tz } from "../shared/dates.ts";

const DEFAULT_TIMEOUT_MS = 8_000;

export interface RunnerDeps {
  db: Db;
  http: Fetcher;
  calendar: CalendarService;
  secrets: SecretResolver;
  logger: Logger;
  seen: SeenStore;
  tz: Tz;
}

const PRIORITY_ORDER = { critical: 0, normal: 1, fyi: 2 } as const;

/**
 * The single place a ModuleContext is assembled. Everything that runs a module
 * — the brief, /api/modules, Telegram commands, the smoke check — goes through
 * here, so adding a field to the context cannot leave a call site behind.
 */
export function buildModuleContext(
  deps: RunnerDeps, moduleName: string, now: Date, signal: AbortSignal,
): ModuleContext {
  return {
    now,
    tz: deps.tz,
    db: deps.db,
    http: deps.http,
    calendar: deps.calendar,
    secrets: deps.secrets,
    logger: deps.logger.child({ module: moduleName }),
    signal,
    seen: deps.seen,
    cache: createModuleCache(deps.db, moduleName, () => now, deps.logger),
  };
}

/**
 * Runs every selected module concurrently, each under its own timeout.
 *
 * A module that throws, times out, or misbehaves becomes a logged `failed`
 * outcome — it never propagates. A brief with four good sections and one
 * failure is vastly more useful at 07:30 than an exception.
 */
export async function runModules(
  modules: readonly JarvisModule[],
  now: Date,
  deps: RunnerDeps,
): Promise<ModuleOutcome[]> {
  const settled = await Promise.all(modules.map((m) => runOne(m, now, deps)));

  return settled.sort((a, b) => {
    const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (byPriority !== 0) return byPriority;
    return modules.findIndex((m) => m.name === a.name) - modules.findIndex((m) => m.name === b.name);
  });
}

async function runOne(
  module: JarvisModule,
  now: Date,
  deps: RunnerDeps,
): Promise<ModuleOutcome> {
  const started = Date.now();
  const timeoutMs = module.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const base = { name: module.name, title: module.title } as const;

  const ctx = buildModuleContext(deps, module.name, now, controller.signal);

  try {
    const result = await module.execute(ctx);
    clearTimeout(timer);
    const durationMs = Date.now() - started;

    if (result === null) {
      deps.logger.debug({ module: module.name, durationMs }, "module had nothing to report");
      return { ...base, priority: "fyi", status: "empty", result: null, plain: "", actions: [], durationMs };
    }

    let plain: string;
    try {
      plain = module.renderPlain(result).trim();
    } catch (err) {
      // A broken renderer must not cost us the module's data entirely.
      deps.logger.error({ module: module.name, err: String(err) }, "renderPlain threw");
      plain = `⚠️ (a szekció megjelenítése hibára futott, az adat megvan)`;
    }

    deps.logger.debug({ module: module.name, durationMs }, "module ok");
    return {
      ...base,
      priority: result.priority,
      status: "ok",
      result: result as ModuleResult,
      plain,
      actions: result.actions,
      durationMs,
    };
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === "AbortError";
    // `String(err)` yields "Error: ...", which reads badly inside a sentence
    // that already says the module is unavailable.
    const message = aborted
      ? `időtúllépés (${timeoutMs} ms)`
      : err instanceof Error ? err.message : String(err);

    deps.logger.warn({ module: module.name, durationMs, err: message }, "module failed");
    return {
      ...base,
      priority: "fyi",
      status: "failed",
      result: null,
      plain: `⚠️ Nem elérhető: ${message}`,
      actions: [],
      durationMs,
      error: message,
    };
  }
}
