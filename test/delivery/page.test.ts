import { describe, it, expect } from "vitest";
import { metricsRowsFrom } from "../../src/delivery/http/view/numbers.ts";
import type { Metric } from "../../src/core/analysis/stats.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";
import { buildTestApp, TEST_TOKEN, stubModule } from "../helpers.ts";
import type { ChatService } from "../../src/core/chat.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

/**
 * Every field null but `date` — the same shape `view-channels.test.ts`'s
 * `row` and `analysis-aggregate.test.ts`'s snapshot helper already use, kept
 * local here rather than shared: a test's fixture should not become another
 * test's dependency (see `metricsFixture`'s own comment above for the same
 * call made about `metrics()`).
 */
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
    // 6/7 = 85.7%, shown as 85% — see the floor test below for why.
    expect(hrv.detail).toContain("85%");
  });

  it("never rounds an incomplete year up to full coverage", () => {
    // 364/365 = 0.99726…; ×100 = 99.726…, which Math.round turns into "100%".
    // A year missing a day would then read as a complete one, in the single
    // place this owner reads coverage. Math.floor gives 99.
    const rows = metricsRowsFrom(metricsFixture({
      hrv7: { value: 61.2, n: 364, coverage: 364 / 365, window: "365d" },
    }));
    const hrv = rows.find((r) => r.label === "HRV (7 nap)")!;
    expect(hrv.detail).toContain("99%");
    expect(hrv.detail).not.toContain("100%");
  });

  it("still says 100% when the coverage really is complete", () => {
    const rows = metricsRowsFrom(metricsFixture({
      hrv7: { value: 61.2, n: 365, coverage: 1, window: "365d" },
    }));
    expect(rows.find((r) => r.label === "HRV (7 nap)")!.detail).toContain("100%");
  });

  // Not in the brief's own test list, added because the brief's Step 5 asks
  // to break `metricsRowsFrom` by giving "Terhelési arány" a `series` and
  // watch a test fail — but the brief's own new `view-numbers.test.ts` tests
  // build their `MetricRow` fixtures by hand and never call
  // `metricsRowsFrom` at all, so that break could not have reached them.
  // This is the test that actually exercises the mapping Step 5 means to
  // break: a row backed by a real daily column gets a `series`, and a ratio
  // of two windows — which has no single column to draw — never does.
  it("only a row backed by a real daily column gets a series", () => {
    // `metricsFixture`'s default `EMPTY` carries a placeholder "365d" window
    // on every field it did not override, so only the overridable `hrv7`
    // field can prove the `days` figure comes from the metric's own window
    // rather than a number this test happened to write down twice.
    const rows = metricsRowsFrom(metricsFixture({
      hrv7: { value: 68.7, n: 6, coverage: 6 / 7, window: "7d" },
    }));
    expect(rows.find((r) => r.label === "Terhelési arány")!.series).toBeNull();
    expect(rows.find((r) => r.label === "Lépés (7 nap)")!.series?.column).toBe("steps");
    expect(rows.find((r) => r.label === "Alvás (90 nap)")!.series?.column).toBe("asleep_min");
    expect(rows.find((r) => r.label === "HRV (7 nap)")!.series).toEqual({ column: "hrv", days: 7 });
  });

  it("a terhelési arány formája és hiányzó szövege igazodik a Terhelés oldaléhoz", () => {
    // F3: /szamok és a Terhelés terület-oldal (view/area/load.ts) korábban
    // más alakban ("1,41" vs "1,41×") és más hiányszöveggel ("nincs alap" vs
    // "nincs elég előzmény") mutatta ugyanazt a számot — mintha két külön
    // mérés lenne, nem egy.
    const withRatio = metricsFixture();
    withRatio.physical.loadRatio = 1.41;
    const withRatioRow = metricsRowsFrom(withRatio).find((r) => r.label === "Terhelési arány")!;
    expect(withRatioRow.value).toBe("1,41×");

    const withoutRatio = metricsFixture();
    const withoutRatioRow = metricsRowsFrom(withoutRatio).find((r) => r.label === "Terhelési arány")!;
    expect(withoutRatioRow.value).toBe("nincs elég előzmény");
  });

  it("egy olvashatatlan ablakcímke csak a saját sorát veszíti el, nem az összeset", () => {
    // A `days` NaN volt minden nem `Nd` alakú címkére, és nem maradt a saját
    // sorában: a /szamok útvonal `Math.max`-szal veszi a leghosszabb ablakot
    // egyetlen közös lekérdezéshez, és `Math.max(NaN, ...)` NaN — vagyis egy
    // rossz címke az oldal ÖSSZES sparkline-ját eltüntette. Ma latens (minden
    // ablak `Nd`), de a kár mérete miatt őrizni kell.
    const rows = metricsRowsFrom(metricsFixture({
      hrv7: { value: 68.7, n: 6, coverage: 6 / 7, window: "hét" },
    }));
    expect(rows.find((r) => r.label === "HRV (7 nap)")!.series).toBeNull();
    // A többi sor érintetlen: ez a különbség a "saját sorát veszíti" és a
    // "mindent visz" között.
    expect(rows.find((r) => r.label === "Lépés (365 nap)")!.series).toEqual({ column: "steps", days: 365 });
    for (const r of rows) expect(r.series?.days).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Routes, through the real in-process Fastify server.
// ---------------------------------------------------------------------------

describe("page routes", () => {
  const boot = () => buildTestApp({ modules: [stubModule({ name: "Teszt" })], now: "2026-09-01T08:00:00.000Z" });

  it("refuses the page without any credential", async () => {
    // The page carries the brief, every analysis, the numbers and the whole
    // thread. 127.0.0.1 is not the guarantee: `deploy/README.md` documents a
    // `tailscale serve` that would proxy this origin to the whole tailnet.
    const app = await boot();
    const res = await app.server.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("serves the page with the bearer header", async () => {
    const app = await boot();
    const res = await app.server.inject({
      method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  it("accepts ?token= once and trades it for an HttpOnly cookie", async () => {
    // A browser cannot put a header on a plain navigation, so the first visit
    // carries the token in the URL. It is exchanged immediately: the cookie
    // means no later navigation repeats it where history and logs can keep it.
    const app = await boot();
    const res = await app.server.inject({ method: "GET", url: `/?token=${TEST_TOKEN}` });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    await app.close();
  });

  it("accepts the cookie alone on the next navigation", async () => {
    const app = await boot();
    const first = await app.server.inject({ method: "GET", url: `/?token=${TEST_TOKEN}` });
    const cookie = String(cookieFrom(first));
    const second = await app.server.inject({ method: "GET", url: "/", headers: { cookie } });
    expect(second.statusCode).toBe(200);
    expect(second.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  it("refuses a wrong token in the query string", async () => {
    const app = await boot();
    const res = await app.server.inject({ method: "GET", url: "/?token=nem-ez-az" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("refuses a question without the token", async () => {
    const app = await boot();
    const res = await app.server.inject({
      method: "POST", url: "/api/chat", payload: { question: "Mi újság?" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts the page's own cookie on the question route", async () => {
    // The page proves itself with this cookie one request earlier. Without it
    // here, a returning visitor got a 200 page and a 401 on every question —
    // sessionStorage dies with the browser session, the 30-day cookie does not.
    const app = await boot();
    const first = await app.server.inject({ method: "GET", url: `/?token=${TEST_TOKEN}` });
    const cookie = cookieFrom(first);

    const res = await app.server.inject({
      method: "POST", url: "/api/chat", headers: { cookie }, payload: { question: "Mi újság?" },
    });
    // Past auth. 502 is the stub chat service refusing to answer, not a refusal
    // to let the question through — 401 is the failure this test exists for.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("refuses a wrong cookie value on the question route", async () => {
    const app = await boot();
    const res = await app.server.inject({
      method: "POST", url: "/api/chat",
      headers: { cookie: "jarvis_token=nem-ez-az" },
      payload: { question: "Mi újság?" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("still refuses a cookie on the other API routes", async () => {
    // Only /api/chat takes the cookie. Every other route is called by a
    // Shortcut or a script, which sends a header and never a cookie.
    const app = await boot();
    const first = await app.server.inject({ method: "GET", url: `/?token=${TEST_TOKEN}` });
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief", headers: { cookie: cookieFrom(first) },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an empty question", async () => {
    const app = await boot();
    const res = await app.server.inject({
      method: "POST", url: "/api/chat",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { question: "   " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("a chat válasza renderelt HTML-t is ad, nem csak nyers markdownt", async () => {
    // A markdown a szerveren renderelődik: egy második, kliensoldali
    // renderelő ugyanazt a munkát kettőzné meg, épp a modell írta szövegen.
    const a = await buildTestApp({
      modules: [stubModule({ name: "Teszt" })],
      now: "2026-09-03T08:00:00.000Z",
      chat: { available: async () => true, ask: async () => "**félkövér** válasz" },
    });
    const res = await a.server.inject({
      method: "POST", url: "/api/chat",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { question: "kérdés" },
    });
    const body = JSON.parse(res.body);
    expect(body.answer).toBe("**félkövér** válasz");
    expect(body.html).toContain("<strong>félkövér</strong>");
    await a.close();
  });

  it("a válasz HTML-je escape-eli a modell írta jelöléseket", async () => {
    const a = await buildTestApp({
      modules: [stubModule({ name: "Teszt" })],
      now: "2026-09-03T08:00:00.000Z",
      chat: { available: async () => true, ask: async () => "<script>alert(1)</script>" },
    });
    const res = await a.server.inject({
      method: "POST", url: "/api/chat",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { question: "kérdés" },
    });
    expect(JSON.parse(res.body).html).not.toContain("<script>alert(1)</script>");
    await a.close();
  });

  it("a válasz a kérdést is renderelt HTML-ként adja vissza (questionHtml)", async () => {
    // A reload mindkét szerepet ugyanazon a `renderMarkdown`-on vezeti át
    // (lásd `chatBlock`) — ha a kérdés élőben csak nyers szövegként kerülne
    // be, a fonál alakja megváltozna az újratöltés után. A szervernek ezért
    // a kérdést is ugyanígy kell renderelnie, nem csak a választ.
    const a = await buildTestApp({
      modules: [stubModule({ name: "Teszt" })],
      now: "2026-09-03T08:00:00.000Z",
      chat: { available: async () => true, ask: async () => "Válasz." },
    });
    const res = await a.server.inject({
      method: "POST", url: "/api/chat",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { question: "**félkövér** kérdés" },
    });
    const body = JSON.parse(res.body);
    expect(body.questionHtml).toContain("<strong>félkövér</strong>");
    await a.close();
  });

  it("a questionHtml escape-eli az ember gépelte jelöléseket", async () => {
    const a = await buildTestApp({
      modules: [stubModule({ name: "Teszt" })],
      now: "2026-09-03T08:00:00.000Z",
      chat: { available: async () => true, ask: async () => "Válasz." },
    });
    const res = await a.server.inject({
      method: "POST", url: "/api/chat",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { question: "<script>alert(1)</script>" },
    });
    expect(JSON.parse(res.body).questionHtml).not.toContain("<script>alert(1)</script>");
    await a.close();
  });

  it("a Ma oldal a mai méréseket mutatja, nullát soha", async () => {
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // Nincs mai sor. `now` 10:00 helyi idő (Europe/Budapest, 2026-09-01 nyári
    // időszámítás): a 8 órás határidejű HRV már elmaradt, a 24 órás határidejű
    // Lépés még várakozik — egyik sem nulla.
    //
    // A `toContain("nincs mérés")` / `not.toMatch(/>0 lépés</)` pár a brief
    // eredeti tesztje volt, de mindkettő a RÉGI `renderPage`-en is lefutott
    // (a "Lépés (7 nap)" számtábla-sor is "nincs mérés"-t ír, és sosem
    // ">0 lépés<" alakban), tehát a bukó lépésnél (2. lépés) nem bukott — nem
    // bizonyította semmit. A csatorna-sorok pontos jelölését ellenőrizzük
    // helyette, amit csak az új `today.ts` állít elő.
    expect(res.body).toContain(
      '<div class="csatorna elmaradt"><span class="cimke">HRV</span><span class="ertek">nincs mérés</span></div>',
    );
    expect(res.body).toContain(
      '<div class="csatorna varakozik"><span class="cimke">Lépés</span><span class="ertek">várakozik</span></div>',
    );
    expect(res.body).not.toMatch(/>0 lépés</);
    await a.close();
  });

  it("a Ma oldal akkor is renderel, ha a brief lekérése hibát dob", async () => {
    const a = await boot();
    // A brief-szolgáltatás megbukik; a mérések és a keret akkor is ott vannak.
    (a.briefs as unknown as { cached: () => never }).cached = () => {
      throw new Error("szándékos hiba");
    };
    const res = await a.server.inject({
      method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // A brief eredeti tesztje `toContain("Ma")` volt, de ez a RÉGI oldalon is
    // lefutott ("Ma még nem készült briefing." — a hiányzó-brief szöveg maga
    // is "Ma"-val kezdődik), tehát semmit sem bizonyított a keretről. Az új
    // keret (`shell.ts`) és a mai csatornák saját jelölését ellenőrizzük.
    expect(res.body).toContain('<div class="csatornak">');
    expect(res.body).toContain('<a href="/" class="menu');
    await a.close();
  });

  it("a Számok oldal a metrikákat adja, sávval", async () => {
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/szamok", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Terhelési arány");
    // Strengthened beyond the brief's literal test: "Terhelési arány" alone
    // would still appear if `/szamok` reused the OLD `renderPage` wholesale
    // (which also renders that label), proving nothing about the new route,
    // the shared shell, or the rail. These pin down what only the new wiring
    // produces.
    expect(res.body).toContain('<a href="/szamok" class="menu" aria-current="page">');
    expect(res.body).toMatch(/<span class="rail[^"]*"[^>]*style="--fill:[\d.]+%"/);
    await a.close();
  });

  it("a Számok oldal sparkline-t rajzol a mért sorokhoz", async () => {
    const a = await boot();
    a.health.upsert({ ...emptySnapshot("2026-09-01"), steps: 9000 }, {}, new Date("2026-09-01T20:00:00Z"));
    const res = await a.server.inject({
      method: "GET", url: "/szamok", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.body).toContain('class="spark');
    await a.close();
  });

  it("a Számok oldal hitelesítés nélkül elutasít", async () => {
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/szamok" });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it("a részletoldal kirajzolja a mérés diagramját", async () => {
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/szamok/hrv", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="plot"');
    expect(res.body).toContain("HRV");
    await a.close();
  });

  it("ismeretlen metrika 404, nem üres diagram", async () => {
    // Egy üres diagram azt állítaná, hogy van ilyen mérés, csak nincs adata.
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/szamok/nincs_ilyen", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it("érvénytelen tartomány az egy évre esik vissza, nem hibázik", async () => {
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/szamok/hrv?tart=marha", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // A puszta `aria-current="page"` bármelyik tartományra igaz lehetne — a
    // teljes linket nézzük, hogy pontosan a 365 napos "1 év" nyerjen, ne
    // csak "valamelyik" tartomány legyen kijelölve.
    expect(res.body).toContain('<a href="/szamok/hrv?tart=365" class="tartomany" aria-current="page">1 év</a>');
    expect(res.body).not.toContain('tart=30" class="tartomany" aria-current="page"');
    expect(res.body).not.toContain('tart=mind" class="tartomany" aria-current="page"');
    await a.close();
  });

  it("érvényes tartomány a kért ablakot jelöli aktívnak, nem az alapértelmezettet", async () => {
    // Az előző teszt párja: önmagában az bizonyítaná, hogy valami mindig
    // aktívnak van jelölve, nem azt, hogy a KÉRT ablak — ezt csak egy nem
    // alapértelmezett, érvényes `tart` érték tudja megmutatni.
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/szamok/hrv?tart=30", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<a href="/szamok/hrv?tart=30" class="tartomany" aria-current="page">30 nap</a>');
    expect(res.body).not.toContain('tart=365" class="tartomany" aria-current="page"');
    expect(res.body).not.toContain('tart=mind" class="tartomany" aria-current="page"');
    await a.close();
  });

  it("a `mind` nem oszt el olyan napokkal, amikről nem is lehetett adat", async () => {
    // A `mind` 4000 napot kér vissza, az előzmény viszont 2019-ben kezdődik:
    // minden lefedettség ~1300 olyan nappal osztódott, amit ez a rendszer nem
    // mérhetett meg. A 99,9%-ban teljes lépéssorozat így „68% lefedettség"-et
    // hirdetett — pontosan az a magabiztosan rossz szám, aminek a kizárására
    // az egész projekt épül, és a diagram bal harmada üresen maradt, minden
    // magyarázó hézagsáv nélkül.
    const a = await boot();
    a.health.upsert({ ...emptySnapshot("2026-08-30"), steps: 9000 }, {}, new Date("2026-08-30T20:00:00Z"));
    a.health.upsert({ ...emptySnapshot("2026-09-01"), steps: 11000 }, {}, new Date("2026-09-01T20:00:00Z"));
    const res = await a.server.inject({
      method: "GET", url: "/szamok/steps?tart=mind", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // 2026-08-30 … 2026-09-01: három nap, két mérés — 66%, nem 0%.
    expect(res.body).toContain('<p class="osszegzes">3 nap: 2 mérés, 66% lefedettség');
    expect(res.body).not.toContain("4000 nap");
    await a.close();
  });

  it("egy előzményen belüli lyuk viszont továbbra is számít a lefedettségbe", async () => {
    // Az előző teszt párja: önmagában az azt is megengedné, hogy az ablak eleje
    // MINDIG az első méréshez tapadjon — amivel egy 30 napos ablakban a 28
    // mérés nélküli nap egyszerűen eltűnne. Csak az előzmény kezdete ELŐTTI
    // rész vágható le, ezért kell egy jóval korábbi sor: az ablak eleje így az
    // előzményen belülre esik, és a benne lévő lyuk valódi lyuk marad.
    const a = await boot();
    a.health.upsert({ ...emptySnapshot("2026-01-01"), steps: 7000 }, {}, new Date("2026-01-01T20:00:00Z"));
    a.health.upsert({ ...emptySnapshot("2026-08-20"), steps: 8000 }, {}, new Date("2026-08-20T20:00:00Z"));
    a.health.upsert({ ...emptySnapshot("2026-09-01"), steps: 11000 }, {}, new Date("2026-09-01T20:00:00Z"));
    const res = await a.server.inject({
      method: "GET", url: "/szamok/steps?tart=30", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<p class="osszegzes">30 nap: 2 mérés, 6% lefedettség');
    await a.close();
  });

  it("a sor saját ablaka oda visz, amit a link ígér", async () => {
    // A Számok sorai a SAJÁT ablakukkal linkelnek ide (`?tart=7`, `?tart=90`),
    // a részletoldal viszont csak a 30/365/mind kulcsokat ismerte: a hét
    // linkből négy némán egy 365 napos diagramra érkezett, miközben az URL-ben
    // `tart=7` állt és a választón az „1 év" volt kijelölve. A sor ablaka
    // valódi információ, nem eldobni kell, hanem megmutatni.
    const a = await boot();
    const szamok = await a.server.inject({
      method: "GET", url: "/szamok", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(szamok.body).toContain('href="/szamok/hrv?tart=7"');

    const res = await a.server.inject({
      method: "GET", url: "/szamok/hrv?tart=7", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<a href="/szamok/hrv?tart=7" class="tartomany" aria-current="page">7 nap</a>');
    expect(res.body).not.toContain('tart=365" class="tartomany" aria-current="page"');
    // A három megnevezett ablak innen is elérhető marad, a helyén a skálán.
    expect(res.body).toContain('<a href="/szamok/hrv?tart=30" class="tartomany">30 nap</a>');
    expect(res.body).toContain('<a href="/szamok/hrv?tart=mind" class="tartomany">minden</a>');
    await a.close();
  });

  it("a képtelen napszám az egy évre esik vissza, nem nyit millió napos ablakot", async () => {
    const a = await boot();
    for (const tart of ["0", "-3", "7,5", "999999"]) {
      const res = await a.server.inject({
        method: "GET", url: `/szamok/hrv?tart=${encodeURIComponent(tart)}`,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<a href="/szamok/hrv?tart=365" class="tartomany" aria-current="page">1 év</a>');
    }
    await a.close();
  });

  it("a részletoldal token nélkül elutasít", async () => {
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/szamok/hrv" });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it("a Kérdés oldal használható marad, ha a modell nem érhető el", async () => {
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/kerdes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<input type="text" placeholder="Kérdezz valamit…" disabled>`);
    expect(res.body).toContain(`<button type="submit" disabled>`);
    expect(res.body).toContain("nem érhető el");
    // Strengthened beyond the brief's literal test, for the same reason the
    // /szamok test above adds its own aria-current check: this
    // text and these disabled controls would render identically if /kerdes
    // reused the OLD `renderPage` wholesale (its `chatBlock` renders the same
    // disabled state by default), proving nothing about the new route or the
    // shared shell. The "kerdes" nav lamp — dark here, since `boot()`'s chat
    // stub is unavailable by default — only the new wiring produces.
    expect(res.body).toContain('<a href="/kerdes" class="menu jelzo holt" aria-current="page">');
    await a.close();
  });

  it("a Kérdés oldal engedi a kérdést, ha a modell elérhető", async () => {
    // The other half of the pair, the same way /page.test.ts's own
    // `renderPage` tests pair "unreachable" with "reachable": without this,
    // disabling the form unconditionally would still pass the test above.
    const chat: ChatService = { available: async () => true, ask: async () => "Válasz." };
    const a = await buildTestApp({
      modules: [stubModule({ name: "Teszt" })], now: "2026-09-01T08:00:00.000Z", chat,
    });
    const res = await a.server.inject({
      method: "GET", url: "/kerdes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<input type="text" placeholder="Kérdezz valamit…">`);
    expect(res.body).toContain(`<button type="submit">`);
    expect(res.body).not.toContain("nem érhető el");
    expect(res.body).toContain('<a href="/kerdes" class="menu jelzo el" aria-current="page">');
    await a.close();
  });

  it("a Kérdés oldal a beszélgetés szálát mutatja", async () => {
    const a = await boot();
    a.conversations.appendExchange(
      "web", "Mi újság?", "Minden rendben.", new Date("2026-09-01T08:00:00.000Z"),
    );
    const res = await a.server.inject({
      method: "GET", url: "/kerdes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Mi újság?");
    expect(res.body).toContain("Minden rendben.");
    await a.close();
  });

  it("a Kérdés oldal akkor is renderel, ha a beszélgetés-lekérés hibát dob", async () => {
    // Its own try/catch, like every other piece of every page: a failing
    // conversation repo must render the empty thread, never take the page
    // down — mirrors the "a Ma oldal akkor is renderel..." test above for
    // the brief service.
    const a = await boot();
    (a.conversations as unknown as { recent: () => never }).recent = () => {
      throw new Error("szándékos hiba");
    };
    const res = await a.server.inject({
      method: "GET", url: "/kerdes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<a href="/kerdes" class="menu');
    await a.close();
  });

  it("a Kérdés oldal hitelesítés nélkül elutasít", async () => {
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/kerdes" });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it("mind a négy oldal kitörli a tokent a címsorból", async () => {
    // `deploy/README.md` a `/?token=<TOKEN>`-t adja belépő URL-nek, és azt
    // ígéri, hogy a token "nem is marad benne a címsorban"; `pageAuth` ugyanezt
    // mondja. A takarító script egy ideig csak a `/kerdes`-re került ki, tehát
    // épp azon az oldalon nem futott, amit a README megnyittat — a token ott
    // maradt a címsorban, az előzményben és minden onnan mentett könyvjelzőben.
    const a = await boot();
    for (const url of ["/", "/szamok", "/terulet", "/kerdes"]) {
      const res = await a.server.inject({
        method: "GET", url, headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(`searchParams.delete("token")`);
      expect(res.body, url).toContain("history.replaceState");
    }
    await a.close();
  });

  it("a megzavart süti nem zárja ki a gazdát", async () => {
    // `decodeURIComponent("%zz")` dob, és a süti a query-token ág ELŐTT fut le,
    // tehát egyetlen rossz süti minden védett útvonalat 500-ra vitt — a
    // dokumentált `/?token=…` visszaút is 500 lett, vagyis a gazda kizárta
    // magát, amíg kézzel sütit nem törölt. Egy dekódolhatatlan süti nem
    // hitelesítő adat: essen át, ne omoljon össze tőle a kiszolgáló.
    const a = await boot();
    const bad = "jarvis_token=%zz";

    const refused = await a.server.inject({ method: "GET", url: "/", headers: { cookie: bad } });
    expect(refused.statusCode).toBe(401);

    const recovered = await a.server.inject({
      method: "GET", url: `/?token=${TEST_TOKEN}`, headers: { cookie: bad },
    });
    expect(recovered.statusCode).toBe(200);

    const asked = await a.server.inject({
      method: "POST", url: "/api/chat",
      headers: { cookie: bad, authorization: `Bearer ${TEST_TOKEN}` },
      payload: { question: "Mi újság?" },
    });
    // 502 a modell-stub visszautasítása; 500 vagy 401 lenne a bukás.
    expect(asked.statusCode).toBe(502);
    await a.close();
  });

  it("olvashatatlan időbélyegből nem lesz magabiztos 'NaN napja'", async () => {
    // Mindkét oszlop NOT NULL ISO ma, tehát ez nem a valószínűségről szól,
    // hanem a hiba alakjáról: `Math.max(0, NaN)` az NaN, és a régi `ageWords`
    // ezt "NaN napja" formában ki is írta — magabiztos hazugság pont ott, ahol
    // a projekt elve az ellenkezőjét követeli. A hiányzó adat nézzen ki
    // hiányzónak: a kor egyszerűen ne jelenjen meg.
    const a = await boot();
    (a.briefs as unknown as { cached: () => unknown }).cached = () => ({
      date: "2026-09-01", dateLabel: "", generatedAt: "nem-datum", synthesizer: "teszt",
      markdown: "## Ma\n- Egy valódi briefing.", actions: [], durationMs: 0,
      fromCache: true, outcomes: [],
    });
    (a.health as unknown as { forDate: () => unknown }).forDate = () => ({
      date: "2026-09-01", hrv: 61, ingestedAt: "sem-ez-nem-datum",
    });

    const res = await a.server.inject({
      method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("NaN");
    // Ami olvasható, az attól még ott van: a briefing szövege és a mért HRV.
    expect(res.body).toContain("Egy valódi briefing.");
    expect(res.body).not.toContain("íródott");
    await a.close();
  });

  it("a legutóbbi adatos napot a keret hangján mondja ki", async () => {
    // A státuszsáv "2026. szeptember 1., kedd"-et ír; egy nyers ISO dátum
    // mellette ugyanarról a dologról két hang ugyanazon az oldalon.
    const a = await boot();
    a.health.fillGaps("2026-08-30", { steps: 8400 }, new Date("2026-08-30T20:00:00.000Z"));
    const res = await a.server.inject({
      method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("A legutóbbi nap: 2026. augusztus 30., vasárnap.");
    await a.close();
  });
});

/** The name=value pair from a Set-Cookie header, ready to send back as `cookie`. */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return header.split(";")[0]!;
}

describe("Ma oldal — teendők", () => {
  const boot = () => buildTestApp({
    modules: [stubModule({ name: "Teszt", title: "🧪 Teszt" })],
    now: "2026-09-03T08:00:00.000Z",
  });
  const get = (a: Awaited<ReturnType<typeof boot>>, url: string) =>
    a.server.inject({ method: "GET", url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });

  /** Only the Teendők band — the rest of the page also renders text. */
  const teendokSav = (html: string): string =>
    /<h2>Teendők<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

  it("a nem mai nyitott teendőt is mutatja", async () => {
    // Ez a bekötés egyetlen valódi kockázata: a listOpen(ma) a valódi
    // adatbázison üres listát ad, és a lap azt állítaná, hogy nincs teendő.
    const a = await boot();
    a.actions.replaceForDate("2026-08-30", [{
      module: "Teszt",
      action: { id: "r1", kind: "checkbox", text: "RÉGI-JELÖLŐ" },
    }], new Date("2026-08-30T08:00:00.000Z"));

    const res = await get(a, "/");
    const sav = teendokSav(res.body);
    expect(sav).toContain("RÉGI-JELÖLŐ");
    // Worded, not a bare ISO date — the same voice the status strip uses for
    // "today", so the reader is not left doing date arithmetic themselves.
    expect(sav).toContain("2026. augusztus 30., vasárnap");
    await a.close();
  });

  it("a modul saját címét használja címkének", async () => {
    const a = await boot();
    a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: { id: "c1", kind: "checkbox", text: "x" },
    }], new Date("2026-09-03T08:00:00.000Z"));
    expect(teendokSav((await get(a, "/")).body)).toContain("🧪 Teszt");
    await a.close();
  });

  it("ismeretlen modulnál a nyers nevet mutatja", async () => {
    // Egy eltűnt modulhoz kitalálni egy szép nevet hazugság volna.
    const a = await boot();
    a.actions.replaceForDate("2026-09-03", [{
      module: "MarNincsIlyen",
      action: { id: "c2", kind: "checkbox", text: "x" },
    }], new Date("2026-09-03T08:00:00.000Z"));
    expect(teendokSav((await get(a, "/")).body)).toContain("MarNincsIlyen");
    await a.close();
  });

  it("teendő nélkül nincs Teendők sáv", async () => {
    const a = await boot();
    expect((await get(a, "/")).body).not.toContain("<h2>Teendők</h2>");
    await a.close();
  });

  it("a hibakódot a query stringből veszi", async () => {
    const a = await boot();
    const res = await get(a, "/?hiba=calendar_failed");
    expect(res.body).toContain("Nem sikerült a naptárba írni");
    await a.close();
  });

  it("ismeretlen hibakódot nem visszhangoz", async () => {
    // A `.hibasav` CSS-szabály minden lapon ott van a <style>-ban, tehát a
    // puszta "hibasav" alszöveg mindig megtalálható — a tényleges kérdés az,
    // hogy megjelenik-e a <p class="hibasav"> elem maga.
    const a = await boot();
    const res = await get(a, "/?hiba=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).not.toContain('<p class="hibasav');
    await a.close();
  });

  it("egy örökölt kulcsnévvel írt ?hiba nem dönti el az egész lapot", async () => {
    // A `HIBAK` sima objektum-literál a nézetben; egy `HIBAK[code]`
    // zárójeles kikeresés a prototípuslánc mentén is keres, és
    // "toString"/"constructor"/"__proto__" mind egy örökölt, IGAZ-nak
    // számító értéket adna vissza — a lap élesben ezért 500-at adott egy
    // kézzel beírt vagy könyvjelzőzött `?hiba=toString` linkre.
    const a = await boot();
    for (const kod of ["toString", "constructor", "__proto__"]) {
      const res = await get(a, `/?hiba=${kod}`);
      expect(res.statusCode, kod).toBe(200);
      expect(res.body, kod).not.toContain('<p class="hibasav');
    }
    await a.close();
  });

  it("a hibázó teendő-lekérdezés nem viszi el a briefinget", async () => {
    // Az F1 óta érvényes minta: minden darab magában bukik.
    const a = await boot();
    (a.actions as unknown as { listAllOpen: () => never }).listAllOpen = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a, "/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("A mai nap");
    await a.close();
  });

  it("a hibázó teendő-lekérdezés nem viszi el a visszavonható sávot sem", async () => {
    // A brief két KÜLÖN try/catch-et ír elő, nem csak azt, hogy a briefing
    // életben marad — az egyik olvasás bukása a másikat sem viheti el. Egy
    // egyetlen közös try/catch-be összevont változat is 200-at adna vissza
    // "A mai nap" szöveggel, tehát az előző teszt önmagában nem látná ezt a
    // hibát; ez a teszt pontosan azt a csatolást fogja meg.
    const a = await buildTestApp({
      modules: [stubModule({ name: "Teszt", title: "🧪 Teszt" })],
      now: "2026-09-03T08:00:00.000Z",
      calendar: {
        listEvents: async () => [],
        createEvent: async () => ({ uid: "u1", calendar: "Jarvis", url: "https://x/1.ics" }),
        deleteEvent: async () => {},
        healthCheck: async () => ({ ok: true }),
      },
    });
    const rows = a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: {
        id: "p1", kind: "proposal", text: "Kirándulás",
        proposal: { title: "Kirándulás", start: "2026-09-05T09:00:00+02:00", end: "2026-09-05T12:00:00+02:00" },
      },
    }], new Date("2026-09-03T08:00:00.000Z"));
    await a.proposals.accept(rows[0]!.id, new Date("2026-09-03T08:00:00.000Z"));

    (a.actions as unknown as { listAllOpen: () => never }).listAllOpen = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a, "/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Visszavonható naptár-írások");
    expect(res.body).toContain("Kirándulás");
    await a.close();
  });

  it("a hibázó visszavonás-lekérdezés nem viszi el a teendő sávot sem", async () => {
    // Ugyanaz a csatolási kockázat a másik irányból: a `proposals.listUndoable`
    // bukása nem viheti el a nyitott teendőket.
    const a = await boot();
    a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: { id: "c1", kind: "checkbox", text: "KIPIPÁLANDÓ" },
    }], new Date("2026-09-03T08:00:00.000Z"));

    (a.proposals as unknown as { listUndoable: () => never }).listUndoable = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a, "/");
    expect(res.statusCode).toBe(200);
    const sav = teendokSav(res.body);
    expect(sav).toContain("KIPIPÁLANDÓ");
    await a.close();
  });

  it("a napok a nyitott teendők közt is csökkenő dátumsorrendben jelennek meg", async () => {
    // A `listAllOpen()` már date DESC-ben rendez, és a page.ts-beli `Map`
    // csoportosítás csak azt tartja meg, hogy melyik nap melyik beszúrás
    // sorrendjében kerül be — a sorrend maga a route saját felelőssége.
    // Egyetlen korábbi teszt sem lát két különböző napot egyszerre, tehát a
    // route saját csoportosító hurokja megfordíthatná a napokat anélkül,
    // hogy bármelyik teszt észrevenné.
    const a = await boot();
    a.actions.replaceForDate("2026-08-30", [{
      module: "Teszt",
      action: { id: "d1", kind: "checkbox", text: "REGI-NAP" },
    }], new Date("2026-08-30T08:00:00.000Z"));
    a.actions.replaceForDate("2026-09-04", [{
      module: "Teszt",
      action: { id: "d2", kind: "checkbox", text: "UJ-NAP" },
    }], new Date("2026-09-04T08:00:00.000Z"));

    const sav = teendokSav((await get(a, "/")).body);
    const ujIdx = sav.indexOf("UJ-NAP");
    const regiIdx = sav.indexOf("REGI-NAP");
    expect(ujIdx).toBeGreaterThanOrEqual(0);
    expect(regiIdx).toBeGreaterThanOrEqual(0);
    expect(ujIdx).toBeLessThan(regiIdx);
    await a.close();
  });

  it("a javaslat részleteinél a hely és a megjegyzés is megjelenik, ha megvan", async () => {
    const a = await boot();
    a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: {
        id: "pd1", kind: "proposal", text: "Túra",
        proposal: {
          title: "Túra", start: "2026-09-05T09:00:00+02:00", end: "2026-09-05T12:00:00+02:00",
          location: "Normafa", notes: "Vigyél vizet",
        },
      },
    }], new Date("2026-09-03T08:00:00.000Z"));

    const sav = teendokSav((await get(a, "/")).body);
    // Worded — day plus clock time — not the raw ISO instant the module
    // stores: a bare "2026-09-05T09:00:00+02:00" would put a second, machine
    // voice for the same date on a page whose status strip already words it.
    expect(sav).toContain("2026. szeptember 5., szombat, 09:00");
    expect(sav).toContain("Normafa");
    expect(sav).toContain("Vigyél vizet");
    await a.close();
  });

  it("a javaslat részleteinél nincs \"undefined\", ha nincs hely vagy megjegyzés", async () => {
    // A hiányzó `location`/`notes` mezőt feltétel nélkül a tömbbe tenni
    // `undefined`-et injektálna, amit az `escapeHtml` `.replace`-e el is
    // dobhatna hibával — ez a lap 500-át adná vissza, nem csak csúnyán
    // renderelne.
    const a = await boot();
    a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: {
        id: "pd2", kind: "proposal", text: "Túra2",
        proposal: {
          title: "Túra2", start: "2026-09-06T09:00:00+02:00", end: "2026-09-06T12:00:00+02:00",
        },
      },
    }], new Date("2026-09-03T08:00:00.000Z"));

    const res = await get(a, "/");
    expect(res.statusCode).toBe(200);
    const sav = teendokSav(res.body);
    expect(sav).toContain("2026. szeptember 6., vasárnap, 09:00");
    expect(sav).not.toContain("undefined");
    await a.close();
  });
});
