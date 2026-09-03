# S8 — Táplálkozás-elemzés: implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A táplálkozás lesz a negyedik elemzési terület — energiaegyensúly,
fehérjefedezet, következetesség —, és a Táplálkozás oldal megkapja az
elemzés-sávot, amit az F3 szándékosan üresen hagyott.

**Architecture:** A meglévő, generikus elemzési csővezeték: az `aggregate()`
kiszámolja a `nutrition` szeletet, a `DOMAINS` lista felveszi, a
`buildDomainPrompt` a `metrics[domain]` szeletet küldi, a válasz az `analyses`
táblába megy, az oldal megmutatja. Új mechanizmus nincs.

**Tech Stack:** Node 24 futtatja a `.ts`-t közvetlenül (nincs build), Fastify 5,
`node:sqlite`, vitest, Groq (ingyenes szint).

## Global Constraints

- **Nincs új futásidejű függőség.** Nincs új adatbázistábla és nincs migráció.
- **Nincs testtömegre vetített fehérje-állítás.** A `health_snapshots` 34
  oszlopa között NINCS testsúly; egy g/ttkg szám kitalált volna. A fedezet a
  SAJÁT tervhez mérődik (a heti étrend napi fehérjéje), és a prompt ezt a
  modellnek is kimondja.
- **A hiányzó adat nem nulla.** Az energiaegyensúly kihagyja azt a napot, ahol
  a bevitel, az alapanyagcsere vagy az aktív kalória bármelyike hiányzik — a
  hiányzót nullának venni naponta több száz kalóriát hazudna.
- **A felület magyar**; kódkomment angolul.
- `--jel` KIZÁRÓLAG mért adat; `--vaz` keret; `--riado` új szabályt nem kap.
- **A tesztek offline futnak**, `memoryDb()`, nem hívnak hálózatot, nem írnak
  a `./data/jarvis.db`-be, nem indítanak szervert a 8787-es porton.
- **Mutációs fegyelem:** minden új teszt bukjon el a javítatlan implementáció
  ellen — ellenőrizd, ne feltételezd. Az F3–F5 alatt tizenkilenc feladatból
  tizennyolc igényelt plusz javítási kört, és **öt esetben maga a TERV
  tesztje volt tautologikus vagy kielégíthetetlen.** Ha egy előírt teszt nem
  tud elbukni, javítsd és írd meg a jelentésben — ne másold át hűségesen.
- Teszt: `npx vitest run <fájl>`. Teljes suite: `npm test` (jelenleg 908 zöld).
  Típusellenőrzés: `npx tsc --noEmit` (jelenleg néma). **Nincs szándékos piros
  állapot ebben a tervben.**

---

### Task 1: A táplálkozási mutatók

**Files:**
- Modify: `src/core/analysis/aggregate.ts`
- Modify: `src/main.ts`, `scripts/analyze.ts`, `src/core/ask/context.ts`,
  `test/helpers.ts` (az `AggregateInput` új mezője miatt — a fordító
  megmutatja mindet)
- Test: `test/core/analysis-nutrition.test.ts`

**Interfaces:**
- Consumes: `HealthSnapshot` (mezői közt `date`, `dietKcal`, `dietProteinG`,
  `basalKcal`, `moveKcal` — mind `number | null`); `PlannedMeal` a
  `src/infra/db/repositories/meals.ts`-ből (`weekday`, `meal`, `item`,
  `needsDefrost`, `defrostLeadH`, `proteinG: number | null`,
  `kcal: number | null`); a fájlban már meglévő `windowed`, `series`,
  `shiftDay`, `Metric` segédek — ezeket ne definiáld újra.
- Produces:
  ```ts
  export interface NutritionMetrics {
    /** Days carrying an intake figure at all. */
    measuredDays: number;
    /** Days from the first intake to `today` inclusive — the honest denominator. */
    windowDays: number;
    lastDate: string | null;
    /** The longest unbroken run of measured days, and the day it ended on. */
    longestStreak: { days: number; endedOn: string } | null;
    kcal: Metric;
    proteinG: Metric;
    balance: {
      /** Mean daily `diet − (basal + move)`, or null with no day carrying all three. */
      mean: number | null;
      n: number;
      over: number;
      under: number;
      /** Days with intake dropped because a burn term was missing. */
      dropped: number;
    };
    /** Planned daily protein from the weekly plan — null when no day is fully priced. */
    plannedProteinG: number | null;
    plannedKcal: number | null;
  }
  // az AggregateInput bővül:
  //   plan: readonly PlannedMeal[];
  // a Metrics bővül:
  //   nutrition: NutritionMetrics;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/core/analysis-nutrition.test.ts` fájlt. Nézd meg előbb egy
meglévő aggregate-teszt (`test/core/analysis-aggregate.test.ts`) snapshot-
segédjét, és **használd azt**, ne írj másikat — ha nincs exportálva, másolj
egy minimálisat a fájlon belülre, ahogy a projekt más tesztjei is teszik.

```ts
import { describe, it, expect } from "vitest";
import { aggregate } from "../../src/core/analysis/aggregate.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";
import type { PlannedMeal } from "../../src/infra/db/repositories/meals.ts";

/** Every field null but the ones a test names. */
function snap(date: string, over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return { date, ingestedAt: `${date}T20:00:00.000Z`,
    sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null,
    steps: null, asleepMin: null, inBedMin: null, coreMin: null, remMin: null,
    deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
    walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
    dietProteinG: null, dietCarbsG: null, dietFatG: null, distanceKm: null,
    standMin: null, walkingSpeed: null, stepLengthCm: null, doubleSupportPct: null,
    asymmetryPct: null, steadinessPct: null, sixMinWalkM: null, stairUpMs: null,
    stairDownMs: null, ...over } as HealthSnapshot;
}

const meal = (weekday: number, m: string, kcal: number | null, proteinG: number | null): PlannedMeal =>
  ({ weekday, meal: m as PlannedMeal["meal"], item: "x",
     needsDefrost: false, defrostLeadH: 0, proteinG, kcal });

const run = (snapshots: HealthSnapshot[], plan: PlannedMeal[] = [], today = "2026-09-10") =>
  aggregate({ today, snapshots, workouts: [], months: [], plan }).nutrition;

describe("táplálkozási mutatók", () => {
  it("az energiaegyensúly kihagyja a hiányos napot, nem veszi nullának", () => {
    // EZ A LEGFONTOSABB ÁLLÍTÁS AZ EGÉSZ DARABBAN. Egy hiányzó aktív kalória
    // nem nulla aktivitás; nullaként beszámítva a napi egyenleg több száz
    // kalóriát hazudna.
    const m = run([
      snap("2026-09-01", { dietKcal: 2000, basalKcal: 1600, moveKcal: 400 }), // -0
      snap("2026-09-02", { dietKcal: 2000, basalKcal: 1600 }),                // kihagyva
      snap("2026-09-03", { dietKcal: 2500, basalKcal: 1600, moveKcal: 400 }), // +500
    ]);
    expect(m.balance.n).toBe(2);
    expect(m.balance.dropped).toBe(1);
    expect(m.balance.mean).toBe(250);
  });

  it("együtt-mért nap nélkül az egyenleg null, nem 0", () => {
    const m = run([snap("2026-09-01", { dietKcal: 2000 })]);
    expect(m.balance.mean).toBeNull();
    expect(m.balance.n).toBe(0);
    expect(m.balance.dropped).toBe(1);
  });

  it("megszámolja a többletes és a hiányos napokat", () => {
    const m = run([
      snap("2026-09-01", { dietKcal: 2500, basalKcal: 1600, moveKcal: 400 }),
      snap("2026-09-02", { dietKcal: 1500, basalKcal: 1600, moveKcal: 400 }),
      snap("2026-09-03", { dietKcal: 1000, basalKcal: 1600, moveKcal: 400 }),
    ]);
    expect(m.balance.over).toBe(1);
    expect(m.balance.under).toBe(2);
  });

  it("a következetesség nevezője az ELSŐ bevitel óta eltelt napok száma", () => {
    // A 2019-es napokról nem azért nincs bevitel, mert kihagytad — a rendszer
    // akkor még nem gyűjtötte. A teljes előzményre osztani hazug arányt adna.
    const m = run([
      snap("2026-01-01"),                       // jóval a bevitel előtt
      snap("2026-09-01", { dietKcal: 2000 }),
      snap("2026-09-02", { dietKcal: 2100 }),
    ]);
    expect(m.measuredDays).toBe(2);
    expect(m.windowDays).toBe(10); // 09-01 .. 09-10 bezárólag
  });

  it("a leghosszabb sorozatot a megszakítás vágja el", () => {
    const m = run([
      snap("2026-09-01", { dietKcal: 1 }),
      snap("2026-09-02", { dietKcal: 1 }),
      snap("2026-09-03", { dietKcal: 1 }),
      snap("2026-09-05", { dietKcal: 1 }),
    ]);
    expect(m.longestStreak).toEqual({ days: 3, endedOn: "2026-09-03" });
  });

  it("nulla mért napnál a sorozat null, egynél 1", () => {
    expect(run([snap("2026-09-01")]).longestStreak).toBeNull();
    expect(run([snap("2026-09-01", { dietKcal: 1 })]).longestStreak)
      .toEqual({ days: 1, endedOn: "2026-09-01" });
  });

  it("a legutóbbi mért nap dátuma a legkésőbbi, nem az utolsó sor", () => {
    const m = run([
      snap("2026-09-03", { dietKcal: 1 }),
      snap("2026-09-01", { dietKcal: 1 }),
    ]);
    expect(m.lastDate).toBe("2026-09-03");
  });

  it("a tervezett fehérje csak a teljesen beárazott napokból jön", () => {
    // Ugyanaz a szabály, amit a Táplálkozás oldal már használ: egy részösszeg
    // a teljes helyén a teljesnek olvasódik.
    const m = run([], [
      meal(1, "reggeli", 500, 30), meal(1, "ebed", 700, 50), meal(1, "vacsora", 400, 30), // 110
      meal(2, "reggeli", 500, 30), meal(2, "ebed", 700, null),                            // kihagyva
    ]);
    expect(m.plannedProteinG).toBe(110);
    expect(m.plannedKcal).toBe(1600);
  });

  it("étrend nélkül a tervezett értékek null-ok", () => {
    const m = run([snap("2026-09-01", { dietKcal: 2000 })], []);
    expect(m.plannedProteinG).toBeNull();
    expect(m.plannedKcal).toBeNull();
  });

  it("egyetlen beárazatlan nap sem ad részösszeget", () => {
    const m = run([], [meal(1, "reggeli", 500, null)]);
    expect(m.plannedProteinG).toBeNull();
  });

  it("a mért bevitel a saját mintaszámával jön", () => {
    const m = run([
      snap("2026-09-01", { dietKcal: 2000, dietProteinG: 100 }),
      snap("2026-09-02", { dietKcal: 2200, dietProteinG: null }),
    ]);
    expect(m.kcal.value).toBe(2100);
    expect(m.kcal.n).toBe(2);
    expect(m.proteinG.value).toBe(100);
    expect(m.proteinG.n).toBe(1);
  });

  it("bevitel nélkül minden mutató hiányt mond, nem nullát", () => {
    const m = run([snap("2026-09-01")]);
    expect(m.measuredDays).toBe(0);
    expect(m.lastDate).toBeNull();
    expect(m.kcal.value).toBeNull();
    expect(m.balance.mean).toBeNull();
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/core/analysis-nutrition.test.ts`
Expected: FAIL — `.nutrition` nem létezik, és az `aggregate` nem fogad `plan`-t

- [ ] **Step 3: Írd meg a mutatókat**

Az `aggregate.ts`-ben az `AggregateInput`-ba:

```ts
  /**
   * The weekly meal plan.
   *
   * The planned protein is what the measured intake is compared against —
   * there is no body weight anywhere in this database, so a per-kilogram
   * claim would have to be invented. The plan is the honest yardstick: it is
   * what this person decided to eat.
   */
  plan: readonly PlannedMeal[];
```

és az importok közé `import type { PlannedMeal } from "../../infra/db/repositories/meals.ts";`.

A `NutritionMetrics` interfészt tedd a `FinanceMetrics` után, a fenti
alakban, a doc-kommentekkel együtt. A `Metrics` interfész kapja meg a
`nutrition: NutritionMetrics;` mezőt.

Az `aggregate()` törzsébe, a finance rész után:

```ts
  // ---- nutrition ----------------------------------------------------------
  const intake = snapshots
    .filter((s) => typeof s.dietKcal === "number")
    .sort((a, b) => a.date.localeCompare(b.date));
  const lastDate = intake.at(-1)?.date ?? null;
  const firstDate = intake[0]?.date ?? null;
  // Days since the FIRST intake, not the whole history: nothing was skipped
  // before the phone started reporting it, and dividing by 2718 days would
  // turn "we only started in September" into "you log one day in thirty-six".
  const windowDays = firstDate === null ? 0 : dayGap(firstDate, today) + 1;

  let longestStreak: NutritionMetrics["longestStreak"] = null;
  let run = 0;
  let previous: string | null = null;
  for (const s of intake) {
    run = previous !== null && dayGap(previous, s.date) === 1 ? run + 1 : 1;
    if (longestStreak === null || run > longestStreak.days) {
      longestStreak = { days: run, endedOn: s.date };
    }
    previous = s.date;
  }

  // A day is only usable when it carries intake AND both burn terms. A
  // missing `moveKcal` is not a day without movement, and counting it as zero
  // would overstate the surplus by however much was actually burned.
  let sum = 0, n = 0, over = 0, under = 0, dropped = 0;
  for (const s of intake) {
    if (typeof s.basalKcal !== "number" || typeof s.moveKcal !== "number") {
      dropped++;
      continue;
    }
    const diff = s.dietKcal! - (s.basalKcal + s.moveKcal);
    sum += diff; n++;
    if (diff > 0) over++; else if (diff < 0) under++;
  }

  // A planned day counts only when every one of its items carries a figure —
  // a partial sum standing where a day's total belongs reads as the total.
  const plannedTotal = (key: "kcal" | "proteinG"): number | null => {
    const byDay = new Map<number, number>();
    for (const p of input.plan) {
      if (byDay.get(p.weekday) === null) continue;
      const v = p[key];
      if (v === null) { byDay.set(p.weekday, null as unknown as number); continue; }
      byDay.set(p.weekday, (byDay.get(p.weekday) ?? 0) + v);
    }
    const totals = [...byDay.values()].filter((v): v is number => typeof v === "number");
    return totals.length === 0 ? null : Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
  };

  const nutrition: NutritionMetrics = {
    measuredDays: intake.length,
    windowDays,
    lastDate,
    longestStreak,
    kcal: windowed(series(snapshots, "dietKcal"), today, Math.max(1, windowDays), `${windowDays}d`),
    proteinG: windowed(series(snapshots, "dietProteinG"), today, Math.max(1, windowDays), `${windowDays}d`),
    balance: { mean: n === 0 ? null : Math.round(sum / n), n, over, under, dropped },
    plannedProteinG: plannedTotal("proteinG"),
    plannedKcal: plannedTotal("kcal"),
  };
```

és a `return` objektumba a `nutrition,` mező.

**Figyelem:** a `plannedTotal` fenti vázlata `null`-t tárol egy `number`
térképben, ami csúnya. Írd át úgy, hogy a nap állapotát tisztán fejezze ki —
például egy `Map<number, number | null>`-lal, vagy előbb csoportosítsd a
tételeket nap szerint, aztán számolj. A viselkedés a fontos, nem a vázlat
betűje: **egyetlen beárazatlan tétel az egész napot kihagyja.**

Ellenőrizd, hogy a `dayGap` exportálva van-e a `stats.ts`-ből, és importáld,
ha még nincs a fájlban.

- [ ] **Step 4: Igazítsd a négy hívási helyet**

A fordító megmutatja mind a négyet (`src/main.ts` kétszer,
`src/core/ask/context.ts`, `test/helpers.ts`, és `scripts/analyze.ts`, ha az
is hív). Mindegyikbe vedd fel a `plan`-t. A `MealRepo`-nak nincs „mindet"
metódusa; a hét hívás `forWeekday(0..6)` összesen 21 sort olvas:

```ts
plan: [0, 1, 2, 3, 4, 5, 6].flatMap((w) => app.meals.forWeekday(w)),
```

A `test/helpers.ts`-ben a `meals` repó már létezik `meals` néven; a
`src/core/ask/context.ts`-ben nézd meg, van-e `meals` a deps közt, és ha
nincs, vedd fel ugyanúgy, ahogy a `workouts` szerepel.

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/core/analysis-nutrition.test.ts`
Expected: PASS mind a 12

Majd: `npm test && npx tsc --noEmit`

- [ ] **Step 6: Mutációs ellenőrzés**

Cseréld a `dropped++; continue;` ágat arra, hogy a hiányzó tagot nullának
veszi (`const basal = s.basalKcal ?? 0;` és ugyanígy a move-ra), és futtasd
újra. Expected: FAIL — „az energiaegyensúly kihagyja a hiányos napot".
Állítsd vissza.

Cseréld a `windowDays` számítását a teljes előzményre (`snapshots.length`), és
futtasd újra. Expected: FAIL — „a következetesség nevezője az ELSŐ bevitel
óta". Állítsd vissza.

A `plannedTotal`-ban hagyd figyelmen kívül a `null` tételeket ahelyett, hogy
kihagynád a napot, és futtasd újra. Expected: FAIL — „a tervezett fehérje
csak a teljesen beárazott napokból jön". Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: táplálkozási mutatók — egyensúly, fedezet, következetesség"
```

---

### Task 2: A nutrition elemzési domain

**Files:**
- Modify: `src/infra/db/repositories/analyses.ts` (a `Domain` unió)
- Modify: `src/core/analysis/analyst.ts` (a `DOMAINS` lista)
- Modify: `src/core/analysis/prompts.ts` (`TITLE`, `BRIEF`, a szabály a
  testsúlyról)
- Test: `test/core/analysis-prompts.test.ts` és
  `test/core/analysis-analyst.test.ts` (meglévő fájlok — nézd meg a nevüket a
  `test/core/` könyvtárban, és a meglévőkbe írj)

**Interfaces:**
- A `Domain` unió bővül: `"physical" | "recovery" | "finance" | "nutrition" | "synthesis"`.
- A `TITLE` és a `BRIEF` `Record` típusúak a `Domain` felett, tehát a fordító
  kikényszeríti az új bejegyzést — ez a szándék, ne lazítsd `Partial`-ra.

- [ ] **Step 1: Írd meg a bukó tesztet**

A meglévő prompt-tesztfájlba:

```ts
describe("táplálkozási prompt", () => {
  it("a saját szeletét küldi, nem a teljes Metrics-et", () => {
    const m = metricsFixture(); // a fájl meglévő fixtúrája; ha nincs, írj minimálisat
    const { user } = buildDomainPrompt("nutrition", m, []);
    expect(user).toContain("measuredDays");
    expect(user).not.toContain("loadRatio");   // a fizikai szelet mezője
  });

  it("kimondja, hogy nincs testsúly-adat", () => {
    // Enélkül a modell g/testtömeg-kilogramm állítást írna, amihez ki kellene
    // találnia egy testsúlyt — pontosan az, amit ez a rendszer nem tesz.
    const { system } = buildDomainPrompt("nutrition", metricsFixture(), []);
    expect(system).toContain("testsúly");
  });

  it("a területnek van magyar címe", () => {
    const { system } = buildDomainPrompt("nutrition", metricsFixture(), []);
    expect(system).toContain("Táplálkozás");
  });
});
```

A futtató tesztfájlba:

```ts
  it("a táplálkozás is végigmegy a futtatáson", async () => {
    // …a fájl meglévő runAnalysis-tesztjének mintájára, egy sikeres
    // válaszsorozattal. Állítsd, hogy a kimenetek közt ott a "nutrition"
    // domain, és hogy az elmentett sorok közt is.
  });

  it("egy elszálló táplálkozás-elemzés nem viszi el a többit", async () => {
    // …a fájl meglévő hibatűrés-tesztjének mintájára: a nutrition hívás
    // dobjon, a másik három írjon. Állítsd, hogy három sikeres kimenet van és
    // a nutrition hibával tér vissza.
  });
```

**A két futtató-teszt csonk szándékosan nem teljes:** a `runAnalysis` tesztek
alakja a meglévő fájlban van, és annak a mintáját kell követni, nem egy
kitaláltat. Olvasd el, és írd meg őket abban az alakban. Ha a meglévő fájl
nem tartalmaz ilyen tesztet, mondd meg a jelentésben, és írj egyet a
`runAnalysis` szignatúrájából.

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/core/`
Expected: FAIL — a `"nutrition"` nem eleme a `Domain` uniónak

- [ ] **Step 3: Vedd fel a domaint**

`src/infra/db/repositories/analyses.ts`:

```ts
export type Domain = "physical" | "recovery" | "finance" | "nutrition" | "synthesis";
```

`src/core/analysis/analyst.ts`:

```ts
const DOMAINS = ["physical", "recovery", "finance", "nutrition"] as const;
```

`src/core/analysis/prompts.ts` — a `TITLE`-be `nutrition: "Táplálkozás",`, a
`BRIEF`-be:

```ts
  nutrition:
    "Energiaegyensúly, fehérjefedezet és a mérés következetessége. A "
    + "`balance` csak azokból a napokból számol, ahol a bevitel ÉS az "
    + "alapanyagcsere ÉS az aktív kalória is megvan; a `dropped` azt mondja, "
    + "hány mért nap maradt ki emiatt. A `plannedProteinG` a heti étrend "
    + "napi fehérjéje — ehhez mérd a mértet, mert TESTSÚLY-ADAT NINCS a "
    + "rendszerben, tehát testtömeg-kilogrammra vetített állítást ne írj.",
```

A testsúly-szabály a `BRIEF`-ben elég, mert a `systemFor` az `extra`
paraméterben ezt is beleteszi a rendszer-üzenetbe — **ellenőrizd, hogy tényleg
így van**, és ha a `BRIEF` nem jut el a system promptba, tedd a szabályt oda,
ahová eljut.

- [ ] **Step 4: Futtasd a teszteket**

Run: `npm test && npx tsc --noEmit`
Expected: minden zöld. Ha egy meglévő teszt a domainek SZÁMÁRA vagy a
`DOMAINS` tartalmára állít, frissítsd — a követelménye nem változik, csak a
lista lett hosszabb; írd meg a jelentésben, melyiket érintetted.

- [ ] **Step 5: Mutációs ellenőrzés**

Vedd ki a testsúly-mondatot a `BRIEF`-ből, és futtasd újra.
Expected: FAIL — „kimondja, hogy nincs testsúly-adat". Állítsd vissza.

Vedd ki a `"nutrition"`-t a `DOMAINS`-ből, és futtasd újra.
Expected: FAIL — a futtató-teszt. Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: a táplálkozás negyedik elemzési területként"
```

---

### Task 3: Az elemzés-sáv a Táplálkozás oldalon

Az F3 szándékosan hagyta el ezt a sávot, és a spec kimondta, hogy az S8 hozza
meg. **Az a teszt, ami ma azt állítja, hogy nincs sáv, most megfordul** — a
követelmény nem szűnik meg, hanem teljesül.

**Files:**
- Modify: `src/delivery/http/view/area/nutrition.ts`
- Modify: `src/delivery/http/routes/areas.ts`
- Test: `test/delivery/area-nutrition.test.ts`, `test/delivery/area-routes.test.ts`

**Interfaces:**
- Consumes: `analysisBand`, `AreaAnalysis`, `EarlierAnalysis` a `./frame.ts`-ből.
- A `NutritionData` két mezővel bővül:
  ```ts
    analysis: AreaAnalysis | undefined;
    earlier: readonly EarlierAnalysis[];
  ```

- [ ] **Step 1: Írd át a meglévő tesztet és írj újat**

A `test/delivery/area-nutrition.test.ts`-ben a „nincs elemzés-sávja, és nincs
hamarosan felirata sem" teszt **helyére**:

```ts
  it("elemzés-sávot kap, mert az S8 óta van nutrition domain", () => {
    // Az F3 ezt a sávot szándékosan hagyta el — akkor nem volt mögötte
    // domain, és egy üres sáv vagy egy „hamarosan" felirat hiányzó adat lett
    // volna, ami nem látszik hiányzónak. Az S8 megcsinálta a domaint.
    const html = nutritionBody({
      ...empty, measuredDays: 74,
      analysis: { markdown: "**Fontos**", createdAt: "2026-09-04T07:00:00.000Z" },
      earlier: [],
    });
    expect(html).toContain("Elemzés");
    expect(html).toContain("<strong>Fontos</strong>");
    expect(html).toContain("2026-09-04");
  });

  it("elemzés nélkül megmondja, hogyan lehet elindítani — nem hamarosant ír", () => {
    const html = nutritionBody({ ...empty, analysis: undefined, earlier: [] });
    expect(html).toContain("Még nem futott");
    expect(html).toContain("npm run analyze");
    expect(html).not.toContain("hamarosan");
  });
```

és az `empty` fixtúra kapja meg az `analysis: undefined, earlier: []` mezőket.

A `test/delivery/area-routes.test.ts`-be:

```ts
  it("a táplálkozás elemzése a saját oldalára kerül", async () => {
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-09-04T07:00:00.000Z", domain: "nutrition",
      markdown: "TAPLALKOZAS-JELOLO", summary: "s", metrics: "{}",
    });
    const res = await get(a, "/terulet/taplalkozas");
    expect(res.body).toContain("TAPLALKOZAS-JELOLO");
  });

  it("a hub Táplálkozás-kártyája a nutrition összefoglalóját viszi", async () => {
    const a = await boot();
    a.analyses.save({
      createdAt: "2026-09-04T07:00:00.000Z", domain: "nutrition",
      markdown: "x", summary: "KARTYA-OSSZEFOGLALO", metrics: "{}",
    });
    const res = await get(a, "/terulet");
    expect(res.body).toContain("KARTYA-OSSZEFOGLALO");
  });
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-nutrition.test.ts test/delivery/area-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Add hozzá a sávot**

A `nutrition.ts` `NutritionData`-jába a két mező, és a `nutritionBody`
visszatérésének VÉGÉRE `analysisBand(d.analysis, d.earlier)`. Írd át a
függvény doc-kommentjét: már nem „az egyetlen sáv nélküli oldal", hanem
ugyanaz a négy sáv, mint a többié — és mondd ki, hogy ezt az S8 hozta meg.

A `routes/areas.ts` táplálkozás-útvonalán add át a domain elemzését és
előzményét, ugyanabban a mintában, ahogy a másik három terület teszi (saját
`try/catch`, saját `logger.warn`).

A hub kártyáján a Táplálkozás mostantól a `nutrition` domain `summary`-jét
viszi, ha van; ha nincs, **marad a mai viselkedés** (a mért napok száma és a
„Rögzített bevitel." sor). A vezető szám (`figure`) továbbra is a mért napok
száma — az a terület saját mért adata, és nem az elemzés dolga megmondani.

- [ ] **Step 4: Futtasd a teszteket**

Run: `npm test && npx tsc --noEmit`
Expected: minden zöld

- [ ] **Step 5: Mutációs ellenőrzés**

Vedd ki az `analysisBand(...)` hívást a `nutritionBody` végéről, és futtasd
újra. Expected: FAIL — „elemzés-sávot kap". Állítsd vissza.

Cseréld a route-ban a domaint `"physical"`-ra, és futtasd újra.
Expected: FAIL — „a táplálkozás elemzése a saját oldalára kerül". Állítsd
vissza, futtasd újra: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: elemzés-sáv a Táplálkozás oldalon"
```

---

## Önátnézés

**Spec-lefedettség.**

| Spec-szakasz | Feladat |
|---|---|
| Energiaegyensúly, együtt-mért napokból | Task 1 |
| Fehérjefedezet a saját tervhez, testsúly nélkül | Task 1 (mutató) + Task 2 (a prompt szabálya) |
| Következetesség, az első bevitel óta | Task 1 |
| `nutrition` domain a csővezetéken | Task 2 |
| Elemzés-sáv a Táplálkozás oldalon | Task 3 |
| A hub kártyájának összefoglalója | Task 3 |
| Hibatűrés | Task 1 (tiszta függvény), Task 2 (domainenkénti elkapás), Task 3 (route) |

Nincs lefedetlen spec-követelmény.

**Két hely, ahol a terv szándékosan nem ad kész kódot.** A Task 1 Step 3
`plannedTotal` vázlata `null`-t tárol egy `number` térképben, és a terv ezt
kimondja: a viselkedés a követelmény, a vázlat betűje nem. A Task 2 futtató-
tesztjei csonkok, mert a `runAnalysis` tesztek alakja a meglévő fájlban van,
és azt kell követni. Mindkét helyen a terv megmondja, mi a helyes eredmény,
és megkéri a megvalósítót, hogy szóljon, ha a meglévő minta mást kíván.

**Sorrendfüggőség.** A Task 2 a Task 1-re épül (a promptnak kell a szelet), a
Task 3 mindkettőre. A suite végig zöld marad.
