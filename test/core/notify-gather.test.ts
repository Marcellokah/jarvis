import { describe, it, expect } from "vitest";
import { gatherCandidates, type GatherDeps } from "../../src/core/notify/gather.ts";
import { createNotificationRepo } from "../../src/infra/db/repositories/notifications.ts";
import { createAnalysisRepo } from "../../src/infra/db/repositories/analyses.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Db } from "../../src/infra/db/index.ts";

const NOW = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Budapest
const signal = () => new AbortController().signal;

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

describe("gatherCandidates", () => {
  it("turns a defrost task into a deadline candidate", async () => {
    const db = memoryDb();
    const d = deps(db, {
      runModule: async (name) => name !== "HealthAndMealPrep" ? null : {
        defrost: [{ item: "csirkemell", takeOutBy: "2026-09-01T12:00:00.000Z", overdue: false }],
      },
    });

    const found = await gatherCandidates(d, NOW, signal());
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    expect(found[0]!.text).toContain("csirkemell");
    db.close();
  });

  it("only offers analyses written since the last notification", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    const notifications = createNotificationRepo(db);

    analyses.save({ createdAt: "2026-09-01T06:00:00.000Z", domain: "physical", markdown: "#", summary: "régi", metrics: "{}" });
    notifications.record({ sentAt: new Date("2026-09-01T07:00:00.000Z"), kinds: ["analysis"], keys: ["k"], text: "t" });
    analyses.save({ createdAt: "2026-09-01T09:00:00.000Z", domain: "recovery", markdown: "#", summary: "friss", metrics: "{}" });

    const found = await gatherCandidates(deps(db, { analyses, notifications }), NOW, signal());
    expect(found.map((c) => c.text).join(" ")).toContain("friss");
    expect(found.map((c) => c.text).join(" ")).not.toContain("régi");
    db.close();
  });

  it("offers every analysis when nothing was ever sent", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    analyses.save({ createdAt: "2026-09-01T06:00:00.000Z", domain: "physical", markdown: "#", summary: "az első", metrics: "{}" });

    const found = await gatherCandidates(deps(db, { analyses }), NOW, signal());
    expect(found.map((c) => c.text).join(" ")).toContain("az első");
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

    const found = await gatherCandidates(d, NOW, signal());
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

    const found = await gatherCandidates(d, NOW, signal());
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    db.close();
  });

  it("records the failure rather than swallowing it", async () => {
    const db = memoryDb();
    const logger = recordingLogger();
    const d = deps(db, { logger, runModule: async () => { throw new Error("modul elszállt"); } });

    await gatherCandidates(d, NOW, signal());
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
    db.close();
  });
});
