# F6 — A reggeli pillanat: implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Ma oldal napszak szerint, néven köszön, és mond egy mondatot, ami
ma tényleg kiemelkedik — vagy hallgat, ha nincs ilyen.

**Architecture:** Egy tiszta view-modul (`view/greeting.ts`), ami már
kiszámolt adatot kap és sztringet ad vissza; a `/` útvonal saját
`try/catch`-ben szerzi meg hozzá a `Metrics`-et.

**Tech Stack:** Node 24 futtatja a `.ts`-t közvetlenül (nincs build), Fastify 5,
vitest.

## Global Constraints

- **Nincs új futásidejű függőség. Nincs kliensoldali JavaScript.**
- **A felület magyar**; kódkomment angolul.
- `--jel` KIZÁRÓLAG mért adat; `--vaz` keret; **`--riado` egyetlen új
  szabályt sem kap** — a lefelé tartó HRV mondata sem riasztás.
- **A csend is tartalom.** Ha egyik kiemelés-szabály sem illeszkedik, a sáv
  nincs ott — se üresen, se „ma minden rendben"-nel.
- **Semmit nem veszünk el.** Ez a darab hozzáad; meglévő viselkedést csak ott
  változtat, ahol a spec kimondja (a `h2` kontrasztja).
- A tesztek offline futnak, `memoryDb()`, nem indítanak szervert a 8787-esen.
- **Mutációs fegyelem:** minden új teszt bukjon el a javítatlan implementáció
  ellen. Az F3–S8 alatt huszonkét feladatból huszonegy igényelt plusz kört, és
  **nyolc esetben maga a TERV tesztje volt tautologikus vagy
  kielégíthetetlen.** Ha egy előírt teszt nem tud elbukni, javítsd és írd meg.
- Teszt: `npx vitest run <fájl>`. Teljes suite: `npm test` (jelenleg 939 zöld).
  Típusellenőrzés: `npx tsc --noEmit` (jelenleg néma). **Nincs szándékos piros
  állapot.**

---

### Task 1: A köszönés és a nap egy mondata

**Files:**
- Create: `src/delivery/http/view/greeting.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/view-greeting.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` a `../markdown.ts`-ből; `hu` a `./format.ts`-ből;
  `Metric` a `../../../core/analysis/stats.ts`-ből (mezői: `value: number | null`,
  `n`, `coverage`, `window`).
- Produces:
  ```ts
  /** Local hour 0..23 and the owner's name — empty string when none is set. */
  export interface GreetingData { hour: number; name: string }
  export function greeting(d: GreetingData): string;

  export interface HighlightInput {
    hrvDeviation: { sigma: number; n7: number; n90: number } | null;
    /** Today's step count, or null when today has none. */
    todaySteps: number | null;
    steps28: Metric;
  }
  /** The one sentence, or null when nothing today clears the bar. */
  export function highlight(h: HighlightInput): string | null;
  /** The band: greeting always, the sentence only when there is one. */
  export function greetingBand(g: GreetingData, h: HighlightInput | null): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/view-greeting.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { greeting, highlight, greetingBand } from "../../src/delivery/http/view/greeting.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";
import type { Metric } from "../../src/core/analysis/stats.ts";

const NINCS: Metric = { value: null, n: 0, coverage: 0, window: "28d" };
const csend = { hrvDeviation: null, todaySteps: null, steps28: NINCS };

describe("köszönés", () => {
  it("napszak szerint köszön, a határokat is beleértve", () => {
    // A határok azért vannak tesztelve percre, mert egy elcsúszott
    // egyenlőtlenség napi egy órán át rossz köszönést adna, és senki nem
    // venné észre.
    const at = (hour: number) => greeting({ hour, name: "" });
    expect(at(4)).toContain("Jó reggelt");   // hajnal 04-től
    expect(at(3)).toContain("Jó éjt");       // 04 előtt még éjszaka
    expect(at(7)).toContain("Jó reggelt");
    expect(at(10)).toContain("Szép napot");  // délelőtt
    expect(at(12)).toContain("Jó napot");    // délután
    expect(at(18)).toContain("Szép estét");
    expect(at(22)).toContain("Jó éjt");
    expect(at(23)).toContain("Jó éjt");
    expect(at(0)).toContain("Jó éjt");
  });

  it("néven szólít, ha van név", () => {
    expect(greeting({ hour: 8, name: "Marcell" })).toContain("Marcell");
  });

  it("név nélkül nem hagy ott egy lógó vesszőt", () => {
    const g = greeting({ hour: 8, name: "" });
    expect(g).not.toContain(",");
    expect(g).toContain("Jó reggelt");
  });

  it("escape-eli a nevet", () => {
    // A konfigból jön, de a konfigot is ember írja.
    const g = greeting({ hour: 8, name: "<b>x</b>" });
    expect(g).not.toContain("<b>x</b>");
    expect(g).toContain("&lt;b&gt;");
  });
});

describe("a nap egy mondata", () => {
  it("a magas HRV-t a saját alapvonalához méri", () => {
    const s = highlight({ ...csend, hrvDeviation: { sigma: 1.42, n7: 6, n90: 84 } });
    expect(s).toContain("1,42");
    expect(s).toContain("fölött");
  });

  it("az alacsony HRV-t ugyanazon a hangon mondja", () => {
    // A lefelé tartó HRV információ, nem riasztás.
    const s = highlight({ ...csend, hrvDeviation: { sigma: -1.3, n7: 6, n90: 84 } });
    expect(s).toContain("1,3");
    expect(s).toContain("alatt");
    expect(s).not.toContain("riado");
  });

  it("a küszöb alatti HRV-eltérésről hallgat", () => {
    expect(highlight({ ...csend, hrvDeviation: { sigma: 0.9, n7: 6, n90: 84 } })).toBeNull();
    expect(highlight({ ...csend, hrvDeviation: { sigma: -0.9, n7: 6, n90: 84 } })).toBeNull();
  });

  it("kevés mérésből nem beszél HRV-ről", () => {
    // Két éjszakából számolt szórás nem állítás.
    expect(highlight({ ...csend, hrvDeviation: { sigma: 2.5, n7: 2, n90: 84 } })).toBeNull();
  });

  it("a kiugró lépésszámot a 28 napos átlaghoz méri", () => {
    const s = highlight({
      ...csend, todaySteps: 18000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    });
    expect(s).toContain("18 000");
    expect(s).toContain("1,8");
  });

  it("a küszöb alatti lépésszámról hallgat", () => {
    expect(highlight({
      ...csend, todaySteps: 12000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    })).toBeNull();
  });

  it("vékony 28 napos alapból nem beszél lépésről", () => {
    // Tizennégy napnál kevesebb mérésből az „átlagod" szó hazug.
    expect(highlight({
      ...csend, todaySteps: 30000,
      steps28: { value: 10000, n: 10, coverage: .35, window: "28d" },
    })).toBeNull();
  });

  it("a HRV előbbre való a lépésnél", () => {
    // A sorrend számít: egyszerre mindkettő igaz lehet, és egy mondat van.
    const s = highlight({
      hrvDeviation: { sigma: 1.42, n7: 6, n90: 84 },
      todaySteps: 18000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    });
    expect(s).toContain("HRV");
    expect(s).not.toContain("lépés");
  });

  it("ha semmi nem emelkedik ki, hallgat", () => {
    // A csend is tartalom: egy kiemelés, ami minden nap megszólal, annyit ér,
    // mint egy jelző, ami mindig ég.
    expect(highlight(csend)).toBeNull();
  });
});

describe("a köszönés sávja", () => {
  it("mondat nélkül is megvan a köszönés", () => {
    // A köszönés soha nem múlik adaton.
    const html = greetingBand({ hour: 8, name: "Marcell" }, null);
    expect(html).toContain("Marcell");
    expect(html).not.toContain("mondat");
  });

  it("mérés nélkül sincs benne üres mondat-elem", () => {
    const html = greetingBand({ hour: 8, name: "" }, csend);
    expect(html).not.toContain('class="mondat"');
  });

  it("a mondat a köszönés alatt jelenik meg", () => {
    const html = greetingBand({ hour: 8, name: "M" },
      { ...csend, hrvDeviation: { sigma: 1.42, n7: 6, n90: 84 } });
    expect(html).toContain('class="mondat"');
    expect(html.indexOf("Jó reggelt")).toBeLessThan(html.indexOf("HRV"));
  });

  it("a sáv stílusa létezik, és nem használ riasztás-színt", () => {
    const rules = STYLE.split("\n").filter((l) => l.trimStart().startsWith(".koszones"));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join("")).not.toContain("riado");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/view-greeting.test.ts`
Expected: FAIL — `Cannot find module '.../view/greeting.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/greeting.ts` fájlt:

```ts
import { escapeHtml } from "../markdown.ts";
import { hu } from "./format.ts";
import type { Metric } from "../../../core/analysis/stats.ts";

export interface GreetingData {
  /** Local hour 0..23 in Europe/Budapest — the caller does the conversion. */
  hour: number;
  /** The owner's name, or an empty string when none is configured. */
  name: string;
}

/**
 * Six times of day, and the reader's name when there is one.
 *
 * Deliberately not a rotating set of phrasings: a greeting that changes at
 * random reads as a toy after a week, and the time of day is variation that
 * actually means something.
 */
export function greeting(d: GreetingData): string {
  const h = d.hour;
  const word = h < 4 ? "Jó éjt"
    : h < 7 ? "Jó reggelt"
    : h < 10 ? "Jó reggelt"
    : h < 12 ? "Szép napot"
    : h < 18 ? "Jó napot"
    : h < 22 ? "Szép estét"
    : "Jó éjt";
  const name = d.name.trim();
  return name === "" ? `${word}!` : `${word}, ${escapeHtml(name)}!`;
}

export interface HighlightInput {
  hrvDeviation: { sigma: number; n7: number; n90: number } | null;
  /** Today's step count, or null when today has none. */
  todaySteps: number | null;
  steps28: Metric;
}

/** A standard deviation this far from the baseline is worth a sentence. */
const SIGMA = 1;
/** Fewer than this many nights and the deviation is not a claim. */
const MIN_HRV_NIGHTS = 3;
/** Today's steps must clear the 28-day mean by this much. */
const STEP_RATIO = 1.5;
/** Fewer than this many measured days and "your average" is a lie. */
const MIN_STEP_DAYS = 14;

/**
 * The one thing worth saying about today — or nothing.
 *
 * The silence is the feature. A highlight that fires every morning is the
 * same thing as an indicator that is always lit: it stops carrying
 * information and starts being decoration, which this project refuses
 * everywhere else. The thresholds are deliberately conservative so most days
 * say nothing at all.
 *
 * Every sentence compares. A bare "10 608 lépés" is a number; "1,7 times your
 * 28-day average" is the thing worth reading.
 *
 * Order matters, because there is one sentence and more than one rule can
 * match: how the body recovered outranks what it did.
 */
export function highlight(h: HighlightInput): string | null {
  const dev = h.hrvDeviation;
  if (dev !== null && dev.n7 >= MIN_HRV_NIGHTS && Math.abs(dev.sigma) >= SIGMA) {
    const irany = dev.sigma > 0 ? "fölött" : "alatt";
    return `A HRV-d ${hu(Math.abs(dev.sigma), 2)} szórással a saját `
      + `90 napos alapvonalad ${irany} van.`;
  }

  const mean = h.steps28.value;
  if (h.todaySteps !== null && mean !== null && mean > 0
      && h.steps28.n >= MIN_STEP_DAYS && h.todaySteps / mean >= STEP_RATIO) {
    return `Ma ${hu(h.todaySteps)} lépés — a 28 napos átlagod `
      + `${hu(h.todaySteps / mean, 1)}-szerese.`;
  }

  return null;
}

/**
 * The band itself: the greeting always, the sentence only when there is one.
 *
 * The greeting never depends on data — the hour and the name are always
 * there — so a morning with nothing measured yet still opens with something
 * addressed to a person rather than with a date.
 */
export function greetingBand(g: GreetingData, h: HighlightInput | null): string {
  const mondat = h === null ? null : highlight(h);
  const sor = mondat === null ? "" : `<p class="mondat">${escapeHtml(mondat)}</p>`;
  return `<section class="koszones"><p class="udv">${greeting(g)}</p>${sor}</section>`;
}
```

**Figyelem:** a `greeting()` az `escapeHtml`-t a névre alkalmazza, a
`greetingBand` viszont a `greeting()` KIMENETÉT teszi a HTML-be — tehát a
nevet nem szabad kétszer escape-elni. Ellenőrizd, hogy a
„escape-eli a nevet" teszt tényleg a helyes alakot várja, és ha a kettős
escape-elés miatt `&amp;lt;` lenne belőle, rendezd el egyértelműen: vagy a
`greeting()` ad nyers szöveget és a sáv escape-el, vagy fordítva — de ne
mindkettő. Írd meg a jelentésben, melyiket választottad.

- [ ] **Step 4: Add hozzá a CSS-t**

A `theme.ts`-ben a `/* ---- teendők és írási műveletek ---- */` blokk ELŐTT:

```css

/* ---- köszönés ---- */
.koszones { margin-bottom: 1.6rem; }
.koszones .udv { margin: 0; font: 500 1.35rem/1.3 var(--text); color: var(--szoveg); }
.koszones .mondat { margin: .35rem 0 0; color: var(--halvany); }
```

És a kontraszt: a `h2` szabályban a `color: var(--vaz);` helyére
`color: var(--halvany);` — a cím szerkezet, nem adat, és ma alig olvasható.

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/view-greeting.test.ts test/delivery/view-theme.test.ts`
Expected: PASS

Majd `npm test && npx tsc --noEmit`. Ha egy meglévő teszt a `h2` színére
állít, frissítsd — a követelménye (a cím látszódjon) nem változik.

- [ ] **Step 6: Mutációs ellenőrzés**

Cseréld a `Math.abs(dev.sigma) >= SIGMA` feltételt `true`-ra.
Expected: FAIL — „a küszöb alatti HRV-eltérésről hallgat". Állítsd vissza.

Cseréld a `dev.n7 >= MIN_HRV_NIGHTS` feltételt `true`-ra.
Expected: FAIL — „kevés mérésből nem beszél HRV-ről". Állítsd vissza.

Cseréld a `h.steps28.n >= MIN_STEP_DAYS` feltételt `true`-ra.
Expected: FAIL — „vékony 28 napos alapból nem beszél lépésről". Állítsd vissza.

Cseréld a HRV-ágat úgy, hogy a lépés-ág elé kerüljön helyett mögé.
Expected: FAIL — „a HRV előbbre való a lépésnél". Állítsd vissza, futtasd
újra: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: napszak szerinti köszönés és a nap egy mondata"
```

---

### Task 2: Bekötés a Ma oldalra

**Files:**
- Modify: `config/config.ts`
- Modify: `src/delivery/http/routes/page-shell.ts`
- Modify: `src/delivery/http/routes/page.ts`
- Modify: `src/delivery/http/view/today.ts`
- Test: `test/delivery/page.test.ts`

**Interfaces:**
- A `config` egy blokkal bővül:
  ```ts
    /** Who the pages greet. Empty means the greeting works without a name. */
    owner: { name: "" },
  ```
- A `TodayData` két mezővel bővül: `greeting: GreetingData` és
  `highlight: HighlightInput | null`.
- A `ShellInputs` egy mezővel bővül: `snapshot: HealthSnapshot | undefined` —
  a `shellInputs` MA IS kiszámolja, csak nem adja ki.

- [ ] **Step 1: Írd meg a bukó tesztet**

A `test/delivery/page.test.ts`-be:

```ts
describe("Ma oldal — köszönés", () => {
  const boot = (now: string) => buildTestApp({
    modules: [stubModule({ name: "Teszt" })], now,
  });
  const get = (a: Awaited<ReturnType<typeof boot>>) =>
    a.server.inject({ method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` } });

  it("a köszönés a lap legelső eleme", async () => {
    // Ez az, amit reggel elsőként lát — a dátum előtt.
    const a = await boot("2026-09-03T06:00:00.000Z"); // 08:00 Budapesten
    const body = (await get(a)).body;
    expect(body).toContain("Jó reggelt");
    expect(body.indexOf("koszones")).toBeLessThan(body.indexOf("allapot"));
    await a.close();
  });

  it("a napszakot a helyi idő adja, nem az UTC", async () => {
    // 22:00 UTC = 00:00 Budapesten. Ha az UTC órát használnánk, este
    // köszönne éjfélkor.
    const a = await boot("2026-09-03T22:00:00.000Z");
    expect((await get(a)).body).toContain("Jó éjt");
    await a.close();
  });

  it("mérés nélkül is köszön", async () => {
    // A köszönés soha nem múlik adaton.
    const a = await boot("2026-09-03T06:00:00.000Z");
    const body = (await get(a)).body;
    expect(body).toContain("Jó reggelt");
    expect(body).not.toContain('class="mondat"');
    await a.close();
  });

  it("a hibázó aggregátum nem viszi el a köszönést", async () => {
    const a = await boot("2026-09-03T06:00:00.000Z");
    // A metrics() a szerver saját closure-je; a legegyszerűbb hibaforrás a
    // health repó, amin keresztül épül.
    (a.health as unknown as { between: () => never }).between = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Jó reggelt");
    await a.close();
  });
});
```

Ellenőrizd, hogy a `buildTestApp` `now` paramétere tényleg a szerver óráját
állítja, és hogy a `TestApp` közzéteszi-e a `health` repót — ha nem, a
hiba-injektálást oldd meg máshogy, és írd meg a jelentésben, hogyan.

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/page.test.ts`
Expected: FAIL — nincs köszönés

- [ ] **Step 3: Vedd fel a nevet a konfigba**

A `config/config.ts`-be, a `modules` blokk ELÉ:

```ts
  /**
   * Who the pages greet.
   *
   * Empty by default on purpose: the repository is private, but a personal
   * name still does not belong in code. The greeting works without it — it
   * simply drops the name rather than leaving a dangling comma.
   */
  owner: { name: "" },
```

- [ ] **Step 4: Add ki a snapshotot a ShellInputs-ból**

A `page-shell.ts` `ShellInputs` interfészébe:

```ts
  /**
   * Today's row, or undefined when there is none.
   *
   * Already computed here for the readings and the freshness line; exposed so
   * the Ma page can build its highlight from it without a second read.
   */
  snapshot: HealthSnapshot | undefined;
```

és a visszatérő objektumba a `snapshot,` mező.

- [ ] **Step 5: Kösd be a `/` útvonalon**

A `page.ts` `/` útvonalában, a meglévő olvasások mellé:

```ts
    // The highlight needs baselines, which only the aggregate has. Its own
    // try/catch: a failing aggregate must drop the sentence, never the
    // greeting — and never the page. This is the first time the Ma page
    // builds an aggregate; the Számok and area pages already do.
    let highlight: HighlightInput | null = null;
    try {
      const m = deps.metrics();
      highlight = {
        hrvDeviation: m.recovery.hrvDeviation,
        todaySteps: inputs.snapshot?.steps ?? null,
        steps28: m.physical.steps.d28,
      };
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "today page rendered without its highlight");
    }
```

és a `todayBody({...})` hívásba:

```ts
      greeting: { hour: Number(isoTime(now, TZ).slice(0, 2)), name: config.owner.name },
      highlight,
```

Vedd fel az importokat: `isoTime` a `../../../shared/dates.ts`-ből, `config`
a `../../../../config/config.ts`-ből (ellenőrizd a relatív mélységet), és a
`HighlightInput` típus a `../view/greeting.ts`-ből.

- [ ] **Step 6: Tedd a sávot a Ma oldal élére**

A `today.ts` `TodayData`-jába:

```ts
  greeting: GreetingData;
  /** Null when the aggregate could not be built — the greeting still shows. */
  highlight: HighlightInput | null;
```

és a `todayBody` visszatérésének LEGELEJÉRE — a hibasáv elé —
`greetingBand(data.greeting, data.highlight)`.

- [ ] **Step 7: Futtasd a teljes suite-ot**

Run: `npm test && npx tsc --noEmit`
Expected: minden zöld. A meglévő Ma-oldal tesztek `TodayData` fixtúrái két
mezővel bővülnek — mechanikus, egyetlen állítást se változtass.

- [ ] **Step 8: Mutációs ellenőrzés**

Cseréld az órát UTC-re (`new Date(...).getUTCHours()`), és futtasd újra.
Expected: FAIL — „a napszakot a helyi idő adja". Állítsd vissza.

Vedd ki a `greetingBand(...)`-ot a `todayBody` elejéről.
Expected: FAIL — „a köszönés a lap legelső eleme". Állítsd vissza.

Vedd ki a `try/catch`-et a highlight körül.
Expected: FAIL — „a hibázó aggregátum nem viszi el a köszönést". Állítsd
vissza, futtasd újra: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: a köszönés a Ma oldal élén"
```

---

## Önátnézés

| Spec-szakasz | Feladat |
|---|---|
| Napszak szerinti, néven szólító köszönés | Task 1 (logika) + Task 2 (óra, név) |
| A nap egy mondata, három szabállyal | Task 1 |
| Csend, ha semmi nem emelkedik ki | Task 1 |
| A lefelé tartó HRV nem riasztás | Task 1 |
| `config.owner.name` üres alapértékkel | Task 2 |
| A `h2` kontrasztja | Task 1 (Step 4) |
| Hibatűrés: a köszönés soha nem múlik adaton | Task 2 |

Nincs lefedetlen spec-követelmény.

**Egy előre kimondott csapda.** A Task 1 Step 3 megjegyzése kiemeli: a
`greeting()` escape-eli a nevet, és a `greetingBand` a KIMENETÉT teszi a
HTML-be — ha a sáv újra escape-elne, `&amp;lt;` lenne belőle. A terv
megmondja, mi a helyes eredmény, és megkéri a megvalósítót, hogy döntse el
egyértelműen, melyik réteg escape-el.

**Sorrendfüggőség.** A Task 2 a Task 1-re épül. A suite végig zöld marad.
