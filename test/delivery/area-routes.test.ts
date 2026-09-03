import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, TEST_TOKEN, stubModule } from "../helpers.ts";
import type { TestApp } from "../helpers.ts";

const UTAK = [
  "/terulet",
  "/terulet/terheles",
  "/terulet/terheles/naplo",
  "/terulet/regeneracio",
  "/terulet/taplalkozas",
  "/terulet/penzugy",
];

let app: TestApp | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const boot = async () => {
  app = await buildTestApp({
    modules: [stubModule({ name: "Teszt" })],
    now: "2026-09-03T08:00:00.000Z",
  });
  return app;
};

const get = (a: TestApp, url: string) =>
  a.server.inject({ method: "GET", url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });

describe("területi útvonalak", () => {
  it("mind a hat útvonal 200-at ad tokennel", async () => {
    const a = await boot();
    for (const url of UTAK) {
      const res = await get(a, url);
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("mind a hat útvonal 401-et ad token nélkül", async () => {
    const a = await boot();
    for (const url of UTAK) {
      const res = await a.server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("a százalék-kódolt alak sem csúszik át a szűrőn", async () => {
    // Az F1 záró reviewja pontosan ezt találta: a hook a nyers URL-t
    // hasonlította, a router viszont dekódolva irányított, így a
    // /%73zamok teljes oldalt adott vissza hitelesítés nélkül.
    const a = await boot();
    for (const url of ["/%74erulet", "/terulet/%74erheles"]) {
      const res = await a.server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("ismeretlen terület 404, nem üres keret", async () => {
    // Egy üres keret azt állítaná, hogy ez a terület létezik, csak nincs
    // adata — ugyanaz a döntés, mint a /szamok/:metrika-nál.
    const a = await boot();
    const res = await get(a, "/terulet/valami");
    expect(res.statusCode).toBe(404);
  });

  it("az /elemzes megszűnt", async () => {
    const a = await boot();
    const res = await get(a, "/elemzes");
    expect(res.statusCode).toBe(404);
  });

  it("üres adatbázison sem 500-azik egyik oldal sem", async () => {
    // Nulla edzés, nulla előfizetés, nulla étrend, nulla elemzés: minden
    // oldal a hiányt mutatja, nem hibát.
    const a = await boot();
    for (const url of UTAK) {
      const res = await get(a, url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain("NaN");
    }
  });

  it("az edzés megjelenik a Terhelés oldalon és a naplóban", async () => {
    const a = await boot();
    a.workouts.save([{
      date: "2026-09-01", type: "Cycling", startedAt: "2026-09-01T06:00:00.000Z",
      durationMin: 42, energyKcal: 310, source: "Watch",
    }]);
    const oldal = await get(a, "/terulet/terheles");
    expect(oldal.body).toContain("Cycling");
    const naplo = await get(a, "/terulet/terheles/naplo");
    expect(naplo.body).toContain("Cycling");
    expect(naplo.body).toContain("Watch");
  });

  it("a napló értelmetlen lapszámra is az első oldalt adja, nem 404-et", async () => {
    const a = await boot();
    for (const q of ["?oldal=0", "?oldal=-3", "?oldal=abc", "?oldal=9999", "?oldal="]) {
      const res = await get(a, `/terulet/terheles/naplo${q}`);
      expect(res.statusCode, q).toBe(200);
    }
  });

  it("a hub az Összegzést mutatja, a területek a sajátjukat", async () => {
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-09-01T07:11:50.124Z", domain: "synthesis",
      markdown: "OSSZKEP-JELOLO", summary: "s", metrics: "{}",
    });
    a.analyses.save({
      createdAt: "2026-09-01T07:08:45.487Z", domain: "physical",
      markdown: "FIZIKAI-JELOLO", summary: "f", metrics: "{}",
    });
    const hub = await get(a, "/terulet");
    expect(hub.body).toContain("OSSZKEP-JELOLO");
    expect(hub.body).not.toContain("FIZIKAI-JELOLO");

    const terheles = await get(a, "/terulet/terheles");
    expect(terheles.body).toContain("FIZIKAI-JELOLO");
    expect(terheles.body).not.toContain("OSSZKEP-JELOLO");
  });

  it("a Terület jelzője kialszik, ha az elemzés hét napnál régebbi", async () => {
    // Az elemzés kézzel indul; az elavulása valódi, cselekvésre hívó állapot.
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-08-20T07:00:00.000Z", domain: "physical",
      markdown: "régi", summary: "s", metrics: "{}",
    });
    const res = await get(a, "/terulet");
    expect(res.body).toMatch(/href="\/terulet" class="menu jelzo holt"/);
  });

  it("a friss elemzés meggyújtja a Terület jelzőjét", async () => {
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-09-01T07:00:00.000Z", domain: "physical",
      markdown: "friss", summary: "s", metrics: "{}",
    });
    const res = await get(a, "/terulet");
    expect(res.body).toMatch(/href="\/terulet" class="menu jelzo el"/);
  });

  it("a hét napos határ zárt: pontosan hét napos elemzésnél még világít", async () => {
    // boot()'s clock is fixed at 2026-09-03T08:00:00.000Z; the lamp rule is
    // "legfeljebb 7 napos" (at most seven days), so an analysis exactly
    // 7 * 86_400_000 ms old sits ON the boundary and must still be lit —
    // a <= vs < mutation here would not otherwise show up in any test.
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-08-27T08:00:00.000Z", domain: "physical",
      markdown: "pont hét napos", summary: "s", metrics: "{}",
    });
    const res = await get(a, "/terulet");
    expect(res.body).toMatch(/href="\/terulet" class="menu jelzo el"/);
  });

  it("a hét napos határon egy perccel túl már kialszik", async () => {
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-08-27T07:59:00.000Z", domain: "physical",
      markdown: "hét napnál egy perccel régebbi", summary: "s", metrics: "{}",
    });
    const res = await get(a, "/terulet");
    expect(res.body).toMatch(/href="\/terulet" class="menu jelzo holt"/);
  });

  it("a modell által írt elemzés escape-elve jelenik meg", async () => {
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-09-01T07:00:00.000Z", domain: "finance",
      markdown: "<script>alert(1)</script>", summary: "s", metrics: "{}",
    });
    const res = await get(a, "/terulet/penzugy");
    expect(res.body).not.toContain("<script>alert(1)</script>");
  });

  it("a típustábla hibája nem viszi el a legutóbbi edzések listáját", async () => {
    // byType() and page() are two independent reads on the Terhelés page;
    // one failing must dim only its own table, per this app's isolation
    // rule. Stubbing the method on the app's own repo object works because
    // buildTestApp hands the server the very same WorkoutRepo instance it
    // returns as `a.workouts` — not a copy.
    const a = await boot();
    a.workouts.save([{
      date: "2026-09-01", type: "Cycling", startedAt: "2026-09-01T06:00:00.000Z",
      durationMin: 42, energyKcal: 310, source: "Watch",
    }]);
    (a.workouts as unknown as { byType: () => never }).byType = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a, "/terulet/terheles");
    expect(res.statusCode).toBe(200);
    // "Teljes napló" only renders when recentTable() got real rows (its
    // empty-state branch omits the link entirely), so its presence proves
    // that table survived byType()'s failure.
    expect(res.body).toContain("Teljes napló");
    // The type table's own heading only renders when byType() returned rows;
    // its absence here confirms the failure actually dimmed that table
    // rather than the mutation being a no-op.
    expect(res.body).not.toContain("Típusok");
  });

  it("a legutóbbi edzések hibája nem viszi el a típustáblát", async () => {
    const a = await boot();
    a.workouts.save([{
      date: "2026-09-01", type: "Cycling", startedAt: "2026-09-01T06:00:00.000Z",
      durationMin: 42, energyKcal: 310, source: "Watch",
    }]);
    (a.workouts as unknown as { page: () => never }).page = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a, "/terulet/terheles");
    expect(res.statusCode).toBe(200);
    // The type table's heading only renders when byType() succeeded.
    expect(res.body).toContain("Típusok");
    // The recent-workouts table falls back to its own empty state when
    // page() fails, so the "Teljes napló" link (only rendered alongside
    // real rows) must not appear.
    expect(res.body).not.toContain("Teljes napló");
    expect(res.body).toContain("Nincs rögzített edzés.");
  });
});
