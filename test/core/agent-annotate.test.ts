import { describe, it, expect } from "vitest";
import { baselineFor, annotate } from "../../src/core/agent/annotate.ts";
import type { Point } from "../../src/core/analysis/stats.ts";

/** 90 days of HRV around 55, then the 203.6 that started all of this. */
const points: Point[] = Array.from({ length: 90 }, (_, i) => ({
  date: `2026-0${i < 31 ? "6" : i < 61 ? "7" : "8"}-${String((i % 30) + 1).padStart(2, "0")}`,
  value: 55 + (i % 5) - 2,
}));

describe("baselineFor", () => {
  it("returns null below the sample floor rather than a confident number", () => {
    expect(baselineFor(points.slice(0, 5), "2026-08-30", 90)).toBeNull();
  });

  it("computes mean, sd and the all-time extremes", () => {
    const base = baselineFor(points, "2026-08-30", 90)!;
    expect(base.n).toBeGreaterThanOrEqual(20);
    expect(base.mean).toBeCloseTo(55, 0);
    expect(base.sd).toBeGreaterThan(0);
    expect(base.allTimeMax).toBe(57);
  });
});

describe("annotate", () => {
  it("names the sigma distance so a far value cannot read as ordinary", () => {
    const base = { mean: 55.8, sd: 15.2, n: 84, allTimeMax: 157.1, allTimeMin: 9.9 };
    const text = annotate(203.6, base);
    expect(text).toContain("203,6");
    expect(text).toMatch(/\+9,[0-9]σ/);
    expect(text).toContain("minden idők maximuma");
  });

  it("says nothing beyond the number when the value is ordinary", () => {
    const base = { mean: 55.8, sd: 15.2, n: 84, allTimeMax: 157.1, allTimeMin: 9.9 };
    expect(annotate(57, base)).toBe("57 (+0,1σ)");
  });

  it("marks an all-time low too", () => {
    const base = { mean: 55.8, sd: 15.2, n: 84, allTimeMax: 157.1, allTimeMin: 9.9 };
    expect(annotate(9.9, base)).toContain("minden idők minimuma");
  });

  it("refuses to imply a baseline it does not have", () => {
    expect(annotate(203.6, null)).toBe("203,6 (nincs elég mérés a viszonyításhoz)");
  });
});
