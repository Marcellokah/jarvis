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

  it("a modell által írt elemzés escape-elve jelenik meg", async () => {
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-09-01T07:00:00.000Z", domain: "finance",
      markdown: "<script>alert(1)</script>", summary: "s", metrics: "{}",
    });
    const res = await get(a, "/terulet/penzugy");
    expect(res.body).not.toContain("<script>alert(1)</script>");
  });
});
