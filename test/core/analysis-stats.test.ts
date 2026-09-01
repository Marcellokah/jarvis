import { describe, it, expect } from "vitest";
import {
  shiftDay, mean, stdDev, slopePer30d, pearson, windowed,
} from "../../src/core/analysis/stats.ts";

describe("shiftDay", () => {
  it("does calendar arithmetic, unaffected by daylight saving", () => {
    // Budapest switches on 2026-03-29. A naive local-time shift would land on
    // the wrong day here; these are plain date labels, so the answer is exact.
    expect(shiftDay("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftDay("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2024-02-28", 1)).toBe("2024-02-29");
  });
});

describe("mean and stdDev", () => {
  it("returns null rather than a number it cannot justify", () => {
    expect(mean([])).toBeNull();
    expect(stdDev([])).toBeNull();
    // One sample has no spread; a zero here would read as "perfectly stable".
    expect(stdDev([5])).toBeNull();
  });

  it("computes the sample standard deviation", () => {
    expect(mean([2, 4, 6])).toBe(4);
    // sample sd of [2,4,6]: sqrt(((-2)^2 + 0 + 2^2) / 2) = sqrt(4) = 2
    expect(stdDev([2, 4, 6])).toBe(2);
  });
});

describe("slopePer30d", () => {
  it("expresses the trend per 30 days, not per day", () => {
    // -0.1 per day over 60 days => -3.0 per 30 days.
    const points = Array.from({ length: 61 }, (_, i) => ({
      date: shiftDay("2026-01-01", i),
      value: 40 - i * 0.1,
    }));
    expect(slopePer30d(points)).toBeCloseTo(-3, 6);
  });

  it("uses the real day gaps, not the position in the array", () => {
    // Two points 100 days apart, rising by 10: 3 per 30 days.
    const points = [
      { date: "2026-01-01", value: 0 },
      { date: "2026-02-01", value: 3.1 },
      { date: "2026-04-11", value: 10 },
    ];
    expect(slopePer30d(points)).toBeCloseTo(3, 1);
  });

  it("returns null below three points", () => {
    expect(slopePer30d([{ date: "2026-01-01", value: 1 }])).toBeNull();
    expect(slopePer30d([
      { date: "2026-01-01", value: 1 }, { date: "2026-01-02", value: 2 },
    ])).toBeNull();
  });
});

describe("pearson", () => {
  it("is 1 for a perfect rise and -1 for a perfect fall", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 9);
  });

  it("refuses when a side has no variance", () => {
    // A flat series correlates with nothing; 0 would be a claim, null is honest.
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("returns null below three pairs and on a length mismatch", () => {
    expect(pearson([1, 2], [2, 4])).toBeNull();
    expect(pearson([1, 2, 3], [1, 2])).toBeNull();
  });
});

describe("windowed", () => {
  const points = [
    { date: "2026-08-25", value: 10 },
    { date: "2026-08-30", value: 20 },
    { date: "2026-08-31", value: 30 },
    // Outside a 7-day window ending 2026-08-31.
    { date: "2026-08-01", value: 1000 },
  ];

  it("averages only what falls inside the window", () => {
    const w = windowed(points, "2026-08-31", 7, "7d");
    expect(w.value).toBe(20);
    expect(w.n).toBe(3);
    expect(w.window).toBe("7d");
  });

  it("reports coverage as the share of days that had a reading", () => {
    const w = windowed(points, "2026-08-31", 7, "7d");
    expect(w.coverage).toBeCloseTo(3 / 7, 9);
  });

  it("is empty, not zero, when nothing falls inside", () => {
    const w = windowed(points, "2027-01-01", 7, "7d");
    expect(w.value).toBeNull();
    expect(w.n).toBe(0);
    expect(w.coverage).toBe(0);
  });

  it("includes the end day and excludes the day that falls off the far edge", () => {
    // A 7-day window ending 2026-08-31 covers 08-25..08-31 inclusive.
    expect(windowed([{ date: "2026-08-25", value: 1 }], "2026-08-31", 7, "7d").n).toBe(1);
    expect(windowed([{ date: "2026-08-24", value: 1 }], "2026-08-31", 7, "7d").n).toBe(0);
  });
});
