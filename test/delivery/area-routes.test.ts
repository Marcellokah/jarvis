import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, TEST_TOKEN, stubModule } from "../helpers.ts";
import type { TestApp } from "../helpers.ts";
import { shiftDay } from "../../src/core/analysis/stats.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

/** Every field null but `date` — see `test/delivery/page.test.ts`'s own
 *  copy for why this is not shared: a test's fixture should not become
 *  another test's dependency. */
function emptySnapshot(date: string): Omit<HealthSnapshot, "ingestedAt"> {
  return {
    date, sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null,
    steps: null, asleepMin: null, inBedMin: null, coreMin: null, remMin: null,
    deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
    walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
    dietProteinG: null, dietCarbsG: null, dietFatG: null, distanceKm: null,
    standMin: null, walkingSpeed: null, stepLengthCm: null, doubleSupportPct: null,
    asymmetryPct: null, steadinessPct: null, sixMinWalkM: null, stairUpMs: null,
    stairDownMs: null,
  };
}

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

  it("a hub kártyák a saját metrikájukat mutatják, nem egymásét", async () => {
    // G3: seed physical.loadRatio and recovery.hrvDeviation.sigma with real,
    // distinguishable values through the actual repos, so a route that
    // sourced the Terhelés card from the wrong metric (e.g. hrvDeviation
    // instead of loadRatio) would render the wrong figure and wrong unit.
    const a = await boot();
    const TODAY = "2026-09-03"; // boot()'s clock, read back through TZ.

    // Terhelési arány ≈ 1,00×: 60 edzésperc minden nap egy teljes éven át —
    // a 28 és a 365 napos napi átlag megegyezik.
    a.workouts.save(Array.from({ length: 365 }, (_, i) => {
      const date = shiftDay(TODAY, -i);
      return {
        date, type: "Walking", startedAt: `${date}T10:00:00.000Z`,
        durationMin: 60, energyKcal: null, source: "teszt",
      };
    }));

    // HRV-eltérés ≈ +1,68 σ — ugyanaz a fixture, mint
    // `test/core/analysis-aggregate.test.ts`-ben: 83 nap váltakozó 45/55,
    // majd az utolsó 7 nap 60.
    for (let i = 0; i < 83; i++) {
      const date = shiftDay(TODAY, -(i + 7));
      a.health.upsert(
        { ...emptySnapshot(date), hrv: i % 2 === 0 ? 45 : 55 }, {}, new Date(`${date}T20:00:00.000Z`),
      );
    }
    for (let i = 0; i < 7; i++) {
      const date = shiftDay(TODAY, -i);
      a.health.upsert({ ...emptySnapshot(date), hrv: 60 }, {}, new Date(`${date}T20:00:00.000Z`));
    }

    const res = await get(a, "/terulet");
    // Scoped to the card grid: the desktop nav's own submenu repeats every
    // area's href too (see `shell.ts`'s `.almenu`), and without this scope
    // that earlier, figure-less link is what a non-greedy search up to the
    // next `class="szam"` would actually land on.
    const kartyak = /<div class="kartyak">[\s\S]*?<\/div>/.exec(res.body)?.[0] ?? "";
    const cardFigure = (href: string) =>
      new RegExp(`href="${href}"[\\s\\S]*?<span class="szam">([^<]+)</span>`).exec(kartyak)?.[1];

    expect(cardFigure("/terulet/terheles")).toBe("1,00×");
    expect(cardFigure("/terulet/regeneracio")).toBe("+1,68 σ");
  });

  it("mind a hat terület a saját sorozatait rajzolja csempeként, nem másikét", async () => {
    // G4: minden területi oldal rögzített oszlophalmazt kap; egy hibás
    // route (pl. a mozgás oszlopai helyett a regeneráció oszlopai a
    // Terhelés oldalon) a linkek oszlopnevein bukna. Adatra nincs szükség —
    // a registry minden oszlopra ad csempét, üres adatbázison is.
    const a = await boot();
    const expectedByUrl: Record<string, readonly string[]> = {
      "/terulet/terheles": ["steps", "distance_km", "move_kcal", "exercise_min"],
      "/terulet/regeneracio": ["hrv", "rhr", "hr_recovery", "sleep_h"],
      "/terulet/taplalkozas": ["diet_kcal", "diet_protein_g"],
    };
    for (const [url, columns] of Object.entries(expectedByUrl)) {
      const res = await get(a, url);
      const hrefs = [...res.body.matchAll(/href="\/szamok\/([a-z_]+)\?tart=\d+"/g)].map((m) => m[1]);
      expect(hrefs, url).toEqual(columns);
    }
  });

  it("a napló nem állít számot, amit nem tud mutatni, ha a sorok olvasása elhasal", async () => {
    // F1: a `total` és a `rows` két külön olvasás. Ha a számláló sikerül, de
    // a sorok olvasása elhasal, a régi kód `total`-t érintetlenül hagyta és
    // `rows`-t üresen — egy üres táblát egy magabiztos "120 edzés" pager
    // alatt, ami pontosan az a hiány, ami nem néz ki hiánynak.
    const a = await boot();
    let calls = 0;
    (a.workouts as unknown as { page: (offset: number, limit: number) => { rows: unknown[]; total: number } })
      .page = (_offset, _limit) => {
        calls++;
        // The first call is the count read (`page(0, 1)`); it succeeds with
        // a real, nonzero total. The second call is the row read; it fails.
        if (calls === 1) return { rows: [], total: 120 };
        throw new Error("szándékos hiba");
      };

    const res = await get(a, "/terulet/terheles/naplo");
    expect(res.statusCode).toBe(200);
    // The pager must not claim a count the table cannot back.
    expect(res.body).not.toContain("120 edzés");
    // worklogBody's own empty-state branch — reached only when `total` was
    // reset to 0 alongside the empty `rows`.
    expect(res.body).toContain("Nincs rögzített edzés.");
  });

  it("minden területi oldalon pontosan egy elem kapja az aria-current jelzőt, a saját helyén", async () => {
    // F4: mind a hat útvonal `section: "terulet"`-tel renderel, tehát az
    // aria-current korábban mindig a hub linkjén landolt — öt oldalon
    // tévesen. Minden URL a saját, elvárt linkjén kell hogy landoljon, és
    // pontosan egy elemen.
    const a = await boot();
    const expected: Record<string, string> = {
      "/terulet": "/terulet",
      "/terulet/terheles": "/terulet/terheles",
      "/terulet/terheles/naplo": "/terulet/terheles",
      "/terulet/regeneracio": "/terulet/regeneracio",
      "/terulet/taplalkozas": "/terulet/taplalkozas",
      "/terulet/penzugy": "/terulet/penzugy",
    };
    for (const [url, expectedHref] of Object.entries(expected)) {
      const res = await get(a, url);
      const hits = [...res.body.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
      expect(hits, url).toEqual([expectedHref]);
    }
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
