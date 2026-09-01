import { describe, it, expect } from "vitest";
import {
  SUMMARY_HEADING, buildDomainPrompt, buildSynthesisPrompt, extractSummary,
} from "../../src/core/analysis/prompts.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";

const metrics: Metrics = {
  today: "2026-08-31",
  physical: {
    byMonth: [{ month: "2026-08", hours: 20, sessions: 18, strength: 9 }],
    loadRatio: 0.82, strengthPerWeek28d: 2.25,
    vo2max: { value: 38.4, n: 101, coverage: 0.28, window: "365d", slopePer30d: -0.4 },
    rhr: { value: 65.2, n: 221, coverage: 0.61, window: "365d", slopePer30d: 1.1 },
    hrRecovery: { value: null, n: 0, coverage: 0, window: "365d", slopePer30d: null },
    steps: {
      d7: { value: 9000, n: 7, coverage: 1, window: "7d" },
      d28: { value: 9500, n: 28, coverage: 1, window: "28d" },
      d90: { value: 9800, n: 90, coverage: 1, window: "90d" },
      d365: { value: 10100, n: 365, coverage: 1, window: "365d" },
    },
  },
  recovery: {
    hrv: {
      d7: { value: 61, n: 6, coverage: 6 / 7, window: "7d" },
      d28: { value: 59, n: 25, coverage: 25 / 28, window: "28d" },
      d90: { value: 58, n: 80, coverage: 80 / 90, window: "90d" },
      d365: { value: 57, n: 230, coverage: 230 / 365, window: "365d" },
    },
    hrvDeviationSigma: 0.4,
    asleepMin: {
      d28: { value: null, n: 0, coverage: 0, window: "28d" },
      d90: { value: 402, n: 12, coverage: 12 / 90, window: "90d" },
      d365: { value: 410, n: 41, coverage: 41 / 365, window: "365d" },
    },
    stages: {
      core: { value: 210, n: 12, coverage: 12 / 90, window: "90d" },
      rem: { value: 95, n: 12, coverage: 12 / 90, window: "90d" },
      deep: { value: 60, n: 12, coverage: 12 / 90, window: "90d" },
    },
    awakenings: { value: 3, n: 12, coverage: 12 / 90, window: "90d" },
    sleepByYear: [{ year: "2026", days: 243, withSleep: 41 }],
  },
  finance: {
    months: [{ month: "2026-09", totalHuf: 24390, activeCount: 5 }],
    monthOverMonth: null,
    annualisedHuf: 292680,
  },
};

describe("buildDomainPrompt", () => {
  it("sends only the domain's own metrics", () => {
    const { user } = buildDomainPrompt("finance", metrics, []);
    expect(user).toContain(JSON.stringify(metrics.finance, null, 2));
    // The financial pass has no business seeing other domains' metrics; a smaller
    // prompt is also a cheaper one against a 6,000 token/minute ceiling.
    expect(user).not.toContain(JSON.stringify(metrics.recovery, null, 2));
  });

  it("includes the previous summaries as memory, newest first", () => {
    // Tokens chosen so they cannot occur in the surrounding prose. An earlier
    // version used "legfrissebb", which the header itself contains ("a
    // legfrissebbel kezdve"), so it passed whatever order the list was in.
    const { user } = buildDomainPrompt("physical", metrics, ["MEMO_UJ", "MEMO_REGI"]);
    expect(user.indexOf("MEMO_UJ")).toBeLessThan(user.indexOf("MEMO_REGI"));
    expect(user).toContain("1. MEMO_UJ");
    expect(user).toContain("2. MEMO_REGI");
  });

  it("says plainly when there is no earlier finding", () => {
    const { user } = buildDomainPrompt("physical", metrics, []);
    expect(user).toContain("Ez az első elemzés ezen a területen");
  });

  it("requires the summary block by name in the system prompt", () => {
    const { system } = buildDomainPrompt("recovery", metrics, []);
    expect(system).toContain(SUMMARY_HEADING);
  });

  it("orders the model to carry coverage into any claim", () => {
    const { system } = buildDomainPrompt("recovery", metrics, []);
    expect(system).toMatch(/lefedettség/i);
  });
});

describe("buildSynthesisPrompt", () => {
  it("passes correlations through with n, and forbids inventing others", () => {
    const { system, user } = buildSynthesisPrompt(
      [{ domain: "physical", summary: "a" }, { domain: "recovery", summary: "b" }],
      [{ key: "load_vs_rhr", label: "terhelés ↔ nyugalmi pulzus", r: -0.42, n: 210, window: "365 nap" }],
    );
    expect(user).toContain("terhelés ↔ nyugalmi pulzus");
    expect(user).toContain("210");
    expect(system).toContain("Csak a megadott összefüggésekről írhatsz");
  });

  it("states outright when nothing cleared the threshold", () => {
    const { user } = buildSynthesisPrompt([{ domain: "physical", summary: "a" }], []);
    expect(user).toContain("Egyetlen összefüggés sem érte el a mintaszám-küszöböt");
  });
});

describe("extractSummary", () => {
  it("takes the text under the summary heading", () => {
    const md = `# Fizikai\n\nHosszabb elemzés.\n\n${SUMMARY_HEADING}\n\nEz az összegzés.`;
    expect(extractSummary(md)).toBe("Ez az összegzés.");
  });

  it("stops at the next heading", () => {
    const md = `${SUMMARY_HEADING}\n\nEz kell.\n\n## Valami más\n\nEz nem.`;
    expect(extractSummary(md)).toBe("Ez kell.");
  });

  it("falls back to the first paragraph when the block is missing", () => {
    // A missing summary must not cost us a finished report.
    const md = "# Fizikai\n\nElső bekezdés.\n\nMásodik bekezdés.";
    expect(extractSummary(md)).toBe("Első bekezdés.");
  });

  it("never returns an empty string for non-empty markdown", () => {
    expect(extractSummary("csak egy sor")).toBe("csak egy sor");
  });
});
