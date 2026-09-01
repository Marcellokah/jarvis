import { describe, it, expect } from "vitest";
import { rollup } from "../../src/infra/health-export/rollup.ts";
import type { ExportEntry } from "../../src/infra/health-export/reader.ts";

async function* stream(entries: ExportEntry[]): AsyncIterable<ExportEntry> {
  for (const e of entries) yield e;
}

function record(type: string, value: string, unit: string, day = "2026-09-01"): ExportEntry {
  return {
    kind: "record", type, value, unit,
    startDate: `${day} 10:00:00 +0200`, endDate: `${day} 10:01:00 +0200`,
    source: "Marcell's Apple Watch",
  };
}

describe("rollup — mobility", () => {
  it("sums distance across the day", async () => {
    const r = await rollup(stream([
      record("DistanceWalkingRunning", "2.5", "km"),
      record("DistanceWalkingRunning", "1.5", "km"),
    ]));
    expect(r.days[0]!.values.distance_km).toBeCloseTo(4, 6);
  });

  it("averages walking speed rather than summing it", async () => {
    // Speed is a rate: adding two readings would invent a pace nobody walked.
    const r = await rollup(stream([
      record("WalkingSpeed", "4.0", "km/hr"),
      record("WalkingSpeed", "5.0", "km/hr"),
    ]));
    expect(r.days[0]!.values.walking_speed).toBeCloseTo(4.5, 6);
  });

  it("takes every one of the ten new types", async () => {
    const r = await rollup(stream([
      record("DistanceWalkingRunning", "3", "km"),
      record("AppleStandTime", "12", "min"),
      record("WalkingSpeed", "4.4", "km/hr"),
      record("WalkingStepLength", "72", "cm"),
      record("WalkingDoubleSupportPercentage", "27", "%"),
      record("WalkingAsymmetryPercentage", "1.5", "%"),
      record("AppleWalkingSteadiness", "88", "%"),
      record("SixMinuteWalkTestDistance", "540", "m"),
      record("StairAscentSpeed", "0.42", "m/s"),
      record("StairDescentSpeed", "0.55", "m/s"),
    ]));
    const v = r.days[0]!.values;
    expect(Object.keys(v).sort()).toEqual([
      "asymmetry_pct", "distance_km", "double_support_pct", "six_min_walk_m",
      "stair_down_ms", "stair_up_ms", "stand_min", "steadiness_pct",
      "step_length_cm", "walking_speed",
    ]);
  });

  it("drops a type whose unit does not match, and says so", async () => {
    // A silent unit change would rescale a whole column. The skipped map is
    // what makes that visible on the very first import.
    const r = await rollup(stream([record("WalkingSpeed", "4.4", "mph")]));
    expect(r.days).toEqual([]);
    expect(Object.keys(r.skipped).join(" ")).toMatch(/WalkingSpeed.*egység/);
  });
});
