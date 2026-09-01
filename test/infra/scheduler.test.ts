import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { fakeClock } from "../../src/infra/clock.ts";
import { runNightlyCleanup, type SchedulerOptions } from "../../src/infra/scheduler.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";
import { createSeenStore } from "../../src/infra/db/repositories/seen.ts";

const NOW = new Date("2026-09-01T04:00:00.000Z");

// `runNightlyCleanup` is tested directly with a fixed `now`, not by triggering
// croner's own schedule: the latter would be slow, timing-dependent, and would
// not exercise anything this direct call does not already cover.
function opts(db: ReturnType<typeof memoryDb>): SchedulerOptions {
  return {
    db,
    clock: fakeClock(NOW.toISOString()),
    logger: silentLogger(),
    seenRetentionDays: 21,
    conversationRetentionDays: 30,
  };
}

describe("runNightlyCleanup", () => {
  it("prunes conversation turns older than retention, keeps ones inside it", () => {
    const db = memoryDb();
    const conversations = createConversationRepo(db);
    // 31 days before NOW: past the 30-day retention, must go.
    conversations.appendExchange("web", "régi", "válasz", new Date("2026-08-01T08:00:00.000Z"));
    // 17 days before NOW: inside retention, must stay.
    conversations.appendExchange("web", "friss", "válasz", new Date("2026-08-15T00:00:00.000Z"));

    runNightlyCleanup(opts(db), NOW);

    expect(conversations.recent("web", 10).map((t) => t.content)).toEqual(["friss", "válasz"]);
    db.close();
  });

  it("prunes seen items older than retention, keeps ones inside it", () => {
    const db = memoryDb();
    const seen = createSeenStore(db);
    // 31 days before NOW: past the 21-day retention, must go.
    seen.record("mod", ["old-key"], new Date("2026-08-01T00:00:00.000Z"));
    // 12 days before NOW: inside retention, must stay.
    seen.record("mod", ["recent-key"], new Date("2026-08-20T00:00:00.000Z"));

    runNightlyCleanup(opts(db), NOW);

    // filterNew reports a key as new only once it is no longer recorded as
    // seen, so this is the observable proof that pruning ran: the aged-out
    // key resurfaces, the recent one is still suppressed.
    expect(seen.filterNew("mod", ["old-key", "recent-key"])).toEqual(["old-key"]);
    db.close();
  });
});
