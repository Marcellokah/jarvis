import { describe, it, expect } from "vitest";
import { runNotifyTick, type NotifyDeps } from "../../src/core/notify/tick.ts";
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
