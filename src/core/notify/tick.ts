import type { Db } from "../../infra/db/index.ts";
import type { Logger } from "../../infra/logger.ts";
import type { NotificationRepo } from "../../infra/db/repositories/notifications.ts";
import type { SeenStore } from "../../infra/db/repositories/seen.ts";
import type { Tz } from "../../shared/dates.ts";
import { gateReason, type GateOptions } from "./gates.ts";
import type { Candidate } from "./candidates.ts";

/** The SeenStore module name the notification keys live under. */
export const NOTIFY_MODULE = "notify";

export interface NotifyDeps {
  db: Db;
  tz: Tz;
  logger: Logger;
  notifications: NotificationRepo;
  seen: SeenStore;
  gates: GateOptions;
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

  const found = await deps.gather(now, signal);
  // One query for every key rather than one per candidate: that is what the
  // SeenStore's plural signature is for.
  const unseen = new Set(deps.seen.filterNew(NOTIFY_MODULE, found.map((c) => c.key)));
  const fresh = found.filter((c) => unseen.has(c.key));
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
