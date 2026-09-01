import { describe, it, expect } from "vitest";
import { renderPage, metricsRowsFrom, type PageData } from "../../src/delivery/http/page.ts";
import type { Metric } from "../../src/core/analysis/stats.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";

const base: PageData = {
  dateLabel: "2026. szeptember 1., kedd",
  briefMarkdown: "## Nap\n- [ ] Ebéd kivétele",
  analyses: [
    { domain: "physical", markdown: "### Fizikai\n- A terhelés magas.", createdAt: "2026-09-01T07:08:45.487Z" },
  ],
  metricsRows: [
    { label: "Terhelési arány", value: "1,41", detail: "28 nap / 365 nap" },
    { label: "Alvás (90 nap)", value: "nincs mérés", detail: "0 nap · 0% lefedettség" },
  ],
  history: [
    { id: 1, chatId: "web", role: "user", content: "Kérdés?", createdAt: "2026-09-01T08:00:00.000Z" },
    { id: 2, chatId: "web", role: "assistant", content: "Válasz.", createdAt: "2026-09-01T08:00:00.000Z" },
  ],
  chatAvailable: true,
};

/**
 * Pulls out the rendered value cell for one metrics-table row, by its label.
 *
 * Used instead of a blanket `not.toContain(">0<")`: that check is brittle (it
 * would pass even if the value were rendered somewhere unescaped, or if the
 * row were dropped entirely) and asserts nothing about *which* cell holds
 * "nincs mérés". This names the row and reads its own cell.
 */
function valueCellFor(html: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<td>${escapedLabel}</td><td class="value">([^<]*)</td>`).exec(html);
  if (!match) throw new Error(`no metrics row rendered for label: ${label}`);
  return match[1]!;
}

describe("renderPage", () => {
  it("renders one document with the four blocks in order", () => {
    const html = renderPage(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    const order = ["Briefing", "Elemzés", "Számok", "Kérdés"];
    const positions = order.map((s) => html.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  it("renders the brief's markdown, checkboxes included", () => {
    expect(renderPage(base)).toContain(`<li class="task"><input type="checkbox" disabled> Ebéd kivétele</li>`);
  });

  it("dates each analysis, so a stale one is visibly stale", () => {
    expect(renderPage(base)).toContain("2026-09-01");
  });

  it("shows a missing measurement as missing, not as zero", () => {
    // Names the sleep row specifically and reads its own value cell, rather
    // than the brittle `not.toContain(">0<")` this replaces (see
    // `valueCellFor` above for why that check was too weak).
    const html = renderPage(base);
    expect(valueCellFor(html, "Alvás (90 nap)")).toBe("nincs mérés");
  });

  it("escapes everything a model or a person typed", () => {
    const html = renderPage({
      ...base,
      history: [{ id: 1, chatId: "web", role: "assistant", content: "<script>x()</script>", createdAt: "2026-09-01T08:00:00.000Z" }],
    });
    expect(html).not.toContain("<script>x()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says so when there is no brief", () => {
    expect(renderPage({ ...base, briefMarkdown: null })).toContain("Ma még nem készült briefing");
  });

  it("says so when there is no analysis yet", () => {
    expect(renderPage({ ...base, analyses: [] })).toContain("Még nem futott mélyelemzés");
  });

  it("keeps the page usable when the model is unreachable", () => {
    // The content never depends on the model: the brief, the analyses and the
    // numbers are all there, and only the question box is disabled.
    const html = renderPage({ ...base, chatAvailable: false });
    expect(html).toContain("Terhelési arány");
    expect(html).toContain("nem érhető el");
    expect(html).toContain("disabled");
  });
});

// ---------------------------------------------------------------------------
// metricsRowsFrom
// ---------------------------------------------------------------------------

const EMPTY: Metric = { value: null, n: 0, coverage: 0, window: "365d" };

/**
 * A full `Metrics` object with every metric empty, in the shape
 * `test/core/ask-context.test.ts`'s `metrics()` helper uses — but not shared
 * with it: a test's helper should not become another test's dependency.
 *
 * `over.hrv7` overrides `recovery.hrv.d7`, the one field these tests need to
 * vary.
 */
function metricsFixture(over: { hrv7?: Metric } = {}): Metrics {
  return {
    today: "2026-09-01",
    physical: {
      byMonth: [], loadRatio: null, strengthPerWeek28d: null,
      vo2max: { ...EMPTY, slopePer30d: null },
      rhr: { ...EMPTY, slopePer30d: null },
      hrRecovery: { ...EMPTY, slopePer30d: null },
      steps: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
    },
    recovery: {
      hrv: { d7: over.hrv7 ?? EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
      hrvDeviation: null,
      asleepMin: { d28: EMPTY, d90: EMPTY, d365: EMPTY },
      stages: { core: EMPTY, rem: EMPTY, deep: EMPTY },
      awakenings: EMPTY, sleepByYear: [],
    },
    finance: { months: [], monthOverMonth: null, annualisedHuf: null },
  };
}

describe("metricsRowsFrom", () => {
  it("shows a missing measurement as missing, never as zero", () => {
    const rows = metricsRowsFrom(metricsFixture());
    const sleep = rows.find((r) => r.label === "Alvás (90 nap)")!;
    expect(sleep.value).toBe("nincs mérés");
    expect(sleep.detail).toContain("0 nap");
  });

  it("carries the evidence beside a real value", () => {
    const rows = metricsRowsFrom(metricsFixture({
      hrv7: { value: 68.7, n: 6, coverage: 6 / 7, window: "7d" },
    }));
    const hrv = rows.find((r) => r.label === "HRV (7 nap)")!;
    expect(hrv.value).toContain("68,7");
    expect(hrv.detail).toContain("6 nap");
    expect(hrv.detail).toContain("86%");
  });
});
