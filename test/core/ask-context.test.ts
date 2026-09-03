import { describe, it, expect, afterEach } from "vitest";
import { trimMetrics, renderAskPrompt, buildAskContext, type AskContext } from "../../src/core/ask/context.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { createSubscriptionMonthRepo } from "../../src/infra/db/repositories/subscription-months.ts";
import { createBriefRepo } from "../../src/infra/db/repositories/briefs.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { buildTestApp, stubModule, type TestApp } from "../helpers.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";

const EMPTY = { value: null, n: 0, coverage: 0, window: "365d" };

function metrics(over: Partial<Metrics["physical"]> = {}): Metrics {
  return {
    today: "2026-09-01",
    physical: {
      byMonth: [], loadRatio: null, strengthPerWeek28d: null,
      vo2max: { ...EMPTY, slopePer30d: null },
      rhr: { ...EMPTY, slopePer30d: null },
      hrRecovery: { ...EMPTY, slopePer30d: null },
      steps: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
      ...over,
    },
    recovery: {
      hrv: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
      hrvDeviation: null,
      asleepMin: { d28: EMPTY, d90: EMPTY, d365: EMPTY },
      stages: { core: EMPTY, rem: EMPTY, deep: EMPTY },
      awakenings: EMPTY, sleepByYear: [],
    },
    finance: { months: [], monthOverMonth: null, annualisedHuf: null },
    nutrition: {
      measuredDays: 0, windowDays: 0, lastDate: null, longestStreak: null,
      kcal: EMPTY, proteinG: EMPTY,
      balance: { mean: null, sd: null, n: 0, over: 0, under: 0, dropped: 0 },
      plannedProteinG: null, plannedKcal: null,
    },
  };
}

describe("trimMetrics", () => {
  it("keeps only the last twelve months of training", () => {
    // The real database holds 55 months since 2019; sending them all costs
    // roughly 4,985 characters, more than the statistics they accompany.
    const byMonth = Array.from({ length: 55 }, (_, i) => ({
      month: `20${22 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      hours: i, sessions: i, strength: i,
    }));
    const trimmed = trimMetrics(metrics({ byMonth }));
    expect(trimmed.physical.byMonth).toHaveLength(12);
    // The last twelve, not the first twelve.
    expect(trimmed.physical.byMonth.at(-1)).toEqual(byMonth.at(-1));
  });

  it("leaves a shorter history alone", () => {
    const byMonth = [{ month: "2026-08", hours: 20, sessions: 18, strength: 9 }];
    expect(trimMetrics(metrics({ byMonth })).physical.byMonth).toEqual(byMonth);
  });

  it("rounds long decimals that carry no information", () => {
    const trimmed = trimMetrics(metrics({ loadRatio: 1.4123456789 }));
    expect(trimmed.physical.loadRatio).toBe(1.41);
  });

  it("keeps null as null rather than rounding it to zero", () => {
    // The whole project rests on this distinction; a rounder that turns an
    // absent measurement into 0 would undo every guard upstream of it.
    const trimmed = trimMetrics(metrics());
    expect(trimmed.physical.loadRatio).toBeNull();
    expect(trimmed.physical.vo2max.value).toBeNull();
  });

  it("leaves integers untouched", () => {
    const trimmed = trimMetrics(metrics({
      steps: { d7: { value: 10608, n: 7, coverage: 1, window: "7d" }, d28: EMPTY, d90: EMPTY, d365: EMPTY },
    }));
    expect(trimmed.physical.steps.d7.value).toBe(10608);
  });
});

describe("renderAskPrompt", () => {
  const base: AskContext = {
    today: "2026-09-01",
    briefMarkdown: "# 2026. szeptember 1.\n\n## Nap\nEbéd: csirke.",
    analyses: [
      { domain: "physical", summary: "A terhelés magas.", createdAt: "2026-09-01T07:08:45.487Z" },
      { domain: "finance", summary: "Stabil költés.", createdAt: "2026-06-01T07:00:00.000Z" },
    ],
    metrics: trimMetrics(metrics()),
    history: [],
  };

  it("dates every analysis, so a stale finding is not quoted as fresh", () => {
    const prompt = renderAskPrompt(base, "Mi a helyzet?");
    expect(prompt).toContain("2026-09-01");
    expect(prompt).toContain("2026-06-01");
  });

  it("says plainly when there is no analysis yet", () => {
    const prompt = renderAskPrompt({ ...base, analyses: [] }, "Mi a helyzet?");
    expect(prompt).toContain("Még nem készült mélyelemzés");
  });

  it("says plainly when there is no brief", () => {
    const prompt = renderAskPrompt({ ...base, briefMarkdown: null }, "Mi a helyzet?");
    expect(prompt).toContain("Ma nem készült briefing");
  });

  it("warns that the monthly breakdown is truncated", () => {
    // Without this the model reads the missing months as missing data and
    // comments on the gap.
    expect(renderAskPrompt(base, "?")).toContain("utolsó tizenkét hónap");
  });

  it("carries the thread forwards, oldest first", () => {
    const prompt = renderAskPrompt({
      ...base,
      history: [
        { id: 1, chatId: "web", role: "user", content: "KERDES_REGI", createdAt: "2026-09-01T08:00:00.000Z" },
        { id: 2, chatId: "web", role: "assistant", content: "VALASZ_REGI", createdAt: "2026-09-01T08:00:00.000Z" },
      ],
    }, "KERDES_UJ");
    expect(prompt.indexOf("KERDES_REGI")).toBeLessThan(prompt.indexOf("VALASZ_REGI"));
    expect(prompt.indexOf("VALASZ_REGI")).toBeLessThan(prompt.indexOf("KERDES_UJ"));
  });

  it("ends with the question", () => {
    const prompt = renderAskPrompt(base, "EZ_A_KERDES");
    expect(prompt.trimEnd().endsWith("EZ_A_KERDES")).toBe(true);
  });
});

/**
 * The assembler itself, over real (empty-unless-seeded) repositories.
 *
 * The brief is the part that mattered: `get(now, { wait: false })` would fall
 * through to a full generation on any day with no stored brief — which, with
 * no scheduled brief in this system, is most days. A question must never pay
 * for a brief nobody asked for.
 */
describe("buildAskContext", () => {
  const NOW = "2026-09-01T08:00:00.000Z";
  let app: TestApp | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  async function deps(runs: { count: number }) {
    app = await buildTestApp({
      modules: [stubModule({
        name: "Számláló",
        execute: async () => { runs.count += 1; return { data: {}, actions: [], priority: "normal" as const }; },
      })],
      now: NOW,
    });
    return {
      app,
      ctxDeps: {
        health: app.health,
        workouts: createWorkoutRepo(app.db),
        meals: app.meals,
        subscriptionMonths: createSubscriptionMonthRepo(app.db),
        analyses: app.analyses,
        conversations: app.conversations,
        briefs: app.briefs,
        clock: { now: () => new Date(NOW) },
        logger: silentLogger(),
        historyDepth: 4,
      },
    };
  }

  it("asks for no brief that does not already exist", async () => {
    const runs = { count: 0 };
    const { ctxDeps } = await deps(runs);

    const ctx = await buildAskContext(ctxDeps, "web", new AbortController().signal);

    expect(ctx.briefMarkdown).toBeNull();
    // The proof: not one module ran, so no Groq synthesis could have fired.
    expect(runs.count).toBe(0);
  });

  it("uses the brief that is already stored", async () => {
    const runs = { count: 0 };
    const { app: a, ctxDeps } = await deps(runs);
    await a.briefs.generate(new Date(NOW));

    const ctx = await buildAskContext(ctxDeps, "web", new AbortController().signal);

    expect(ctx.briefMarkdown).not.toBeNull();
    expect(runs.count).toBe(1); // the explicit generate, and nothing more
  });

  it("treats a stored-but-empty brief as no brief", async () => {
    // Missing data must look missing. An empty markdown would otherwise reach
    // the prompt under "A mai briefing:", telling the model a brief exists.
    const runs = { count: 0 };
    const { app: a, ctxDeps } = await deps(runs);
    createBriefRepo(a.db).save({
      date: "2026-09-01", generatedAt: NOW, synthesizer: "template",
      markdown: "   \n  ", durationMs: 1,
    });

    const ctx = await buildAskContext(ctxDeps, "web", new AbortController().signal);

    expect(ctx.briefMarkdown).toBeNull();
    expect(renderAskPrompt(ctx, "Mi újság?")).toContain("Ma nem készült briefing");
    expect(runs.count).toBe(0);
  });
});
