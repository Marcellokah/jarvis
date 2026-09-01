import { describe, it, expect } from "vitest";
import { gatherCandidates, type GatherDeps } from "../../src/core/notify/gather.ts";
import { createNotificationRepo } from "../../src/infra/db/repositories/notifications.ts";
import { createAnalysisRepo } from "../../src/infra/db/repositories/analyses.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Db } from "../../src/infra/db/index.ts";

const NOW = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Budapest

function deps(db: Db, over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    tz: TZ,
    logger: recordingLogger(),
    notifications: createNotificationRepo(db),
    analyses: createAnalysisRepo(db),
    metrics: () => null,
    runModule: async () => null,
    ...over,
  };
}

// The full RenewalAlert shape from src/modules/finance-subs/index.ts, so the
// reader in gather.ts is shown picking `name`/`renewsOn` out of a realistic
// object rather than a fixture minimal enough to hide a wrong field name.
//
// The default is a renewal one day out, because that is what the module can
// actually emit: `alertDaysBefore` is [7, 3, 1], so `daysUntil` is only ever
// 7, 3 or 1 — never 0, and never negative. Fixtures outside that set describe
// a situation production cannot reach, and a source can look covered while
// being dead.
function renewalAlert(over: Partial<{
  name: string; amountHuf: number; cycle: string; renewsOn: string;
  daysUntil: number; cancelUrl: string | null; unused: boolean; daysSinceUse: number | null;
}> = {}) {
  return {
    name: "Netflix", amountHuf: 4990, cycle: "monthly", renewsOn: "2026-09-02",
    daysUntil: 1, cancelUrl: null, unused: false, daysSinceUse: null,
    ...over,
  };
}

describe("gatherCandidates", () => {
  it("turns a defrost task into a deadline candidate", async () => {
    const db = memoryDb();
    const d = deps(db, {
      runModule: async (name) => name !== "HealthAndMealPrep" ? null : {
        defrost: [{ item: "csirkemell", takeOutBy: "2026-09-01T12:00:00.000Z", overdue: false }],
      },
    });

    const found = await gatherCandidates(d, NOW);
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    expect(found[0]!.text).toContain("csirkemell");
    db.close();
  });

  it("turns a subscription renewal one day out into a candidate", async () => {
    const db = memoryDb();
    // The whole reason the event horizon is counted in days: this alert is
    // the closest one the finance module can emit, and it is still 21 hours
    // away at NOW — outside the four-hour instant horizon that used to be
    // applied here, which made the renewal source unreachable in production.
    const d = deps(db, {
      runModule: async (name) => name !== "FinanceAndSubs" ? null : {
        alerts: [renewalAlert({ name: "Netflix", renewsOn: "2026-09-02", daysUntil: 1 })],
      },
    });

    const found = await gatherCandidates(d, NOW);
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    // Event wording, not deadline wording: a renewal arrives, it is not missed.
    expect(found[0]!.text).toBe("Netflix megújul — holnap.");
    db.close();
  });

  it("leaves the earlier renewal alerts for later", async () => {
    const db = memoryDb();
    // The other two values `alertDaysBefore` produces. Three and seven days
    // out is a line in the daily brief, not a reason to interrupt anyone.
    const d = deps(db, {
      runModule: async (name) => name !== "FinanceAndSubs" ? null : {
        alerts: [
          renewalAlert({ name: "Spotify", renewsOn: "2026-09-04", daysUntil: 3 }),
          renewalAlert({ name: "iCloud", renewsOn: "2026-09-08", daysUntil: 7 }),
        ],
      },
    });

    expect(await gatherCandidates(d, NOW)).toEqual([]);
    db.close();
  });

  it("keeps the finance renewal when only the health module throws", async () => {
    const db = memoryDb();
    const d = deps(db, {
      runModule: async (name) => {
        if (name === "HealthAndMealPrep") throw new Error("modul elszállt");
        if (name === "FinanceAndSubs") return { alerts: [renewalAlert({ name: "Spotify" })] };
        return null;
      },
    });

    const found = await gatherCandidates(d, NOW);
    expect(found.some((c) => c.text.includes("Spotify"))).toBe(true);
    db.close();
  });

  it("reads a renewal on today's local date as arrived, not as missed", async () => {
    const db = memoryDb();
    // 21:00 Budapest on the renewal's own day: the fixed 07:00Z instant is
    // fourteen hours past, but the day is not over, so the renewal is still
    // "ma" — and never deadline vocabulary, which is untrue of something that
    // happened on schedule.
    const now = new Date("2026-09-02T19:00:00.000Z");
    const d = deps(db, {
      runModule: async (name) => name !== "FinanceAndSubs" ? null : {
        alerts: [renewalAlert({ name: "Spotify", renewsOn: "2026-09-02", daysUntil: 1 })],
      },
    });

    const found = await gatherCandidates(d, now);
    expect(found[0]!.text).toBe("Spotify megújul — ma.");
    expect(found[0]!.text).not.toContain("lejárt");
    db.close();
  });

  it("only offers analyses written since the last notification", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    const notifications = createNotificationRepo(db);

    analyses.save({ createdAt: "2026-09-01T06:00:00.000Z", domain: "physical", markdown: "#", summary: "régi", metrics: "{}" });
    notifications.record({ sentAt: new Date("2026-09-01T07:00:00.000Z"), kinds: ["analysis"], keys: ["k"], text: "t" });
    analyses.save({ createdAt: "2026-09-01T09:00:00.000Z", domain: "recovery", markdown: "#", summary: "friss", metrics: "{}" });

    const found = await gatherCandidates(deps(db, { analyses, notifications }), NOW);
    expect(found.map((c) => c.text).join(" ")).toContain("friss");
    expect(found.map((c) => c.text).join(" ")).not.toContain("régi");
    db.close();
  });

  it("offers every analysis when nothing was ever sent", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    analyses.save({ createdAt: "2026-09-01T06:00:00.000Z", domain: "physical", markdown: "#", summary: "az első", metrics: "{}" });

    const found = await gatherCandidates(deps(db, { analyses }), NOW);
    expect(found.map((c) => c.text).join(" ")).toContain("az első");
    db.close();
  });

  it("does not call a three-week-old analysis new, even on the very first tick", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    // With nothing ever sent the "since the last notification" filter passes
    // everything, so the age limit is the only thing standing between a cold
    // start and every domain's newest analysis going out at once.
    analyses.save({ createdAt: "2026-08-11T06:00:00.000Z", domain: "physical", markdown: "#", summary: "hetekkel ezelőtti", metrics: "{}" });
    analyses.save({ createdAt: "2026-09-01T06:00:00.000Z", domain: "recovery", markdown: "#", summary: "ma reggeli", metrics: "{}" });

    const found = await gatherCandidates(deps(db, { analyses }), NOW);
    const texts = found.map((c) => c.text).join(" ");
    expect(texts).toContain("ma reggeli");
    expect(texts).not.toContain("hetekkel ezelőtti");
    db.close();
  });

  it("drops an analysis just over a day old", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    // 25 hours before NOW. Yesterday morning's analysis was already there to
    // be read; announcing it now would be announcing old news.
    analyses.save({ createdAt: "2026-08-31T09:00:00.000Z", domain: "physical", markdown: "#", summary: "tegnapelőtti", metrics: "{}" });

    expect(await gatherCandidates(deps(db, { analyses }), NOW)).toEqual([]);
    db.close();
  });

  it("keeps the other sources when one of them throws", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    analyses.save({ createdAt: "2026-09-01T09:00:00.000Z", domain: "physical", markdown: "#", summary: "megmarad", metrics: "{}" });

    // The modules reach the network and the calendar; they are the likeliest
    // thing here to fail, and they must not silence a finding that is already
    // in hand.
    const d = deps(db, { analyses, runModule: async () => { throw new Error("modul elszállt"); } });

    const found = await gatherCandidates(d, NOW);
    expect(found.map((c) => c.text).join(" ")).toContain("megmarad");
    db.close();
  });

  it("keeps the modules when the metrics throw", async () => {
    const db = memoryDb();
    const d = deps(db, {
      metrics: () => { throw new Error("aggregálás elszállt"); },
      runModule: async (name) => name !== "HealthAndMealPrep" ? null : {
        defrost: [{ item: "csirkemell", takeOutBy: "2026-09-01T12:00:00.000Z", overdue: false }],
      },
    });

    const found = await gatherCandidates(d, NOW);
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    db.close();
  });

  it("records the specific failure rather than swallowing it", async () => {
    const db = memoryDb();
    const logger = recordingLogger();
    const d = deps(db, { logger, runModule: async () => { throw new Error("modul elszállt"); } });

    await gatherCandidates(d, NOW);
    // Both module calls fail here, so this asserts on the exact defrost
    // warning rather than "any warn entry", which an unrelated warning
    // elsewhere in the function could also satisfy.
    expect(logger.entries).toContainEqual(expect.objectContaining({
      level: "warn",
      msg: "defrost deadlines unavailable for the notification",
      obj: expect.objectContaining({ err: expect.stringContaining("modul elszállt") }),
    }));
    db.close();
  });
});
