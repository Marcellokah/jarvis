import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordSubscriptionMonth } from "../../src/core/subscription-snapshot.ts";
import { createSubscriptionRepo, type SubscriptionSeed } from "../../src/infra/db/repositories/subscriptions.ts";
import { createSubscriptionMonthRepo } from "../../src/infra/db/repositories/subscription-months.ts";
import { fakeClock } from "../../src/infra/clock.ts";
import { memoryDb } from "../helpers.ts";
import type { Db } from "../../src/infra/db/index.ts";

// This is the one implementation both main.ts (start-up) and
// infra/scheduler.ts (04:00 sweep) call — exercising it directly here is what
// stands in for testing either call site, and is what would have caught the
// isoDate(now) vs. isoDate(now, TZ) drift between their two former copies.

function sub(p: Partial<SubscriptionSeed> & Pick<SubscriptionSeed, "name" | "nextRenewal">): SubscriptionSeed {
  return {
    amountHuf: 5000, cycle: "monthly", category: null, cancelUrl: null,
    lastUsedAt: null, notes: null, ...p,
  };
}

let db: Db;
beforeEach(() => { db = memoryDb(); });
afterEach(() => { db.close(); });

describe("recordSubscriptionMonth", () => {
  it("snapshots every subscription, including an inactive one", () => {
    const subscriptions = createSubscriptionRepo(db);
    subscriptions.replaceAll([
      sub({ name: "Netflix", nextRenewal: "2026-09-07" }),
      sub({ name: "HBO Max", nextRenewal: "2026-09-10", active: false }),
    ]);
    const subscriptionMonths = createSubscriptionMonthRepo(db);

    recordSubscriptionMonth({
      subscriptions, subscriptionMonths, clock: fakeClock("2026-08-31T10:00:00Z"),
    });

    const august = subscriptionMonths.forMonth("2026-08");
    expect(august.map((s) => s.name).sort()).toEqual(["HBO Max", "Netflix"]);
    expect(august.find((s) => s.name === "HBO Max")!.active).toBe(false);
  });

  it("keys the month by Budapest local time, not raw UTC", () => {
    // 22:30 UTC on Aug 31 is already past midnight (00:30 CEST) in Budapest —
    // a UTC-naive `now.toISOString().slice(0, 7)` would misfile this under
    // August. Budapest local time is what the brief's own reasoning ("did the
    // Mac see this month") depends on.
    const subscriptions = createSubscriptionRepo(db);
    subscriptions.replaceAll([sub({ name: "Netflix", nextRenewal: "2026-09-07" })]);
    const subscriptionMonths = createSubscriptionMonthRepo(db);

    recordSubscriptionMonth({
      subscriptions, subscriptionMonths, clock: fakeClock("2026-08-31T22:30:00Z"),
    });

    expect(subscriptionMonths.months()).toEqual(["2026-09"]);
    expect(subscriptionMonths.forMonth("2026-08")).toHaveLength(0);
  });
});
