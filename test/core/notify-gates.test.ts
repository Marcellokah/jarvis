import { describe, it, expect } from "vitest";
import { gateReason, type GateOptions } from "../../src/core/notify/gates.ts";
import { TZ } from "../../src/shared/dates.ts";

const OPTS: GateOptions = { minHoursBetween: 4, quietFromHour: 22, quietToHour: 7 };
const at = (iso: string) => new Date(iso);

// 2026-09-01T10:00:00Z is 12:00 in Budapest (CEST, UTC+2).
const NOON = "2026-09-01T10:00:00.000Z";

describe("gateReason", () => {
  it("opens when nothing was ever sent and the hour is fine", () => {
    expect(gateReason(at(NOON), TZ, null, OPTS)).toBeNull();
  });

  it("closes inside the four-hour window", () => {
    const threeHoursAgo = "2026-09-01T07:00:00.000Z";
    expect(gateReason(at(NOON), TZ, threeHoursAgo, OPTS)).toMatch(/négy|óra/i);
  });

  it("opens once four hours have passed", () => {
    const fourHoursAgo = "2026-09-01T06:00:00.000Z";
    expect(gateReason(at(NOON), TZ, fourHoursAgo, OPTS)).toBeNull();
  });

  it("closes during quiet hours, on both sides of midnight", () => {
    // 23:00 and 02:00 Budapest.
    expect(gateReason(at("2026-09-01T21:00:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
    expect(gateReason(at("2026-09-02T00:00:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
  });

  it("opens again at the end of quiet hours", () => {
    // 06:59 is still quiet, 07:00 is not.
    expect(gateReason(at("2026-09-01T04:59:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
    expect(gateReason(at("2026-09-01T05:00:00.000Z"), TZ, null, OPTS)).toBeNull();
  });

  it("closes at the start of quiet hours", () => {
    // 21:59 is fine, 22:00 is not.
    expect(gateReason(at("2026-09-01T19:59:00.000Z"), TZ, null, OPTS)).toBeNull();
    expect(gateReason(at("2026-09-01T20:00:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
  });

  it("judges quiet hours in Budapest time, not UTC", () => {
    // 2026-01-15T22:30Z is 23:30 in Budapest (CET, UTC+1) — quiet. Judging in
    // UTC would call it 22:30 and still quiet, so use a case where they differ:
    // 2026-01-15T06:30Z is 07:30 Budapest (allowed) but 06:30 UTC (quiet).
    expect(gateReason(at("2026-01-15T06:30:00.000Z"), TZ, null, OPTS)).toBeNull();
  });
});
