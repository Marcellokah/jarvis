import { Cron } from "croner";
import type { Clock } from "./clock.ts";
import type { Db } from "./db/index.ts";
import type { Logger } from "./logger.ts";
import { createSeenStore } from "./db/repositories/seen.ts";
import { createSubscriptionRepo } from "./db/repositories/subscriptions.ts";
import { createSubscriptionMonthRepo } from "./db/repositories/subscription-months.ts";
import { recordSubscriptionMonth } from "../core/subscription-snapshot.ts";

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

    // Second recording point (the first is start-up, in main.ts). It is not a
    // guarantee that no month goes unrecorded: croner does not replay a run
    // missed while the machine was asleep, and on a laptop that sleeps at 04:00
    // this leg may simply never fire. Start-up is the leg that actually holds —
    // whenever the agent restarts, the month gets recorded.
    // Same shared implementation as main.ts calls, so the two cannot drift
    // the way they already had once (see core/subscription-snapshot.ts).
    // The already-captured `now` is reused rather than calling clock.now()
    // again, so this snapshot's recorded_at matches the cleanup run above it.
    try {
      recordSubscriptionMonth({
        subscriptions: createSubscriptionRepo(opts.db),
        subscriptionMonths: createSubscriptionMonthRepo(opts.db),
        clock: { now: () => now },
      });
    } catch (err) {
      opts.logger.warn({ err: String(err) }, "nightly subscription snapshot failed");
    }
  });

  opts.logger.info({ cleanup: "0 4 * * *" }, "scheduler started");

  return { stop() { cleanup.stop(); } };
}
