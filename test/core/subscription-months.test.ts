import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createSubscriptionMonthRepo } from "../../src/infra/db/repositories/subscription-months.ts";

const NOW = new Date("2026-08-31T10:00:00Z");
const subs = [
  { name: "Netflix", amountHuf: 4490, cycle: "monthly" as const, active: true },
  { name: "Gym", amountHuf: 19900, cycle: "monthly" as const, active: true },
];

describe("monthly subscription snapshot", () => {
  it("records what was active in a month", () => {
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-08", subs, NOW);

    const august = repo.forMonth("2026-08");
    expect(august.map((s) => s.name).sort()).toEqual(["Gym", "Netflix"]);
    expect(august.find((s) => s.name === "Netflix")!.amountHuf).toBe(4490);
    db.close();
  });

  it("overwrites the same month rather than accumulating duplicates", () => {
    // It runs on every start and every night: the month-end state is what counts.
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-08", subs, NOW);
    repo.record("2026-08", [{ ...subs[0]!, amountHuf: 4990 }], NOW);

    const august = repo.forMonth("2026-08");
    expect(august).toHaveLength(1);
    expect(august[0]!.amountHuf).toBe(4990);
    db.close();
  });

  it("keeps months apart, which is the whole point", () => {
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-07", [{ ...subs[0]!, amountHuf: 3990 }], NOW);
    repo.record("2026-08", [{ ...subs[0]!, amountHuf: 4490 }], NOW);

    expect(repo.forMonth("2026-07")[0]!.amountHuf).toBe(3990);
    expect(repo.forMonth("2026-08")[0]!.amountHuf).toBe(4490);
    expect(repo.months()).toEqual(["2026-07", "2026-08"]);
    db.close();
  });

  it("records an inactive subscription too, so a cancellation is visible", () => {
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-08", [{ ...subs[0]!, active: false }], NOW);
    expect(repo.forMonth("2026-08")[0]!.active).toBe(false);
    db.close();
  });
});
