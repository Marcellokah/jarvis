import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, seedMeals, meal, TEST_TOKEN, type TestApp } from "../helpers.ts";
import { healthAndMealPrep } from "../../src/modules/health-mealprep/index.ts";

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const MONDAY = "2026-08-31T06:20:00+02:00";

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
 * The Shortcut's exact sequence: POST health, then GET the brief.
 *
 * This is the flow the whole 07:30 design exists to serve, and it is easy to
 * break invisibly — a brief generated an hour ago is still "fresh" by the
 * cache's own rules, so the answer looks perfectly valid while silently
 * predating the data that just arrived.
 */
describe("the Shortcut's POST-then-GET flow", () => {
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
