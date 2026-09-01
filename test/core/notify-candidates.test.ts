import { describe, it, expect } from "vitest";
import {
  candidates, HRV_SIGMA_THRESHOLD, RHR_SLOPE_THRESHOLD,
  leadOf, ANALYSIS_LEAD_MAX_CHARS,
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
  // An event is judged in local days, not in hours: a renewal is known a day
  // ahead (`alertDaysBefore` is [7, 3, 1]), so every alert the finance module
  // can emit is at least seventeen hours away. Under the four-hour instant
  // horizon the deadlines use, not one of them would ever have been a
  // candidate, and the source was dead in production while looking alive here.
  const event = (over: Partial<{ label: string; dueAt: string; overdue: boolean }> = {}) => ({
    label: "Netflix megújul", dueAt: "2026-09-01T11:00:00.000Z", overdue: false,
    sort: "event" as const, ...over,
  });

  it("words an event on today's local date as ma", () => {
    const found = candidates(input({ deadlines: [event()] }));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("Netflix megújul — ma.");
    expect(found[0]!.urgency).toBe("now");
  });

  it("words an event on tomorrow's local date as holnap", () => {
    const found = candidates(input({ deadlines: [event({ dueAt: "2026-09-02T07:00:00.000Z" })] }));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("Netflix megújul — holnap.");
    expect(found[0]!.urgency).toBe("soon");
  });

  it("keeps an event today that the four-hour horizon would have dropped", () => {
    // 22:00 Budapest, ten hours out. This is the shape of every renewal the
    // finance module produces, and the case the hours-based horizon killed.
    const found = candidates(input({ deadlines: [event({ dueAt: "2026-09-01T20:00:00.000Z" })] }));
    expect(found[0]!.text).toBe("Netflix megújul — ma.");
  });

  it("words a past event as arrived, not missed", () => {
    // 07:00 Budapest, five hours before `now` — the renewal already happened,
    // on schedule. overdue:true mirrors gather.ts deriving it from the fixed
    // instant; the wording must not turn it into "a határidő már lejárt.".
    const found = candidates(input({
      deadlines: [event({ dueAt: "2026-09-01T05:00:00.000Z", overdue: true })],
    }));
    expect(found[0]!.text).toBe("Netflix megújul — ma.");
    expect(found[0]!.text).not.toContain("lejárt");
  });

  it("drops an event the day after tomorrow", () => {
    expect(candidates(input({ deadlines: [event({ dueAt: "2026-09-03T07:00:00.000Z" })] }))).toEqual([]);
  });

  it("drops an event whose day is over", () => {
    // Yesterday's renewal is not news. An event is not a deadline: nothing was
    // missed, so there is nothing left to say about it.
    expect(candidates(input({ deadlines: [event({ dueAt: "2026-08-31T07:00:00.000Z" })] }))).toEqual([]);
  });

  it("judges the day in Budapest time, not UTC", () => {
    // 00:30 Budapest on the 2nd, which is still the 1st in UTC. Counting the
    // UTC dates would call the renewal "holnap" on the morning it happens.
    const found = candidates(input({
      now: new Date("2026-09-01T22:30:00.000Z"),
      deadlines: [event({ dueAt: "2026-09-02T07:00:00.000Z" })],
    }));
    expect(found[0]!.text).toBe("Netflix megújul — ma.");
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

  it("uses the lead, not the whole summary, when the summary runs long", () => {
    // A one-paragraph analysis summary — the shape `analyst.ts` actually
    // writes, well past ANALYSIS_LEAD_MAX_CHARS.
    const longSummary = Array.from({ length: 40 }, (_, i) => `megállapítás${i}`).join(" ");
    const found = candidates(input({
      newAnalyses: [{ domain: "physical", summary: longSummary, createdAt: "2026-09-01T09:00:00.000Z" }],
    }));
    expect(found[0]!.text).not.toContain(longSummary);
    expect(found[0]!.text).toBe(`${DOMAIN_LABEL_PHYSICAL} — ${leadOf(longSummary)}`);
    expect(found[0]!.text.endsWith("…")).toBe(true);
  });
});

// Mirrors DOMAIN_LABEL.physical in candidates.ts — kept local because the map
// itself is not exported, only its effect on the text.
const DOMAIN_LABEL_PHYSICAL = "Fizikai fejlődés";

describe("leadOf", () => {
  it("leaves a summary at or under the limit completely unchanged", () => {
    const short = "A terhelés magas, érdemes lassítani a jövő héten.";
    expect(leadOf(short)).toBe(short);
    expect(leadOf(short).endsWith("…")).toBe(false);
  });

  it("cuts a long summary at a word boundary and ends with an ellipsis", () => {
    const long = Array.from({ length: 40 }, (_, i) => `szó${i}`).join(" ");
    const lead = leadOf(long);

    expect(lead.endsWith("…")).toBe(true);

    // What precedes the ellipsis must be an exact prefix of the source that
    // stops exactly at a space (or the end of the string) — never mid-word.
    const withoutEllipsis = lead.slice(0, -1);
    expect(long.startsWith(withoutEllipsis)).toBe(true);
    const nextChar = long[withoutEllipsis.length];
    expect(nextChar === " " || nextChar === undefined).toBe(true);
  });

  it("never produces a result longer than the limit, ellipsis included", () => {
    for (const len of [1, ANALYSIS_LEAD_MAX_CHARS - 1, ANALYSIS_LEAD_MAX_CHARS,
      ANALYSIS_LEAD_MAX_CHARS + 1, ANALYSIS_LEAD_MAX_CHARS + 50, 1_000]) {
      const summary = Array.from({ length: Math.ceil(len / 4) }, (_, i) => `w${i}`).join(" ").slice(0, len);
      expect(leadOf(summary).length).toBeLessThanOrEqual(ANALYSIS_LEAD_MAX_CHARS);
    }
  });

  it("respects an explicit maxChars override", () => {
    const summary = "egy két három négy öt hat hét nyolc kilenc tíz";
    const lead = leadOf(summary, 10);
    expect(lead.length).toBeLessThanOrEqual(10);
    expect(lead.endsWith("…")).toBe(true);
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
