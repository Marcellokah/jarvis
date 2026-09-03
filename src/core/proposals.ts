import type { ActionRepo, StoredAction } from "../infra/db/repositories/actions.ts";
import type { CalendarWriteRepo } from "../infra/db/repositories/calendar-writes.ts";
import type { CalendarService } from "../infra/calendar/service.ts";
import type { Logger } from "../infra/logger.ts";

export interface AcceptResult {
  action: StoredAction;
  eventUid: string;
  calendar: string;
}

export interface ProposalService {
  accept(actionId: string, now: Date): Promise<AcceptResult>;
  decline(actionId: string, now: Date): Promise<StoredAction>;
  complete(actionId: string, now: Date): Promise<StoredAction>;
  /** Removes an event Jarvis created and reopens its action. */
  undo(eventUid: string, now: Date): Promise<void>;
  listUndoable(limit: number): { eventUid: string; title: string; startsAt: string; calendar: string }[];
}

export class ProposalError extends Error {
  code: "not_found" | "wrong_kind" | "already_resolved" | "calendar_failed";
  constructor(code: ProposalError["code"], message: string) {
    super(message);
    this.name = "ProposalError";
    this.code = code;
  }
}

export function createProposalService(deps: {
  actions: ActionRepo;
  writes: CalendarWriteRepo;
  calendar: CalendarService;
  logger: Logger;
}): ProposalService {
  function load(actionId: string): StoredAction {
    const action = deps.actions.find(actionId);
    if (!action) throw new ProposalError("not_found", `Nincs ilyen teendő: ${actionId}`);
    return action;
  }

  return {
    /**
     * The only path that writes to your calendar.
     *
     * Two requests can only interleave at an `await` — this app has one
     * database connection and JavaScript is single-threaded — so the
     * `status !== "open"` guard below is followed *immediately*, with no
     * `await` between them, by claiming the action: its status is set to
     * "accepted" right there, before the calendar is ever touched. That
     * makes the guard-and-claim indivisible, so of two overlapping accept()
     * calls the second always observes "accepted" and fails with
     * already_resolved, instead of both reading "open" and both creating a
     * calendar event.
     *
     * If the calendar write then fails, the claim is reverted — the status
     * is set back to "open" before the `calendar_failed` error is thrown —
     * so the action stays retryable exactly as before this change: claiming
     * it and leaving it claimed on a failed write would lose the proposal
     * entirely.
     */
    async accept(actionId, now) {
      const action = load(actionId);

      if (action.kind !== "proposal" || !action.proposal) {
        throw new ProposalError("wrong_kind", `A(z) "${action.text}" nem naptár-javaslat.`);
      }
      if (action.status !== "open") {
        throw new ProposalError("already_resolved", `Ezt már elintézted (${action.status}).`);
      }
      deps.actions.setStatus(action.id, "accepted", now);

      let created;
      try {
        created = await deps.calendar.createEvent(action.proposal);
      } catch (err) {
        // Revert the claim: a failed write must not cost you the proposal.
        deps.actions.setStatus(action.id, "open", now);
        deps.logger.error({ actionId, err: String(err) }, "calendar write failed; action left open");
        throw new ProposalError("calendar_failed", `Nem sikerült a naptárba írni: ${String(err)}`);
      }

      deps.writes.record({
        actionId: action.id,
        eventUid: created.uid,
        calendar: created.calendar,
        title: action.proposal.title,
        startsAt: action.proposal.start,
        createdAt: now.toISOString(),
      });

      deps.logger.info({ actionId, uid: created.uid }, "proposal accepted");
      return { action: { ...action, status: "accepted" }, eventUid: created.uid, calendar: created.calendar };
    },

    /**
     * Unlike accept(), this guards against an already-resolved action.
     * Declining an accepted proposal reached via a stale page (the browser
     * Back button after a successful accept, since `/` sends no
     * Cache-Control) would silently orphan its calendar event: the write
     * stays in the calendar and in the undo band, but the action vanishes
     * from Teendők with no way back to it.
     */
    async decline(actionId, now) {
      const action = load(actionId);
      if (action.status !== "open") {
        throw new ProposalError("already_resolved", `Ezt már elintézted (${action.status}).`);
      }
      deps.actions.setStatus(action.id, "declined", now);
      return { ...action, status: "declined" };
    },

    // No status guard here, deliberately, unlike decline(): ticking a
    // checkbox twice is genuinely harmless — there is no side effect to
    // orphan — and the write route already redirects cleanly on
    // already_resolved, so a guard would only change the JSON API's answer
    // for a case that was never actually a problem.
    async complete(actionId, now) {
      const action = load(actionId);
      deps.actions.setStatus(action.id, "done", now);
      return { ...action, status: "done" };
    },

    async undo(eventUid, now) {
      const write = deps.writes.findByUid(eventUid);
      if (!write) throw new ProposalError("not_found", `Nincs ilyen létrehozott esemény: ${eventUid}`);
      if (write.deletedAt) throw new ProposalError("already_resolved", "Ezt már visszavontad.");

      await deps.calendar.deleteEvent(write.eventUid, write.calendar);
      deps.writes.markDeleted(write.eventUid, now);
      // Reopen the action so it can be reconsidered tomorrow.
      if (write.actionId) deps.actions.setStatus(write.actionId, "open", now);

      deps.logger.info({ eventUid }, "calendar write undone");
    },

    listUndoable(limit) {
      return deps.writes.recent(limit).map((w) => ({
        eventUid: w.eventUid, title: w.title, startsAt: w.startsAt, calendar: w.calendar,
      }));
    },
  };
}
