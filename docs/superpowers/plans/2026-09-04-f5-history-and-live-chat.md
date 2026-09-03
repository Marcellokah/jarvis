# F5 — Előzmény és élő beszélgetés: implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A korábbi elemzések elérhetővé válnak a területi oldalakon és a
hubon, JavaScript nélkül; a chat válasza pedig újratöltés nélkül kerül a
fonálba.

**Architecture:** Az előzmény natív `<details>`. A chat scriptje — ami már ma
is létezik és `fetch`-el — a `location.reload()` helyett beilleszti a
szervertől kapott, ott renderelt HTML-t.

**Tech Stack:** Node 24 futtatja a `.ts`-t közvetlenül (nincs build), Fastify 5,
`node:sqlite`, vitest.

## Global Constraints

- **Nincs új futásidejű függőség.**
- **A kliensoldali JavaScript felülete nem nő.** Két örökölt kivétel van (a
  token-takarító a fejlécben, a kérdés-űrlap küldője); az F5 az utóbbi
  EGYETLEN sorát cseréli, és semmilyen új lapra nem kerül script. Az
  elemzés-előzmény natív `<details>`, nulla JS.
- **A felület magyar.** Felhasználónak szánt szöveg és CSS-osztálynév magyarul,
  kódkomment angolul.
- **Színszabály:** `--jel` KIZÁRÓLAG mért adat; `--vaz` keret, soha nem adat;
  `--riado` kizárólag az állapotsáv elmaradt-csatorna sora és a
  naptár-hiba sávja — ez a terv EGYETLEN új `--riado` szabályt sem ad.
- **A hiányzó adat hiányzónak látsszon.** Korábbi elemzés nélkül nincs
  `<details>` — sem üresen, sem letiltva.
- **A tesztek offline futnak**, `memoryDb()`, nem írnak a `./data/jarvis.db`-be,
  nem indítanak szervert a 8787-es porton.
- **Mutációs fegyelem:** minden új teszt bukjon el a javítatlan implementáció
  ellen — ellenőrizd, ne feltételezd. Az F3-on tizenkét feladatból tizenegy,
  az F4-en négyből négy igényelt plusz javítási kört, szinte mindig azért,
  mert egy teszt nem látta a hibát, amit őrizni hivatott; **háromszor maga a
  TERV tesztje volt tautologikus.** Ha egy előírt tesztről kiderül, hogy nem
  tud elbukni, javítsd és írd meg a jelentésben — ne másold át hűségesen.
  Minden állítást szűkíts a saját sávjára lusta, jobbról lehorgonyzott
  kivonattal.
- Minden HTML-be kerülő szöveg `escapeHtml`-en megy át; markdown csak
  `renderMarkdown`-on.
- Teszt: `npx vitest run <fájl>`. Teljes suite: `npm test` (jelenleg 878 zöld).
  Típusellenőrzés: `npx tsc --noEmit` (jelenleg néma). **Nincs szándékos piros
  állapot ebben a tervben.**

---

## Fájlszerkezet

```
MÓDOSUL
  src/delivery/http/view/area/frame.ts   analysisBand + előzmény        (Task 1)
  src/delivery/http/view/theme.ts        a <details> stílusa            (Task 1)
  src/delivery/http/view/area/load.ts    LoadData.earlier               (Task 2)
  src/delivery/http/view/area/recovery.ts  RecoveryData.earlier         (Task 2)
  src/delivery/http/view/area/finance.ts   FinanceData.earlier          (Task 2)
  src/delivery/http/view/area/hub.ts       HubData.earlierSynthesis     (Task 2)
  src/delivery/http/routes/areas.ts        a korábbiak átadása          (Task 2)
  src/delivery/http/routes/page.ts         /api/chat html mezője        (Task 3)
  src/delivery/http/view/ask.ts            reload helyett beillesztés   (Task 3)
```

---

### Task 1: Az előzmény-blokk

**Files:**
- Modify: `src/delivery/http/view/area/frame.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/area-frame.test.ts` (meglévő fájl, bővül)

**Interfaces:**
- Consumes: `escapeHtml`, `renderMarkdown` a `../../markdown.ts`-ből (mindkettő
  már importálva van ebben a fájlban).
- Produces:
  ```ts
  export interface EarlierAnalysis { createdAt: string; summary: string }
  // MEGVÁLTOZIK — a második paraméter KÖTELEZŐ, hogy a fordító minden
  // hívási helyet megtaláljon:
  export function analysisBand(
    a: AreaAnalysis | undefined,
    earlier: readonly EarlierAnalysis[],
  ): string;
  // ÚJ, külön exportálva: a hub maga rendereli a synthesis-t, nem
  // analysisBand-en keresztül, de ugyanezt az előzmény-blokkot akarja.
  export function historyBlock(earlier: readonly EarlierAnalysis[]): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Illeszd a `test/delivery/area-frame.test.ts` végére. Az importsort egészítsd
ki a `historyBlock`-kal és a `STYLE`-lal, ha még nincs ott.

```ts
describe("elemzés-előzmény", () => {
  const earlier = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      createdAt: `2026-08-${String(20 - i).padStart(2, "0")}T07:00:00.000Z`,
      summary: `összefoglaló ${i}`,
    }));

  /** Csak az előzmény-blokk — a sáv fölötte szintén rendel markdownt. */
  const elozmeny = (html: string): string =>
    /<details class="elozmeny">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";

  it("korábbi elemzés nélkül nincs details", () => {
    // Egy üres, kinyitható doboz azt ígérné, hogy van benne valami.
    expect(historyBlock([])).toBe("");
    expect(analysisBand({ markdown: "x", createdAt: "2026-09-01T07:00:00.000Z" }, []))
      .not.toContain("<details");
  });

  it("a felirat a valódi darabszámot mondja", () => {
    // Egy „Korábbiak" felirat nem árulja el, érdemes-e kinyitni.
    expect(historyBlock(earlier(1))).toContain("1 korábbi elemzés");
    expect(historyBlock(earlier(3))).toContain("3 korábbi elemzés");
  });

  it("legfeljebb ötöt mutat", () => {
    // A hatodiktól már archívum, és annak külön hely kell.
    const sav = elozmeny(historyBlock(earlier(9)));
    expect((sav.match(/class="tetel"/g) ?? [])).toHaveLength(5);
  });

  it("hatnál is azt mondja, hányat MUTAT, nem hányan vannak", () => {
    // Egy „9 korábbi elemzés" felirat öt tétel fölött hazudik.
    expect(historyBlock(earlier(9))).toContain("5 korábbi elemzés");
    expect(historyBlock(earlier(9))).not.toContain("9 korábbi elemzés");
  });

  it("minden tételt a saját dátumával és összefoglalójával mutat", () => {
    const sav = elozmeny(historyBlock(earlier(2)));
    expect(sav).toContain("2026-08-20");
    expect(sav).toContain("összefoglaló 0");
    expect(sav).toContain("2026-08-19");
    expect(sav).toContain("összefoglaló 1");
  });

  it("a dátumot napra csonkítja, nem a teljes időbélyeget írja ki", () => {
    const sav = elozmeny(historyBlock(earlier(1)));
    expect(sav).not.toContain("T07:00:00");
  });

  it("escape-eli az összefoglalót", () => {
    // A summary-t a modell írja, nem ez a kód.
    const sav = elozmeny(historyBlock([
      { createdAt: "2026-08-20T07:00:00.000Z", summary: "<script>alert(1)</script>" },
    ]));
    expect(sav).not.toContain("<script>alert(1)</script>");
    expect(sav).toContain("&lt;script&gt;");
  });

  it("a sáv alá kerül, nem a helyére", () => {
    const html = analysisBand(
      { markdown: "**mai**", createdAt: "2026-09-01T07:00:00.000Z" },
      earlier(2),
    );
    expect(html).toContain("<strong>mai</strong>");
    expect(html.indexOf("<strong>mai</strong>")).toBeLessThan(html.indexOf("<details"));
  });

  it("elemzés nélkül is megjelenik, ha van korábbi", () => {
    // Furcsa állapot, de lehetséges: a legfrissebb futás elszállt ezen a
    // domainen, a korábbiak viszont megvannak. A hiány kimondva marad, és
    // az előzmény attól még elérhető.
    const html = analysisBand(undefined, earlier(2));
    expect(html).toContain("Még nem futott");
    expect(html).toContain("<details");
  });

  it("a details alapból csukva van", () => {
    // Nyitva ugyanaz a hosszú lista lenne, csak összecsukható kerettel.
    expect(historyBlock(earlier(3))).not.toContain("<details class=\"elozmeny\" open");
  });

  it("a stíluslap kezeli az elozmeny osztályt", () => {
    const rules = STYLE.split("\n").filter((l) => l.trimStart().startsWith(".elozmeny"));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join("")).not.toContain("riado");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-frame.test.ts`
Expected: FAIL — `historyBlock` nincs exportálva

- [ ] **Step 3: Írd meg a modult**

A `src/delivery/http/view/area/frame.ts`-ben, az `AreaAnalysis` mellé:

```ts
export interface EarlierAnalysis {
  createdAt: string;
  /** One paragraph — the field the next analysis run reads back. */
  summary: string;
}

/**
 * How many earlier analyses the disclosure shows.
 *
 * Past this the list stops being a history and becomes an archive, and an
 * archive wants its own place rather than a fold on a page about today.
 */
const ELOZMENY_MAX = 5;

/**
 * The earlier analyses for one domain, collapsed.
 *
 * A native `<details>`, with no JavaScript: the browser already has a
 * disclosure widget, and a scripted accordion would be more code and worse
 * keyboard reach for the same thing.
 *
 * The `<summary>` names the count rather than saying "Korábbiak", because a
 * neutral label does not tell the reader whether opening it is worth it. It
 * names how many are SHOWN, not how many exist — a label promising nine over
 * a list of five is the same class of confidently-wrong number this project
 * refuses everywhere else.
 *
 * Nothing at all when there is no history: an empty disclosure would promise
 * something behind it.
 */
export function historyBlock(earlier: readonly EarlierAnalysis[]): string {
  const shown = earlier.slice(0, ELOZMENY_MAX);
  if (shown.length === 0) return "";
  const items = shown.map((e) => [
    `<div class="tetel">`,
    `<span class="kor">${escapeHtml(e.createdAt.slice(0, 10))}</span>`,
    `<p>${escapeHtml(e.summary)}</p>`,
    "</div>",
  ].join("")).join("");
  return `<details class="elozmeny"><summary>${shown.length} korábbi elemzés</summary>`
    + `${items}</details>`;
}
```

Cseréld az `analysisBand` szignatúráját és a két visszatérését:

```ts
export function analysisBand(
  a: AreaAnalysis | undefined,
  earlier: readonly EarlierAnalysis[],
): string {
  const elozmeny = historyBlock(earlier);
  if (a === undefined) {
    return "<section><h2>Elemzés</h2>"
      + `<p class="halk">Még nem futott mélyelemzés erre a területre. `
      + `Indítsd: <code>npm run analyze</code></p>${elozmeny}</section>`;
  }
  return `<section><h2>Elemzés · ${escapeHtml(a.createdAt.slice(0, 10))}</h2>`
    + `${renderMarkdown(a.markdown)}${elozmeny}</section>`;
}
```

- [ ] **Step 4: Add hozzá a CSS-t**

A `theme.ts`-ben a `/* ---- teendők és írási műveletek ---- */` blokk ELŐTT:

```css

/* ---- elemzés-előzmény ---- */
.elozmeny { margin-top: 1.2rem; border-top: 1px solid var(--racs); padding-top: .6rem; }
.elozmeny > summary { cursor: pointer; color: var(--vaz);
  font: 600 .68rem/1.6 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
.elozmeny > summary:focus-visible { outline: 2px solid var(--jel); outline-offset: 2px; }
.elozmeny .tetel { padding: .7rem 0; border-bottom: 1px solid var(--racs); }
.elozmeny .tetel:last-child { border-bottom: 0; }
.elozmeny .kor { display: block; font: .62rem/1.6 var(--mono); color: var(--halvany);
  letter-spacing: .12em; }
.elozmeny .tetel p { margin: .2rem 0 0; color: var(--halvany); }
```

- [ ] **Step 5: Igazítsd a meglévő hívásokat**

Az `analysisBand` második paramétere most kötelező, tehát a fordító megmutatja
minden hívási helyét. **Ideiglenesen** add át mindenhol az üres tömböt
(`[]`) — a Task 2 köti be a valódi adatot. Így a suite végig zöld marad.

- [ ] **Step 6: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-frame.test.ts test/delivery/view-theme.test.ts`
Expected: PASS

Majd: `npm test && npx tsc --noEmit` — mindennek zöldnek kell maradnia.

- [ ] **Step 7: Mutációs ellenőrzés**

Cseréld a `historyBlock` első sorát `const shown = [...earlier];`-re (a
levágás nélkül), és futtasd újra.
Expected: FAIL — „legfeljebb ötöt mutat" és „hatnál is azt mondja, hányat
MUTAT". Állítsd vissza.

Cseréld a `if (shown.length === 0) return "";` sort `if (false) return "";`-re.
Expected: FAIL — „korábbi elemzés nélkül nincs details". Állítsd vissza.

Cseréld az `escapeHtml(e.summary)`-t `e.summary`-ra.
Expected: FAIL — „escape-eli az összefoglalót". Állítsd vissza, futtasd újra:
PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: elemzés-előzmény natív details-ben, JS nélkül"
```

---

### Task 2: Az előzmény bekötése

**Files:**
- Modify: `src/delivery/http/view/area/load.ts`, `recovery.ts`, `finance.ts`,
  `hub.ts`
- Modify: `src/delivery/http/routes/areas.ts`
- Test: `test/delivery/area-routes.test.ts` (meglévő fájl, bővül)

**Interfaces:**
- Consumes: `historyBlock`, `EarlierAnalysis` a `./frame.ts`-ből; az
  `AnalysisRepo`-n a már meglévő `recent(domain, n): AnalysisRow[]`
  (legfrissebbel elöl) és `latestPerDomain(): AnalysisRow[]`. Az `AnalysisRow`
  mezői: `id, createdAt, domain, markdown, summary, metrics`.
- Produces: `LoadData`, `RecoveryData`, `FinanceData` mind egy
  `earlier: readonly EarlierAnalysis[]` mezővel bővül; a `HubData` egy
  `earlierSynthesis: readonly EarlierAnalysis[]` mezővel.

- [ ] **Step 1: Írd meg a bukó tesztet**

Illeszd a `test/delivery/area-routes.test.ts` végére:

```ts
describe("elemzés-előzmény az oldalakon", () => {
  const ANALIZIS = (domain: string, nap: string, summary: string) => ({
    createdAt: `2026-08-${nap}T07:00:00.000Z`, domain: domain as never,
    markdown: `# ${domain} ${nap}`, summary, metrics: "{}",
  });

  /** Csak az elemzés-sáv — a lap többi része is rendel szöveget. */
  const elemzesSav = (html: string): string =>
    /<h2>Elemzés[^<]*<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

  it("a korábbi elemzések a saját területükön jelennek meg", async () => {
    const a = await boot();
    a.analyses.save(ANALIZIS("physical", "10", "FIZIKAI-RÉGI"));
    a.analyses.save(ANALIZIS("physical", "20", "FIZIKAI-ÚJ"));
    const sav = elemzesSav((await get(a, "/terulet/terheles")).body);
    expect(sav).toContain("1 korábbi elemzés");
    expect(sav).toContain("FIZIKAI-RÉGI");
  });

  it("a legfrissebb nem jelenik meg kétszer", async () => {
    // A sávban a markdownja van; az előzményben nem szabad ott lennie.
    const a = await boot();
    a.analyses.save(ANALIZIS("physical", "10", "RÉGI-ÖSSZEFOGLALÓ"));
    a.analyses.save(ANALIZIS("physical", "20", "LEGFRISSEBB-ÖSSZEFOGLALÓ"));
    const sav = elemzesSav((await get(a, "/terulet/terheles")).body);
    expect(sav).not.toContain("LEGFRISSEBB-ÖSSZEFOGLALÓ");
    expect(sav).toContain("RÉGI-ÖSSZEFOGLALÓ");
  });

  it("nem szivárog át másik terület előzménye", async () => {
    // Két domain, hogy a keresztbe-szivárgás kiderüljön.
    const a = await boot();
    a.analyses.save(ANALIZIS("physical", "10", "FIZIKAI-RÉGI"));
    a.analyses.save(ANALIZIS("physical", "20", "FIZIKAI-ÚJ"));
    a.analyses.save(ANALIZIS("finance", "11", "PÉNZ-RÉGI"));
    a.analyses.save(ANALIZIS("finance", "21", "PÉNZ-ÚJ"));
    const terheles = elemzesSav((await get(a, "/terulet/terheles")).body);
    expect(terheles).toContain("FIZIKAI-RÉGI");
    expect(terheles).not.toContain("PÉNZ-RÉGI");
  });

  it("egyetlen elemzésnél nincs előzmény-doboz", async () => {
    const a = await boot();
    a.analyses.save(ANALIZIS("recovery", "20", "EGYETLEN"));
    expect(elemzesSav((await get(a, "/terulet/regeneracio")).body))
      .not.toContain("<details");
  });

  it("a hub az Összegzés korábbi darabjait mutatja", async () => {
    const a = await boot();
    a.analyses.save(ANALIZIS("synthesis", "10", "ÖSSZKÉP-RÉGI"));
    a.analyses.save(ANALIZIS("synthesis", "20", "ÖSSZKÉP-ÚJ"));
    const body = (await get(a, "/terulet")).body;
    expect(body).toContain("1 korábbi elemzés");
    expect(body).toContain("ÖSSZKÉP-RÉGI");
  });

  it("a hibázó elemzés-lekérdezés nem viszi el a lapot", async () => {
    const a = await boot();
    (a.analyses as unknown as { recent: () => never }).recent = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a, "/terulet/terheles");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Terhelési arány");
  });
});
```

Ha a `TestApp` nem teszi közzé az `analyses` repót, az már ott van — a
meglévő tesztek használják.

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-routes.test.ts`
Expected: FAIL — nincs előzmény-doboz

- [ ] **Step 3: Bővítsd a négy view-modult**

`load.ts`, `recovery.ts`, `finance.ts` mindegyikének adat-interfészébe:

```ts
  /** Earlier analyses for this domain, newest first, without the one in the band. */
  earlier: readonly EarlierAnalysis[];
```

és a törzsükben az `analysisBand(d.analysis)` hívás legyen
`analysisBand(d.analysis, d.earlier)`. Vedd fel az `EarlierAnalysis` típust
az importok közé.

A `hub.ts` `HubData`-jába:

```ts
  /** Earlier synthesis analyses, newest first, without the one shown above. */
  earlierSynthesis: readonly EarlierAnalysis[];
```

és a synthesis-szekció végére, a `renderMarkdown` után, a `</section>` elé
fűzd be a `historyBlock(d.earlierSynthesis)` kimenetét. **Ha nincs synthesis
elemzés, a szekció ma egyáltalán nem jelenik meg** — ilyenkor az előzményt
sem mutatjuk; ez egyszerűbb, mint egy cím nélküli doboz, és a helyzet
átmeneti (a következő futás megírja a synthesis-t).

- [ ] **Step 4: Kösd be az útvonalakon**

A `src/delivery/http/routes/areas.ts`-ben az `analysisFor` mellé:

```ts
/**
 * The earlier analyses for one domain, newest first, without the one the band
 * already shows.
 *
 * Filtered by id rather than by dropping the first row: `latestPerDomain()`
 * answers with MAX(id) per domain and `recent()` orders by created_at DESC,
 * id DESC, so the two agree today — but an id comparison stays correct if
 * either ever stops agreeing, and it costs one comparison.
 */
function earlierFor(
  deps: PageDeps, rows: readonly AnalysisRow[], domain: Domain,
): EarlierAnalysis[] {
  const latest = rows.find((a) => a.domain === domain);
  if (latest === undefined) return [];
  return deps.analyses.recent(domain, ELOZMENY_LEKERES)
    .filter((r) => r.id !== latest.id)
    .map((r) => ({ createdAt: r.createdAt, summary: r.summary }));
}
```

`ELOZMENY_LEKERES` egy modul-szintű konstans, értéke `6` — öt megjelenítendő
plusz a sávban lévő, amit kiszűrünk:

```ts
/** Five shown plus the one the band already carries, which is filtered out. */
const ELOZMENY_LEKERES = 6;
```

Vedd fel az importokat: `type Domain` a
`../../../infra/db/repositories/analyses.ts`-ből, `type EarlierAnalysis` a
`../view/area/frame.ts`-ből.

Minden területi útvonalon a meglévő, elemzést olvasó `try/catch`-be tedd be
a hívást is — **ugyanabba, nem újba**: egy forrás, egy hiba, egy `logger.warn`.
Az `inputs.analyses` a `shellInputs` saját `try/catch`-e mögül jön, a
`recent()` viszont most fut, tehát a route-ban kell köré védelem:

```ts
    let earlier: EarlierAnalysis[] = [];
    try {
      earlier = earlierFor(deps, inputs.analyses, "physical");
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "area page rendered without its analysis history");
    }
```

és add át a megfelelő `earlier` / `earlierSynthesis` mezőben. A
`taplalkozas` útvonal **nem** kap ilyet: nincs `nutrition` domain, és a
`nutritionBody` nem hív `analysisBand`-et.

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-routes.test.ts`
Expected: PASS

Majd: `npm test && npx tsc --noEmit`

- [ ] **Step 6: Mutációs ellenőrzés**

Töröld a `.filter((r) => r.id !== latest.id)` sort, és futtasd újra.
Expected: FAIL — „a legfrissebb nem jelenik meg kétszer". Állítsd vissza.

Cseréld az `earlierFor`-ban a `domain` paramétert fixen `"physical"`-ra, és
futtasd újra. Expected: FAIL — „nem szivárog át másik terület előzménye".
Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: a korábbi elemzések a területi oldalakon és a hubon"
```

---

### Task 3: Beszélgetés újratöltés nélkül

**Files:**
- Modify: `src/delivery/http/routes/page.ts` (a `POST /api/chat` válasza)
- Modify: `src/delivery/http/view/ask.ts` (a script)
- Test: `test/delivery/page.test.ts` és `test/delivery/view-ask.test.ts`

**Interfaces:**
- A `POST /api/chat` válasza egy mezővel bővül:
  ```jsonc
  { "answer": "…",  // változatlan: a nyers markdown
    "html": "…" }   // ÚJ: ugyanaz renderMarkdown-on átvezetve
  ```
  Ellenőrizve: az `/api/chat`-et kizárólag a lap saját scriptje hívja
  (`view/ask.ts`); a Telegram a `delivery/telegram/responses.ts`-en megy.

- [ ] **Step 1: Írd meg a bukó tesztet**

A `test/delivery/page.test.ts`-be, a chat-tesztek mellé:

```ts
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
```

Ellenőrizd a `ChatService` interfészét (`src/core/chat.ts`) és a
`buildTestApp` `chat` opciójának alakját, mielőtt a fenti csonkot használod;
ha eltér, igazítsd — a KÖVETELMÉNY a fontos, nem a csonk betűje.

A `test/delivery/view-ask.test.ts`-be:

```ts
describe("a chat scriptje", () => {
  it("nem tölti újra a lapot a sikeres válaszon", () => {
    // A görgetési pozíció, a briefing, a mérések és a diagramok mind
    // újraépültek egy kérdés miatt, miközben a szerver már a kezében
    // tartotta a választ.
    const sikeres = SCRIPT.split("catch")[0] ?? "";
    expect(sikeres).not.toContain("location.reload()");
  });

  it("a kérdést szövegként, a választ HTML-ként teszi be", () => {
    // Amit az ember gépel, az nem HTML. Amit a szerver renderelt, az igen —
    // és már escape-elve.
    expect(SCRIPT).toContain("textContent");
    expect(SCRIPT).toContain("innerHTML");
  });

  it("a html mező hiányában visszaesik az újratöltésre", () => {
    // Régi szerver vagy félbeszakadt telepítés: a válasz megvan, csak a
    // lapon keresztül jön elő. Az újratöltés a szerver igazságát mutatja.
    expect(SCRIPT).toContain("location.reload()");
  });

  it("a hibaág változatlanul kezeli a hibát", () => {
    expect(SCRIPT).toContain("Újra");
    expect(SCRIPT).toContain("A fenti tartalom teljes.");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/page.test.ts test/delivery/view-ask.test.ts`
Expected: FAIL — nincs `html` mező, és a script még reloadol

- [ ] **Step 3: Bővítsd az /api/chat választ**

A `src/delivery/http/routes/page.ts`-ben:

```ts
        const answer = await deps.chat.ask(WEB_CHAT_ID, parsed.data.question, controller.signal);
        // `html` beside `answer`, not instead of it: the raw markdown is the
        // response's contract and stays. The rendered form travels with it so
        // the page can put the answer straight into the thread — rendering it
        // in the browser instead would mean a second markdown renderer, on
        // exactly the text a model wrote.
        return reply.send({ answer, html: renderMarkdown(answer) });
```

Vedd fel az importot: `renderMarkdown` a `../markdown.ts`-ből.

- [ ] **Step 4: Írd át a script sikeres ágát**

A `src/delivery/http/view/ask.ts` `SCRIPT`-jében cseréld ezt:

```js
    if (!res.ok) throw new Error("HTTP " + res.status);
    location.reload();
```

erre:

```js
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    // No `html` means an older server than this page: the answer exists, it
    // just has to come back through a reload. The reload shows the server's
    // own truth, so nothing is lost by it.
    if (!data.html) { location.reload(); return; }

    const thread = form.parentNode;
    const add = (who, cls, fill) => {
      const box = document.createElement("div");
      box.className = "turn " + cls;
      const name = document.createElement("div");
      name.className = "who";
      name.textContent = who;
      box.appendChild(name);
      fill(box);
      thread.insertBefore(box, form);
      return box;
    };
    // The question goes in as text, never as markup: what a person types is
    // not HTML. The answer goes in as HTML because the server rendered it —
    // through the same escaping renderer a reload would have used.
    add("Te", "user", (box) => {
      const p = document.createElement("p");
      p.textContent = question;
      box.appendChild(p);
    });
    add("Jarvis", "assistant", (box) => { box.insertAdjacentHTML("beforeend", data.html); });

    input.value = "";
    form.classList.remove("busy");
    button.textContent = "Kérdés";
    input.disabled = button.disabled = false;
    input.focus();
```

Frissítsd a `SCRIPT` fölötti doc-kommentet: mondja ki, hogy a válasz a
fonálba kerül, és hogy a `location.reload()` csak a `html` hiányának ága.

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/page.test.ts test/delivery/view-ask.test.ts`
Expected: PASS

Majd: `npm test && npx tsc --noEmit`

- [ ] **Step 6: Mutációs ellenőrzés**

Cseréld a `return reply.send({ answer, html: renderMarkdown(answer) });` sort
a régire (`{ answer }`), és futtasd újra.
Expected: FAIL — „a chat válasza renderelt HTML-t is ad". Állítsd vissza.

Cseréld a `p.textContent = question;` sort `p.innerHTML = question;`-re, és
futtasd újra. Expected: FAIL — „a kérdést szövegként, a választ HTML-ként
teszi be"? **Ellenőrizd:** ez a teszt csak azt állítja, hogy a `textContent`
SZEREPEL a scriptben, tehát ha az `innerHTML` máshol is előfordul, a mutáció
NEM bukik el. Ha így van, mondd ki a jelentésben, és erősítsd meg a tesztet
úgy, hogy a kérdést beillesztő sorra szűkít — például arra, hogy a
`question` változó `textContent`-tel kerül be. Ne hagyd benne a gyenge
állítást.

Cseréld az `if (!data.html)` feltételt `if (false)`-ra, és futtasd újra.
Expected: FAIL — „a html mező hiányában visszaesik az újratöltésre". Állítsd
vissza, futtasd újra: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: a chat válasza a fonálba kerül, újratöltés nélkül"
```

---

## Önátnézés

**Spec-lefedettség.**

| Spec-szakasz | Feladat |
|---|---|
| Natív `<details>`, JS nélkül | Task 1 |
| A `<summary>` a darabszámot mondja | Task 1 |
| Legfeljebb öt korábbi | Task 1 |
| Korábbi nélkül nincs doboz | Task 1 |
| Az előzmény a saját domainjéé, a legfrissebb nélkül | Task 2 |
| A hub synthesis-előzménye | Task 2 |
| Hibatűrés: egy forrás, egy `try/catch` | Task 2 |
| `/api/chat` `html` mezője, szerver-oldali renderelés | Task 3 |
| A válasz a fonálba kerül, a kérdés szövegként | Task 3 |
| `location.reload()` csak a `html` hiányának ágán | Task 3 |
| A hibaág változatlan | Task 3 |

Nincs lefedetlen spec-követelmény.

**Egy előre kimondott gyengeség.** A Task 3 script-tesztjei a script
SZÖVEGÉRE állítanak, nem a viselkedésére — kliensoldali futtató nélkül ez az,
ami ellenőrizhető, és a spec ezt kimondja. Ezért a Task 3 Step 6 kifejezetten
megkérdezi, elbukik-e a `textContent` → `innerHTML` mutáció, és utasít a
teszt megerősítésére, ha nem. Ha egy teszt nem tud elbukni, az ebben a
projektben nem teszt.

**Sorrendfüggőség.** A Task 1 és a Task 3 független egymástól. A Task 2 a
Task 1-re épül. A suite végig zöld marad — a Task 1 Step 5 azért adja át
ideiglenesen az üres tömböt minden hívási helyen.
