import type { Db } from "../../infra/db/index.ts";
import type { Logger } from "../../infra/logger.ts";
import type { NotificationRepo } from "../../infra/db/repositories/notifications.ts";
import type { SeenStore } from "../../infra/db/repositories/seen.ts";
import type { Tz } from "../../shared/dates.ts";
import { gateReason, type GateOptions } from "./gates.ts";
import { byUrgency, type Candidate } from "./candidates.ts";

/** The SeenStore module name the notification keys live under. */
export const NOTIFY_MODULE = "notify";

/**
 * At most this many items in one push. A push is not a report.
 *
 * The list arrives sorted urgent-first, so the cap keeps what matters and
 * drops the tail. What it drops is not recorded as seen, so it is still there
 * to be said the next time the assistant speaks.
 */
export const MAX_PER_NOTIFICATION = 5;

/**
 * The last time this process gathered — in memory, not in the database.
 *
 * `lastSentAt()` alone gates only the cheap half. On a day with nothing to
 * say nothing is recorded, so that gate stays open and every fifteen-minute
 * tick runs both modules and walks seven years of rows again: sixty times a
 * day, not the "at most every four hours" the design claims. Memory is enough
 * — after a restart one extra gather costs nothing and is invisible.
 */
export interface GatherMark {
  /** Null until this process has gathered once. */
  at: Date | null;
}

export function createGatherMark(): GatherMark {
  return { at: null };
}

export interface NotifyDeps {
  db: Db;
  tz: Tz;
  logger: Logger;
  notifications: NotificationRepo;
  seen: SeenStore;
  gates: GateOptions;
  /** Process-local mark of the last gather, gating the expensive half. */
  gatherMark: GatherMark;
  /** Collects candidates. Only called once the gates have opened. */
  gather: (now: Date, signal: AbortSignal) => Promise<Candidate[]>;
  compose: (
    cs: readonly Candidate[], signal: AbortSignal,
  ) => Promise<{ text: string; source: "groq" | "template" }>;
  send: (text: string) => Promise<void>;
}

export type TickResult = "sent" | "gated" | "nothing" | "failed";

/**
 * One pass of the proactive check.
 *
 * The order is the design: gates first, and only then any work. A tick that
 * cannot send must not read the database or run a module — otherwise a
 * fifteen-minute cron would run the modules ninety-six times a day to discover
 * ninety-two times that it was not allowed to speak.
 */
export async function runNotifyTick(
  deps: NotifyDeps,
  now: Date,
  signal: AbortSignal,
): Promise<TickResult> {
  const closed = gateReason(now, deps.tz, deps.notifications.lastSentAt(), deps.gates);
  if (closed) {
    // Logged rather than silent: "nothing happened" and "something was
    // suppressed" look identical otherwise, and only one of them is a bug.
    deps.logger.debug({ reason: closed }, "proactive notification gated");
    return "gated";
  }

  // The second gate, and the one that actually protects the work: together
  // these two mean gathering happens no more often than the send limit, since
  // the later of the two marks has to be older than the limit before anything
  // runs. Judged here rather than in `gateReason` so the reason stays honest —
  // "nothing was sent" and "nothing was even looked at" are different facts.
  const gathered = deps.gatherMark.at;
  if (gathered !== null) {
    const elapsedH = (now.getTime() - gathered.getTime()) / 3_600_000;
    if (elapsedH < deps.gates.minHoursBetween) {
      deps.logger.debug(
        {
          reason: `az utolsó gyűjtés ${elapsedH.toFixed(1)} órája futott, `
            + `a korlát ${deps.gates.minHoursBetween} óra`,
        },
        "proactive notification gated",
      );
      return "gated";
    }
  }

  // Marked before the call, not after: a gather that throws has already spent
  // the work, and repeating it every fifteen minutes would spend it again.
  deps.gatherMark.at = now;
  const found = await deps.gather(now, signal);
  // One query for every key rather than one per candidate: that is what the
  // SeenStore's plural signature is for.
  const unseen = new Set(deps.seen.filterNew(NOTIFY_MODULE, found.map((c) => c.key)));
  // Sorted again before the cap rather than trusting the order `gather`
  // happened to return: dropping the tail is only safe if the tail is the
  // least urgent part of the list.
  const fresh = found
    .filter((c) => unseen.has(c.key))
    .sort(byUrgency)
    .slice(0, MAX_PER_NOTIFICATION);
  if (fresh.length === 0) return "nothing";

  const { text, source } = await deps.compose(fresh, signal);
  if (!text.trim()) return "nothing";

  try {
    await deps.send(text);
  } catch (err) {
    // Nothing is recorded, so the next open gate tries again. A missed message
    // has to be repeated; an unnecessary one does not.
    deps.logger.warn({ err: String(err) }, "proactive notification could not be sent");
    return "failed";
  }

  // Both writes together: a recorded send that never went out is a message
  // lost for good, and a recorded key with no message is the same thing twice.
  deps.db.transaction(() => {
    deps.notifications.record({
      sentAt: now, kinds: fresh.map((c) => c.kind), keys: fresh.map((c) => c.key), text,
    });
    deps.seen.record(NOTIFY_MODULE, fresh.map((c) => c.key), now);
  });

  deps.logger.info({ count: fresh.length, source }, "proactive notification sent");
  return "sent";
}
