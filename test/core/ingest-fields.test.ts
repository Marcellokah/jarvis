import { describe, it, expect } from "vitest";
import { readSnapshot } from "../../src/delivery/http/routes/ingest.ts";

describe("readSnapshot — the widened channel", () => {
  it("accepts the point-in-time measurements", () => {
    const r = readSnapshot({
      hrv: 68, rhr: 48, vo2max: 38.4, hrRecovery: 24, walkingHr: 96,
      walkingSpeed: 4.4, stepLengthCm: 72, doubleSupportPct: 27,
      asymmetryPct: 1.5, steadinessPct: 88, sixMinWalkM: 540,
      stairUpMs: 0.42, stairDownMs: 0.55,
    });
    expect(r.ignored).toEqual([]);
    expect(r.accepted).toHaveLength(13);
    expect(r.values.walkingSpeed).toBe(4.4);
  });

  it("accepts the accumulating totals", () => {
    const r = readSnapshot({
      steps: 11121, distanceKm: 8.4, moveKcal: 640, basalKcal: 1720,
      exerciseMin: 41, flights: 12, standMin: 540,
      dietKcal: 2210, dietProteinG: 138, dietCarbsG: 210, dietFatG: 78,
    });
    expect(r.ignored).toEqual([]);
    expect(r.accepted).toHaveLength(11);
  });

  it("treats zero as absent where zero is impossible", () => {
    // Nobody walks at zero speed or eats zero calories; a zero here is a
    // Shortcut that found no sample and substituted one.
    const r = readSnapshot({ walkingSpeed: 0, dietKcal: 0, vo2max: 0 });
    expect(r.accepted).toEqual([]);
    expect(r.ignored.map((i) => i.field).sort()).toEqual(["dietKcal", "vo2max", "walkingSpeed"]);
  });

  it("keeps zero where zero is a real reading", () => {
    // A day with no stairs climbed is a fact about the day.
    const r = readSnapshot({ steps: 0, flights: 0, distanceKm: 0, standMin: 0 });
    expect(r.ignored).toEqual([]);
    expect(r.values.flights).toBe(0);
  });

  it("still rejects one bad field without losing the others", () => {
    const r = readSnapshot({ hrv: 68, rhr: 5 });
    expect(r.values.hrv).toBe(68);
    expect(r.ignored.map((i) => i.field)).toEqual(["rhr"]);
  });
});
