import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProposalService, ProposalError, type ProposalService } from "../../src/core/proposals.ts";
import { createActionRepo, type ActionRepo } from "../../src/infra/db/repositories/actions.ts";
import { createCalendarWriteRepo, type CalendarWriteRepo } from "../../src/infra/db/repositories/calendar-writes.ts";
import type { CalendarService } from "../../src/infra/calendar/service.ts";
import type { ActionItem } from "../../src/core/module.ts";
import { memoryDb } from "../helpers.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { Db } from "../../src/infra/db/index.ts";

const NOW = new Date("2026-08-31T06:20:00+02:00");
const DATE = "2026-08-31";

const proposalAction: ActionItem = {
  id: "ignored", kind: "proposal",
  text: "Túra: Normafa",
  proposal: {
    title: "Túra: Normafa", start: "2026-09-05T08:00:00+02:00", end: "2026-09-05T12:30:00+02:00",
  },
};
const checkboxAction: ActionItem = { id: "ignored", kind: "checkbox", text: "Vedd ki a csirkét" };

let db: Db;
let actions: ActionRepo;
let writes: CalendarWriteRepo;
let calendar: CalendarService;
let service: ProposalService;
const createEvent = vi.fn();
const deleteEvent = vi.fn();

beforeEach(() => {
  db = memoryDb();
  actions = createActionRepo(db);
  writes = createCalendarWriteRepo(db);
  createEvent.mockReset();
  deleteEvent.mockReset();
  calendar = {
    listEvents: async () => [],
    createEvent,
    deleteEvent,
    healthCheck: async () => ({ ok: true }),
  };
  service = createProposalService({ actions, writes, calendar, logger: silentLogger() });
});
afterEach(() => db.close());

const seedActions = (items: ActionItem[]) =>
  actions.replaceForDate(DATE, items.map((action) => ({ module: "Test", action })), NOW);

describe("accepting a proposal", () => {
  it("creates the event and records it for undo", async () => {
    createEvent.mockResolvedValue({ uid: "jarvis-1", calendar: "Jarvis", url: "https://x/1.ics" });
    const [stored] = seedActions([proposalAction]);

    const result = await service.accept(stored!.id, NOW);

    expect(result.eventUid).toBe("jarvis-1");
    expect(createEvent).toHaveBeenCalledWith(proposalAction.proposal);
    expect(actions.find(stored!.id)!.status).toBe("accepted");

    const trail = writes.recent(10);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ eventUid: "jarvis-1", calendar: "Jarvis", actionId: stored!.id });
  });

  it("leaves the action open when the calendar write fails, so it can be retried", async () => {
    // Marking it accepted before the write succeeds would lose the proposal
    // entirely — you would never be offered the hike again.
    createEvent.mockRejectedValue(new Error("403 Forbidden"));
    const [stored] = seedActions([proposalAction]);

    await expect(service.accept(stored!.id, NOW)).rejects.toThrow(ProposalError);
    expect(actions.find(stored!.id)!.status).toBe("open");
    expect(writes.recent(10)).toHaveLength(0);
  });

  it("refuses to accept the same proposal twice", async () => {
    createEvent.mockResolvedValue({ uid: "jarvis-1", calendar: "Jarvis", url: "u" });
    const [stored] = seedActions([proposalAction]);

    await service.accept(stored!.id, NOW);
    await expect(service.accept(stored!.id, NOW)).rejects.toMatchObject({ code: "already_resolved" });
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses to write a calendar event for a plain checkbox", async () => {
    const [stored] = seedActions([checkboxAction]);
    await expect(service.accept(stored!.id, NOW)).rejects.toMatchObject({ code: "wrong_kind" });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("reports an unknown action rather than silently doing nothing", async () => {
    await expect(service.accept("no-such-id", NOW)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("undo", () => {
  it("deletes the event and reopens the action", async () => {
    createEvent.mockResolvedValue({ uid: "jarvis-1", calendar: "Jarvis", url: "u" });
    deleteEvent.mockResolvedValue(undefined);
    const [stored] = seedActions([proposalAction]);
    await service.accept(stored!.id, NOW);

    await service.undo("jarvis-1", NOW);

    expect(deleteEvent).toHaveBeenCalledWith("jarvis-1", "Jarvis");
    expect(actions.find(stored!.id)!.status).toBe("open");
    expect(writes.recent(10)).toHaveLength(0); // no longer undoable
  });

  it("refuses to undo the same event twice", async () => {
    createEvent.mockResolvedValue({ uid: "jarvis-1", calendar: "Jarvis", url: "u" });
    deleteEvent.mockResolvedValue(undefined);
    const [stored] = seedActions([proposalAction]);
    await service.accept(stored!.id, NOW);
    await service.undo("jarvis-1", NOW);

    await expect(service.undo("jarvis-1", NOW)).rejects.toMatchObject({ code: "already_resolved" });
  });

  it("keeps the trail intact when the delete fails", async () => {
    createEvent.mockResolvedValue({ uid: "jarvis-1", calendar: "Jarvis", url: "u" });
    deleteEvent.mockRejectedValue(new Error("network down"));
    const [stored] = seedActions([proposalAction]);
    await service.accept(stored!.id, NOW);

    await expect(service.undo("jarvis-1", NOW)).rejects.toThrow(/network down/);
    expect(writes.recent(10)).toHaveLength(1);
  });
});

describe("checkboxes", () => {
  it("marks a checkbox done", async () => {
    const [stored] = seedActions([checkboxAction]);
    expect((await service.complete(stored!.id, NOW)).status).toBe("done");
    expect(actions.find(stored!.id)!.status).toBe("done");
  });

  it("keeps a completed action completed when the brief regenerates", () => {
    const [stored] = seedActions([checkboxAction]);
    actions.setStatus(stored!.id, "done", NOW);

    // Re-running the brief must never un-tick something you already did.
    const [regenerated] = seedActions([checkboxAction]);
    expect(regenerated!.id).toBe(stored!.id);
    expect(regenerated!.status).toBe("done");
    expect(actions.listOpen(DATE)).toHaveLength(0);
  });
});
