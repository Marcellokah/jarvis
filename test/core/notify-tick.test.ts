import { describe, it, expect } from "vitest";
import {
  createGatherMark, runNotifyTick, MAX_PER_NOTIFICATION, type NotifyDeps,
} from "../../src/core/notify/tick.ts";
import { createNotificationRepo } from "../../src/infra/db/repositories/notifications.ts";
import { createSeenStore } from "../../src/infra/db/repositories/seen.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Db } from "../../src/infra/db/index.ts";
import type { Candidate } from "../../src/core/notify/candidates.ts";

const NOON = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Budapest
const CANDIDATE: Candidate = {
  key: "health:rhr-rising", kind: "health", urgency: "soon", text: "A nyugalmi pulzusod emelkedik (200 nap).",
};

function deps(db: Db, over: Partial<NotifyDeps> = {}): NotifyDeps {
  return {
    db,
    tz: TZ,
    logger: recordingLogger(),
    notifications: createNotificationRepo(db),
    seen: createSeenStore(db),
    gates: { minHoursBetween: 4, quietFromHour: 22, quietToHour: 7 },
    gatherMark: createGatherMark(),
    gather: async () => [CANDIDATE],
    compose: async (cs) => ({ text: cs.map((c) => c.text).join(" "), source: "template" as const }),
    send: async () => {},
    ...over,
  };
}

const signal = () => new AbortController().signal;

describe("runNotifyTick", () => {
  it("sends, then records both the log and the dedupe keys", async () => {
    const db = memoryDb();
    const sent: string[] = [];
    const d = deps(db, { send: async (text) => { sent.push(text); } });

    expect(await runNotifyTick(d, NOON, signal())).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(d.notifications.lastSentAt()).toBe(NOON.toISOString());
    expect(d.seen.filterNew("notify", [CANDIDATE.key])).toEqual([]);
    db.close();
  });

  it("does not gather anything when a gate is closed", async () => {
    const db = memoryDb();
    let gathered = 0;
    // 23:00 Budapest — quiet. A tick that cannot send must do no work at all,
    // which is what keeps a 15-minute cron from running modules 96 times a day.
    const d = deps(db, { gather: async () => { gathered++; return [CANDIDATE]; } });

    expect(await runNotifyTick(d, new Date("2026-09-01T21:00:00.000Z"), signal())).toBe("gated");
    expect(gathered).toBe(0);
    db.close();
  });

  it("says nothing when nothing clears the thresholds", async () => {
    const db = memoryDb();
    const sent: string[] = [];
    const d = deps(db, { gather: async () => [], send: async (t) => { sent.push(t); } });

    expect(await runNotifyTick(d, NOON, signal())).toBe("nothing");
    expect(sent).toEqual([]);
    expect(d.notifications.lastSentAt()).toBeNull();
    db.close();
  });

  it("does not repeat a candidate it already sent", async () => {
    const db = memoryDb();
    const sent: string[] = [];
    const d = deps(db, { send: async (t) => { sent.push(t); } });

    await runNotifyTick(d, NOON, signal());
    // Eight hours later the gate is open again, but the candidate is the same.
    const later = new Date("2026-09-01T18:00:00.000Z");
    expect(await runNotifyTick(d, later, signal())).toBe("nothing");
    expect(sent).toHaveLength(1);
    db.close();
  });

  it("does not gather again a quarter of an hour after finding nothing", async () => {
    const db = memoryDb();
    let gathered = 0;
    // Nothing was sent, so `lastSentAt()` is still null and the send gate is
    // wide open. Without the second mark both modules would run and the
    // aggregation would walk seven years of rows sixty times a day.
    const d = deps(db, { gather: async () => { gathered++; return []; } });

    expect(await runNotifyTick(d, NOON, signal())).toBe("nothing");
    const quarterLater = new Date("2026-09-01T10:15:00.000Z");
    expect(await runNotifyTick(d, quarterLater, signal())).toBe("gated");
    expect(gathered).toBe(1);
    db.close();
  });

  it("gathers again once the four hours are up", async () => {
    const db = memoryDb();
    let gathered = 0;
    const d = deps(db, { gather: async () => { gathered++; return []; } });

    await runNotifyTick(d, NOON, signal());
    const fourHoursLater = new Date("2026-09-01T14:00:00.000Z");
    expect(await runNotifyTick(d, fourHoursLater, signal())).toBe("nothing");
    expect(gathered).toBe(2);
    db.close();
  });

  it("says what it suppressed when the gather mark closes the gate", async () => {
    const db = memoryDb();
    const logger = recordingLogger();
    const d = deps(db, { logger, gather: async () => [] });

    await runNotifyTick(d, NOON, signal());
    await runNotifyTick(d, new Date("2026-09-01T10:15:00.000Z"), signal());
    // "nothing was sent" and "nothing was even looked at" are different facts,
    // so the reason names the gather rather than the last notification.
    expect(logger.entries).toContainEqual(expect.objectContaining({
      level: "debug",
      msg: "proactive notification gated",
      obj: expect.objectContaining({ reason: expect.stringContaining("gyűjtés") }),
    }));
    db.close();
  });

  it("sends at most five items, and keeps the rest for next time", async () => {
    const db = memoryDb();
    const many: Candidate[] = Array.from({ length: 8 }, (_, i) => ({
      key: `analysis:d${i}:2026-09-01`,
      kind: "analysis" as const,
      urgency: i === 7 ? "now" as const : "soon" as const,
      text: `tétel ${i}`,
    }));
    let composed: readonly Candidate[] = [];
    const d = deps(db, {
      gather: async () => many,
      compose: async (cs) => { composed = cs; return { text: "x", source: "template" as const }; },
    });

    expect(await runNotifyTick(d, NOON, signal())).toBe("sent");
    // A push is not a report: the tail is dropped rather than sent as a wall
    // of text Telegram would split into several messages.
    expect(composed).toHaveLength(MAX_PER_NOTIFICATION);
    // The urgent one was produced last and is kept anyway — the cap keeps what
    // matters, it does not keep whatever arrived first.
    expect(composed[0]!.text).toBe("tétel 7");
    // What was dropped was not recorded either, so it can still be said later.
    expect(d.seen.filterNew("notify", many.map((c) => c.key))).toEqual(["d4", "d5", "d6"].map((d) => `analysis:${d}:2026-09-01`));
    db.close();
  });

  it("leaves no trace when sending fails", async () => {
    const db = memoryDb();
    // Neither half may land: a recorded send that never happened is a message
    // lost for good, and a recorded key with no message is worse.
    const d = deps(db, { send: async () => { throw new Error("telegram down"); } });

    expect(await runNotifyTick(d, NOON, signal())).toBe("failed");
    expect(d.notifications.lastSentAt()).toBeNull();
    expect(d.seen.filterNew("notify", [CANDIDATE.key])).toEqual([CANDIDATE.key]);
    db.close();
  });
});
