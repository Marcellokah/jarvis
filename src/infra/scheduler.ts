import { Cron } from "croner";
import type { Clock } from "./clock.ts";
import type { Db } from "./db/index.ts";
import type { Logger } from "./logger.ts";
import { createSeenStore } from "./db/repositories/seen.ts";
import { createSubscriptionRepo } from "./db/repositories/subscriptions.ts";
import { createSubscriptionMonthRepo } from "./db/repositories/subscription-months.ts";
import { createConversationRepo } from "./db/repositories/conversations.ts";
import { recordSubscriptionMonth } from "../core/subscription-snapshot.ts";

export interface SchedulerOptions {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** Drop seen_items older than this, so a re-released item can resurface. */
  seenRetentionDays: number;
  /**
   * A conversation thread is not long-term memory — that is what the
   * `analyses` table is for — only the recent back-and-forth a follow-up
   * question depends on. Nobody asks "what did I say a month ago?", so
   * anything older than this is safe to drop.
   */
  conversationRetentionDays: number;
  /**
   * The proactive check. Absent when there is no Telegram bot to speak
   * through, in which case no tick is scheduled at all.
   */
  notify?: { cron: string; run: (now: Date) => Promise<void> };
}

export interface Scheduler {
  stop(): void;
}

/**
 * The nightly sweep's body, pulled out of the cron callback so it can be
 * tested directly against a fixed `now` rather than by trying to trigger
 * croner's own schedule — a timing-dependent test would be slow and flaky for
 * no real coverage gain, whereas this function is a plain call.
 */
export function runNightlyCleanup(opts: SchedulerOptions, now: Date): void {
  // The only thing still on a timer. Not automation — the process's own hygiene:
  // expired cache entries and dedupe records that have outlived their purpose.
  try {
    const prunedSeen = createSeenStore(opts.db).prune(opts.seenRetentionDays, now);
    const prunedTurns = createConversationRepo(opts.db).prune(
      new Date(now.getTime() - opts.conversationRetentionDays * 86_400_000),
    );
    opts.db.run("DELETE FROM module_cache WHERE expires_at < ?", now.toISOString());
    opts.logger.info({ prunedSeen, prunedTurns }, "nightly cleanup complete");
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

  const cleanup = new Cron("0 4 * * *", { timezone, protect: true }, () => {
    runNightlyCleanup(opts, opts.clock.now());
  });

  const notify = opts.notify
    ? new Cron(opts.notify.cron, { timezone, protect: true }, async () => {
        try {
          await opts.notify!.run(opts.clock.now());
        } catch (err) {
          // A failing tick must never take the scheduler down with it.
          opts.logger.warn({ err: String(err) }, "proactive notification tick failed");
        }
      })
    : null;

  opts.logger.info(
    { cleanup: "0 4 * * *", notify: opts.notify?.cron ?? null },
    "scheduler started",
  );

  return {
    stop() {
      cleanup.stop();
      notify?.stop();
    },
  };
}
