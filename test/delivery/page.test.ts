import { describe, it, expect } from "vitest";
import { metricsRowsFrom } from "../../src/delivery/http/view/numbers.ts";
import type { Metric } from "../../src/core/analysis/stats.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";
import { buildTestApp, TEST_TOKEN, stubModule } from "../helpers.ts";
import type { ChatService } from "../../src/core/chat.ts";

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

  it("a Számok oldal hitelesítés nélkül elutasít", async () => {
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/szamok" });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it("az Elemzés oldal dátumozza az elemzéseket", async () => {
    const a = await boot();
    // AnalysisRepo.save(row: Omit<AnalysisRow, "id">) — createdAt, domain,
    // markdown, summary és metrics mind kötelező.
    a.analyses.save({
      createdAt: "2026-09-01T07:08:45.487Z", domain: "physical",
      markdown: "### Fizikai\n- Magas.", summary: "Magas.", metrics: "{}",
    });
    const res = await a.server.inject({
      method: "GET", url: "/elemzes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("2026-09-01");
    // Strengthened beyond the brief's literal test, for the same reason the
    // /szamok test above adds the aria-current check: "2026-09-01" alone
    // would also appear if /elemzes reused the OLD `renderPage` wholesale
    // (which also dates each analysis), proving nothing about the new route
    // or the shared shell. This pins down what only the new wiring produces.
    // Includes the "elemzes" nav lamp too, lit because this test just saved
    // an analysis (see `navState`'s own `latestPerDomain().length > 0` check).
    expect(res.body).toContain('<a href="/elemzes" class="menu jelzo el" aria-current="page">');
    await a.close();
  });

  it("az Elemzés oldal megmondja, ha még nem futott elemzés", async () => {
    const a = await boot();
    const res = await a.server.inject({
      method: "GET", url: "/elemzes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Még nem futott mélyelemzés");
    await a.close();
  });

  it("az Elemzés oldal hitelesítés nélkül elutasít", async () => {
    // Not in the brief, but Task 5's auth hook is default-deny for anything
    // outside `/api/*` and `PUBLIC_ROUTES` — this confirms the new route is
    // actually guarded rather than assuming the hook covers it.
    const a = await boot();
    const res = await a.server.inject({ method: "GET", url: "/elemzes" });
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
    // /szamok and /elemzes tests above add their own aria-current check: this
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
    for (const url of ["/", "/szamok", "/elemzes", "/kerdes"]) {
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
