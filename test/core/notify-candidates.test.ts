import { describe, it, expect } from "vitest";
import {
  candidates, HRV_SIGMA_THRESHOLD, RHR_SLOPE_THRESHOLD,
  type CandidateInput,
} from "../../src/core/notify/candidates.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";

const EMPTY = { value: null, n: 0, coverage: 0, window: "365d" };
const NOW = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Budapest

function metrics(over: {
  hrvDeviation?: Metrics["recovery"]["hrvDeviation"];
  rhrSlope?: number | null;
  rhrN?: number;
} = {}): Metrics {
  return {
    today: "2026-09-01",
    physical: {
      byMonth: [], loadRatio: null, strengthPerWeek28d: null,
      vo2max: { ...EMPTY, slopePer30d: null },
      rhr: { value: 60, n: over.rhrN ?? 200, coverage: 0.55, window: "365d", slopePer30d: over.rhrSlope ?? null },
      hrRecovery: { ...EMPTY, slopePer30d: null },
      steps: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
    },
    recovery: {
      hrv: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
      hrvDeviation: over.hrvDeviation ?? null,
      asleepMin: { d28: EMPTY, d90: EMPTY, d365: EMPTY },
      stages: { core: EMPTY, rem: EMPTY, deep: EMPTY },
      awakenings: EMPTY, sleepByYear: [],
    },
    finance: { months: [], monthOverMonth: null, annualisedHuf: null },
  };
}

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return { now: NOW, tz: TZ, metrics: metrics(), newAnalyses: [], deadlines: [], ...over };
}

describe("candidates — deadlines", () => {
  it("takes a deadline inside the horizon", () => {
    const found = candidates(input({
      deadlines: [{ label: "csirkemell", dueAt: "2026-09-01T12:00:00.000Z", overdue: false }],
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("deadline");
    expect(found[0]!.text).toContain("csirkemell");
  });

  it("ignores a deadline beyond the horizon", () => {
    const found = candidates(input({
      deadlines: [{ label: "messze", dueAt: "2026-09-03T10:00:00.000Z", overdue: false }],
    }));
    expect(found).toEqual([]);
  });

  it("treats an overdue deadline as urgent now", () => {
    const found = candidates(input({
      deadlines: [{ label: "elkésett", dueAt: "2026-09-01T06:00:00.000Z", overdue: true }],
    }));
    expect(found[0]!.urgency).toBe("now");
  });

  it("gives the same key for the same situation on two different ticks", () => {
    // The key is the whole point of deduplication: if it moved with the clock,
    // every tick would look new and the assistant would repeat itself forever.
    const deadlines = [{ label: "csirkemell", dueAt: "2026-09-01T12:00:00.000Z", overdue: false }];
    const first = candidates(input({ deadlines }))[0]!.key;
    const later = candidates(input({ now: new Date("2026-09-01T10:15:00.000Z"), deadlines }))[0]!.key;
    expect(later).toBe(first);
  });
});

describe("candidates — events", () => {
  it("words a future event without deadline vocabulary", () => {
    const found = candidates(input({
      deadlines: [{
        label: "Netflix megújul", dueAt: "2026-09-01T11:00:00.000Z",
        overdue: false, sort: "event",
      }],
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("Netflix megújul — 60 perc múlva.");
  });

  it("words a past event as arrived, not missed", () => {
    // overdue:true here mirrors gather.ts deriving it from the fixed renewal
    // instant — the case that used to render as "a határidő már lejárt.",
    // which is untrue of something that already happened on schedule.
    const found = candidates(input({
      deadlines: [{
        label: "Netflix megújul", dueAt: "2026-08-29T07:00:00.000Z",
        overdue: true, sort: "event",
      }],
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("Netflix megújul — ma.");
    expect(found[0]!.text).not.toContain("lejárt");
  });

  it("still applies the deadline horizon and urgency to events", () => {
    // Only the wording differs between the two sorts — an event far in the
    // future is dropped exactly like a distant deadline would be.
    const found = candidates(input({
      deadlines: [{
        label: "messze", dueAt: "2026-09-03T10:00:00.000Z",
        overdue: false, sort: "event",
      }],
    }));
    expect(found).toEqual([]);
  });
});

describe("candidates — health", () => {
  it("takes an HRV deviation at the threshold with enough samples", () => {
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -HRV_SIGMA_THRESHOLD, n7: 5, n90: 60 } }),
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("health");
  });

  it("carries its own evidence in the text", () => {
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -2.1, n7: 5, n90: 60 } }),
    }));
    // A notification that does not say what it rests on cannot be checked.
    expect(found[0]!.text).toContain("60");
  });

  it("ignores a deviation below the threshold", () => {
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -1.0, n7: 5, n90: 60 } }),
    }));
    expect(found).toEqual([]);
  });

  it("ignores a deviation whose recent window is too thin", () => {
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -3, n7: 2, n90: 60 } }),
    }));
    expect(found).toEqual([]);
  });

  it("ignores a deviation whose baseline is too thin", () => {
    // Three nights cannot establish that a fortnight is unusual.
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -3, n7: 5, n90: 8 } }),
    }));
    expect(found).toEqual([]);
  });

  it("takes a worsening resting heart rate trend", () => {
    const found = candidates(input({ metrics: metrics({ rhrSlope: RHR_SLOPE_THRESHOLD, rhrN: 200 }) }));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toMatch(/nyugalmi pulzus/i);
  });

  it("ignores an improving resting heart rate trend", () => {
    // Falling resting heart rate is good news, and good news is not a push.
    const found = candidates(input({ metrics: metrics({ rhrSlope: -3, rhrN: 200 }) }));
    expect(found).toEqual([]);
  });

  it("says nothing when there are no metrics at all", () => {
    expect(candidates(input({ metrics: null }))).toEqual([]);
  });
});

describe("candidates — analyses", () => {
  it("takes a new analysis summary", () => {
    const found = candidates(input({
      newAnalyses: [{ domain: "physical", summary: "A terhelés magas.", createdAt: "2026-09-01T09:00:00.000Z" }],
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("analysis");
    expect(found[0]!.text).toContain("A terhelés magas.");
  });

  it("keys an analysis by its identity, not by the current time", () => {
    const newAnalyses = [{ domain: "physical", summary: "x", createdAt: "2026-09-01T09:00:00.000Z" }];
    const first = candidates(input({ newAnalyses }))[0]!.key;
    const later = candidates(input({ now: new Date("2026-09-01T10:30:00.000Z"), newAnalyses }))[0]!.key;
    expect(later).toBe(first);
  });
});

describe("candidates — ordering", () => {
  it("puts the urgent first", () => {
    // Both are deadlines, so both are built in array order before anything else
    // is appended. The non-urgent one comes first, which means only the sort can
    // put the urgent one at the front.
    const found = candidates(input({
      deadlines: [
        { label: "ráér", dueAt: "2026-09-01T13:00:00.000Z", overdue: false },
        { label: "most", dueAt: "2026-09-01T09:00:00.000Z", overdue: true },
      ],
    }));
    expect(found[0]!.text).toContain("most");
    expect(found[1]!.text).toContain("ráér");
  });
});
