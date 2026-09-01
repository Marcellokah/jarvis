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
    distanceKm: null, standMin: null, walkingSpeed: null, stepLengthCm: null,
    doubleSupportPct: null, asymmetryPct: null, steadinessPct: null,
    sixMinWalkM: null, stairUpMs: null, stairDownMs: null,
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
    const allFound = relations(input(snapshots), 30);
    const keys = allFound.map((r) => r.key);
    // Every pair that appears must be in the closed list.
    for (const k of keys) {
      expect(["load_vs_rhr", "load_vs_hrv", "hrv_vs_sleep", "steps_vs_rhr"]).toContain(k);
    }
    // And the fixture should exercise at least some of them, not return empty.
    expect(allFound.length).toBeGreaterThan(0);
  });

  it("correlates the rolling training load against resting heart rate", () => {
    // Train daily from a year ago until 100 days ago, then stop. The 28-day
    // rolling load ramps up, plateaus, then decays to zero — enough variation
    // for a correlation to mean anything.
    const trainingDays = new Set<string>();
    for (let i = 364; i >= 100; i--) trainingDays.add(shiftDay(TODAY, -i));

    const workouts = [...trainingDays].map((d) => ({
      date: d, type: "Walking", startedAt: `${d}T10:00:00.000Z`,
      durationMin: 60, energyKcal: null, source: "Watch",
    }));

    // RHR falls exactly as the load rises. The load is recomputed here rather
    // than taken from the module, so an off-by-one in its window shows up as a
    // correlation below 1 instead of agreeing with itself.
    const snapshots = Array.from({ length: 365 }, (_, i) => {
      const date = shiftDay(TODAY, -i);
      let load = 0;
      for (let k = 0; k < 28; k++) if (trainingDays.has(shiftDay(date, -k))) load += 60;
      return snap(date, { rhr: 100 - load / 28 });
    });

    const pair = relations({ today: TODAY, snapshots, workouts, months: [] }, 30)
      .find((r) => r.key === "load_vs_rhr");
    expect(pair).toBeDefined();
    expect(pair!.n).toBe(365);
    expect(pair!.r).toBeCloseTo(-1, 6);
  });

  it("correlates the rolling training load against HRV", () => {
    // Same training pattern as the RHR test: load ramps, plateaus, decays.
    // HRV rises as load rises (positive correlation).
    const trainingDays = new Set<string>();
    for (let i = 364; i >= 100; i--) trainingDays.add(shiftDay(TODAY, -i));

    const workouts = [...trainingDays].map((d) => ({
      date: d, type: "Walking", startedAt: `${d}T10:00:00.000Z`,
      durationMin: 60, energyKcal: null, source: "Watch",
    }));

    // HRV rises exactly as the load rises. Computed independently to catch
    // window off-by-one errors.
    const snapshots = Array.from({ length: 365 }, (_, i) => {
      const date = shiftDay(TODAY, -i);
      let load = 0;
      for (let k = 0; k < 28; k++) if (trainingDays.has(shiftDay(date, -k))) load += 60;
      return snap(date, { hrv: 50 + load / 28 });
    });

    const pair = relations({ today: TODAY, snapshots, workouts, months: [] }, 30)
      .find((r) => r.key === "load_vs_hrv");
    expect(pair).toBeDefined();
    expect(pair!.n).toBe(365);
    expect(pair!.r).toBeCloseTo(1, 6);
  });
});
