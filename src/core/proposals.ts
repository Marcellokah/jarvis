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
     * Order matters: the event is created first and only then recorded as
     * accepted. If iCloud rejects the write, the action stays open so it can
     * be retried — marking it accepted first would lose the proposal entirely.
     */
    async accept(actionId, now) {
      const action = load(actionId);

      if (action.kind !== "proposal" || !action.proposal) {
        throw new ProposalError("wrong_kind", `A(z) "${action.text}" nem naptár-javaslat.`);
      }
      if (action.status !== "open") {
        throw new ProposalError("already_resolved", `Ezt már elintézted (${action.status}).`);
      }

      let created;
      try {
        created = await deps.calendar.createEvent(action.proposal);
      } catch (err) {
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
      deps.actions.setStatus(action.id, "accepted", now);

      deps.logger.info({ actionId, uid: created.uid }, "proposal accepted");
      return { action: { ...action, status: "accepted" }, eventUid: created.uid, calendar: created.calendar };
    },

    async decline(actionId, now) {
      const action = load(actionId);
      deps.actions.setStatus(action.id, "declined", now);
      return { ...action, status: "declined" };
    },

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
