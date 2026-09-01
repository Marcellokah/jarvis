import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSubscriptionRepo, type SubscriptionSeed } from "../../src/infra/db/repositories/subscriptions.ts";
import { memoryDb } from "../helpers.ts";
import type { Db } from "../../src/infra/db/index.ts";

function sub(p: Partial<SubscriptionSeed> & Pick<SubscriptionSeed, "name" | "nextRenewal">): SubscriptionSeed {
  return {
    amountHuf: 5000, cycle: "monthly", category: null, cancelUrl: null,
    lastUsedAt: null, notes: null, ...p,
  };
}

let db: Db;
beforeEach(() => { db = memoryDb(); });
afterEach(() => { db.close(); });

describe("listAll", () => {
  it("returns inactive rows too, unlike listActive", () => {
    const repo = createSubscriptionRepo(db);
    repo.replaceAll([
      sub({ name: "Netflix", nextRenewal: "2026-09-07" }),
      sub({ name: "HBO Max", nextRenewal: "2026-09-10", active: false }),
    ]);

    expect(repo.listAll().map((s) => s.name)).toEqual(["HBO Max", "Netflix"]);
    expect(repo.listActive().map((s) => s.name)).toEqual(["Netflix"]);
  });
});
