import { describe, it, expect } from "vitest";
import {
  toAppleDate, normaliseSleepValue, normalisePhoneNumber,
} from "../../src/core/health/phone-samples.ts";

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

describe("normalisePhoneNumber", () => {
  it("reads the decimal comma the phone actually sent", () => {
    // Both verbatim from the first live run on 2026-09-01. The owner's phone is
    // Hungarian, so Shortcuts renders 8.71793477021344 with a comma — and the
    // rollup's Number() call turned it into NaN, which is why distance_km
    // vanished from that day and the energy columns lost their only source.
    expect(normalisePhoneNumber("8,71793477021344")).toBe("8.71793477021344");
    expect(normalisePhoneNumber("1198,36299999997")).toBe("1198.36299999997");
    expect(Number(normalisePhoneNumber("8,71793477021344")!)).toBeCloseTo(8.71793477021344, 12);
  });

  it("passes machine-formatted numbers through untouched", () => {
    // Integers were never broken — steps and flights landed on 2026-09-01 —
    // and a caller that can send a dot must keep working.
    expect(normalisePhoneNumber("12727")).toBe("12727");
    expect(normalisePhoneNumber("0")).toBe("0");
    expect(normalisePhoneNumber("8.717")).toBe("8.717");
    expect(normalisePhoneNumber("-1.5")).toBe("-1.5");
    expect(normalisePhoneNumber("  6645  ")).toBe("6645");
  });

  it("reads a short comma decimal as a decimal, because nothing here groups", () => {
    // `1,234` is genuinely ambiguous in the abstract. It is not ambiguous in
    // this payload: `1198,36299999997` proves Shortcuts writes no thousands
    // separator, so a lone comma can only be the decimal point. The shapes that
    // would reveal grouping are all refused below, so this reading cannot be
    // silently wrong — it can only stop being accepted.
    expect(normalisePhoneNumber("1,234")).toBe("1.234");
  });

  it("refuses a grouped number instead of guessing which comma means what", () => {
    // The moment a separator pair appears, the decimal comma stops being the
    // only reading — so this refuses rather than picking one. A refusal is
    // named in the reply; a wrong pick would be a plausible-looking number.
    expect(normalisePhoneNumber("1.198,363")).toBeNull();
    expect(normalisePhoneNumber("1,198.363")).toBeNull();
    expect(normalisePhoneNumber("1,198,363")).toBeNull();
    expect(normalisePhoneNumber("1 234")).toBeNull();
    expect(normalisePhoneNumber("1 234,5")).toBeNull();
  });

  it("refuses everything Number() would have been too generous about", () => {
    // Number() reads all of these, and the empty string as zero. That is the
    // generosity this boundary exists to remove: a refusal is visible, a
    // silently rescaled or invented number is not.
    expect(normalisePhoneNumber("")).toBeNull();
    expect(normalisePhoneNumber("   ")).toBeNull();
    expect(normalisePhoneNumber("0x1f")).toBeNull();
    expect(normalisePhoneNumber("1e5")).toBeNull();
    expect(normalisePhoneNumber("Infinity")).toBeNull();
    expect(normalisePhoneNumber("12,")).toBeNull();
    expect(normalisePhoneNumber(",5")).toBeNull();
    expect(normalisePhoneNumber("8,7 km")).toBeNull();
    expect(normalisePhoneNumber("nyolc")).toBeNull();
  });
});
