import { describe, it, expect } from "vitest";
import { relations } from "../../src/core/analysis/relations.ts";
import { shiftDay } from "../../src/core/analysis/stats.ts";
import type { AggregateInput } from "../../src/core/analysis/aggregate.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

const TODAY = "2026-08-31";

function snap(date: string, p: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    date, sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null,
    steps: null, asleepMin: null, inBedMin: null, coreMin: null, remMin: null,
    deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
    walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
    dietProteinG: null, dietCarbsG: null, dietFatG: null,
    ingestedAt: "2026-08-31T00:00:00.000Z", ...p,
  };
}

function input(snapshots: HealthSnapshot[]): AggregateInput {
  return { today: TODAY, snapshots, workouts: [], months: [] };
}

describe("relations", () => {
  it("drops a pair below the minimum sample size entirely", () => {
    // 10 days of a flawless relationship is still 10 days. It must not appear
    // as a weak correlation — it must not appear at all.
    const snapshots = Array.from({ length: 10 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50 + i, asleepMin: 300 + i * 10 }));
    expect(relations(input(snapshots), 30)).toEqual([]);
  });

  it("reports a pair once it clears the minimum, with n and the window", () => {
    const snapshots = Array.from({ length: 40 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50 + i, asleepMin: 300 + i * 10 }));
    const found = relations(input(snapshots), 30);
    const pair = found.find((r) => r.key === "hrv_vs_sleep");
    expect(pair).toBeDefined();
    expect(pair!.n).toBe(40);
    expect(pair!.r).toBeCloseTo(1, 6);
    expect(pair!.window).toBe("teljes átfedés");
  });

  it("pairs only the days where both values are present", () => {
    const snapshots = [
      ...Array.from({ length: 35 }, (_, i) =>
        snap(shiftDay(TODAY, -i), { hrv: 50 + i, asleepMin: 300 + i * 10 })),
      // Fifty days carrying only one side of the pair — they cannot join it.
      ...Array.from({ length: 50 }, (_, i) => snap(shiftDay(TODAY, -(i + 40)), { hrv: 99 })),
    ];
    const pair = relations(input(snapshots), 30).find((r) => r.key === "hrv_vs_sleep");
    expect(pair!.n).toBe(35);
  });

  it("omits a pair whose correlation cannot be computed", () => {
    // HRV never varies: there is no relationship to measure, and 0 would be
    // a claim rather than an absence.
    const snapshots = Array.from({ length: 40 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50, asleepMin: 300 + i * 10 }));
    expect(relations(input(snapshots), 30).find((r) => r.key === "hrv_vs_sleep")).toBeUndefined();
  });

  it("keeps every pair it returns inside the closed list", () => {
    const snapshots = Array.from({ length: 400 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50 + (i % 7), rhr: 60 + (i % 5), steps: 8000 + i, asleepMin: 400 + (i % 9) }));
    const keys = relations(input(snapshots), 30).map((r) => r.key);
    for (const k of keys) {
      expect(["load_vs_rhr", "load_vs_hrv", "hrv_vs_sleep", "steps_vs_rhr"]).toContain(k);
    }
  });
});
