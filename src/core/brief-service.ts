import type { JarvisModule, ModuleOutcome } from "./module.ts";
import type { Synthesizer } from "./synthesis/synthesizer.ts";
import { synthesizeWithFallback } from "./synthesis/synthesizer.ts";
import { runModules, type RunnerDeps } from "./runner.ts";
import { selectModules } from "./registry.ts";
import type { BriefRepo, StoredBrief } from "../infra/db/repositories/briefs.ts";
import type { ActionRepo, StoredAction } from "../infra/db/repositories/actions.ts";
import type { Logger } from "../infra/logger.ts";
import { huLongDate, isoDate, isoTime, type Tz } from "../shared/dates.ts";

export interface Brief {
  date: string;
  dateLabel: string;
  generatedAt: string;
  synthesizer: string;
  markdown: string;
  actions: StoredAction[];
  durationMs: number;
  fromCache: boolean;
  outcomes: ModuleOutcome[];
}

export interface BriefServiceOptions {
  modules: readonly JarvisModule[];
  synthesizers: readonly Synthesizer[];
  runner: RunnerDeps;
  briefs: BriefRepo;
  actions: ActionRepo;
  logger: Logger;
  tz: Tz;
  freshnessMinutes: number;
  maxWaitSeconds: number;
}

export interface GetOptions {
  /** Wait for an in-flight generation rather than returning a stale brief. */
  wait?: boolean;
  waitSeconds?: number;
  /** Ignore the cache entirely. */
  force?: boolean;
}

export interface BriefService {
  generate(now: Date): Promise<Brief>;
  /** Runs a single module on demand, for `/finance`-style Telegram commands. */
  runOne(name: string, now: Date): Promise<ModuleOutcome | null>;
  get(now: Date, opts?: GetOptions): Promise<Brief>;
  /** Fire-and-forget regeneration, e.g. after a health snapshot arrives. */
  regenerate(now: Date): Promise<Brief>;
  inFlight(): boolean;
}

export function createBriefService(opts: BriefServiceOptions): BriefService {
  let pending: Promise<Brief> | null = null;

  async function generate(now: Date): Promise<Brief> {
    const started = Date.now();
    const date = isoDate(now, opts.tz);
    const selected = selectModules(opts.modules, now, opts.tz);

    opts.logger.info(
      { date, modules: selected.map((m) => m.name) },
      "generating brief",
    );

    const outcomes = await runModules(selected, now, opts.runner);

    const ctx = {
      date,
      dateLabel: huLongDate(now, opts.tz),
      time: isoTime(now, opts.tz),
      outcomes,
    };

    // Synthesis gets its own generous budget; module timeouts already elapsed.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let synthesis;
    try {
      synthesis = await synthesizeWithFallback(
        opts.synthesizers, ctx, opts.logger, controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - started;
    const generatedAt = now.toISOString();

    // Actions come from the module outcomes, not by parsing them back out of
    // the markdown — synthesis is free to reword a line, and an id must survive that.
    const actions = opts.actions.replaceForDate(
      date,
      outcomes.flatMap((o) => o.actions.map((action) => ({ module: o.name, action }))),
      now,
    );

    opts.briefs.save({
      date,
      generatedAt,
      synthesizer: synthesis.synthesizer,
      markdown: synthesis.markdown,
      durationMs,
    });

    // Recorded only after the brief is safely stored. Recording earlier would
    // mean a crash mid-synthesis silently swallowed today's news: the items
    // would count as "already reported" without ever having been shown.
    for (const outcome of outcomes) {
      if (outcome.status === "ok" && outcome.result?.dedupeKeys?.length) {
        opts.runner.seen.record(outcome.name, outcome.result.dedupeKeys, now);
      }
    }

    opts.logger.info(
      {
        date,
        synthesizer: synthesis.synthesizer,
        demoted: synthesis.demoted,
        durationMs,
        sections: outcomes.filter((o) => o.status === "ok").length,
        failed: outcomes.filter((o) => o.status === "failed").map((o) => o.name),
      },
      "brief ready",
    );

    return {
      date,
      dateLabel: ctx.dateLabel,
      generatedAt,
      synthesizer: synthesis.synthesizer,
      markdown: synthesis.markdown,
      actions,
      durationMs,
      fromCache: false,
      outcomes,
    };
  }

  function fromStored(stored: StoredBrief, now: Date): Brief {
    return {
      date: stored.date,
      dateLabel: huLongDate(new Date(stored.generatedAt), opts.tz),
      generatedAt: stored.generatedAt,
      synthesizer: stored.synthesizer,
      markdown: stored.markdown,
      actions: opts.actions.listOpen(stored.date),
      durationMs: stored.durationMs,
      fromCache: true,
      outcomes: [],
    };
  }

  function isFresh(stored: StoredBrief, now: Date): boolean {
    const ageMs = now.getTime() - Date.parse(stored.generatedAt);
    return ageMs >= 0 && ageMs < opts.freshnessMinutes * 60_000;
  }

  async function regenerate(now: Date): Promise<Brief> {
    if (pending) return pending;
    pending = generate(now).finally(() => { pending = null; });
    return pending;
  }

  return {
    generate,
    regenerate,
    inFlight: () => pending !== null,

    async runOne(name, now) {
      const module = opts.modules.find((m) => m.name.toLowerCase() === name.toLowerCase());
      if (!module || !module.enabled) return null;
      const [outcome] = await runModules([module], now, opts.runner);
      return outcome ?? null;
    },

    /**
     * The 07:30 path. Returns instantly when a fresh brief exists; otherwise
     * joins an in-flight generation, bounded, and falls back to the last good
     * brief rather than making the Shortcut hang.
     */
    async get(now, options = {}) {
      const date = isoDate(now, opts.tz);
      const stored = opts.briefs.latestForDate(date);
      const waitMs = Math.min(
        (options.waitSeconds ?? opts.maxWaitSeconds) * 1000,
        opts.maxWaitSeconds * 1000,
      );

      // Caller wants an answer now, not a fresh one.
      if (options.wait === false && stored && !options.force) {
        return fromStored(stored, now);
      }

      // A generation already running means the cached brief is known to be out
      // of date — that is exactly what the health POST signals. Serving the
      // cache here is what made the Shortcut's POST-then-GET flow silently
      // return yesterday's numbers.
      if (pending) {
        try {
          return await withTimeout(pending, waitMs);
        } catch (err) {
          if (stored) {
            opts.logger.warn(
              { err: String(err) },
              "in-flight generation did not finish in time; serving last good brief",
            );
            return fromStored(stored, now);
          }
          throw err;
        }
      }

      if (!options.force && stored && isFresh(stored, now)) {
        return fromStored(stored, now);
      }

      const generation = regenerate(now);
      try {
        return await withTimeout(generation, waitMs);
      } catch (err) {
        const fallback = stored ?? opts.briefs.latest();
        if (fallback) {
          opts.logger.warn(
            { err: String(err), servedFrom: fallback.generatedAt },
            "generation did not finish in time; serving last good brief",
          );
          return fromStored(fallback, now);
        }
        throw err;
      }
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
