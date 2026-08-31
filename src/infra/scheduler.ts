import { Cron } from "croner";
import type { BriefService } from "../core/brief-service.ts";
import type { Clock } from "./clock.ts";
import type { Db } from "./db/index.ts";
import type { Logger } from "./logger.ts";
import { createSeenStore } from "./db/repositories/seen.ts";
import type { ContactRepo } from "./db/repositories/contacts.ts";
import { TZ } from "../shared/dates.ts";

export interface SchedulerOptions {
  /** Cron expression for the pre-warm, in Europe/Budapest. */
  preWarmCron: string;
  briefs: BriefService;
  db: Db;
  clock: Clock;
  logger: Logger;
  /** Drop seen_items older than this, so a re-released item can resurface. */
  seenRetentionDays: number;
  contacts: ContactRepo;
  /** Cron for the "did the phone check in?" test, in Europe/Budapest. */
  contactCheckCron: string;
  /** Off while the Shortcut is still being built. */
  contactAlert: boolean;
  /**
   * Reaches the user out of band — Telegram in production. Absent when no bot
   * is configured, in which case a missing morning is only logged.
   */
  notify?: (text: string) => Promise<void>;
}

export interface Scheduler {
  stop(): void;
}

/**
 * Builds the brief before the Shortcut asks for it.
 *
 * Synthesis takes 10-40 seconds, which Apple Shortcuts will not reliably wait
 * for. Running at 07:20 means the 07:30 request is served from cache in
 * milliseconds, and the health snapshot that arrives with it only has to
 * trigger a refresh, not a cold build.
 */
export function startScheduler(opts: SchedulerOptions): Scheduler {
  const timezone = "Europe/Budapest";

  const preWarm = new Cron(opts.preWarmCron, { timezone, protect: true }, async () => {
    const started = Date.now();
    try {
      const brief = await opts.briefs.generate(opts.clock.now());
      opts.logger.info(
        { synthesizer: brief.synthesizer, durationMs: Date.now() - started },
        "pre-warm complete",
      );
    } catch (err) {
      // The Shortcut will fall back to the last good brief; nothing to escalate.
      opts.logger.error({ err: String(err) }, "pre-warm failed");
    }
  });

  // Housekeeping, well away from the morning window.
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

  /**
   * The one check that catches a silent morning.
   *
   * Everything else here reports on work this process did. This reports on
   * work that *should have arrived from outside* — and that is the failure
   * nothing else can see: an ad-blocker DNS profile swallowing the tailnet
   * name, a dropped Tailscale session, a disabled automation. From the
   * server's side they all look like a quiet night.
   */
  const contactCheck = new Cron(opts.contactCheckCron, { timezone, protect: true }, async () => {
    await checkClientContact(opts);
  });

  opts.logger.info(
    {
      preWarm: opts.preWarmCron,
      nextRun: preWarm.nextRun()?.toISOString(),
      contactCheck: opts.contactAlert ? opts.contactCheckCron : "off",
    },
    "scheduler started",
  );

  return {
    stop() {
      preWarm.stop();
      cleanup.stop();
      contactCheck.stop();
    },
  };
}

export interface ContactCheckOptions {
  contacts: ContactRepo;
  contactAlert: boolean;
  clock: Clock;
  logger: Logger;
  notify?: (text: string) => Promise<void>;
}

/**
 * Exported so the alert can be tested without waiting for 08:00. Returns
 * whether it decided to alert, which is the whole behaviour worth asserting.
 */
export async function checkClientContact(opts: ContactCheckOptions): Promise<boolean> {
  if (!opts.contactAlert) return false;

  const now = opts.clock.now();
  if (!opts.contacts.missingOn(now, TZ)) return false;

  const last = opts.contacts.last();
  opts.logger.warn({ lastContact: last?.at ?? null }, "no client contact today");

  const text = [
    "⚠️ Ma reggel nem jelentkezett a telefon.",
    "",
    last
      ? `A Shortcut nem hívta meg a szervert. Utolsó kapcsolat: ${last.at}`
      : "A Shortcut még soha nem hívta meg a szervert.",
    "",
    "Ellenőrizd a telefonon:",
    "• fut-e a Tailscale,",
    '• be van-e kapcsolva a "Use Tailscale DNS",',
    "• engedélyezve van-e az automatizálás.",
    "",
    "A brief elkészült — /brief paranccsal bármikor elkéred.",
  ].join("\n");

  try {
    await opts.notify?.(text);
  } catch (err) {
    // The alert failing must not take the scheduler down with it.
    opts.logger.error({ err: String(err) }, "could not deliver the missing-contact alert");
  }
  return true;
}
