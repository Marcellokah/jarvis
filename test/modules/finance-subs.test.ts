import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { financeAndSubs, nextOccurrence } from "../../src/modules/finance-subs/index.ts";
import { createSubscriptionRepo, type SubscriptionSeed } from "../../src/infra/db/repositories/subscriptions.ts";
import { memoryDb, ctxAt } from "../helpers.ts";
import type { Db } from "../../src/infra/db/index.ts";

const cfg = { enabled: true, alertDaysBefore: [7, 3, 1], unusedAfterDays: 60 };
const mod = financeAndSubs(cfg);
const MONDAY = "2026-08-31T06:20:00+02:00";

function sub(p: Partial<SubscriptionSeed> & Pick<SubscriptionSeed, "name" | "nextRenewal">): SubscriptionSeed {
  return {
    amountHuf: 5000, cycle: "monthly", category: null, cancelUrl: null,
    lastUsedAt: null, notes: null, ...p,
  };
}

let db: Db;
beforeEach(() => { db = memoryDb(); });
afterEach(() => { db.close(); });

const seed = (subs: SubscriptionSeed[]) => createSubscriptionRepo(db).replaceAll(subs);

describe("renewal alerts", () => {
  it("alerts at exactly the configured lead times", async () => {
    seed([
      sub({ name: "Holnap", nextRenewal: "2026-09-01" }),   // 1 day
      sub({ name: "Három nap", nextRenewal: "2026-09-03" }), // 3 days
      sub({ name: "Hét nap", nextRenewal: "2026-09-07" }),   // 7 days
      sub({ name: "Öt nap", nextRenewal: "2026-09-05" }),    // 5 — not a lead time
    ]);

    const result = await mod.execute(ctxAt(MONDAY, db));
    expect(result!.data.alerts.map((a) => a.name)).toEqual(["Holnap", "Három nap", "Hét nap"]);
  });

  it("treats an imminent renewal as critical", async () => {
    seed([sub({ name: "Telekom", nextRenewal: "2026-09-01", amountHuf: 12990 })]);
    const result = await mod.execute(ctxAt(MONDAY, db));

    expect(result!.priority).toBe("critical");
    expect(mod.renderPlain(result!)).toContain("holnap");
    // hu-HU groups with a non-breaking space (U+00A0), not a plain space.
    expect(mod.renderPlain(result!)).toMatch(/12\s990\sFt/);
  });

  it("stays quiet when nothing renews soon and nothing is idle", async () => {
    seed([sub({ name: "Távoli", nextRenewal: "2026-09-20", lastUsedAt: "2026-08-30" })]);
    expect(await mod.execute(ctxAt(MONDAY, db))).toBeNull();
  });
});

describe("unused subscriptions", () => {
  it("flags a subscription idle past the threshold and offers to cancel it", async () => {
    seed([sub({
      name: "Netflix", nextRenewal: "2026-09-07", amountHuf: 4490,
      lastUsedAt: "2026-06-01", cancelUrl: "https://netflix.com/cancelplan",
    })]);

    const result = await mod.execute(ctxAt(MONDAY, db));

    expect(result!.data.unused[0]).toMatchObject({ name: "Netflix" });
    const proposal = result!.actions.find((a) => a.kind === "proposal");
    if (proposal?.kind !== "proposal") throw new Error("expected a calendar proposal");
    // The reminder must land before the money moves, not after.
    expect(proposal.proposal.start).toContain("2026-09-06");
    expect(proposal.proposal.notes).toContain("netflix.com/cancelplan");
  });

  it("does not offer to cancel something with no cancel URL", async () => {
    seed([sub({ name: "Valami", nextRenewal: "2026-09-07", lastUsedAt: "2026-01-01" })]);
    const result = await mod.execute(ctxAt(MONDAY, db));
    expect(result!.actions.filter((a) => a.kind === "proposal")).toHaveLength(0);
  });

  it("reports idle subscriptions even when nothing is renewing", async () => {
    seed([sub({ name: "Rég nem használt", nextRenewal: "2026-09-25", lastUsedAt: "2026-01-01" })]);
    const result = await mod.execute(ctxAt(MONDAY, db));
    expect(result!.data.unused).toHaveLength(1);
    expect(result!.priority).toBe("normal");
  });
});

describe("totals", () => {
  it("normalises every cycle to a monthly figure", async () => {
    seed([
      sub({ name: "Havi", nextRenewal: "2026-09-01", amountHuf: 1000, cycle: "monthly" }),
      sub({ name: "Éves", nextRenewal: "2026-09-01", amountHuf: 12000, cycle: "annual" }),
      sub({ name: "Negyedéves", nextRenewal: "2026-09-01", amountHuf: 3000, cycle: "quarterly" }),
    ]);

    const result = await mod.execute(ctxAt(MONDAY, db));
    expect(result!.data.monthlyTotalHuf).toBe(3000); // 1000 + 1000 + 1000
    expect(result!.data.annualTotalHuf).toBe(36000);
  });
});

describe("nextOccurrence", () => {
  it("rolls a long-past date forward so the YAML never needs editing", () => {
    expect(nextOccurrence("2024-03-05", "monthly", "2026-08-31")).toBe("2026-09-05");
    expect(nextOccurrence("2020-09-03", "annual", "2026-08-31")).toBe("2026-09-03");
  });

  it("keeps a future date untouched", () => {
    expect(nextOccurrence("2026-12-01", "monthly", "2026-08-31")).toBe("2026-12-01");
  });

  it("anchors on the original day so month-end dates do not drift", () => {
    // The classic bug: adding a month to 31 Jan lands on 3 March, and every
    // subsequent renewal is then wrong by a few days, forever.
    expect(nextOccurrence("2026-01-31", "monthly", "2026-02-15")).toBe("2026-02-28");
    expect(nextOccurrence("2026-01-31", "monthly", "2026-03-15")).toBe("2026-03-31");
    expect(nextOccurrence("2026-01-31", "monthly", "2026-04-15")).toBe("2026-04-30");
  });

  it("handles a leap day", () => {
    expect(nextOccurrence("2024-02-29", "annual", "2026-01-01")).toBe("2026-02-28");
  });
});

describe("usage marking", () => {
  it("matches a subscription by fragment, as /used gym would", () => {
    seed([sub({ name: "Gym bérlet", nextRenewal: "2026-09-01" })]);
    const updated = createSubscriptionRepo(db).markUsed("gym", new Date(MONDAY));
    expect(updated?.lastUsedAt).toBe("2026-08-31");
  });

  it("preserves usage marks across a re-seed from YAML", () => {
    const repo = createSubscriptionRepo(db);
    seed([sub({ name: "Gym", nextRenewal: "2026-09-01" })]);
    repo.markUsed("gym", new Date(MONDAY));

    // Re-seeding must not wipe what you told it through Telegram.
    seed([sub({ name: "Gym", nextRenewal: "2026-09-01", lastUsedAt: null })]);
    expect(repo.listActive()[0]!.lastUsedAt).toBe("2026-08-31");
  });
});
