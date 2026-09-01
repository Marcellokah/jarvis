import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, seedMeals, meal, stubModule, TEST_TOKEN, type TestApp } from "../helpers.ts";
import { healthAndMealPrep } from "../../src/modules/health-mealprep/index.ts";
import { createBriefRepo } from "../../src/infra/db/repositories/briefs.ts";
import type { Synthesizer } from "../../src/core/synthesis/synthesizer.ts";

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const MONDAY = "2026-08-31T06:20:00+02:00";

/** Never resolves before the test's `wait=0` deadline — forces `get()` down
 *  the "generation did not finish in time" path deterministically, instead
 *  of racing a fast template render against a 0ms timeout. */
const slowSynthesizer: Synthesizer = {
  name: "slow",
  available: async () => true,
  synthesize: async (ctx) => {
    await new Promise((r) => setTimeout(r, 50));
    return `# ${ctx.dateLabel}\n\n## Egészség\n\nkész`;
  },
};

let app: TestApp;
afterEach(async () => { await app?.close(); app = undefined as unknown as TestApp; });

async function boot() {
  app = await buildTestApp({
    modules: [healthAndMealPrep({ enabled: true, defrostHorizonH: 24 })],
    now: MONDAY,
    freshnessMinutes: 90,
  });
  seedMeals(app.db, [meal({ weekday: 1, meal: "ebed", item: "Csirkemell", proteinG: 55 })]);
  return app;
}

/**
 * A health snapshot POST followed by a GET for the brief — whenever the
 * Shortcut, or anything else, happens to do that.
 *
 * It is easy to break invisibly — a brief generated an hour ago is still
 * "fresh" by the cache's own rules, so the answer looks perfectly valid while
 * silently predating the data that just arrived.
 */
describe("POST-then-GET reflects new data", () => {
  it("reflects health data that arrives after a brief was already cached", async () => {
    await boot();

    // A brief exists from earlier — well inside the freshness window.
    const first = await app.server.inject({
      method: "GET", url: "/api/morning-brief", headers: auth,
    });
    expect(first.headers["x-jarvis-cached"]).toBe("false");
    expect(first.body).toContain("Nincs friss Apple Watch adat");

    // The Shortcut pushes this morning's numbers.
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { sleepH: 6.2, hrv: 41, rhr: 58 },
    });

    // The very next GET must show them, not the hour-old cached brief.
    const second = await app.server.inject({
      method: "GET", url: "/api/morning-brief", headers: auth,
    });
    expect(second.body).toContain("6.2 óra");
    expect(second.body).toContain("HRV 41");
    expect(second.body).not.toContain("Nincs friss Apple Watch adat");
  });

  it("still serves the cache when nothing has changed", async () => {
    await boot();
    await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });

    const second = await app.server.inject({
      method: "GET", url: "/api/morning-brief", headers: auth,
    });
    expect(second.headers["x-jarvis-cached"]).toBe("true");
  });

  it("answers immediately from cache when the caller asks not to wait", async () => {
    await boot();
    await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: { sleepH: 7 },
    });

    const fast = await app.server.inject({
      method: "GET", url: "/api/morning-brief?wait=0", headers: auth,
    });
    expect(fast.statusCode).toBe(200);
  });
});

/**
 * The live regression: `POST /api/ingest/health` used to delete today's
 * cached brief outright, leaving a window where `latestForDate()` finds
 * nothing for today. A `wait=0` GET landing in that window fell back to
 * `BriefRepo.latest()` — the most recent brief on *any* date — and served it
 * as a 200 with `x-jarvis-cached: true`, indistinguishable from a correct
 * answer. That other day's meal plan, subscriptions, and readiness verdict
 * went out as if they were today's.
 */
describe("an ingest must never cause another date's brief to be served as today's", () => {
  it("does not serve a different date's cached brief for a wait=0 request after ingest", async () => {
    app = await buildTestApp({
      modules: [healthAndMealPrep({ enabled: true, defrostHorizonH: 24 })],
      now: MONDAY,
      synthesizers: [slowSynthesizer],
      freshnessMinutes: 90,
      maxWaitSeconds: 5,
    });
    seedMeals(app.db, [meal({ weekday: 1, meal: "ebed", item: "Csirkemell", proteinG: 55 })]);

    // A brief for a wholly unrelated date sits in the table — the exact shape
    // of the hazard: nothing about today points to it, but a cross-date
    // lookup could still reach it.
    const OTHER_DAY_MARKDOWN = "# Más nap\n\n## Más nap\n\nEz szeptember 4-i adat.";
    createBriefRepo(app.db).save({
      date: "2026-09-04",
      generatedAt: "2026-09-04T04:20:00.000Z",
      synthesizer: "template",
      markdown: OTHER_DAY_MARKDOWN,
      durationMs: 1,
    });

    // No brief exists yet for today — nobody has asked for one. The Shortcut's
    // morning flow: push health, then ask for the brief without waiting for a
    // fresh generation.
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { sleepH: 6.2, hrv: 41, rhr: 58 },
    });

    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief?format=text&wait=0", headers: auth,
    });

    // Whatever this answers — today's own (possibly stale) brief, or an
    // honest "not ready" — it must never be 2026-09-04's brief dressed up
    // as today's.
    expect(res.body).not.toContain("Ez szeptember 4-i adat.");
    expect(res.headers["x-jarvis-generated-at"]).not.toBe("2026-09-04T04:20:00.000Z");
    expect(
      res.statusCode === 200 && res.headers["x-jarvis-cached"] === "true"
        && res.headers["x-jarvis-generated-at"] === "2026-09-04T04:20:00.000Z",
    ).toBe(false);
  });
});

/**
 * `cached()` is the read the page and the question use.
 *
 * `get(now, { wait: false })` looks like the same thing and is not: its fast
 * path needs a stored row, and with no scheduled brief in this system most
 * days have none — so it falls through to a full generation. Opening the page
 * and then asking one question would be two Groq calls inside one minute,
 * against a 6,000 token/minute ceiling, neither of them asked for.
 */
describe("BriefService.cached", () => {
  /** Counts every module run, so "never generates" is an assertion and not a hope. */
  function countingModule() {
    let runs = 0;
    return {
      module: stubModule({
        name: "Számláló",
        execute: async () => { runs += 1; return { data: {}, actions: [], priority: "normal" as const }; },
      }),
      runs: () => runs,
    };
  }

  it("returns null when nothing is stored, without generating anything", async () => {
    const counter = countingModule();
    app = await buildTestApp({ modules: [counter.module], now: MONDAY });

    expect(app.briefs.cached(new Date(MONDAY))).toBeNull();
    expect(counter.runs()).toBe(0);
    expect(app.briefs.inFlight()).toBe(false);
  });

  it("returns the stored brief when there is one, still without generating", async () => {
    const counter = countingModule();
    app = await buildTestApp({ modules: [counter.module], now: MONDAY });

    const generated = await app.briefs.generate(new Date(MONDAY));
    expect(counter.runs()).toBe(1);

    const cached = app.briefs.cached(new Date(MONDAY));
    expect(cached).not.toBeNull();
    expect(cached!.markdown).toBe(generated.markdown);
    expect(cached!.fromCache).toBe(true);
    // The module ran once, for the explicit generate — not again for the read.
    expect(counter.runs()).toBe(1);
  });

  it("returns null for a day that has no brief, even when another day does", async () => {
    // Reaching across to the most recent brief of any date is the bug this
    // whole service guards against: yesterday's meal plan dressed as today's.
    const counter = countingModule();
    app = await buildTestApp({ modules: [counter.module], now: MONDAY });

    await app.briefs.generate(new Date(MONDAY));
    expect(app.briefs.cached(new Date("2026-09-05T06:20:00+02:00"))).toBeNull();
    expect(counter.runs()).toBe(1);
  });
});
