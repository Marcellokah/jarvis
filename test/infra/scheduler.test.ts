import { describe, it, expect } from "vitest";
import { scheduledJobs } from "croner";
import { memoryDb, recordingLogger } from "../helpers.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { fakeClock } from "../../src/infra/clock.ts";
import {
  runNightlyCleanup, startScheduler, runNotifyCronTick, NOTIFY_CRON_NAME,
  type SchedulerOptions,
} from "../../src/infra/scheduler.ts";
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

// `startScheduler`'s notify cron is exercised through croner's own API rather
// than by waiting on real time: `.trigger()` runs the job's callback
// immediately regardless of its schedule, and `.stop()` / `scheduledJobs`
// report real state. `runNightlyCleanup`'s test above proves the same thing
// is possible for the housekeeping cron only because that body was already
// pulled out; the notify path gets both the extracted-body coverage and this
// end-to-end wiring coverage, since the two things that changed here are the
// wiring itself and the body's failure handling.
describe("runNotifyCronTick", () => {
  it("runs the tick with the given now", async () => {
    const calls: Date[] = [];
    await runNotifyCronTick({ run: async (now) => { calls.push(now); } }, NOW, recordingLogger());
    expect(calls).toEqual([NOW]);
  });

  it("swallows a throwing tick and logs a warning instead of throwing", async () => {
    const logger = recordingLogger();
    await expect(
      runNotifyCronTick({ run: async () => { throw new Error("groq is down"); } }, NOW, logger),
    ).resolves.toBeUndefined();
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });
});

describe("startScheduler — notify cron wiring", () => {
  it("registers no notify job when opts.notify is absent", () => {
    const db = memoryDb();
    const scheduler = startScheduler(opts(db));
    expect(scheduledJobs.some((j) => j.name === NOTIFY_CRON_NAME)).toBe(false);
    scheduler.stop();
    db.close();
  });

  it("registers the notify job on the configured pattern when opts.notify is present", () => {
    const db = memoryDb();
    const scheduler = startScheduler({
      ...opts(db),
      notify: { cron: "*/15 * * * *", run: async () => {} },
    });
    const job = scheduledJobs.find((j) => j.name === NOTIFY_CRON_NAME);
    expect(job).toBeDefined();
    expect(job!.getPattern()).toBe("*/15 * * * *");
    scheduler.stop();
    db.close();
  });

  it("triggering the registered job runs the wired tick, not just its own stub", async () => {
    const db = memoryDb();
    const calls: Date[] = [];
    const scheduler = startScheduler({
      ...opts(db),
      notify: { cron: "*/15 * * * *", run: async (now) => { calls.push(now); } },
    });
    const job = scheduledJobs.find((j) => j.name === NOTIFY_CRON_NAME)!;
    await job.trigger();
    expect(calls).toEqual([NOW]);
    scheduler.stop();
    db.close();
  });

  it("a throwing tick does not take the scheduler down when triggered for real", async () => {
    const db = memoryDb();
    const scheduler = startScheduler({
      ...opts(db),
      notify: { cron: "*/15 * * * *", run: async () => { throw new Error("telegram down"); } },
    });
    const job = scheduledJobs.find((j) => j.name === NOTIFY_CRON_NAME)!;
    await expect(job.trigger()).resolves.toBeUndefined();
    scheduler.stop();
    db.close();
  });

  it("stop() stops the notify cron", () => {
    const db = memoryDb();
    const scheduler = startScheduler({
      ...opts(db),
      notify: { cron: "*/15 * * * *", run: async () => {} },
    });
    const job = scheduledJobs.find((j) => j.name === NOTIFY_CRON_NAME)!;
    expect(job.isStopped()).toBe(false);

    scheduler.stop();

    expect(job.isStopped()).toBe(true);
    // Named jobs remove themselves from the registry on stop(), which is also
    // what lets the next test claim the same name without a collision.
    expect(scheduledJobs.some((j) => j.name === NOTIFY_CRON_NAME)).toBe(false);
    db.close();
  });
});
