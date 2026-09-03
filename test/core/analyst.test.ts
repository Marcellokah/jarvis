import { describe, it, expect } from "vitest";
import { runAnalysis, type AnalystOptions } from "../../src/core/analysis/analyst.ts";
import { SUMMARY_HEADING } from "../../src/core/analysis/prompts.ts";
import { createAnalysisRepo } from "../../src/infra/db/repositories/analyses.ts";
import { GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";
import type { Relation } from "../../src/core/analysis/relations.ts";

const EMPTY_METRIC = { value: null, n: 0, coverage: 0, window: "365d" };
const metrics: Metrics = {
  today: "2026-08-31",
  physical: {
    byMonth: [], loadRatio: null, strengthPerWeek28d: null,
    vo2max: { ...EMPTY_METRIC, slopePer30d: null },
    rhr: { ...EMPTY_METRIC, slopePer30d: null },
    hrRecovery: { ...EMPTY_METRIC, slopePer30d: null },
    steps: { d7: EMPTY_METRIC, d28: EMPTY_METRIC, d90: EMPTY_METRIC, d365: EMPTY_METRIC },
  },
  recovery: {
    hrv: { d7: EMPTY_METRIC, d28: EMPTY_METRIC, d90: EMPTY_METRIC, d365: EMPTY_METRIC },
    hrvDeviation: null,
    asleepMin: { d28: EMPTY_METRIC, d90: EMPTY_METRIC, d365: EMPTY_METRIC },
    stages: { core: EMPTY_METRIC, rem: EMPTY_METRIC, deep: EMPTY_METRIC },
    awakenings: EMPTY_METRIC, sleepByYear: [],
  },
  finance: { months: [], monthOverMonth: null, annualisedHuf: null },
  nutrition: {
    measuredDays: 0, windowDays: 0, lastDate: null, longestStreak: null,
    kcal: EMPTY_METRIC, proteinG: EMPTY_METRIC,
    balance: { mean: null, sd: null, n: 0, over: 0, under: 0, dropped: 0 },
    plannedProteinG: null, plannedKcal: null,
  },
};

const relations: Relation[] = [];

/** Answers each call in order; a `null` entry throws instead of answering. */
function scriptedFetcher(answers: (string | null)[]): Fetcher & { calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const self = {
    calls,
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      if (!url.startsWith(GROQ_CHAT_URL)) throw new Error(`unexpected url ${url}`);
      calls.push(String(init?.body ?? ""));
      const answer = answers[i++];
      if (answer === null || answer === undefined) throw new Error("groq exploded");
      return { choices: [{ message: { content: answer }, finish_reason: "stop" }] } as T;
    },
    async text(): Promise<string> { throw new Error("not used"); },
  };
  return self;
}

function answer(body: string): string {
  return `# Cím\n\n${body}\n\n${SUMMARY_HEADING}\n\n${body} összegzés.`;
}

function options(fetcher: Fetcher, over: Partial<AnalystOptions> = {}): AnalystOptions {
  const db = memoryDb();
  return {
    fetcher, model: "test-model", maxTokens: 1200, temperature: 0.3,
    timeoutMs: 5_000, paceMs: 60_000, memoryDepth: 3,
    apiKey: async () => "key",
    analyses: createAnalysisRepo(db),
    logger: recordingLogger(),
    clock: { now: () => new Date("2026-08-31T08:00:00.000Z") },
    // Injected so the suite never actually waits a minute per call.
    sleep: async () => {},
    ...over,
  };
}

const signal = () => new AbortController().signal;

describe("runAnalysis", () => {
  it("runs the four domains and then the synthesis", async () => {
    const fetcher = scriptedFetcher([
      answer("fizikai"), answer("regen"), answer("pénz"), answer("táplálkozás"), answer("össze"),
    ]);
    const run = await runAnalysis(metrics, relations, options(fetcher), signal());

    expect(run.outcomes.map((o) => o.domain))
      .toEqual(["physical", "recovery", "finance", "nutrition", "synthesis"]);
    expect(run.outcomes.every((o) => o.error === null)).toBe(true);
    expect(fetcher.calls).toHaveLength(5);
  });

  it("a táplálkozás is végigmegy a futtatáson", async () => {
    // nutrition is the fourth domain in the pipeline; it must both appear in
    // the outcomes and be persisted like any other domain.
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    const fetcher = scriptedFetcher([
      answer("fizikai"), answer("regen"), answer("pénz"), answer("táplálkozás"), answer("össze"),
    ]);
    const run = await runAnalysis(metrics, relations, options(fetcher, { analyses }), signal());

    expect(run.outcomes.map((o) => o.domain)).toContain("nutrition");
    const stored = analyses.recent("nutrition", 1)[0]!;
    expect(stored.summary).toBe("táplálkozás összegzés.");
    db.close();
  });

  it("keeps the other domains when one fails, and names the failure", async () => {
    // The finance call throws; physical and recovery must survive it.
    const fetcher = scriptedFetcher([
      answer("fizikai"), answer("regen"), null, answer("táplálkozás"), answer("össze"),
    ]);
    const run = await runAnalysis(metrics, relations, options(fetcher), signal());

    const finance = run.outcomes.find((o) => o.domain === "finance")!;
    expect(finance.markdown).toBeNull();
    expect(finance.error).toContain("groq exploded");
    expect(run.outcomes.find((o) => o.domain === "physical")!.markdown).not.toBeNull();
    expect(run.outcomes.find((o) => o.domain === "synthesis")!.markdown).not.toBeNull();
  });

  it("egy elszálló táplálkozás-elemzés nem viszi el a többit", async () => {
    // The nutrition call throws; physical, recovery and finance must still
    // write their findings, and the failure must land on the nutrition
    // outcome specifically.
    const fetcher = scriptedFetcher([
      answer("fizikai"), answer("regen"), answer("pénz"), null, answer("össze"),
    ]);
    const run = await runAnalysis(metrics, relations, options(fetcher), signal());

    const nutrition = run.outcomes.find((o) => o.domain === "nutrition")!;
    expect(nutrition.markdown).toBeNull();
    expect(nutrition.error).toContain("groq exploded");

    const domainOutcomes = run.outcomes.filter((o) => o.domain !== "synthesis");
    expect(domainOutcomes.filter((o) => o.error === null)).toHaveLength(3);
  });

  it("skips the synthesis when fewer than two domains succeeded", async () => {
    const fetcher = scriptedFetcher([answer("fizikai"), null, null, null]);
    const run = await runAnalysis(metrics, relations, options(fetcher), signal());

    // One domain has nothing to be related to; a synthesis call would spend
    // tokens restating it.
    expect(run.outcomes.find((o) => o.domain === "synthesis")).toBeUndefined();
    expect(fetcher.calls).toHaveLength(4);
  });

  it("waits between calls, because two in one minute breaks the token ceiling", async () => {
    const waits: number[] = [];
    const fetcher = scriptedFetcher([answer("a"), answer("b"), answer("c"), answer("d"), answer("e")]);
    await runAnalysis(metrics, relations, options(fetcher, {
      sleep: async (ms: number) => { waits.push(ms); },
    }), signal());

    // Four gaps between five calls, and never before the first.
    expect(waits).toEqual([60_000, 60_000, 60_000, 60_000]);
  });

  it("stores every successful domain with its summary and metrics", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    const fetcher = scriptedFetcher([
      answer("fizikai"), answer("regen"), answer("pénz"), answer("táplálkozás"), answer("össze"),
    ]);
    await runAnalysis(metrics, relations, options(fetcher, { analyses }), signal());

    const stored = analyses.recent("physical", 1)[0]!;
    expect(stored.summary).toBe("fizikai összegzés.");
    expect(JSON.parse(stored.metrics)).toHaveProperty("loadRatio");
    db.close();
  });

  it("feeds the previous summaries back as memory", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    analyses.save({
      createdAt: "2026-07-01T08:00:00.000Z", domain: "physical",
      markdown: "#", summary: "MÚLTKORI MEGÁLLAPÍTÁS", metrics: "{}",
    });
    const fetcher = scriptedFetcher([answer("a"), answer("b"), answer("c"), answer("d"), answer("e")]);
    await runAnalysis(metrics, relations, options(fetcher, { analyses }), signal());

    expect(fetcher.calls[0]).toContain("MÚLTKORI MEGÁLLAPÍTÁS");
    db.close();
  });

  it("fails every domain cleanly when there is no API key", async () => {
    const fetcher = scriptedFetcher([]);
    const run = await runAnalysis(metrics, relations, options(fetcher, {
      apiKey: async () => undefined,
    }), signal());

    expect(fetcher.calls).toHaveLength(0);
    expect(run.outcomes).toHaveLength(4);
    for (const o of run.outcomes) expect(o.error).toContain("GROQ_API_KEY");
  });
});
