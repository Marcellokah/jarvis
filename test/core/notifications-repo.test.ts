import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createNotificationRepo } from "../../src/infra/db/repositories/notifications.ts";

const AT = (iso: string) => new Date(iso);

describe("notification repo", () => {
  it("has no last-sent time before anything was sent", () => {
    const db = memoryDb();
    // Null, not epoch zero: "never notified" must not read as "notified long
    // ago", because the four-hour gate treats those the same way only by luck.
    expect(createNotificationRepo(db).lastSentAt()).toBeNull();
    db.close();
  });

  it("returns the most recent send time", () => {
    const db = memoryDb();
    const repo = createNotificationRepo(db);

    repo.record({ sentAt: AT("2026-09-01T08:00:00.000Z"), kinds: ["deadline"], keys: ["a"], text: "x" });
    repo.record({ sentAt: AT("2026-09-01T13:00:00.000Z"), kinds: ["health"], keys: ["b"], text: "y" });

    expect(repo.lastSentAt()).toBe("2026-09-01T13:00:00.000Z");
    db.close();
  });

  it("keeps what was sent, so it can be checked afterwards", () => {
    const db = memoryDb();
    const repo = createNotificationRepo(db);

    repo.record({
      sentAt: AT("2026-09-01T08:00:00.000Z"),
      kinds: ["deadline", "health"],
      keys: ["deadline:csirke:2026-09-01", "health:hrv-low"],
      text: "Vedd ki a csirkét.",
    });

    const last = repo.recent(1)[0]!;
    expect(last.kinds).toEqual(["deadline", "health"]);
    expect(last.keys).toEqual(["deadline:csirke:2026-09-01", "health:hrv-low"]);
    expect(last.text).toBe("Vedd ki a csirkét.");
    db.close();
  });

  it("returns the newest first", () => {
    const db = memoryDb();
    const repo = createNotificationRepo(db);

    repo.record({ sentAt: AT("2026-09-01T08:00:00.000Z"), kinds: ["health"], keys: ["a"], text: "régi" });
    repo.record({ sentAt: AT("2026-09-01T13:00:00.000Z"), kinds: ["health"], keys: ["b"], text: "friss" });

    expect(repo.recent(2).map((n) => n.text)).toEqual(["friss", "régi"]);
    db.close();
  });
});
