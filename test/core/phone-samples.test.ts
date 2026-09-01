import { describe, it, expect } from "vitest";
import { toAppleDate, normaliseSleepValue } from "../../src/core/health/phone-samples.ts";

describe("toAppleDate", () => {
  it("keeps the local wall clock and the offset", () => {
    // The rollup reads the local day from the first ten characters, so the
    // conversion must not shift the clock into UTC.
    expect(toAppleDate("2026-09-01T23:10:00+02:00")).toBe("2026-09-01 23:10:00 +0200");
  });

  it("handles a negative offset", () => {
    expect(toAppleDate("2026-01-15T06:30:00-05:00")).toBe("2026-01-15 06:30:00 -0500");
  });

  it("treats Z as +0000 rather than guessing a zone", () => {
    expect(toAppleDate("2026-09-01T23:10:00Z")).toBe("2026-09-01 23:10:00 +0000");
  });

  it("accepts fractional seconds and drops them", () => {
    expect(toAppleDate("2026-09-01T23:10:00.482+02:00")).toBe("2026-09-01 23:10:00 +0200");
  });

  it("returns null for anything it does not recognise", () => {
    // Null is the signal to report the sample as ignored. Guessing a format
    // would put a sample on the wrong day, silently.
    expect(toAppleDate("2026-09-01 23:10:00")).toBeNull();
    expect(toAppleDate("tegnap este")).toBeNull();
    expect(toAppleDate("")).toBeNull();
  });

  it("rejects invalid date components", () => {
    // A month of 13, day of 45, or hour of 99 would silently file on a wrong day.
    // Validate by round-tripping: the date arithmetic will roll invalid values.
    expect(toAppleDate("2026-13-01T12:00:00+02:00")).toBeNull();
    expect(toAppleDate("2026-09-45T12:00:00+02:00")).toBeNull();
    expect(toAppleDate("2026-09-01T99:00:00+02:00")).toBeNull();
    expect(toAppleDate("2026-09-01T12:61:00+02:00")).toBeNull();
  });

  it("accepts an offset written without a colon", () => {
    expect(toAppleDate("2026-09-01T23:10:00+0200")).toBe("2026-09-01 23:10:00 +0200");
  });

  it("rejects a timestamp missing the offset entirely", () => {
    expect(toAppleDate("2026-09-01T23:10:00")).toBeNull();
  });
});

describe("normaliseSleepValue", () => {
  it("passes an Apple constant through unchanged", () => {
    expect(normaliseSleepValue("HKCategoryValueSleepAnalysisAsleepDeep"))
      .toBe("HKCategoryValueSleepAnalysisAsleepDeep");
  });

  it("maps the names the Shortcuts app shows", () => {
    expect(normaliseSleepValue("Deep")).toBe("HKCategoryValueSleepAnalysisAsleepDeep");
    expect(normaliseSleepValue("REM")).toBe("HKCategoryValueSleepAnalysisAsleepREM");
    expect(normaliseSleepValue("Core")).toBe("HKCategoryValueSleepAnalysisAsleepCore");
    expect(normaliseSleepValue("Awake")).toBe("HKCategoryValueSleepAnalysisAwake");
    expect(normaliseSleepValue("In Bed")).toBe("HKCategoryValueSleepAnalysisInBed");
  });

  it("is forgiving about case and spacing, because the source is a UI label", () => {
    expect(normaliseSleepValue("deep")).toBe("HKCategoryValueSleepAnalysisAsleepDeep");
    expect(normaliseSleepValue("in bed")).toBe("HKCategoryValueSleepAnalysisInBed");
    expect(normaliseSleepValue("  Asleep  ")).toBe("HKCategoryValueSleepAnalysisAsleepUnspecified");
    expect(normaliseSleepValue("deep-sleep")).toBe("HKCategoryValueSleepAnalysisAsleepDeep");
    expect(normaliseSleepValue("in_bed")).toBe("HKCategoryValueSleepAnalysisInBed");
  });

  it("returns null for a name it does not know", () => {
    // We could not measure the exact labels — the owner has no staged sleep
    // data yet. So an unknown name must surface, not vanish.
    expect(normaliseSleepValue("Mély alvás")).toBeNull();
    expect(normaliseSleepValue("")).toBeNull();
  });
});
