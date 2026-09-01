import { describe, it, expect } from "vitest";
import { aggregate, type AggregateInput } from "../../src/core/analysis/aggregate.ts";
import { shiftDay } from "../../src/core/analysis/stats.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";
import type { WorkoutRow } from "../../src/infra/health-export/rollup.ts";

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

function workout(date: string, durationMin: number, type = "Walking"): WorkoutRow {
  return { date, type, startedAt: `${date}T10:00:00.000Z`, durationMin, energyKcal: null, source: "Watch" };
}

function input(p: Partial<AggregateInput> = {}): AggregateInput {
  return { today: TODAY, snapshots: [], workouts: [], months: [], ...p };
}

describe("aggregate — physical", () => {
  it("computes the load ratio from daily averages, not raw totals", () => {
    // 60 minutes every day for a full year: the 28-day and 365-day daily
    // averages are equal, so the ratio is 1 whatever the totals are.
    const workouts = Array.from({ length: 365 }, (_, i) => workout(shiftDay(TODAY, -i), 60));
    const m = aggregate(input({ workouts }));
    expect(m.physical.loadRatio).toBeCloseTo(1, 6);
  });

  it("measures load against the window, not against the days trained", () => {
    // Daily for the last 28 days, then only every fourth day before that.
    // Dividing by the window length gives roughly 3.3; dividing by days trained
    // would give 1.0, so this fixture tells the two apart.
    const recent = Array.from({ length: 28 }, (_, i) => workout(shiftDay(TODAY, -i), 60));
    const older = Array.from({ length: 84 }, (_, i) => workout(shiftDay(TODAY, -(28 + i * 4)), 60));
    const ratio = aggregate(input({ workouts: [...recent, ...older] })).physical.loadRatio!;
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(4);
  });

  it("shows a ratio below 1 when recent training has dropped off", () => {
    // Trained daily for the year, but nothing in the last 28 days.
    const workouts = Array.from({ length: 365 }, (_, i) => workout(shiftDay(TODAY, -(i + 28)), 60));
    const m = aggregate(input({ workouts }));
    expect(m.physical.loadRatio).toBe(0);
  });

  it("is null when there is no long-run baseline to compare against", () => {
    const m = aggregate(input({ workouts: [workout(TODAY, 60)] }));
    // One day of training is not a 365-day baseline; a ratio here would be
    // arithmetically computable and completely meaningless.
    expect(m.physical.loadRatio).toBeNull();
  });

  it("has no ratio for someone with no history before the window being measured", () => {
    // 28 days of daily training and nothing before it satisfies a naive guard on
    // the strength of the very days being measured, and reports about 13x.
    const workouts = Array.from({ length: 28 }, (_, i) => workout(shiftDay(TODAY, -i), 60));
    expect(aggregate(input({ workouts })).physical.loadRatio).toBeNull();
  });

  it("counts strength sessions per week over 28 days", () => {
    const workouts = [
      workout(shiftDay(TODAY, -1), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -3), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -8), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -10), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -40), 60, "TraditionalStrengthTraining"), // outside
      workout(shiftDay(TODAY, -2), 60, "Walking"),                      // not strength
    ];
    const m = aggregate(input({ workouts }));
    expect(m.physical.strengthPerWeek28d).toBeCloseTo(4 / 4, 6);
  });

  it("groups training by month with hours, sessions and strength count", () => {
    const workouts = [
      workout("2026-08-02", 90, "TraditionalStrengthTraining"),
      workout("2026-08-03", 30),
      workout("2026-07-15", 60),
    ];
    const m = aggregate(input({ workouts }));
    expect(m.physical.byMonth).toEqual([
      { month: "2026-07", hours: 1, sessions: 1, strength: 0 },
      { month: "2026-08", hours: 2, sessions: 2, strength: 1 },
    ]);
  });

  it("carries the VO2max trend as a slope per 30 days", () => {
    // Rising from 34.0 to 40.0 over 60 days: 0.1/day = 3.0 per 30 days.
    const snapshots = Array.from({ length: 61 }, (_, i) =>
      snap(shiftDay(TODAY, -60 + i), { vo2max: 40 - (60 - i) * 0.1 }));
    const m = aggregate(input({ snapshots }));
    expect(m.physical.vo2max.slopePer30d).toBeCloseTo(3, 5);
    expect(m.physical.vo2max.n).toBe(61);
  });
});

describe("aggregate — recovery", () => {
  it("expresses the recent HRV deviation in standard deviations", () => {
    // 90 days at 50 with a spread, then 7 days at 60.
    const snapshots = [
      ...Array.from({ length: 83 }, (_, i) =>
        snap(shiftDay(TODAY, -(i + 7)), { hrv: i % 2 === 0 ? 45 : 55 })),
      ...Array.from({ length: 7 }, (_, i) => snap(shiftDay(TODAY, -i), { hrv: 60 })),
    ];
    const m = aggregate(input({ snapshots }));
    expect(m.recovery.hrvDeviationSigma).not.toBeNull();
    expect(m.recovery.hrvDeviationSigma!).toBeGreaterThan(0);
  });

  it("reports sleep coverage per year, because the sparsity is the finding", () => {
    const snapshots = [
      snap("2025-01-01", { asleepMin: 400 }),
      snap("2025-01-02"),
      snap("2026-01-01", { asleepMin: 420 }),
    ];
    const m = aggregate(input({ snapshots }));
    expect(m.recovery.sleepByYear).toEqual([
      { year: "2025", days: 2, withSleep: 1 },
      { year: "2026", days: 1, withSleep: 1 },
    ]);
  });

  it("leaves a metric null rather than zero when nothing was measured", () => {
    const m = aggregate(input({ snapshots: [snap(TODAY)] }));
    expect(m.recovery.hrv.d28.value).toBeNull();
    expect(m.recovery.hrv.d28.n).toBe(0);
    expect(m.recovery.asleepMin.d90.value).toBeNull();
  });
});

describe("aggregate — finance", () => {
  const months = [
    { month: "2026-07", subs: [
      { name: "Netflix", amountHuf: 4490, cycle: "monthly", active: true },
      { name: "Gym", amountHuf: 19900, cycle: "monthly", active: true },
    ] },
    { month: "2026-08", subs: [
      { name: "Netflix", amountHuf: 4990, cycle: "monthly", active: true },
      { name: "Gym", amountHuf: 19900, cycle: "monthly", active: false },
    ] },
  ];

  it("totals only what was active in the month", () => {
    const m = aggregate(input({ months }));
    expect(m.finance.months).toEqual([
      { month: "2026-07", totalHuf: 24390, activeCount: 2 },
      { month: "2026-08", totalHuf: 4990, activeCount: 1 },
    ]);
  });

  it("names what changed between the last two months", () => {
    const m = aggregate(input({ months }));
    expect(m.finance.monthOverMonth).toEqual({
      from: "2026-07", to: "2026-08", deltaHuf: -19400,
      changes: [
        { name: "Gym", fromHuf: 19900, toHuf: null },
        { name: "Netflix", fromHuf: 4490, toHuf: 4990 },
      ],
    });
  });

  it("has nothing to compare in the first month, and says so with null", () => {
    const m = aggregate(input({ months: months.slice(0, 1) }));
    // The table was created in S2; there is no history before it, and an
    // invented comparison would be an estimate wearing a measurement's clothes.
    expect(m.finance.monthOverMonth).toBeNull();
  });

  it("annualises the latest month's total spending", () => {
    const m = aggregate(input({ months }));
    // August total is 4990, so annualised is 4990 * 12.
    expect(m.finance.annualisedHuf).toBe(59880);
  });
});
