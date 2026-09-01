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

// The full RenewalAlert shape from src/modules/finance-subs/index.ts, so the
// reader in gather.ts is shown picking `name`/`renewsOn` out of a realistic
// object rather than a fixture minimal enough to hide a wrong field name.
function renewalAlert(over: Partial<{
  name: string; amountHuf: number; cycle: string; renewsOn: string;
  daysUntil: number; cancelUrl: string | null; unused: boolean; daysSinceUse: number | null;
}> = {}) {
  return {
    name: "Netflix", amountHuf: 4990, cycle: "monthly", renewsOn: "2026-09-01",
    daysUntil: 0, cancelUrl: null, unused: false, daysSinceUse: null,
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

  it("turns a subscription renewal into a deadline candidate", async () => {
    const db = memoryDb();
    // Before the fixed 07:00Z instant and within the 4h horizon, so this
    // exercises the ordinary "still ahead" path rather than the overdue one.
    const now = new Date("2026-09-01T04:30:00.000Z");
    const d = deps(db, {
      runModule: async (name) => name !== "FinanceAndSubs" ? null : {
        alerts: [renewalAlert({ name: "Netflix", renewsOn: "2026-09-01" })],
      },
    });

    const found = await gatherCandidates(d, now, signal());
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    expect(found[0]!.text).toContain("Netflix");
    db.close();
  });

  it("keeps the finance renewal when only the health module throws", async () => {
    const db = memoryDb();
    const now = new Date("2026-09-01T04:30:00.000Z");
    const d = deps(db, {
      runModule: async (name) => {
        if (name === "HealthAndMealPrep") throw new Error("modul elszállt");
        if (name === "FinanceAndSubs") return { alerts: [renewalAlert({ name: "Spotify" })] };
        return null;
      },
    });

    const found = await gatherCandidates(d, now, signal());
    expect(found.some((c) => c.text.includes("Spotify"))).toBe(true);
    db.close();
  });

  it("marks a renewal already past its fixed instant as overdue rather than dropping it", async () => {
    const db = memoryDb();
    // renewsOn is three days before `now` — well outside the 4h horizon. If
    // `overdue` were still hardcoded false this candidate would be filtered
    // out silently instead of surfacing as already-elapsed.
    const now = new Date("2026-09-04T10:00:00.000Z");
    const d = deps(db, {
      runModule: async (name) => name !== "FinanceAndSubs" ? null : {
        alerts: [renewalAlert({ name: "Spotify", renewsOn: "2026-09-01", daysUntil: -3 })],
      },
    });

    const found = await gatherCandidates(d, now, signal());
    expect(found.some((c) => c.text.includes("Spotify"))).toBe(true);
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

  it("records the specific failure rather than swallowing it", async () => {
    const db = memoryDb();
    const logger = recordingLogger();
    const d = deps(db, { logger, runModule: async () => { throw new Error("modul elszállt"); } });

    await gatherCandidates(d, NOW, signal());
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
