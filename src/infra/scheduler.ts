import { Cron } from "croner";
import type { Clock } from "./clock.ts";
import type { Db } from "./db/index.ts";
import type { Logger } from "./logger.ts";
import { createSeenStore } from "./db/repositories/seen.ts";

export interface SchedulerOptions {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** Drop seen_items older than this, so a re-released item can resurface. */
  seenRetentionDays: number;
}

export interface Scheduler {
  stop(): void;
}

/**
 * The only timer left in the system.
 *
 * The brief used to be pre-warmed at 07:20 so an unattended 07:30 request could
 * be served from cache. There is no unattended request any more — the brief is
 * generated when you ask for it. What remains is housekeeping.
 */
export function startScheduler(opts: SchedulerOptions): Scheduler {
  const timezone = "Europe/Budapest";

  // The only thing still on a timer. Not automation — the process's own hygiene:
  // expired cache entries and dedupe records that have outlived their purpose.
  const cleanup = new Cron("0 4 * * *", { timezone, protect: true }, () => {
    const now = opts.clock.now();
    try {
      const prunedSeen = createSeenStore(opts.db).prune(opts.seenRetentionDays, now);
      opts.db.run("DELETE FROM module_cache WHERE expires_at < ?", now.toISOString());
      opts.logger.info({ prunedSeen }, "nightly cleanup complete");
    } catch (err) {
      opts.logger.warn({ err: String(err) }, "nightly cleanup failed");
    }
  });

  opts.logger.info({ cleanup: "0 4 * * *" }, "scheduler started");

  return { stop() { cleanup.stop(); } };
}
