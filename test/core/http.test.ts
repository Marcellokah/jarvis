import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTestApp, seedMeals, meal, stubModule, TEST_TOKEN, type TestApp } from "../helpers.ts";
import { healthAndMealPrep } from "../../src/modules/health-mealprep/index.ts";

const MONDAY = "2026-08-31T06:20:00+02:00";
const auth = { authorization: `Bearer ${TEST_TOKEN}` };

let app: TestApp;
afterEach(async () => { await app?.close(); });

async function boot(now = MONDAY) {
  app = await buildTestApp({
    modules: [healthAndMealPrep({ enabled: true, defrostHorizonH: 24 })],
    now,
  });
  seedMeals(app.db, [
    meal({ weekday: 1, meal: "ebed", item: "Csirkemell", proteinG: 55, needsDefrost: true, defrostLeadH: 12 }),
  ]);
  return app;
}

describe("auth", () => {
  beforeEach(async () => { await boot(); });

  it("rejects /api/* without a token", async () => {
    const res = await app.server.inject({ method: "GET", url: "/api/morning-brief" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief",
      headers: { authorization: "Bearer wrong-token-0123456789abc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("leaves /healthz open so a liveness probe needs no secret", async () => {
    const res = await app.server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/morning-brief", () => {
  beforeEach(async () => { await boot(); });

  it("returns plain text by default — iOS notifications do not render markdown", async () => {
    const res = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("Csirkemell");
    expect(res.body).not.toContain("##");
    expect(res.body).not.toContain("- [ ]");
    expect(res.body).toContain("☐");
    expect(res.headers["x-jarvis-synthesizer"]).toBe("template");
  });

  it("returns markdown on request", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief?format=md", headers: auth,
    });
    expect(res.body).toContain("## 🥦 Egészség & Meal Prep");
    expect(res.body).toContain("- [ ]");
  });

  it("exposes actions with stable ids in JSON", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief?format=json", headers: auth,
    });
    const body = res.json();

    expect(body.synthesizer).toBe("template");
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.actions[0]).toMatchObject({ kind: "checkbox", status: "open" });
    expect(body.actions[0].id).toBeTruthy();
  });

  it("serves the cached brief on a second call, then regenerates on force", async () => {
    const first = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(first.headers["x-jarvis-cached"]).toBe("false");

    const second = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(second.headers["x-jarvis-cached"]).toBe("true");

    const forced = await app.server.inject({
      method: "GET", url: "/api/morning-brief?force=true", headers: auth,
    });
    expect(forced.headers["x-jarvis-cached"]).toBe("false");
  });

  it("rejects a malformed format", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief?format=pdf", headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/ingest/health", () => {
  beforeEach(async () => { await boot(); });

  it("stores the Shortcut's snapshot and the next brief reflects it", async () => {
    const ingest = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { sleepH: 8.2, hrv: 64, rhr: 49, moveKcal: 700, exerciseMin: 55 },
    });

    expect(ingest.statusCode).toBe(202);
    expect(ingest.json()).toMatchObject({ ok: true, date: "2026-08-31" });

    const brief = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(brief.body).toContain("8.2 óra");
    expect(brief.body).toContain("HRV 64");
  });

  it("accepts a partial snapshot — a missing HRV must not cost the morning", async () => {
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: { sleepH: 6.5 },
    });
    expect(res.statusCode).toBe(202);

    const brief = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(brief.body).toContain("6.5 óra");
  });

  /**
   * The Shortcut sends one snapshot for the whole morning. When Apple Health
   * has no sample for a reading, Shortcuts substitutes 0 rather than omitting
   * the field — and a single such field used to 400 the entire request, losing
   * the readings that were perfectly good. That is the opposite of the promise
   * this endpoint makes.
   */
  it("ignores one bad reading instead of losing the whole snapshot", async () => {
    // Exactly what the phone sent: no resting-heart-rate sample, so 0.
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { sleepH: 7.5, hrv: 87, rhr: 0 },
    });

    expect(res.statusCode).toBe(202);
    const brief = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(brief.body).toContain("7.5 óra");
    expect(brief.body).toContain("HRV 87");
  });

  it("names what it ignored, so a broken Shortcut step is visible", async () => {
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { hrv: 87, rhr: 0, sleepH: 99 },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { accepted: string[]; ignored: { field: string }[] };
    expect(body.accepted).toEqual(["hrv"]);
    expect(body.ignored.map((i) => i.field).sort()).toEqual(["rhr", "sleepH"]);
  });

  it("treats zero sleep as no reading, not as a sleepless night", async () => {
    // 0 drove the readiness verdict to "gyenge — ma inkább könnyű mozgás":
    // confident advice from a measurement that was never taken.
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { sleepH: 0, hrv: 87 },
    });
    expect(res.statusCode).toBe(202);

    const brief = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(brief.body).toContain("nincs alvás adat");
    expect(brief.body).not.toContain("0 óra alvás");
  });

  it("keeps a zero that is genuinely plausible", async () => {
    // At 07:30 you really may have burned no active energy yet. Only the
    // readings that cannot be zero in a living person are treated as absent.
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { sleepH: 7, moveKcal: 0 },
    });

    expect(res.statusCode).toBe(202);
    expect((res.json() as { accepted: string[] }).accepted.sort()).toEqual(["moveKcal", "sleepH"]);
  });

  it("ignores an empty field, which is how Shortcuts sends a missing sample", async () => {
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { sleepH: 7, hrv: "", rhr: null },
    });

    expect(res.statusCode).toBe(202);
    expect((res.json() as { accepted: string[] }).accepted).toEqual(["sleepH"]);
  });

  it("still refuses a body that is not a snapshot at all", async () => {
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: [1, 2, 3],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/modules", () => {
  it("reports each module's health without running the brief", async () => {
    await boot();
    const res = await app.server.inject({ method: "GET", url: "/api/modules", headers: auth });
    const body = res.json();

    expect(body.modules).toHaveLength(1);
    expect(body.modules[0]).toMatchObject({
      name: "HealthAndMealPrep", enabled: true, runsToday: true,
    });
    expect(body.modules[0].health.ok).toBe(true);
  });

  it("flags an unseeded meal plan rather than silently producing an empty brief", async () => {
    app = await buildTestApp({
      modules: [healthAndMealPrep({ enabled: true, defrostHorizonH: 24 })], now: MONDAY,
    });
    const res = await app.server.inject({ method: "GET", url: "/api/modules", headers: auth });

    expect(res.json().modules[0].health).toMatchObject({ ok: false });
    expect(res.json().modules[0].health.detail).toContain("npm run seed");
  });
});

describe("degradation", () => {
  it("still serves a brief when every module fails", async () => {
    app = await buildTestApp({
      modules: [stubModule({ name: "Broken", execute: async () => { throw new Error("no network"); } })],
      now: MONDAY,
    });

    const res = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Nem futott le: Broken");
  });
});
