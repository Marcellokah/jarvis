# F3 — Területi oldalak: implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Négy területi oldal (Terhelés, Regeneráció, Táplálkozás, Pénzügy) egy
hub alatt, hogy a 2392 edzés, az 5 előfizetés, a heti étrend és a 74 nap
bevitel végre látszódjon — mindegyik a saját domain-elemzésével együtt, amiért
az `/elemzes` feloldódik.

**Architecture:** Szerver-oldali HTML, keretrendszer és build lépés nélkül,
ahogy az F1 óta. A `view/area/*` modulok már lekérdezett adatot kapnak és
sztringet adnak vissza — repository-hoz nem érnek, ezért adatbázis nélkül
tesztelhetők. A `routes/areas.ts` végzi a lekérdezést, darabonkénti
`try/catch`-csel. Egy új rajzoló primitív készül (`view/chart/bars.ts`), ami
kétféle üreset ismer: nincs adat és mért nulla.

**Tech Stack:** Node 24 futtatja a `.ts`-t közvetlenül (nincs build), Fastify 5,
`node:sqlite`, vitest. Kézzel írt SVG.

## Global Constraints

Ezek minden feladatra érvényesek, külön ismétlés nélkül.

- **Nincs új futásidejű függőség.** Sem npm csomag, sem CDN. Ez a projekt kemény
  szabálya, és ezért van minden diagram kézzel írt SVG-ben.
- **Nincs kliensoldali JavaScript a diagramokban és a lapozásban.** A meglévő
  `SCRUB_SCRIPT` és a `/kerdes` űrlap-scriptje az egyetlen kivétel, és azokhoz
  nem nyúlunk.
- **A felület magyar.** Minden felhasználónak szánt szöveg, osztálynév és
  adatmező-név magyarul; a kódbeli kommentek angolul, a meglévő fájlok
  mintájára.
- **Színszabály:** `--jel` KIZÁRÓLAG mért adat. `--vaz` keret és HUD-felirat,
  soha nem adat. `--riado` KIZÁRÓLAG az állapotsáv elmaradt-csatorna sora; új
  szabályban nem jelenhet meg. Ami nincs mérve, annak nincs színe és nem
  animálódik.
- **A hiányzó adat hiányzónak látsszon.** Soha nem nulla, soha nem üres keret,
  és soha nem „hamarosan" felirat.
- **A tesztek offline futnak**, nem írnak a `./data/jarvis.db`-be, nem nyúlnak a
  launchd agenthez, és nem indítanak szervert a 8787-es porton. Az adatbázis
  minden teszthez `memoryDb()`.
- **Mutációs fegyelem:** minden új teszt bukjon el a javítatlan implementáció
  ellen. Ellenőrizd — ne feltételezd. Ez a projekt eddig ~14 olyan tesztet
  termelt, ami elromlott implementáció mellett is zöld volt.
- Minden HTML-be kerülő szöveg `escapeHtml`-en megy át; markdown csak
  `renderMarkdown`-on.
- Teszt futtatás: `npx vitest run <fájl>`. Teljes suite: `npm test`.
  Típusellenőrzés: `npx tsc --noEmit`.

---

## Fájlszerkezet

```
ÚJ
  src/delivery/http/view/chart/bars.ts     havi oszlopdiagram (Task 1)
  src/delivery/http/view/format.ts         közös magyar számformázás (Task 5)
  src/delivery/http/view/area/frame.ts     a területi oldalak közös sávjai (Task 5)
  src/delivery/http/view/area/load.ts      Terhelés (Task 6)
  src/delivery/http/view/area/recovery.ts  Regeneráció (Task 7)
  src/delivery/http/view/area/nutrition.ts Táplálkozás (Task 8)
  src/delivery/http/view/area/finance.ts   Pénzügy (Task 9)
  src/delivery/http/view/area/hub.ts       a /terulet hub (Task 10)
  src/delivery/http/view/area/worklog.ts   edzésnapló + lapozó (Task 11)
  src/delivery/http/routes/areas.ts        a hat új útvonal (Task 12)

MÓDOSUL
  src/delivery/http/view/theme.ts          új CSS-sávok (Task 1, 4, 5)
  src/infra/db/repositories/workouts.ts    byType(), page() (Task 2)
  src/delivery/http/server.ts              ServerDeps (Task 3)
  src/delivery/http/routes/page.ts         PageDeps, /elemzes törlése (Task 3, 12)
  src/main.ts                              a bővült deps (Task 3)
  test/helpers.ts                          a bővült deps (Task 3)
  src/delivery/http/view/shell.ts          Section, ITEMS, almenü (Task 4)
  src/delivery/http/view/analyses.ts       analysesBody törlése (Task 12)
```

---

### Task 1: A havi oszlopdiagram primitív

Ez a feladat a branch tézise. A diagramnak **kétféle üresről** kell tudnia, és
a kettőnek a kimenetből megkülönböztethetőnek kell lennie:

- `value: null` → **nincs adat**. A hely halvány sávot kap (`class="hezag"`),
  ugyanazt a szókincset, amit a nagy diagram használ a lyukra: ez talaj, nem
  adat. Ilyen a pénzügy 2026 augusztusa előtti minden hónapja.
- `value: 0` → **mért nulla**. Látható tőcsonk a tengelyen
  (`class="oszlop nulla"`), mert egy edzés nélküli hónap mért tény, nem hiány.

**Files:**
- Create: `src/delivery/http/view/chart/bars.ts`
- Modify: `src/delivery/http/view/theme.ts` (a `/* ---- nagy diagram ---- */`
  blokk UTÁN, a fájl legvégére, a záró backtick elé)
- Test: `test/delivery/chart-bars.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` a `../../markdown.ts`-ből.
- Produces:
  ```ts
  export interface BarsSpec { label: string; format: (v: number) => string }
  export interface BarRow { label: string; value: number | null }
  export function bars(rows: readonly BarRow[], spec: BarsSpec): string
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/chart-bars.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { bars } from "../../src/delivery/http/view/chart/bars.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";

const spec = { label: "Edzésóra", format: (v: number) => `${v} óra` };

/** Egy szabály minden CSS-blokkja, a téma-teszt mintájára. */
const rules = (selector: string): string[] =>
  STYLE.split("\n").filter((line) => line.trimStart().startsWith(selector));

describe("havi oszlopdiagram", () => {
  it("a nincs-adat és a mért nulla a kimenetből megkülönböztethető", () => {
    // Ez a primitív egyetlen igazi állítása. Ha a kettő egyformán néz ki, a
    // diagram azt mondja egy nem rögzített hónapról, hogy nulla volt — pont
    // az a magabiztosan rossz szám, ami ellen ez a rendszer épül.
    const html = bars([
      { label: "2026-07", value: null },
      { label: "2026-08", value: 0 },
      { label: "2026-09", value: 12 },
    ], spec);
    expect((html.match(/class="hezag"/g) ?? [])).toHaveLength(1);
    expect((html.match(/class="oszlop nulla"/g) ?? [])).toHaveLength(1);
    expect((html.match(/class="oszlop"/g) ?? [])).toHaveLength(1);
  });

  it("a mért nulla látható magasságot kap, nem nullát", () => {
    // Egy 0 magas téglalap érvényes SVG, és pontosan nulla képpontot fest: a
    // mért nulla nyomtalanul eltűnne, és megkülönböztethetetlen lenne attól,
    // hogy oda semmit nem rajzoltunk.
    const html = bars([{ label: "2026-08", value: 0 }, { label: "2026-09", value: 40 }], spec);
    const zero = /class="oszlop nulla"[^>]*height="([\d.]+)"/.exec(html);
    expect(zero).not.toBeNull();
    expect(Number(zero![1])).toBeGreaterThan(0);
  });

  it("az olvasó a nincs-adat hónapra nem értéket mond", () => {
    const html = bars([{ label: "2025-01", value: null }, { label: "2025-02", value: 3 }], spec);
    expect(html).toContain("2025-01 · nincs adat");
    expect(html).toContain("2025-02 · 3 óra");
  });

  it("csupa hiány esetén kimondja a hiányt, nem üres keretet ad", () => {
    // Egy üres keret úgy olvasódik, hogy a diagram elromlott. Egy mondat úgy,
    // hogy még nincs mit mutatni.
    const html = bars([{ label: "2026-08", value: null }, { label: "2026-09", value: null }], spec);
    expect(html).toContain("nincs adat");
    expect(html).not.toContain('class="hezag"');
    expect(html).not.toContain('class="oszlop"');
  });

  it("üres bemenetre sem esik szét", () => {
    const html = bars([], spec);
    expect(html).toContain("nincs adat");
    expect(html).not.toContain("NaN");
  });

  it("egyetlen hónapból álló bemenetre sem oszt nullával", () => {
    const html = bars([{ label: "2026-09", value: 7 }], spec);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).toContain('class="oszlop"');
  });

  it("a tengely ritkít, de a két végét mindig kiírja", () => {
    // 56 oszlop alá 56 felirat nem fér: egyetlen olvashatatlan maszattá
    // folyna. A két szélső viszont az, ami megmondja, milyen tartományt
    // nézünk — az sosem eshet ki.
    const rows = Array.from({ length: 56 }, (_, i) => ({
      label: `H${i}`, value: i,
    }));
    const html = bars(rows, spec);
    const labels = [...html.matchAll(/class="tengely"[^>]*>(H\d+)</g)].map((m) => m[1]);
    expect(labels.length).toBeLessThan(20);
    expect(labels).toContain("H0");
    expect(labels).toContain("H55");
  });

  it("minden hónap elérhető olvasóval, a ritkítottak is", () => {
    // A ritkítás nem vehet el információt: amit a tengely nem ír ki, azt az
    // olvasójának akkor is meg kell mondania.
    const rows = Array.from({ length: 56 }, (_, i) => ({ label: `H${i}`, value: i }));
    const html = bars(rows, spec);
    expect((html.match(/class="celpont"/g) ?? [])).toHaveLength(56);
    expect(html).toContain("H23 · 23 óra");
  });

  it("a riasztás színe egyetlen szabályában sem szerepel", () => {
    // --riado kizárólag az állapotsáv elmaradt-csatorna sora. Egy diagram,
    // ami magentát használ, elveszi a magenta egyetlen jelentését.
    const own = rules(".oszlopok");
    expect(own.length).toBeGreaterThan(0);
    expect(own.join("")).not.toContain("riado");
  });

  it("a nem mért hónap nem animálódik", () => {
    // A hiányt az teszi láthatóvá, hogy ott nem történik semmi.
    const style = rules(".oszlopok").join("");
    expect(/\.oszlopok \.oszlop \{[^}]*animation/.test(STYLE)).toBe(true);
    expect(style).not.toMatch(/\.oszlopok \.hezag \{[^}]*animation/);
  });

  it("a csökkentett mozgás leállítja az oszlopok beúszását", () => {
    expect(STYLE).toMatch(/prefers-reduced-motion[\s\S]*\.oszlopok \.oszlop \{ animation: none/);
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/chart-bars.test.ts`
Expected: FAIL — `Cannot find module '.../chart/bars.ts'`

- [ ] **Step 3: Írd meg a primitívet**

Hozd létre a `src/delivery/http/view/chart/bars.ts` fájlt:

```ts
import { escapeHtml } from "../../markdown.ts";

const W = 720, H = 180, L = 52, R = 8, T = 10, B = 26;
const IW = W - L - R;
const IH = H - T - B;

/**
 * How many axis labels this width can carry without them running together.
 *
 * A label per column is the obvious thing and the wrong one: 56 months under
 * a 720-unit box is 12 units each, which is narrower than the text. The ends
 * are always drawn because they are what say WHICH span this is; in between
 * the labels thin out evenly. Nothing is lost by it — every column keeps its
 * own reader, and the reader carries the full label.
 */
const MAX_LABELS = 12;

/**
 * The shortest bar that is still visible, in this viewBox's own units.
 *
 * A measured zero must draw something. A zero-height rect is legal SVG that
 * paints exactly nothing, and the month would then be indistinguishable from
 * one nobody recorded — the very confusion this primitive exists to prevent.
 */
const STUB = 1.5;

export interface BarsSpec {
  label: string;
  format: (v: number) => string;
}

export interface BarRow {
  label: string;
  /** null means nobody recorded this month; 0 means it was recorded as zero. */
  value: number | null;
}

/**
 * Months as columns — the chart for volume, not for a daily measurement.
 *
 * The large `plot` is built for a daily series with gap bands, and training
 * volume is not that shape. A day without training is a REAL zero, not a
 * missing measurement, so a daily line would lie on the axis through most of
 * the record and its bucketed median would be zero: an accurate picture that
 * says nothing. Monthly totals are the thing worth looking at.
 *
 * The one rule that matters here is that **two different kinds of empty
 * exist**, and they must not render alike:
 *
 *   - `null` — nobody recorded this month. It gets the same vocabulary the
 *     large chart uses for a hole: a `hezag` band, which is ground rather
 *     than data. Every month before 2026-08 in the subscription record is
 *     this: the table was created in S2 and earlier months are deliberately
 *     not reconstructed.
 *   - `0` — recorded, and it was zero. A visible stub on the axis. A month
 *     without training inside the workout record's own span is this.
 *
 * Collapsing the two would tell the reader that an unrecorded month was zero,
 * which is exactly the class of confidently-wrong number this whole system is
 * built against.
 */
export function bars(rows: readonly BarRow[], spec: BarsSpec): string {
  const measured = rows.filter(
    (r): r is { label: string; value: number } => r.value !== null,
  );
  const summary = escapeHtml(
    measured.length === 0
      ? `${spec.label} — nincs adat`
      : `${spec.label} — ${measured.length} mért hónap ${rows.length} hónapból`,
  );
  const open = `<svg class="oszlopok" viewBox="0 0 ${W} ${H}" role="group" aria-label="${summary}">`
    + `<title>${summary}</title>`;

  // Nothing measured is not an empty picture. An empty frame reads as "the
  // chart broke"; a sentence reads as "there is nothing here yet".
  if (measured.length === 0) {
    return `${open}<text class="tengely" x="${L}" y="${T + IH / 2}">nincs adat</text></svg>`;
  }

  const n = (v: number) => Math.round(v * 100) / 100;
  const max = Math.max(...measured.map((r) => r.value));
  const cw = IW / rows.length;
  const bw = Math.max(1, cw * 0.7);
  // An all-zero series has no scale to place anything on; every bar is a stub.
  const yOf = (v: number) =>
    max === 0 ? T + IH - STUB : T + IH - Math.max(STUB, (v / max) * IH);

  // Holes first: they are the ground the rest is drawn on, exactly as the
  // large chart draws its gap bands before anything else.
  const holes = rows.map((r, i) => {
    if (r.value !== null) return "";
    const x = L + i * cw + (cw - bw) / 2;
    return `<rect class="hezag" x="${n(x)}" y="${T}" width="${n(bw)}" height="${IH}"/>`;
  }).join("");

  const grid = [0, 1].map((f) => {
    const y = T + IH * (1 - f);
    return `<line class="racs" x1="${L}" y1="${n(y)}" x2="${W - R}" y2="${n(y)}"/>`
      + `<text class="tengely" x="4" y="${n(y + 3)}">${escapeHtml(spec.format(max * f))}</text>`;
  }).join("");

  const columns = rows.map((r, i) => {
    if (r.value === null) return "";
    const x = L + i * cw + (cw - bw) / 2;
    const y = yOf(r.value);
    // The class carries the distinction into the markup, so a reader — and a
    // test — can tell a recorded zero from an unrecorded month.
    const cls = r.value === 0 ? "oszlop nulla" : "oszlop";
    return `<rect class="${cls}" x="${n(x)}" y="${n(y)}" width="${n(bw)}" height="${n(T + IH - y)}"/>`;
  }).join("");

  const every = Math.max(1, Math.ceil(rows.length / MAX_LABELS));
  const axis = rows.map((r, i) => {
    const last = i === rows.length - 1;
    if (i !== 0 && !last && i % every !== 0) return "";
    const anchor = i === 0 ? "start" : last ? "end" : "middle";
    const x = i === 0 ? L : last ? W - R : L + (i + 0.5) * cw;
    return `<text class="tengely" x="${n(x)}" y="${H - 8}" text-anchor="${anchor}">`
      + `${escapeHtml(r.label)}</text>`;
  }).join("");

  // Same readout box the large chart uses: clamped inside the plot so it
  // never spills past an edge, sized to its own label.
  const reader = (x: number, text: string) => {
    const esc = escapeHtml(text);
    const boxW = Math.max(96, esc.length * 6);
    const bx = Math.min(W - R - boxW, Math.max(L, x - boxW / 2));
    return `<g class="olvaso"><rect x="${n(bx)}" y="${T}" width="${boxW}" height="18" rx="2"/>`
      + `<text x="${n(bx + 6)}" y="${T + 13}">${esc}</text></g>`;
  };

  // One target per column, thinned labels included: what the axis cannot
  // print, the reader still says.
  const targets = rows.map((r, i) => {
    const x = L + i * cw;
    const text = `${r.label} · ${r.value === null ? "nincs adat" : spec.format(r.value)}`;
    return `<rect class="celpont" tabindex="0" x="${n(x)}" y="${T}" width="${n(cw)}" height="${IH}">`
      + `<title>${escapeHtml(text)}</title></rect>${reader(x + cw / 2, text)}`;
  }).join("");

  return `${open}${holes}${grid}${columns}${axis}${targets}</svg>`;
}
```

- [ ] **Step 4: Add hozzá a CSS-t**

A `src/delivery/http/view/theme.ts` végén, a `@media (prefers-reduced-motion:
reduce) { .plot .vonal, .plot .sav { animation: none; } }` sor UTÁN, a záró
`` ` `` elé illeszd be:

```css

/* ---- havi oszlopdiagram ---- */
.oszlopok { display: block; width: 100%; height: auto; }
.oszlopok .racs { stroke: var(--vaz); stroke-width: .5; opacity: .35; }
.oszlopok .tengely { fill: var(--vaz); font: .62rem var(--mono); }
/* Ugyanaz a szókincs, mint a nagy diagramé: a nem rögzített hónap talaj,
   nem adat — tehát nincs saját színe és nem is mozdul. */
.oszlopok .hezag { fill: var(--racs); }
.oszlopok .oszlop { fill: var(--jel); }
.oszlopok .celpont { fill: transparent; outline: none; }
.oszlopok .olvaso { opacity: 0; pointer-events: none; }
.oszlopok .olvaso rect { fill: var(--racs); }
.oszlopok .olvaso text { fill: var(--szoveg); font: .66rem var(--mono); }
.oszlopok .celpont:hover + .olvaso,
.oszlopok .celpont:focus + .olvaso { opacity: 1; }
.oszlopok .celpont:focus-visible { stroke: var(--jel); stroke-width: 1; }
.oszlopok .oszlop { animation: settle .5s cubic-bezier(.2,.8,.2,1) both; }
@media (prefers-reduced-motion: reduce) { .oszlopok .oszlop { animation: none; } }
```

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/chart-bars.test.ts test/delivery/view-theme.test.ts`
Expected: PASS mind

- [ ] **Step 6: Mutációs ellenőrzés**

Cseréld ideiglenesen a `bars.ts`-ben a `const cls = r.value === 0 ? "oszlop
nulla" : "oszlop";` sort erre: `const cls = "oszlop";`, és futtasd újra.
Expected: FAIL — „a nincs-adat és a mért nulla a kimenetből
megkülönböztethető". Állítsd vissza.

Ezután cseréld a `holes` ágban a `if (r.value !== null) return "";` sort erre:
`if (true) return "";`, és futtasd újra.
Expected: FAIL. Állítsd vissza, és futtasd a tesztet még egyszer: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/delivery/http/view/chart/bars.ts src/delivery/http/view/theme.ts test/delivery/chart-bars.test.ts
git commit -m "feat: havi oszlopdiagram, ami ismeri a kétféle üreset"
```

---

### Task 2: Edzés-összesítés és lapozás a repository-ban

2392 sor betöltése és JS-ben csoportosítása minden oldalletöltésre indokolatlan,
amikor az SQLite egy `GROUP BY`-jal elvégzi.

**Files:**
- Modify: `src/infra/db/repositories/workouts.ts`
- Test: `test/infra/workouts-repo.test.ts`

**Interfaces:**
- Consumes: `Db` (`../index.ts`), `WorkoutRow` (`../../health-export/rollup.ts`),
  aminek a mezői: `date`, `type`, `startedAt`, `durationMin`, `energyKcal`,
  `source`.
- Produces:
  ```ts
  export interface WorkoutTypeTotal {
    type: string;
    sessions: number;
    minutes: number;
    /** null when NOT ONE session of this type carried a kcal figure. */
    kcal: number | null;
    /** How many sessions carried one. */
    kcalFrom: number;
    lastDate: string;
  }
  // a WorkoutRepo interfészen:
  byType(): WorkoutTypeTotal[];
  page(offset: number, limit: number): { rows: WorkoutRow[]; total: number };
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/infra/workouts-repo.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";

const w = (date: string, type: string, min: number, kcal: number | null) => ({
  date, type, startedAt: `${date}T06:00:00.000Z`,
  durationMin: min, energyKcal: kcal, source: "teszt",
});

describe("WorkoutRepo.byType", () => {
  it("típusonként összesít, alkalomszám szerint csökkenően", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      w("2026-01-01", "Walking", 30, 120),
      w("2026-01-02", "Walking", 45, 180),
      w("2026-01-03", "Cycling", 60, 400),
    ]);
    const totals = repo.byType();
    expect(totals.map((t) => t.type)).toEqual(["Walking", "Cycling"]);
    expect(totals[0]!.sessions).toBe(2);
    expect(totals[0]!.minutes).toBe(75);
    expect(totals[0]!.kcal).toBe(300);
    expect(totals[0]!.lastDate).toBe("2026-01-02");
    db.close();
  });

  it("a kalóriát nem hordozó típusra null-t ad, nem nullát", () => {
    // 0 kcal azt állítaná, hogy megmértük és nulla volt. Az energy_kcal
    // nullázható, és a séta gyakran nem hoz kalóriát — a különbség valódi.
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([w("2026-01-01", "Cooldown", 10, null), w("2026-01-02", "Cooldown", 12, null)]);
    const only = repo.byType()[0]!;
    expect(only.kcal).toBeNull();
    expect(only.kcalFrom).toBe(0);
    db.close();
  });

  it("részleges kalóriánál megmondja, hány alkalomból jön az összeg", () => {
    // Egy 400 kcal-s összeg két alkalomból és tízből nagyon más állítás.
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      w("2026-01-01", "Hiking", 60, 400),
      w("2026-01-02", "Hiking", 60, null),
      w("2026-01-03", "Hiking", 60, null),
    ]);
    const only = repo.byType()[0]!;
    expect(only.sessions).toBe(3);
    expect(only.kcal).toBe(400);
    expect(only.kcalFrom).toBe(1);
    db.close();
  });

  it("üres táblára üres listát ad", () => {
    const db = memoryDb();
    expect(createWorkoutRepo(db).byType()).toEqual([]);
    db.close();
  });
});

describe("WorkoutRepo.page", () => {
  const seed = (n: number) => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save(Array.from({ length: n }, (_, i) =>
      w(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, `T${i}`, 30, null)));
    return { db, repo };
  };

  it("a legújabbat adja elöl, és megmondja az összlétszámot", () => {
    const { db, repo } = seed(120);
    const first = repo.page(0, 50);
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(120);
    expect(first.rows[0]!.date >= first.rows[49]!.date).toBe(true);
    db.close();
  });

  it("a tartományon túli eltolásra üres lapot ad, nem esik szét", () => {
    const { db, repo } = seed(10);
    const past = repo.page(500, 50);
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(10);
    db.close();
  });

  it("negatív eltolást és nulla méretet is épen kezel", () => {
    // Ezek nem a felhasználótól jönnek, hanem egy elszámolt hívótól — és egy
    // negatív OFFSET SQLite-ban csendben mást csinál, mint amit a hívó hitt.
    const { db, repo } = seed(10);
    expect(repo.page(-5, 50).rows).toHaveLength(10);
    expect(repo.page(0, 0).rows).toHaveLength(1);
    db.close();
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/infra/workouts-repo.test.ts`
Expected: FAIL — `repo.byType is not a function`

- [ ] **Step 3: Bővítsd a repository-t**

A `src/infra/db/repositories/workouts.ts`-ben az `import` sorok után illeszd be:

```ts
export interface WorkoutTypeTotal {
  type: string;
  sessions: number;
  minutes: number;
  /**
   * Total kcal across the sessions of this type that carry one — `null` when
   * not one of them does.
   *
   * `0` would be a claim that the sessions were measured and burned nothing.
   * `energy_kcal` is nullable and plenty of walks arrive without it, so the
   * distinction is real: SQLite's `SUM` over an all-NULL column answers NULL,
   * which is exactly the honest answer, and it is passed through rather than
   * coalesced to zero.
   */
  kcal: number | null;
  /** How many sessions the sum is built from — 400 kcal from one session of ten is a different claim than from ten. */
  kcalFrom: number;
  lastDate: string;
}
```

Az `interface WorkoutRepo` blokkba, a `between` után:

```ts
  /** Per-type totals over the whole history, busiest type first. */
  byType(): WorkoutTypeTotal[];
  /** One page of workouts, newest first, plus how many there are in total. */
  page(offset: number, limit: number): { rows: WorkoutRow[]; total: number };
```

A `createWorkoutRepo` visszatérő objektumába, a `between` után:

```ts
    byType() {
      return db.all<{
        type: string; sessions: number; minutes: number;
        kcal: number | null; kcal_from: number; last_date: string;
      }>(
        `SELECT type,
                COUNT(*)           AS sessions,
                SUM(duration_min)  AS minutes,
                SUM(energy_kcal)   AS kcal,
                COUNT(energy_kcal) AS kcal_from,
                MAX(date)          AS last_date
           FROM workouts
          GROUP BY type
          ORDER BY sessions DESC, type`,
      ).map((r) => ({
        type: r.type, sessions: r.sessions, minutes: r.minutes,
        kcal: r.kcal, kcalFrom: r.kcal_from, lastDate: r.last_date,
      }));
    },

    page(offset, limit) {
      // Clamped here rather than trusted: a negative OFFSET is not an error in
      // SQLite, it quietly behaves as something the caller did not ask for,
      // and a zero LIMIT returns nothing at all — both would look like "there
      // are no workouts" to a page that has 2392 of them.
      const from = Math.max(0, Math.floor(offset));
      const size = Math.max(1, Math.floor(limit));
      const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workouts")?.n ?? 0;
      const rows = db.all<Row>(
        "SELECT * FROM workouts ORDER BY date DESC, started_at DESC LIMIT ? OFFSET ?",
        size, from,
      ).map(toWorkout);
      return { rows, total };
    },
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `npx vitest run test/infra/workouts-repo.test.ts`
Expected: PASS mind a 7

- [ ] **Step 5: Mutációs ellenőrzés**

Cseréld a `kcal: r.kcal` sort erre: `kcal: r.kcal ?? 0`, és futtasd újra.
Expected: FAIL — „a kalóriát nem hordozó típusra null-t ad, nem nullát".
Állítsd vissza.

Cseréld a `const from = Math.max(0, Math.floor(offset));` sort erre:
`const from = offset;`, és futtasd újra.
Expected: FAIL — „negatív eltolást és nulla méretet is épen kezel". Állítsd
vissza, majd futtasd újra: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/infra/db/repositories/workouts.ts test/infra/workouts-repo.test.ts
git commit -m "feat: edzés-összesítés típusonként és lapozás a repository-ban"
```

---

### Task 3: A PageDeps nyers Metrics-et és három új repository-t kap

Tisztán szerkezeti feladat, **viselkedésváltozás nélkül**: a meglévő teszteknek
egytől egyig zöldnek kell maradniuk. A területi oldalaknak `physical.byMonth`,
`recovery.sleepByYear` és `finance.monthOverMonth` kell — nem formázott sorok.

**Files:**
- Modify: `src/delivery/http/server.ts` (`ServerDeps`, a `registerPageRoutes`
  hívás)
- Modify: `src/delivery/http/routes/page.ts` (`PageDeps`, a `/szamok` útvonal)
- Modify: `src/main.ts`
- Modify: `test/helpers.ts`
- Test: a meglévő suite — nincs új teszt

**Interfaces:**
- Produces:
  ```ts
  // src/delivery/http/routes/page.ts
  export interface PageDeps {
    briefs: BriefService;
    chat: ChatService;
    analyses: AnalysisRepo;
    conversations: ConversationRepo;
    health: HealthRepo;
    workouts: WorkoutRepo;
    meals: MealRepo;
    subscriptions: SubscriptionRepo;
    /** The freshest aggregate, rebuilt per request. */
    metrics: () => Metrics;
    clock: Clock;
    logger: Logger;
  }
  ```
  A `ServerDeps` ugyanezt a négy mezőt kapja (`workouts`, `meals`,
  `subscriptions`, `metrics` a `metricsRows` helyett).

- [ ] **Step 1: Cseréld a mezőt a PageDeps-ben**

A `src/delivery/http/routes/page.ts`-ben cseréld a `metricsRows: () =>
MetricRow[];` sort erre:

```ts
  workouts: WorkoutRepo;
  meals: MealRepo;
  subscriptions: SubscriptionRepo;
  /**
   * The freshest aggregate, rebuilt per request.
   *
   * Raw `Metrics` rather than the finished `MetricRow[]` the Számok page
   * shows: the area pages want `physical.byMonth`, `recovery.sleepByYear`
   * and `finance.monthOverMonth`, none of which survive the formatting into
   * rows. `/szamok` applies `metricsRowsFrom` itself, inside the same
   * try/catch that already guarded it.
   */
  metrics: () => Metrics;
```

Az import-blokkba vedd fel:

```ts
import type { Metrics } from "../../../core/analysis/aggregate.ts";
import type { WorkoutRepo } from "../../../infra/db/repositories/workouts.ts";
import type { MealRepo } from "../../../infra/db/repositories/meals.ts";
import type { SubscriptionRepo } from "../../../infra/db/repositories/subscriptions.ts";
import { metricsRowsFrom, numbersBody, type MetricRow } from "../view/numbers.ts";
```

(a meglévő `import { numbersBody, type MetricRow } from "../view/numbers.ts";`
sort ez váltja ki)

- [ ] **Step 2: Igazítsd a `/szamok` útvonalat**

A `/szamok` útvonalban cseréld

```ts
      metricsRows = deps.metricsRows();
```

erre:

```ts
      metricsRows = metricsRowsFrom(deps.metrics());
```

- [ ] **Step 3: Igazítsd a ServerDeps-et**

A `src/delivery/http/server.ts`-ben cseréld a `metricsRows: () => MetricRow[];`
sort erre:

```ts
  workouts: WorkoutRepo;
  meals: MealRepo;
  subscriptions: SubscriptionRepo;
  metrics: () => Metrics;
```

Vedd fel az importokat:

```ts
import type { Metrics } from "../../core/analysis/aggregate.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { MealRepo } from "../../infra/db/repositories/meals.ts";
import type { SubscriptionRepo } from "../../infra/db/repositories/subscriptions.ts";
```

Töröld a most feleslegessé vált `import type { MetricRow } from
"./view/numbers.ts";` sort, ha semmi más nem használja a fájlban.

A `registerPageRoutes(...)` hívásában cseréld a `metricsRows: deps.metricsRows,`
részt erre:

```ts
    workouts: deps.workouts, meals: deps.meals, subscriptions: deps.subscriptions,
    metrics: deps.metrics,
```

- [ ] **Step 4: Igazítsd a main.ts-t**

A `src/main.ts`-ben cseréld a `metricsRows: () => { ... }` blokkot erre:

```ts
  workouts: app.workouts,
  meals: app.meals,
  subscriptions: app.subscriptions,
  // Rebuilt per request rather than cached: the page must show tonight's
  // sleep the moment it is ingested, not the value at process start-up.
  metrics: () => {
    const today = isoDate(app.clock.now(), TZ);
    return aggregate({
      today,
      snapshots: app.health.between("1970-01-01", today),
      workouts: app.workouts.between("1970-01-01", today),
      months: app.subscriptionMonths.months().map((month) => ({
        month, subs: app.subscriptionMonths.forMonth(month),
      })),
    });
  },
```

Töröld a `import { metricsRowsFrom } from "./delivery/http/view/numbers.ts";`
sort, ha semmi más nem használja.

Ha az `app` objektumon nincs `meals` vagy `subscriptions` mező, keresd meg,
hol épül (`grep -n "workouts:" src/app.ts src/*.ts`), és vedd fel őket
ugyanott, `createMealRepo(db)` és `createSubscriptionRepo(db)` hívással — a
két gyártófüggvény a `src/infra/db/repositories/meals.ts`-ben és a
`subscriptions.ts`-ben van.

- [ ] **Step 5: Igazítsd a test/helpers.ts-t**

Cseréld a `const metricsRows = () => { ... };` blokkot erre:

```ts
  const meals = createMealRepo(db);
  const subscriptions = createSubscriptionRepo(db);

  // Same construction the real ask-context assembler and main.ts use: the
  // page's numbers table is always the freshest `aggregate()` over an
  // in-memory (here, empty-unless-seeded) database.
  const metrics = () => {
    const today = isoDate(clock.now());
    return aggregate({
      today,
      snapshots: health.between("1970-01-01", today),
      workouts: workouts.between("1970-01-01", today),
      months: subscriptionMonths.months().map((month) => ({
        month, subs: subscriptionMonths.forMonth(month),
      })),
    });
  };
```

A `buildServer({ ... })` hívásban cseréld a `metricsRows,` részt erre:

```ts
    workouts, meals, subscriptions, metrics,
```

Vedd fel az importot:

```ts
import { createSubscriptionRepo, type SubscriptionRepo } from "../src/infra/db/repositories/subscriptions.ts";
```

A `createMealRepo` már importálva van a fájl tetején. Töröld a
`metricsRowsFrom` importot, ha semmi más nem használja.

Bővítsd a `TestApp` interfészt és a `buildTestApp` visszatérési objektumát,
hogy a későbbi tesztek tudjanak edzést, étrendet és előfizetést vetni:

```ts
// az interfészbe:
  workouts: WorkoutRepo;
  meals: MealRepo;
  subscriptions: SubscriptionRepo;
```

```ts
// a return objektumba, a `conversations` mellé:
    workouts, meals, subscriptions,
```

és a hozzájuk tartozó `import type` sorok (`WorkoutRepo` a
`workouts.ts`-ből, `MealRepo` a `meals.ts`-ből).

- [ ] **Step 6: Futtasd a teljes suite-ot és a típusellenőrzést**

Run: `npm test && npx tsc --noEmit`
Expected: minden meglévő teszt PASS, `tsc` néma. Ha bármelyik bukik, az
átalakítás nem volt viselkedés-semleges — javítsd, ne a tesztet.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: a PageDeps nyers Metrics-et kap, plusz három repository-t"
```

---

### Task 4: A navigáció négy eleme, Terület jelzővel és asztali almenüvel

**Files:**
- Modify: `src/delivery/http/view/shell.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/view-shell.test.ts` (meglévő fájl, bővül)

**Interfaces:**
- Produces:
  ```ts
  export type Section = "ma" | "terulet" | "szamok" | "kerdes";
  export interface NavState { ma: boolean; terulet: boolean; kerdes: boolean }
  ```
  (`elemzes` eltűnik mindkettőből)
- Az `ITEMS` és a `layout()` szignatúrája egyébként változatlan.

- [ ] **Step 1: Írd meg a bukó tesztet**

Illeszd a `test/delivery/view-shell.test.ts` végére (a fájl meglévő
importjai mellé vedd fel, ami hiányzik):

```ts
describe("navigáció a területekkel", () => {
  const base = {
    dateLabel: "2026. szeptember 3., csütörtök",
    briefAge: null,
    channels: { arrived: 0, waiting: 0, missing: 0, missingLabels: [], total: 6 },
    body: "<p>törzs</p>",
  };

  it("négy menüpont van, és az Elemzés nincs köztük", () => {
    // Telefonon a menü alsó sor. Hét-nyolc elem ott elemenként ~14%
    // szélesség, vágott címkékkel — ezért marad négy, és ezért olvad fel az
    // /elemzes a területekbe.
    const html = layout({
      ...base, section: "ma",
      nav: { ma: true, terulet: true, kerdes: true },
    });
    const menu = [...html.matchAll(/class="menu[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(menu).toEqual(["Ma", "Terület", "Számok", "Kérdés"]);
    expect(html).not.toContain('href="/elemzes"');
  });

  it("a Terület jelzője kialszik, ha nincs friss elemzés", () => {
    // Egy jelző, ami nem tud kikapcsolni, dekoráció — az /elemzes régi
    // jelzője („van legalább egy elemzés") az első elemzés után soha többé
    // nem aludt ki.
    const el = layout({ ...base, section: "ma", nav: { ma: true, terulet: true, kerdes: false } });
    const holt = layout({ ...base, section: "ma", nav: { ma: true, terulet: false, kerdes: false } });
    expect(/href="\/terulet" class="menu jelzo el"/.test(el)).toBe(true);
    expect(/href="\/terulet" class="menu jelzo holt"/.test(holt)).toBe(true);
  });

  it("a területi oldalon a Terület az aktív elem, és csak az", () => {
    const html = layout({
      ...base, section: "terulet",
      nav: { ma: false, terulet: true, kerdes: false },
    });
    const current = [...html.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
    expect(current).toEqual(["/terulet"]);
  });

  it("az almenü csak a terulet szekcióban jelenik meg", () => {
    // A Ma és a Számok oldalán a menü ugyanaz a négy elem, mint eddig.
    const inside = layout({ ...base, section: "terulet", nav: { ma: false, terulet: true, kerdes: false } });
    const outside = layout({ ...base, section: "ma", nav: { ma: false, terulet: true, kerdes: false } });
    expect(inside).toContain('href="/terulet/terheles"');
    expect(inside).toContain('href="/terulet/regeneracio"');
    expect(inside).toContain('href="/terulet/taplalkozas"');
    expect(inside).toContain('href="/terulet/penzugy"');
    expect(outside).not.toContain('href="/terulet/terheles"');
  });

  it("az almenü telefonon nem látszik", () => {
    // Az alsó sor négy eleme marad; az almenü kizárólag az asztali sávban él.
    expect(/\.almenu \{[^}]*display:\s*none/.test(STYLE)).toBe(true);
    expect(/min-width:\s*46rem\s*\)\s*\{[\s\S]*\.almenu \{[^}]*display:\s*block/.test(STYLE)).toBe(true);
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/view-shell.test.ts`
Expected: FAIL — a `Section` nem ismeri a `"terulet"` értéket, a `NavState`-nek
nincs `terulet` mezője, és az `ITEMS` az Elemzést sorolja.

- [ ] **Step 3: Írd át a shell.ts-t**

Cseréld a `Section` típust:

```ts
export type Section = "ma" | "terulet" | "szamok" | "kerdes";
```

Cseréld a `NavState`-et:

```ts
/** Whether each section has anything live to show right now. */
export interface NavState { ma: boolean; terulet: boolean; kerdes: boolean }
```

Cseréld az `ITEMS` konstanst és a `nav()` függvényt:

```ts
/**
 * `szamok` carries no indicator on purpose.
 *
 * It always has history behind it, so its lamp could never go dark — and an
 * indicator that cannot turn off is decoration, not information. `terulet`'s
 * lamp CAN go dark, which is why it has one: it is lit while the deep
 * analysis is fresh, and the analysis is started by hand (`npm run analyze`),
 * so a dark lamp is an actionable state rather than a permanent decoration.
 * This is exactly what the old `/elemzes` lamp ("there is at least one
 * analysis") could never be — after the first run it stayed lit forever.
 */
const ITEMS: { section: Section; href: string; label: string; lamp: keyof NavState | null }[] = [
  { section: "ma", href: "/", label: "Ma", lamp: "ma" },
  { section: "terulet", href: "/terulet", label: "Terület", lamp: "terulet" },
  { section: "szamok", href: "/szamok", label: "Számok", lamp: null },
  { section: "kerdes", href: "/kerdes", label: "Kérdés", lamp: "kerdes" },
];

/**
 * The four areas, listed under "Terület" — on the desktop rail only.
 *
 * On a phone the nav is the bottom row, and the four top-level items already
 * fill it; a sub-list there would either shrink every label past reading or
 * push the row off the thumb's reach. The hub page is the phone's way in, and
 * it carries the same four as cards.
 */
const TERULETEK: { href: string; label: string }[] = [
  { href: "/terulet/terheles", label: "Terhelés" },
  { href: "/terulet/regeneracio", label: "Regeneráció" },
  { href: "/terulet/taplalkozas", label: "Táplálkozás" },
  { href: "/terulet/penzugy", label: "Pénzügy" },
];

function nav(data: ShellData): string {
  const items = ITEMS.map((item) => {
    const active = item.section === data.section;
    const lamp = item.lamp === null ? "" : (data.nav[item.lamp] ? " jelzo el" : " jelzo holt");
    const link = `<a href="${item.href}" class="menu${lamp}"${active ? ' aria-current="page"' : ""}>`
      + `${escapeHtml(item.label)}</a>`;
    // The sub-list is rendered only while the reader is inside the section:
    // on every other page it would be four links to somewhere they did not
    // ask about, in a rail that has held four items since F1.
    if (item.section !== "terulet" || !active) return link;
    const sub = TERULETEK.map((t) =>
      `<a href="${t.href}" class="alelem">${escapeHtml(t.label)}</a>`).join("");
    return `${link}<span class="almenu">${sub}</span>`;
  }).join("");
  return `<nav>${items}</nav>`;
}
```

- [ ] **Step 4: Add hozzá az almenü CSS-ét**

A `theme.ts`-ben a `nav a.menu.jelzo.el::after { background: var(--jel); }` sor
UTÁN, még a `@media (min-width: 46rem)` blokk ELŐTT illeszd be:

```css
/* Az almenü kizárólag az asztali sávban él: telefonon az alsó sor négy
   eleme a teljes hely, és a hub a belépő a területekre. */
.almenu { display: none; }
```

A `@media (min-width: 46rem)` blokkba, a `nav a.menu.jelzo::after { ... }` sor
után:

```css
  .almenu { display: block; margin: .1rem 0 .4rem .7rem;
    border-left: 1px solid var(--racs); }
  .almenu a.alelem { display: block; padding: .3rem .7rem; color: var(--halvany);
    text-decoration: none; font: .64rem/1.4 var(--mono); letter-spacing: .12em;
    text-transform: uppercase; }
  .almenu a.alelem:hover { color: var(--vaz); }
```

- [ ] **Step 5: Terjeszd ki a beúszás lépcsőjét**

A területi oldalaknak hat sávjuk is lehet, a `--i` viszont csak az ötödik
gyermekig van beállítva — azon túl a lépcső csendben leáll. A `theme.ts`-ben a
`.lap > *:nth-child(5) { --i: 4; }` sor után illeszd be:

```css
.lap > *:nth-child(6) { --i: 5; }
.lap > *:nth-child(7) { --i: 6; }
.lap > *:nth-child(8) { --i: 7; }
```

- [ ] **Step 6: Futtasd a teszteket**

Run: `npx vitest run test/delivery/view-shell.test.ts test/delivery/view-theme.test.ts`
Expected: PASS

`npm test` ilyenkor MÉG BUKIK a `routes/page.ts`-ben (`section: "elemzes"` és
`nav.elemzes` már nem létezik) — ezt a Task 12 zárja le. A típushiba ezen a
ponton várt és helyes: a fordító pontosan azokra a helyekre mutat, amiket a
Task 12-nek át kell írnia.

- [ ] **Step 7: Commit**

```bash
git add src/delivery/http/view/shell.ts src/delivery/http/view/theme.ts test/delivery/view-shell.test.ts
git commit -m "feat: négyelemű menü Terület jelzővel és asztali almenüvel"
```

---

### Task 5: A területi oldalak közös sávjai és a közös számformázás

Öt oldal osztozik ugyanazon a négy sávon. Ha mindegyik magának írja meg,
ötször tér el egymástól — és a felületet minden nap ugyanaz az ember nézi,
akinek a keresés helye ne változzon oldalanként.

**Files:**
- Create: `src/delivery/http/view/format.ts`
- Create: `src/delivery/http/view/area/frame.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Modify: `src/delivery/http/view/channels.ts`, `numbers.ts`,
  `chart/registry.ts` (a saját `hu` másolatuk cseréje importra)
- Test: `test/delivery/area-frame.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // view/format.ts
  export function hu(n: number, digits?: number): string;
  export function huFt(n: number): string;

  // view/area/frame.ts
  export interface LeadFigure {
    label: string;
    /** Already formatted — null when it could not be measured. */
    value: string | null;
    /** What it is measured against. */
    against: string;
    /** What to say when `value` is null. */
    missing: string;
  }
  export function leadBand(f: LeadFigure): string;

  export interface SeriesTile { column: string; label: string; days: number; chart: string }
  export function seriesBand(title: string, tiles: readonly SeriesTile[]): string;

  export interface AreaAnalysis { markdown: string; createdAt: string }
  export function analysisBand(a: AreaAnalysis | undefined): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-frame.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { hu, huFt } from "../../src/delivery/http/view/format.ts";
import { leadBand, seriesBand, analysisBand } from "../../src/delivery/http/view/area/frame.ts";

describe("magyar számformázás", () => {
  it("ezres csoportot sima szóközzel ad, nem nem-törő szóközzel", () => {
    // A hu-HU alapból U+00A0-t tesz be, és a felület többi része sima
    // szóközre hajtja (lásd chart/registry.ts) — a kettő keveredve két
    // hangon írná ugyanazt a számot ugyanazon az oldalon.
    expect(hu(64860)).toBe("64 860");
    expect(hu(64860)).not.toContain("\u00a0");
  });
  it("tizedesvesszőt használ", () => {
    expect(hu(1.41, 2)).toBe("1,41");
  });
  it("a forintot mértékegységgel adja", () => {
    expect(huFt(64860)).toBe("64 860 Ft");
  });
});

describe("vezető szám", () => {
  it("mért értéknél a számot mutatja", () => {
    const html = leadBand({
      label: "Terhelési arány", value: "1,41×",
      against: "28 napos napi átlag a 365 naposhoz mérve", missing: "nincs elég előzmény",
    });
    expect(html).toContain("1,41×");
    expect(html).toContain("28 napos napi átlag");
    expect(html).not.toContain("hianyzik");
  });

  it("hiánynál nem nullát mutat, és jelöli, hogy hiányzik", () => {
    // Ez a szabály, amiért ez a rendszer épült: a hiányzó adat hiányzónak
    // látsszon. Egy 0,00× ugyanúgy néz ki, mint egy mért érték.
    const html = leadBand({
      label: "Terhelési arány", value: null,
      against: "28 napos napi átlag a 365 naposhoz mérve", missing: "nincs elég előzmény",
    });
    expect(html).toContain("nincs elég előzmény");
    expect(html).toContain("hianyzik");
    expect(html).not.toContain("0");
  });

  it("escape-eli a címkét és a szöveget", () => {
    const html = leadBand({
      label: "<b>x</b>", value: "<i>1</i>", against: "&", missing: "-",
    });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&amp;");
  });
});

describe("sorozat-csempék", () => {
  it("minden csempe a saját részletoldalára visz, a saját ablakával", () => {
    const html = seriesBand("Mozgás", [
      { column: "steps", label: "Lépés", days: 90, chart: "<svg/>" },
    ]);
    expect(html).toContain('href="/szamok/steps?tart=90"');
    expect(html).toContain("Lépés");
    expect(html).toContain("<svg/>");
  });

  it("csempe nélkül nem ad üres címet", () => {
    // Egy "Mozgás" fejléc alatta semmivel hiányzó adat, ami nem látszik
    // hiányzónak.
    expect(seriesBand("Mozgás", [])).toBe("");
  });

  it("kódolja az oszlopnevet az URL-ben", () => {
    const html = seriesBand("X", [{ column: "a/b", label: "A", days: 7, chart: "" }]);
    expect(html).toContain("/szamok/a%2Fb?tart=7");
  });
});

describe("elemzés-sáv", () => {
  it("a dátumával együtt mutatja az elemzést", () => {
    // Egy két hete készült elemzés akkor is két hetes, ha magabiztosan
    // hangzik — a dátum az egyetlen, ami ezt megmondja.
    const html = analysisBand({ markdown: "**Fontos** megállapítás", createdAt: "2026-09-01T07:08:45.487Z" });
    expect(html).toContain("2026-09-01");
    expect(html).toContain("<strong>Fontos</strong>");
  });

  it("elemzés nélkül megmondja, hogyan lehet elindítani", () => {
    const html = analysisBand(undefined);
    expect(html).toContain("Még nem futott");
    expect(html).toContain("npm run analyze");
    expect(html).not.toContain("hamarosan");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-frame.test.ts`
Expected: FAIL — `Cannot find module '.../view/format.ts'`

- [ ] **Step 3: Írd meg a format.ts-t**

Hozd létre a `src/delivery/http/view/format.ts` fájlt:

```ts
/**
 * Hungarian number formatting, in one place.
 *
 * Three copies of this had grown across the view layer, and they had already
 * drifted: two folded the grouping separator to a plain space and one did
 * not, so `/szamok` rendered "64 860" with U+00A0 while the status strip
 * rendered the same figure with a plain one. Two voices for one number on one
 * page is exactly the kind of small inconsistency that makes a readout look
 * less trustworthy than it is.
 *
 * The fold is deliberate, not a workaround: hu-HU's own grouping separator is
 * a no-break space, and the rest of this UI has rendered a plain one since
 * the first channel readout.
 */
export function hu(n: number, digits = 0): string {
  return n
    .toLocaleString("hu-HU", {
      minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true,
    })
    .replace(/\u00a0/g, " ");
}

/** Forint, with its unit — the one currency this system knows. */
export function huFt(n: number): string {
  return `${hu(n)} Ft`;
}
```

- [ ] **Step 4: Írd meg a frame.ts-t**

Hozd létre a `src/delivery/http/view/area/frame.ts` fájlt:

```ts
import { escapeHtml, renderMarkdown } from "../../markdown.ts";

/**
 * The one figure that says how an area is doing, with what it is measured
 * against.
 *
 * `value` is `null` when the figure could not be computed at all — not zero,
 * not a dash. The distinction is the whole point: a load ratio of 0,00× and
 * "not enough history to compare against" look identical as numbers and mean
 * opposite things.
 */
export interface LeadFigure {
  label: string;
  /** Already formatted for a person — null when it could not be measured. */
  value: string | null;
  /** What the figure is measured against, in words. */
  against: string;
  /** What to say instead of a number. Used only when `value` is null. */
  missing: string;
}

export function leadBand(f: LeadFigure): string {
  const measured = f.value !== null;
  return [
    `<section class="vezeto${measured ? "" : " hianyzik"}">`,
    `<span class="cimke">${escapeHtml(f.label)}</span>`,
    `<span class="szam">${escapeHtml(measured ? f.value! : f.missing)}</span>`,
    `<span class="halk">${escapeHtml(f.against)}</span>`,
    "</section>",
  ].join("");
}

/** One series, its sparkline, and the window its detail page should open at. */
export interface SeriesTile {
  column: string;
  label: string;
  days: number;
  /** The already-rendered sparkline SVG — the view layer never queries. */
  chart: string;
}

/**
 * The area's series as a row of tiles, each linking to its own detail page.
 *
 * An empty band renders as nothing rather than as a heading with a void under
 * it: a "Mozgás" title with no content is missing data that does not look
 * missing.
 */
export function seriesBand(title: string, tiles: readonly SeriesTile[]): string {
  if (tiles.length === 0) return "";
  const items = tiles.map((t) =>
    `<a class="csempe" href="/szamok/${encodeURIComponent(t.column)}?tart=${t.days}">`
    + `<span class="cimke">${escapeHtml(t.label)}</span>${t.chart}</a>`,
  ).join("");
  return `<section><h2>${escapeHtml(title)}</h2><div class="csempek">${items}</div></section>`;
}

export interface AreaAnalysis { markdown: string; createdAt: string }

/**
 * The area's own analysis, dated.
 *
 * The date is not decoration. `latestPerDomain()` mixes vintages by design —
 * a failed run leaves the other domains' last successes in place — so it is
 * the only thing telling the reader how old this finding actually is.
 *
 * An area with no analysis says so and names the command, rather than
 * promising one later: this project's shell has carried no "coming soon"
 * since F1. An area that has no analysis DOMAIN at all (nutrition, until S8
 * builds one) does not call this function — its band is absent, not empty.
 */
export function analysisBand(a: AreaAnalysis | undefined): string {
  if (a === undefined) {
    return "<section><h2>Elemzés</h2>"
      + `<p class="halk">Még nem futott mélyelemzés erre a területre. `
      + `Indítsd: <code>npm run analyze</code></p></section>`;
  }
  return `<section><h2>Elemzés · ${escapeHtml(a.createdAt.slice(0, 10))}</h2>`
    + `${renderMarkdown(a.markdown)}</section>`;
}
```

- [ ] **Step 5: Add hozzá a CSS-t**

A `theme.ts`-ben a `/* ---- havi oszlopdiagram ---- */` blokk ELŐTT illeszd be:

```css

/* ---- területi oldalak ---- */
.vezeto { display: flex; flex-direction: column; gap: .2rem;
  padding: 1rem 0 1.2rem; border-bottom: 1px solid var(--racs); }
.vezeto .cimke { font: .68rem/1.4 var(--mono); letter-spacing: .18em;
  text-transform: uppercase; color: var(--vaz); }
.vezeto .szam { font: 600 2.2rem/1.15 var(--mono); font-variant-numeric: tabular-nums;
  color: var(--jel); }
/* Ami nincs mérve, annak nincs színe: a hiány színtelen és kisebb, mert nem
   szám — a szöveg maga a tartalom. */
.vezeto.hianyzik .szam { color: var(--halvany); font-size: 1.1rem; font-weight: 400; }
.csempek { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1px; background: var(--racs); border: 1px solid var(--racs); }
.csempe { display: flex; flex-direction: column; gap: .4rem; padding: .7rem .8rem;
  background: var(--lap); text-decoration: none; color: var(--szoveg); }
.csempe .cimke { font: .68rem/1.4 var(--mono); letter-spacing: .1em;
  text-transform: uppercase; color: var(--halvany); }
.csempe:hover .cimke { color: var(--vaz); }
```

- [ ] **Step 6: Cseréld a három `hu` másolatot importra**

- `src/delivery/http/view/channels.ts`: töröld a `const hu = (n, digits = 0) =>
  ...` blokkot, és vedd fel: `import { hu } from "./format.ts";`
- `src/delivery/http/view/chart/registry.ts`: töröld a `const hu = ...` blokkot
  a fölötte lévő magyarázó kommenttel együtt, és vedd fel:
  `import { hu } from "../format.ts";`
- `src/delivery/http/view/numbers.ts`: töröld a `const hu = ...` blokkot, és
  vedd fel: `import { hu } from "./format.ts";`

A `numbers.ts` másolata volt az, ami NEM hajtotta sima szóközre a
csoportelválasztót — ez a csere tehát ott megváltoztatja a kimenetet
(U+00A0 → sima szóköz). Ez szándékos javítás: a projekt kimondott
rendering-szabálya a sima szóköz (lásd `chart/registry.ts` eredeti
kommentjét). Egyetlen meglévő teszt sem rögzíti a nem-törő szóközt, tehát a
suite-nak zöldnek kell maradnia.

- [ ] **Step 7: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-frame.test.ts test/delivery/view-numbers.test.ts test/delivery/view-channels.test.ts test/delivery/chart-registry.test.ts`
Expected: PASS mind

- [ ] **Step 8: Mutációs ellenőrzés**

Cseréld a `frame.ts`-ben a `const measured = f.value !== null;` sort erre:
`const measured = true;`, és futtasd újra.
Expected: FAIL — „hiánynál nem nullát mutat". Állítsd vissza.

Cseréld a `seriesBand` első sorát erre: `if (false) return "";`, és futtasd
újra. Expected: FAIL — „csempe nélkül nem ad üres címet". Állítsd vissza,
futtasd újra: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: a területi oldalak közös sávjai és egy közös számformázó"
```

---

### Task 6: A Terhelés oldal törzse

**Files:**
- Create: `src/delivery/http/view/area/load.ts`
- Test: `test/delivery/area-load.test.ts`

**Interfaces:**
- Consumes: `leadBand`, `seriesBand`, `analysisBand`, `SeriesTile`,
  `AreaAnalysis` a `./frame.ts`-ből; `bars`, `BarRow` a `../chart/bars.ts`-ből;
  `hu` a `../format.ts`-ből; `WorkoutTypeTotal` a
  `../../../../infra/db/repositories/workouts.ts`-ből; `WorkoutRow` a
  `../../../../infra/health-export/rollup.ts`-ből.
- Produces:
  ```ts
  export interface LoadData {
    loadRatio: number | null;
    strengthPerWeek28d: number | null;
    byMonth: readonly { month: string; hours: number; sessions: number; strength: number }[];
    byType: readonly WorkoutTypeTotal[];
    recent: readonly WorkoutRow[];
    tiles: readonly SeriesTile[];
    analysis: AreaAnalysis | undefined;
  }
  export function loadBody(d: LoadData): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-load.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { loadBody } from "../../src/delivery/http/view/area/load.ts";

const empty = {
  loadRatio: null, strengthPerWeek28d: null,
  byMonth: [], byType: [], recent: [], tiles: [], analysis: undefined,
};

const w = (date: string, type: string, min: number, kcal: number | null) => ({
  date, type, startedAt: `${date}T06:00:00.000Z`,
  durationMin: min, energyKcal: kcal, source: "teszt",
});

describe("Terhelés oldal", () => {
  it("a terhelési arányt mutatja vezető számként", () => {
    const html = loadBody({ ...empty, loadRatio: 1.41 });
    expect(html).toContain("Terhelési arány");
    expect(html).toContain("1,41×");
  });

  it("alap nélkül nem 1,00×-et mutat", () => {
    // A loadRatio null, ha 28 előzmény-edzésnapnál kevesebb van. Egy 1,00×
    // azt állítaná, hogy pont az átlagon vagyunk — ami mérés, nem hiány.
    const html = loadBody({ ...empty });
    expect(html).toContain("nincs elég előzmény");
    expect(html).not.toContain("1,00×");
  });

  it("a havi edzésórát oszlopdiagramként rajzolja", () => {
    const html = loadBody({
      ...empty,
      byMonth: [
        { month: "2026-07", hours: 12.5, sessions: 20, strength: 8 },
        { month: "2026-08", hours: 9, sessions: 15, strength: 6 },
      ],
    });
    expect(html).toContain('class="oszlopok"');
    expect(html).toContain("2026-07");
  });

  it("a kalóriát nem hordozó típusnál nincs mérést ír, nem 0 kcal-t", () => {
    // Az energy_kcal nullázható, és a séta gyakran nem hoz kalóriát. A 0
    // kcal azt állítaná, hogy megmértük.
    const html = loadBody({
      ...empty,
      byType: [
        { type: "Cooldown", sessions: 68, minutes: 527, kcal: null, kcalFrom: 0, lastDate: "2026-08-30" },
      ],
    });
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("0 kcal");
  });

  it("részleges kalóriánál megmondja, hány alkalomból jön", () => {
    const html = loadBody({
      ...empty,
      byType: [
        { type: "Hiking", sessions: 19, minutes: 3760, kcal: 8400, kcalFrom: 4, lastDate: "2026-07-11" },
      ],
    });
    expect(html).toContain("8 400 kcal");
    expect(html).toContain("4 alkalomból");
  });

  it("az utolsó edzések listája alatt link visz a teljes naplóra", () => {
    const html = loadBody({ ...empty, recent: [w("2026-09-01", "Walking", 32, 140)] });
    expect(html).toContain("Walking");
    expect(html).toContain('href="/terulet/terheles/naplo"');
  });

  it("edzés nélkül nem üres táblát mutat, hanem kimondja a hiányt", () => {
    const html = loadBody({ ...empty });
    expect(html).toContain("Nincs rögzített edzés");
  });

  it("escape-eli az edzés típusát és forrását", () => {
    // A típus az Apple exportjából jön, nem ebből a kódból.
    const html = loadBody({ ...empty, recent: [w("2026-09-01", "<script>x</script>", 10, null)] });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("elemzés nélkül is teljes oldalt ad", () => {
    const html = loadBody({ ...empty, loadRatio: 1.2 });
    expect(html).toContain("Még nem futott");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-load.test.ts`
Expected: FAIL — `Cannot find module '.../area/load.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/area/load.ts` fájlt:

```ts
import { escapeHtml } from "../../markdown.ts";
import { hu } from "../format.ts";
import { bars, type BarRow } from "../chart/bars.ts";
import {
  analysisBand, leadBand, seriesBand,
  type AreaAnalysis, type SeriesTile,
} from "./frame.ts";
import type { WorkoutTypeTotal } from "../../../../infra/db/repositories/workouts.ts";
import type { WorkoutRow } from "../../../../infra/health-export/rollup.ts";

export interface LoadData {
  loadRatio: number | null;
  strengthPerWeek28d: number | null;
  byMonth: readonly { month: string; hours: number; sessions: number; strength: number }[];
  byType: readonly WorkoutTypeTotal[];
  /** The most recent sessions, newest first. */
  recent: readonly WorkoutRow[];
  tiles: readonly SeriesTile[];
  analysis: AreaAnalysis | undefined;
}

const ORAK = { label: "Edzésóra", format: (v: number) => `${hu(v, 1)} óra` };

/** "1 óra 32 perc" — minutes are what the record holds, hours are what a person reads. */
function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return h === 0 ? `${m} perc` : `${h} óra ${m} perc`;
}

/**
 * A type's calorie total, with how much of it is actually measured.
 *
 * `energy_kcal` is nullable and a great many walks arrive without one, so
 * three different things have to stay distinguishable: no session carried a
 * figure (no measurement), some did (a total, plus how many it rests on), and
 * all did (just the total).
 */
function kcalCell(t: WorkoutTypeTotal): string {
  if (t.kcal === null) return `<span class="halk">nincs mérés</span>`;
  const total = `${hu(t.kcal)} kcal`;
  if (t.kcalFrom === t.sessions) return total;
  return `${total} <span class="halk">(${t.kcalFrom} alkalomból)</span>`;
}

function typeTable(rows: readonly WorkoutTypeTotal[]): string {
  if (rows.length === 0) return "";
  const body = rows.map((t, i) => [
    `<tr class="live" style="--i:${i}">`,
    `<td>${escapeHtml(t.type)}</td>`,
    `<td class="value">${hu(t.sessions)}</td>`,
    `<td class="value">${hu(t.minutes / 60, 1)} óra</td>`,
    `<td class="ev">${kcalCell(t)}</td>`,
    `<td class="ev"><span class="note">${escapeHtml(t.lastDate)}</span></td>`,
    "</tr>",
  ].join("")).join("");
  return `<section><h2>Típusok</h2><table>${body}</table></section>`;
}

function recentTable(rows: readonly WorkoutRow[]): string {
  // An empty table with a heading is missing data that does not look missing.
  if (rows.length === 0) {
    return `<section><h2>Legutóbbi edzések</h2>`
      + `<p class="halk">Nincs rögzített edzés.</p></section>`;
  }
  const body = rows.map((w, i) => [
    `<tr class="live" style="--i:${i}">`,
    `<td>${escapeHtml(w.date)}</td>`,
    `<td>${escapeHtml(w.type)}</td>`,
    `<td class="value">${escapeHtml(duration(w.durationMin))}</td>`,
    `<td class="ev">${w.energyKcal === null
      ? `<span class="halk">nincs mérés</span>`
      : `${hu(w.energyKcal)} kcal`}</td>`,
    "</tr>",
  ].join("")).join("");
  return `<section><h2>Legutóbbi edzések</h2><table>${body}</table>`
    + `<p><a href="/terulet/terheles/naplo">Teljes napló →</a></p></section>`;
}

export function loadBody(d: LoadData): string {
  const lead = leadBand({
    label: "Terhelési arány",
    value: d.loadRatio === null ? null : `${hu(d.loadRatio, 2)}×`,
    against: "28 napos napi átlag edzésperc a 365 naposhoz mérve",
    missing: "nincs elég előzmény",
  });

  // The strength count rides with the monthly chart rather than getting its
  // own: two bar charts stacked on one time axis are harder to read than one
  // chart and one number.
  const strength = d.strengthPerWeek28d === null
    ? ""
    : `<p class="halk">Erősítés: ${hu(d.strengthPerWeek28d, 1)} alkalom hetente `
      + `(28 napos ablak).</p>`;

  const monthRows: BarRow[] = d.byMonth.map((m) => ({ label: m.month, value: m.hours }));
  const monthly = d.byMonth.length === 0
    ? ""
    : `<section><h2>Havi edzésóra</h2>${bars(monthRows, ORAK)}${strength}</section>`;

  return [
    lead,
    seriesBand("Mozgás", d.tiles),
    monthly,
    typeTable(d.byType),
    recentTable(d.recent),
    analysisBand(d.analysis),
  ].join("");
}
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-load.test.ts`
Expected: PASS mind a 9

- [ ] **Step 5: Mutációs ellenőrzés**

Cseréld a `kcalCell` első sorát erre: `if (false) return ...;`, és tedd a
`const total` sort `const total = \`${hu(t.kcal ?? 0)} kcal\`;`-ra. Futtasd
újra. Expected: FAIL — „a kalóriát nem hordozó típusnál nincs mérést ír".
Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/area/load.ts test/delivery/area-load.test.ts
git commit -m "feat: Terhelés oldal — típusbontás, havi óra, legutóbbi edzések"
```

---

### Task 7: A Regeneráció oldal törzse

Ez az oldal a projekt legnagyobb ismert adathiányát mutatja: 2718 napból 386-on
van alvás, és az elmúlt 90 napban egyetlenegyen sem. A hiány itt nem
lábjegyzet, hanem tartalom.

**Files:**
- Create: `src/delivery/http/view/area/recovery.ts`
- Test: `test/delivery/area-recovery.test.ts`

**Interfaces:**
- Consumes: `leadBand`, `seriesBand`, `analysisBand`, `SeriesTile`,
  `AreaAnalysis` a `./frame.ts`-ből; `hu` a `../format.ts`-ből; `Metric` a
  `../../../../core/analysis/stats.ts`-ből (mezői: `value: number | null`,
  `n: number`, `coverage: number`, `window: string`).
- Produces:
  ```ts
  export interface RecoveryData {
    deviation: { sigma: number; n7: number; n90: number } | null;
    sleepByYear: readonly { year: string; days: number; withSleep: number }[];
    stages: { core: Metric; rem: Metric; deep: Metric };
    awakenings: Metric;
    tiles: readonly SeriesTile[];
    analysis: AreaAnalysis | undefined;
  }
  export function recoveryBody(d: RecoveryData): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-recovery.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { recoveryBody } from "../../src/delivery/http/view/area/recovery.ts";
import type { Metric } from "../../src/core/analysis/stats.ts";

const NINCS: Metric = { value: null, n: 0, coverage: 0, window: "90d" };
const empty = {
  deviation: null,
  sleepByYear: [],
  stages: { core: NINCS, rem: NINCS, deep: NINCS },
  awakenings: NINCS,
  tiles: [],
  analysis: undefined,
};

describe("Regeneráció oldal", () => {
  it("a HRV-eltérést mutatja vezető számként, a mintaszámokkal", () => {
    // Egy nyers ms-érték semmihez nem viszonyítható. A szórás annyit ér,
    // amennyi mérésből számoltuk — ezért van ott az n7 és az n90.
    const html = recoveryBody({ ...empty, deviation: { sigma: 1.42, n7: 6, n90: 84 } });
    expect(html).toContain("1,42");
    expect(html).toContain("6");
    expect(html).toContain("84");
  });

  it("eltérés nélkül nem nullát mutat", () => {
    const html = recoveryBody({ ...empty });
    expect(html).toContain("nincs elég mérés");
    expect(html).not.toMatch(/class="szam">0/);
  });

  it("az alvás lefedettségét évenként mutatja, sávval", () => {
    const html = recoveryBody({
      ...empty,
      sleepByYear: [
        { year: "2022", days: 365, withSleep: 217 },
        { year: "2026", days: 245, withSleep: 43 },
      ],
    });
    expect(html).toContain("2022");
    expect(html).toContain("217");
    expect(html).toContain('class="rail"');
    expect(html).toContain("59%");
  });

  it("a nulla lefedettségű évet kihaltnak jelöli, nem 0%-os mért sávnak", () => {
    // Egy 0%-ra kitöltött sáv úgy néz ki, mint egy mérés, ami rosszul sült
    // el. A nulla mérés nem rossz mérés — nincs mérés.
    const html = recoveryBody({
      ...empty,
      sleepByYear: [{ year: "2021", days: 365, withSleep: 0 }],
    });
    expect(html).toContain('class="rail dead"');
  });

  it("a nem mért alvásfázist hiányként írja, nem 0 percként", () => {
    const html = recoveryBody({ ...empty });
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("0 perc");
  });

  it("a mért fázist az értékével és a mintaszámával adja", () => {
    const html = recoveryBody({
      ...empty,
      stages: {
        core: { value: 215, n: 300, coverage: .3, window: "365d" },
        rem: NINCS, deep: NINCS,
      },
    });
    expect(html).toContain("215 perc");
    expect(html).toContain("300 nap");
  });

  it("alvás-előzmény nélkül kimondja a hiányt", () => {
    expect(recoveryBody({ ...empty })).toContain("Nincs alvás-előzmény");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-recovery.test.ts`
Expected: FAIL — `Cannot find module '.../area/recovery.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/area/recovery.ts` fájlt:

```ts
import { escapeHtml } from "../../markdown.ts";
import { hu } from "../format.ts";
import {
  analysisBand, leadBand, seriesBand,
  type AreaAnalysis, type SeriesTile,
} from "./frame.ts";
import type { Metric } from "../../../../core/analysis/stats.ts";

export interface RecoveryData {
  /** Recent HRV against its own 90-day baseline, in standard deviations. */
  deviation: { sigma: number; n7: number; n90: number } | null;
  sleepByYear: readonly { year: string; days: number; withSleep: number }[];
  stages: { core: Metric; rem: Metric; deep: Metric };
  awakenings: Metric;
  tiles: readonly SeriesTile[];
  analysis: AreaAnalysis | undefined;
}

/**
 * One metric as a row: value, or the absence of one, plus its evidence.
 *
 * `value === null` never renders as zero. "0 perc of REM sleep" and "REM
 * sleep was never measured" are opposite claims that would look identical.
 */
function metricRow(label: string, m: Metric, unit: string, digits: number, i: number): string {
  const measured = m.value !== null;
  const pct = Math.min(100, Math.max(0, m.coverage * 100));
  return [
    `<tr class="${measured ? "live" : "dead"}" style="--i:${i}">`,
    `<td>${escapeHtml(label)}</td>`,
    `<td class="value">${measured ? `${hu(m.value!, digits)}${unit}` : "nincs mérés"}</td>`,
    `<td class="ev"><span class="rail${measured ? "" : " dead"}" style="--fill:${pct.toFixed(1)}%"></span>`,
    `<span class="note">${hu(m.n)} nap · ${Math.floor(pct)}% lefedettség (${escapeHtml(m.window)})</span></td>`,
    "</tr>",
  ].join("");
}

/**
 * Sleep coverage per year — the loudest missing-data block on the site.
 *
 * This is the one figure that explains why every sleep number elsewhere is
 * thin, and the year-by-year shape is what tells the story a single total
 * cannot: the coverage fell away, it did not simply start late. A year with
 * zero measured nights gets the dead rail rather than a rail filled to 0% —
 * a 0% bar reads as a measurement that went badly, and no measurement is not
 * a bad measurement.
 */
function sleepBlock(rows: readonly { year: string; days: number; withSleep: number }[]): string {
  if (rows.length === 0) {
    return `<section><h2>Alvás lefedettsége</h2>`
      + `<p class="halk">Nincs alvás-előzmény.</p></section>`;
  }
  const body = rows.map((r, i) => {
    const pct = r.days === 0 ? 0 : (r.withSleep / r.days) * 100;
    const measured = r.withSleep > 0;
    return [
      `<tr class="${measured ? "live" : "dead"}" style="--i:${i}">`,
      `<td>${escapeHtml(r.year)}</td>`,
      `<td class="value">${hu(r.withSleep)} / ${hu(r.days)} nap</td>`,
      `<td class="ev"><span class="rail${measured ? "" : " dead"}" style="--fill:${pct.toFixed(1)}%"></span>`,
      `<span class="note">${Math.floor(pct)}% lefedettség</span></td>`,
      "</tr>",
    ].join("");
  }).join("");
  return `<section><h2>Alvás lefedettsége</h2><table>${body}</table></section>`;
}

export function recoveryBody(d: RecoveryData): string {
  const lead = leadBand({
    label: "HRV az alapvonalához",
    value: d.deviation === null
      ? null
      : `${d.deviation.sigma > 0 ? "+" : ""}${hu(d.deviation.sigma, 2)} σ`,
    against: d.deviation === null
      ? "7 napos átlag a 90 napos alapvonalhoz mérve"
      : `7 nap ${hu(d.deviation.n7)} mérése a 90 nap ${hu(d.deviation.n90)} méréséhez mérve`,
    missing: "nincs elég mérés",
  });

  const stages = [
    metricRow("Mély alvás", d.stages.deep, " perc", 0, 0),
    metricRow("REM", d.stages.rem, " perc", 0, 1),
    metricRow("Alap alvás", d.stages.core, " perc", 0, 2),
    metricRow("Ébredés", d.awakenings, "", 1, 3),
  ].join("");

  return [
    lead,
    seriesBand("Regeneráció", d.tiles),
    sleepBlock(d.sleepByYear),
    `<section><h2>Fázisok és ébredés</h2><table>${stages}</table></section>`,
    analysisBand(d.analysis),
  ].join("");
}
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-recovery.test.ts`
Expected: PASS mind a 7

- [ ] **Step 5: Mutációs ellenőrzés**

A `metricRow`-ban cseréld a `${measured ? \`${hu(m.value!, digits)}${unit}\` :
"nincs mérés"}` részt erre: `${hu(m.value ?? 0, digits)}${unit}`, és futtasd
újra. Expected: FAIL — „a nem mért alvásfázist hiányként írja".

A `sleepBlock`-ban cseréld a `const measured = r.withSleep > 0;` sort erre:
`const measured = true;`, és futtasd újra. Expected: FAIL — „a nulla
lefedettségű évet kihaltnak jelöli". Állítsd vissza mindkettőt, futtasd újra:
PASS.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/area/recovery.ts test/delivery/area-recovery.test.ts
git commit -m "feat: Regeneráció oldal — az alváshiány évenkénti lefedettséggel"
```

---

### Task 8: A Táplálkozás oldal törzse

Az egyetlen oldal **elemzés-sáv nélkül**: nincs `nutrition` domain (az S8
hozza majd). A sáv nem üresen áll ott, hanem egyáltalán nincs ott.

**Files:**
- Create: `src/delivery/http/view/area/nutrition.ts`
- Test: `test/delivery/area-nutrition.test.ts`

**Interfaces:**
- Consumes: `leadBand`, `seriesBand`, `SeriesTile` a `./frame.ts`-ből (az
  `analysisBand`-et NEM hívja); `hu` a `../format.ts`-ből; `PlannedMeal` a
  `../../../../infra/db/repositories/meals.ts`-ből (mezői: `weekday: number`,
  `meal: "reggeli" | "ebed" | "vacsora"`, `item: string`,
  `needsDefrost: boolean`, `defrostLeadH: number`, `proteinG: number | null`,
  `kcal: number | null`).
- Produces:
  ```ts
  export interface NutritionData {
    measuredDays: number;
    /** The day the most recent intake was recorded on, or null. */
    lastDate: string | null;
    /** Mean measured intake per day — null where nothing was measured. */
    actual: { kcal: number | null; proteinG: number | null };
    plan: readonly PlannedMeal[];
    tiles: readonly SeriesTile[];
  }
  export function nutritionBody(d: NutritionData): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-nutrition.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { nutritionBody } from "../../src/delivery/http/view/area/nutrition.ts";

const empty = {
  measuredDays: 0, lastDate: null,
  actual: { kcal: null, proteinG: null },
  plan: [], tiles: [],
};

const m = (weekday: number, meal: "reggeli" | "ebed" | "vacsora", item: string,
  extra: Partial<{ needsDefrost: boolean; defrostLeadH: number; proteinG: number | null; kcal: number | null }> = {}) => ({
  weekday, meal, item,
  needsDefrost: false, defrostLeadH: 0, proteinG: null, kcal: null, ...extra,
});

describe("Táplálkozás oldal", () => {
  it("a mért napok számát mutatja vezető számként, nem napi átlagot", () => {
    // Ez a terület még alig mért. Egy magabiztos napi átlag 74 nap
    // mintájából többet állítana, mint amennyit tudunk.
    const html = nutritionBody({ ...empty, measuredDays: 74, lastDate: "2026-09-01" });
    expect(html).toContain("74");
    expect(html).toContain("2026-09-01");
  });

  it("egyetlen mért nap nélkül nem nullát mutat", () => {
    const html = nutritionBody({ ...empty });
    expect(html).toContain("nincs mérés");
  });

  it("nincs elemzés-sávja, és nincs hamarosan felirata sem", () => {
    // Nincs nutrition domain. A sáv nem üresen áll ott — nincs ott.
    const html = nutritionBody({ ...empty, measuredDays: 74 });
    expect(html).not.toContain("Elemzés");
    expect(html).not.toContain("hamarosan");
    expect(html).not.toContain("npm run analyze");
  });

  it("a heti étrendet naponta összegzi", () => {
    const html = nutritionBody({
      ...empty,
      plan: [
        m(1, "reggeli", "Zabkása", { proteinG: 25, kcal: 550 }),
        m(1, "ebed", "Csirkemell", { proteinG: 55, kcal: 700, needsDefrost: true, defrostLeadH: 12 }),
      ],
    });
    expect(html).toContain("Zabkása");
    expect(html).toContain("1 250 kcal");
    expect(html).toContain("80 g");
  });

  it("a kiolvasztást igénylő tételt megjelöli az előkészítési idejével", () => {
    const html = nutritionBody({
      ...empty,
      plan: [m(2, "ebed", "Marhapörkölt", { needsDefrost: true, defrostLeadH: 12 })],
    });
    expect(html).toContain("12 óra");
  });

  it("hiányos tervezett értéknél nem részösszeget ad", () => {
    // A protein_g és a kcal nullázható. Egy két tételből egyet ismerő nap
    // összege nem a nap terve.
    const html = nutritionBody({
      ...empty,
      plan: [
        m(3, "reggeli", "Kávé", { kcal: null, proteinG: null }),
        m(3, "ebed", "Rizs", { kcal: 600, proteinG: 12 }),
      ],
    });
    expect(html).toContain("nincs adat");
    expect(html).not.toContain("600 kcal");
  });

  it("étrend nélkül kimondja a hiányt", () => {
    expect(nutritionBody({ ...empty })).toContain("Nincs heti étrend");
  });

  it("escape-eli az étel nevét", () => {
    const html = nutritionBody({ ...empty, plan: [m(1, "reggeli", "<img src=x>")] });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-nutrition.test.ts`
Expected: FAIL — `Cannot find module '.../area/nutrition.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/area/nutrition.ts` fájlt:

```ts
import { escapeHtml } from "../../markdown.ts";
import { hu } from "../format.ts";
import { leadBand, seriesBand, type SeriesTile } from "./frame.ts";
import type { PlannedMeal } from "../../../../infra/db/repositories/meals.ts";

export interface NutritionData {
  /** How many days carry an intake figure at all. */
  measuredDays: number;
  /** The day the most recent intake was recorded on, or null. */
  lastDate: string | null;
  /** Mean measured intake per day — null where nothing was measured. */
  actual: { kcal: number | null; proteinG: number | null };
  plan: readonly PlannedMeal[];
  tiles: readonly SeriesTile[];
}

const NAPOK = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
const ETKEZESEK: { key: PlannedMeal["meal"]; label: string }[] = [
  { key: "reggeli", label: "Reggeli" },
  { key: "ebed", label: "Ebéd" },
  { key: "vacsora", label: "Vacsora" },
];

/**
 * A day's planned total — or nothing, when any item on it is unpriced.
 *
 * `protein_g` and `kcal` are both nullable. Summing only the items that
 * happen to carry a figure would put a partial number where a day's plan
 * belongs, and a partial number in a total's position reads as the total.
 */
function planTotal(items: readonly PlannedMeal[], key: "kcal" | "proteinG"): number | null {
  if (items.length === 0) return null;
  let sum = 0;
  for (const item of items) {
    const v = item[key];
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

function planTable(plan: readonly PlannedMeal[]): string {
  if (plan.length === 0) {
    return `<section><h2>Heti étrend</h2><p class="halk">Nincs heti étrend.</p></section>`;
  }
  // Weekdays in the order a week is lived, Monday first — the column holds
  // 0..6 with 0 as Sunday, which is the storage order, not the reading order.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const rows = order.map((weekday, i) => {
    const items = plan.filter((p) => p.weekday === weekday);
    if (items.length === 0) return "";
    const cells = ETKEZESEK.map(({ key }) => {
      const it = items.find((p) => p.meal === key);
      if (it === undefined) return `<td class="halk">—</td>`;
      const defrost = it.needsDefrost
        ? ` <span class="halk">(kiolvasztás ${hu(it.defrostLeadH)} óra)</span>`
        : "";
      return `<td>${escapeHtml(it.item)}${defrost}</td>`;
    }).join("");
    const kcal = planTotal(items, "kcal");
    const protein = planTotal(items, "proteinG");
    const total = kcal === null || protein === null
      ? `<span class="halk">nincs adat</span>`
      : `${hu(kcal)} kcal · ${hu(protein)} g`;
    return `<tr class="live" style="--i:${i}"><td>${escapeHtml(NAPOK[weekday]!)}</td>`
      + `${cells}<td class="ev">${total}</td></tr>`;
  }).join("");
  return `<section><h2>Heti étrend</h2><table>${rows}</table></section>`;
}

/**
 * Plan and reality side by side — two numbers, not a verdict.
 *
 * Reading the comparison is S8's job, once a nutrition analysis exists. This
 * band only puts the planned daily mean next to the measured one and says how
 * many days the measured side rests on.
 */
function comparison(d: NutritionData): string {
  const planned = d.plan.length === 0 ? null : (() => {
    const order = [0, 1, 2, 3, 4, 5, 6];
    const totals = order
      .map((w) => planTotal(d.plan.filter((p) => p.weekday === w), "kcal"))
      .filter((v): v is number => v !== null);
    return totals.length === 0 ? null : totals.reduce((a, b) => a + b, 0) / totals.length;
  })();

  const cell = (v: number | null, unit: string) =>
    v === null ? `<span class="halk">nincs adat</span>` : `${hu(v)}${unit}`;

  return [
    `<section><h2>Terv és valóság</h2><table>`,
    `<tr class="live" style="--i:0"><td>Tervezett napi kalória</td>`,
    `<td class="value">${cell(planned, " kcal")}</td>`,
    `<td class="ev"><span class="note">a heti étrendből</span></td></tr>`,
    `<tr class="${d.actual.kcal === null ? "dead" : "live"}" style="--i:1"><td>Mért napi kalória</td>`,
    `<td class="value">${cell(d.actual.kcal, " kcal")}</td>`,
    `<td class="ev"><span class="note">${hu(d.measuredDays)} mért nap átlaga</span></td></tr>`,
    `<tr class="${d.actual.proteinG === null ? "dead" : "live"}" style="--i:2"><td>Mért napi fehérje</td>`,
    `<td class="value">${cell(d.actual.proteinG, " g")}</td>`,
    `<td class="ev"><span class="note">${hu(d.measuredDays)} mért nap átlaga</span></td></tr>`,
    `</table></section>`,
  ].join("");
}

/**
 * The nutrition area — the one page with no analysis band.
 *
 * There is no `nutrition` analysis domain yet (S8 will add one), so the
 * fourth band is absent rather than empty. An empty band, or a "coming soon"
 * note in its place, would be missing data that does not look missing — the
 * thing this shell has refused since F1.
 */
export function nutritionBody(d: NutritionData): string {
  const lead = leadBand({
    label: "Mért napok",
    value: d.measuredDays === 0 ? null : hu(d.measuredDays),
    against: d.lastDate === null
      ? "bevitel rögzítve"
      : `bevitel rögzítve · legutóbb ${d.lastDate}`,
    missing: "nincs mérés",
  });

  return [
    lead,
    seriesBand("Bevitel", d.tiles),
    comparison(d),
    planTable(d.plan),
  ].join("");
}
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-nutrition.test.ts`
Expected: PASS mind a 8

- [ ] **Step 5: Mutációs ellenőrzés**

A `planTotal`-ban cseréld a `if (v === null) return null;` sort erre:
`if (v === null) continue;`, és futtasd újra. Expected: FAIL — „hiányos
tervezett értéknél nem részösszeget ad". Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/area/nutrition.ts test/delivery/area-nutrition.test.ts
git commit -m "feat: Táplálkozás oldal — heti étrend, terv és valóság, elemzés-sáv nélkül"
```

---

### Task 9: A Pénzügy oldal törzse

**Files:**
- Create: `src/delivery/http/view/area/finance.ts`
- Test: `test/delivery/area-finance.test.ts`

**Interfaces:**
- Consumes: `leadBand`, `analysisBand`, `AreaAnalysis` a `./frame.ts`-ből;
  `bars`, `BarRow` a `../chart/bars.ts`-ből; `hu`, `huFt` a
  `../format.ts`-ből; `Subscription` a
  `../../../../infra/db/repositories/subscriptions.ts`-ből. A mezői
  ellenőrizve: `id: number`, `name: string`, `amountHuf: number`,
  `cycle: "monthly" | "quarterly" | "annual"`, `nextRenewal: string`,
  `category: string | null`, `cancelUrl: string | null`,
  `lastUsedAt: string | null`, `active: boolean`, `notes: string | null`.
  Mindet a `listAll()` adja vissza.
- Produces:
  ```ts
  export interface FinanceData {
    months: readonly { month: string; totalHuf: number; activeCount: number }[];
    monthOverMonth: {
      from: string; to: string; deltaHuf: number;
      changes: readonly { name: string; fromHuf: number | null; toHuf: number | null }[];
    } | null;
    annualisedHuf: number | null;
    /** How many recorded months an annual projection needs. */
    minMonths: number;
    subscriptions: readonly Subscription[];
    /** Today, for "in how many days" — the view never reads a clock itself. */
    today: string;
    analysis: AreaAnalysis | undefined;
  }
  export function financeBody(d: FinanceData): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-finance.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { financeBody } from "../../src/delivery/http/view/area/finance.ts";
import type { Subscription } from "../../src/infra/db/repositories/subscriptions.ts";

const sub = (p: Partial<Subscription> & Pick<Subscription, "name" | "amountHuf">): Subscription => ({
  id: 1, cycle: "monthly", nextRenewal: "2026-09-12", category: null,
  cancelUrl: null, lastUsedAt: null, active: true, notes: null, ...p,
} as Subscription);

const empty = {
  months: [], monthOverMonth: null, annualisedHuf: null, minMonths: 6,
  subscriptions: [], today: "2026-09-03", analysis: undefined,
};

describe("Pénzügy oldal", () => {
  it("a havi terhet mutatja vezető számként", () => {
    const html = financeBody({
      ...empty,
      months: [{ month: "2026-09", totalHuf: 64860, activeCount: 5 }],
    });
    expect(html).toContain("64 860 Ft");
  });

  it("hat hónapnál kevesebb rögzítésnél nem évesít, és nem 0 Ft-ot ír", () => {
    // Egyetlen hónapot tizenkettővel szorozni egy évnyi költést állítana egy
    // hónapnyi bizonyítékból. A küszöb indoklása az aggregate.ts-ben áll.
    const html = financeBody({
      ...empty,
      months: [
        { month: "2026-08", totalHuf: 64860, activeCount: 5 },
        { month: "2026-09", totalHuf: 64860, activeCount: 5 },
      ],
      annualisedHuf: null,
    });
    // Csak az évesítés sávját nézzük: a "64 860 Ft" vezető szám maga is
    // tartalmazza a "0 Ft" részsztringet, tehát a teljes oldalra menő
    // állítás vaklármát adna.
    const sav = /Évesített teher<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
    expect(sav).toContain("nincs elég hónap");
    expect(sav).toContain("2 a 6-ból");
    expect(sav).not.toContain("Ft");
  });

  it("elég hónap esetén kiírja az évesített terhet", () => {
    const html = financeBody({ ...empty, annualisedHuf: 778320, minMonths: 6 });
    expect(html).toContain("778 320 Ft");
  });

  it("a hiányzó utolsó használatot nincs adatként írja, nem sohaként", () => {
    // A mező csak akkor íródik, ha valami feljegyzi. A "soha" azt állítaná,
    // hogy tudjuk: nem használtad.
    const html = financeBody({
      ...empty,
      subscriptions: [sub({ name: "Telekom", amountHuf: 12990, lastUsedAt: null })],
    });
    expect(html).toContain("nincs adat");
    expect(html).not.toContain("soha");
  });

  it("megmondja, hány nap múlva újul meg", () => {
    const html = financeBody({
      ...empty, today: "2026-09-03",
      subscriptions: [sub({ name: "Netflix", amountHuf: 4490, nextRenewal: "2026-09-12" })],
    });
    expect(html).toContain("9 nap");
  });

  it("a havi terhet oszlopdiagramként rajzolja", () => {
    const html = financeBody({
      ...empty,
      months: [
        { month: "2026-08", totalHuf: 64860, activeCount: 5 },
        { month: "2026-09", totalHuf: 64860, activeCount: 5 },
      ],
    });
    expect(html).toContain('class="oszlopok"');
    // Csak a rögzített hónapok szerepelnek: a rögzítés előtti hónapok nem
    // nulla oszlopok, hanem egyáltalán nincsenek a diagramon.
    expect(html).not.toContain("2026-07");
  });

  it("előfizetés nélkül kimondja a hiányt", () => {
    expect(financeBody({ ...empty })).toContain("Nincs rögzített előfizetés");
  });

  it("escape-eli az előfizetés nevét", () => {
    const html = financeBody({
      ...empty, subscriptions: [sub({ name: "<b>X</b>", amountHuf: 100 })],
    });
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-finance.test.ts`
Expected: FAIL — `Cannot find module '.../area/finance.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/area/finance.ts` fájlt:

```ts
import { escapeHtml } from "../../markdown.ts";
import { hu, huFt } from "../format.ts";
import { analysisBand, leadBand, type AreaAnalysis } from "./frame.ts";
import { bars, type BarRow } from "../chart/bars.ts";
import type { Subscription } from "../../../../infra/db/repositories/subscriptions.ts";

export interface FinanceData {
  months: readonly { month: string; totalHuf: number; activeCount: number }[];
  monthOverMonth: {
    from: string; to: string; deltaHuf: number;
    changes: readonly { name: string; fromHuf: number | null; toHuf: number | null }[];
  } | null;
  /** The latest month × 12, or null below `minMonths` recorded months. */
  annualisedHuf: number | null;
  minMonths: number;
  subscriptions: readonly Subscription[];
  /** Today, so the view can say "in N days" without reading a clock itself. */
  today: string;
  analysis: AreaAnalysis | undefined;
}

const FORINT = { label: "Havi teher", format: (v: number) => huFt(v) };

const CIKLUS: Record<string, string> = {
  monthly: "havi", quarterly: "negyedéves", annual: "éves",
};

/** Whole days between two ISO dates, positive when `to` is in the future. */
function daysUntil(today: string, to: string): number | null {
  const a = Date.parse(`${today}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function renewalCell(today: string, next: string): string {
  const days = daysUntil(today, next);
  if (days === null) return `<span class="halk">nincs adat</span>`;
  const when = days < 0 ? `${hu(-days)} napja` : `${hu(days)} nap múlva`;
  return `${escapeHtml(next)} <span class="halk">(${when})</span>`;
}

function subTable(d: FinanceData): string {
  if (d.subscriptions.length === 0) {
    return `<section><h2>Előfizetések</h2>`
      + `<p class="halk">Nincs rögzített előfizetés.</p></section>`;
  }
  const body = d.subscriptions.map((s, i) => [
    `<tr class="${s.active ? "live" : "dead"}" style="--i:${i}">`,
    `<td>${escapeHtml(s.name)}`,
    s.category ? ` <span class="halk">${escapeHtml(s.category)}</span>` : "",
    `</td>`,
    `<td class="value">${huFt(s.amountHuf)}</td>`,
    `<td class="ev"><span class="note">${escapeHtml(CIKLUS[s.cycle] ?? s.cycle)}</span></td>`,
    `<td class="ev">${renewalCell(d.today, s.nextRenewal)}</td>`,
    // "nincs adat", never "soha": the field is only written when something
    // records a use, so its absence says nothing about whether the service
    // was used.
    `<td class="ev">${s.lastUsedAt === null
      ? `<span class="halk">nincs adat</span>`
      : escapeHtml(s.lastUsedAt.slice(0, 10))}</td>`,
    "</tr>",
  ].join("")).join("");
  return `<section><h2>Előfizetések</h2><table>${body}</table></section>`;
}

export function financeBody(d: FinanceData): string {
  const latest = d.months.at(-1);
  const delta = d.monthOverMonth === null
    ? "hónapról hónapra nincs mihez mérni"
    : `${d.monthOverMonth.deltaHuf === 0 ? "változatlan" : `${d.monthOverMonth.deltaHuf > 0 ? "+" : ""}${huFt(d.monthOverMonth.deltaHuf)}`}`
      + ` ${d.monthOverMonth.from} óta`;

  const lead = leadBand({
    label: "Havi teher",
    value: latest === undefined ? null : huFt(latest.totalHuf),
    against: latest === undefined ? "rögzített előfizetési hónap" : delta,
    missing: "nincs rögzített hónap",
  });

  // Only the recorded months. A month before the record began is not a zero
  // column — it is not on the chart at all, which is why the rows carry real
  // numbers and never a null: the caller has nothing to put there.
  const monthRows: BarRow[] = d.months.map((m) => ({ label: m.month, value: m.totalHuf }));
  const chart = d.months.length === 0
    ? ""
    : `<section><h2>Havi teher</h2>${bars(monthRows, FORINT)}</section>`;

  // The threshold is not a formatting choice: multiplying one observed month
  // by twelve turns a month of evidence into a year of spending. Below it the
  // honest answer is that there is not yet enough history to project from.
  const annual = `<section><h2>Évesített teher</h2><p class="${d.annualisedHuf === null ? "halk" : ""}">`
    + (d.annualisedHuf === null
      ? `nincs elég hónap az évesítéshez (${hu(d.months.length)} a ${hu(d.minMonths)}-ból)`
      : escapeHtml(huFt(d.annualisedHuf)))
    + "</p></section>";

  return [lead, chart, subTable(d), annual, analysisBand(d.analysis)].join("");
}
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-finance.test.ts`
Expected: PASS mind a 8

- [ ] **Step 5: Mutációs ellenőrzés**

Cseréld az `annual` blokkban a `d.annualisedHuf === null` feltételt erre:
`false`, és a `huFt(d.annualisedHuf)` hívást erre: `huFt(d.annualisedHuf ?? 0)`.
Futtasd újra. Expected: FAIL — „hat hónapnál kevesebb rögzítésnél nem évesít".
Állítsd vissza.

Cseréld a `lastUsedAt === null` ág szövegét „soha"-ra, és futtasd újra.
Expected: FAIL — „a hiányzó utolsó használatot nincs adatként írja". Állítsd
vissza, futtasd újra: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/area/finance.ts test/delivery/area-finance.test.ts
git commit -m "feat: Pénzügy oldal — előfizetések, havi teher, becsületes évesítés"
```

---

### Task 10: A hub oldal törzse

**Files:**
- Create: `src/delivery/http/view/area/hub.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/area-hub.test.ts`

**Interfaces:**
- Consumes: `escapeHtml`, `renderMarkdown` a `../../markdown.ts`-ből;
  `AreaAnalysis` a `./frame.ts`-ből.
- Produces:
  ```ts
  export interface HubCard {
    href: string;
    title: string;
    /** The area's own headline figure, already formatted — null when absent. */
    figure: string | null;
    /** One sentence from the domain's analysis, or the area's own line. */
    note: string;
    /** How old the note's source is, as an ISO date — null when it has none. */
    noteDate: string | null;
  }
  export interface HubData {
    synthesis: AreaAnalysis | undefined;
    cards: readonly HubCard[];
  }
  export function hubBody(d: HubData): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-hub.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { hubBody } from "../../src/delivery/http/view/area/hub.ts";

const card = (over: Partial<Parameters<typeof hubBody>[0]["cards"][number]> = {}) => ({
  href: "/terulet/terheles", title: "Terhelés",
  figure: "1,41×", note: "A terhelés magas.", noteDate: "2026-09-01", ...over,
});

describe("terület-hub", () => {
  it("az Összegzés elemzést a dátumával mutatja", () => {
    const html = hubBody({
      synthesis: { markdown: "**Összkép**", createdAt: "2026-09-01T07:11:50.124Z" },
      cards: [],
    });
    expect(html).toContain("Összegzés");
    expect(html).toContain("2026-09-01");
    expect(html).toContain("<strong>Összkép</strong>");
  });

  it("Összegzés nélkül nem ad üres címet", () => {
    // Egy "Összegzés" fejléc semmivel alatta hiányzó adat, ami nem látszik
    // hiányzónak.
    const html = hubBody({ synthesis: undefined, cards: [card()] });
    expect(html).not.toContain("Összegzés");
  });

  it("minden kártya a saját területére visz", () => {
    const html = hubBody({ synthesis: undefined, cards: [card()] });
    expect(html).toContain('href="/terulet/terheles"');
    expect(html).toContain("1,41×");
    expect(html).toContain("A terhelés magas.");
  });

  it("a kártyán ott a forrás kora", () => {
    // Egy két hete készült elemzés összefoglalója akkor is két hetes, ha
    // magabiztosan hangzik.
    const html = hubBody({ synthesis: undefined, cards: [card({ noteDate: "2026-08-20" })] });
    expect(html).toContain("2026-08-20");
  });

  it("vezető szám nélküli kártya nem nullát mutat", () => {
    const html = hubBody({
      synthesis: undefined,
      cards: [card({ figure: null, note: "Nincs elég előzmény.", noteDate: null })],
    });
    expect(html).toContain("nincs adat");
    expect(html).not.toMatch(/class="szam">0/);
  });

  it("escape-eli a kártya szövegét", () => {
    const html = hubBody({
      synthesis: undefined,
      cards: [card({ title: "<b>T</b>", note: "<i>n</i>", figure: "<u>f</u>" })],
    });
    expect(html).not.toContain("<b>T</b>");
    expect(html).not.toContain("<i>n</i>");
    expect(html).not.toContain("<u>f</u>");
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-hub.test.ts`
Expected: FAIL — `Cannot find module '.../area/hub.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/area/hub.ts` fájlt:

```ts
import { escapeHtml, renderMarkdown } from "../../markdown.ts";
import type { AreaAnalysis } from "./frame.ts";

export interface HubCard {
  href: string;
  title: string;
  /** The area's own headline figure, already formatted — null when absent. */
  figure: string | null;
  /**
   * One sentence about the area.
   *
   * Normally the domain analysis's own `summary`. Nutrition has no analysis
   * domain (S8 will add one), so its card carries a measured line of its own
   * instead — a card with something true to say is not a missing-data state.
   */
  note: string;
  /** The ISO date the note's source carries, or null when it has none. */
  noteDate: string | null;
}

export interface HubData {
  synthesis: AreaAnalysis | undefined;
  cards: readonly HubCard[];
}

/**
 * The way into the four areas, and the only page that carries the synthesis.
 *
 * Not an empty click-through: the nav has four slots and there are eight
 * pages behind them, so this page has to earn its place. It does that by
 * being where the cross-domain analysis lives and where each area states its
 * headline figure — which is also the fastest read on the whole site.
 */
export function hubBody(d: HubData): string {
  const synthesis = d.synthesis === undefined
    ? ""
    : `<section><h2>Összegzés · ${escapeHtml(d.synthesis.createdAt.slice(0, 10))}</h2>`
      + `${renderMarkdown(d.synthesis.markdown)}</section>`;

  const cards = d.cards.map((c) => [
    `<a class="kartya${c.figure === null ? " hianyzik" : ""}" href="${c.href}">`,
    `<span class="cimke">${escapeHtml(c.title)}</span>`,
    `<span class="szam">${escapeHtml(c.figure ?? "nincs adat")}</span>`,
    `<span class="halk">${escapeHtml(c.note)}</span>`,
    c.noteDate === null ? "" : `<span class="kor">${escapeHtml(c.noteDate)}</span>`,
    "</a>",
  ].join("")).join("");

  return `${synthesis}<section><div class="kartyak">${cards}</div></section>`;
}
```

- [ ] **Step 4: Add hozzá a CSS-t**

A `theme.ts`-ben a `/* ---- területi oldalak ---- */` blokk végére (a
`.csempe:hover .cimke { ... }` sor után) illeszd be:

```css
.kartyak { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 1px; background: var(--racs); border: 1px solid var(--racs); }
.kartya { display: flex; flex-direction: column; gap: .35rem; padding: 1rem;
  background: var(--lap); text-decoration: none; color: var(--szoveg); }
.kartya .cimke { font: .68rem/1.4 var(--mono); letter-spacing: .18em;
  text-transform: uppercase; color: var(--vaz); }
.kartya .szam { font: 600 1.5rem/1.2 var(--mono); font-variant-numeric: tabular-nums;
  color: var(--jel); }
.kartya.hianyzik .szam { color: var(--halvany); font-size: 1rem; font-weight: 400; }
.kartya .kor { font: .62rem/1.4 var(--mono); color: var(--halvany); }
.kartya:hover { background: var(--hatter); }
```

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-hub.test.ts test/delivery/view-theme.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/area/hub.ts src/delivery/http/view/theme.ts test/delivery/area-hub.test.ts
git commit -m "feat: terület-hub az Összegzéssel és négy élő kártyával"
```

---

### Task 11: Az edzésnapló és a lapozója

**Files:**
- Create: `src/delivery/http/view/area/worklog.ts`
- Test: `test/delivery/area-worklog.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` a `../../markdown.ts`-ből; `hu` a `../format.ts`-ből;
  `WorkoutRow` a `../../../../infra/health-export/rollup.ts`-ből.
- Produces:
  ```ts
  export const OLDAL_MERET = 50;
  export function parseOldal(raw: string | undefined, total: number): number;
  export function worklogBody(
    rows: readonly WorkoutRow[], oldal: number, total: number,
  ): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-worklog.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { OLDAL_MERET, parseOldal, worklogBody } from "../../src/delivery/http/view/area/worklog.ts";

const w = (date: string, type = "Walking", kcal: number | null = 140) => ({
  date, type, startedAt: `${date}T06:12:00.000Z`,
  durationMin: 32, energyKcal: kcal, source: "iPhone",
});

describe("parseOldal", () => {
  it("értelmes lapszámot elfogad", () => {
    expect(parseOldal("3", 500)).toBe(3);
  });

  it("minden értelmetlen bemenet az első oldalra esik", () => {
    // Ezek mind egy régi könyvjelzőből, egy elgépelésből vagy egy kézzel
    // szerkesztett URL-ből jönnek. Egyik sem a szerver hibája, és egyik sem
    // viheti el az oldalt — de 404-et sem kapnak, mert a napló LÉTEZIK.
    for (const raw of ["0", "-3", "9999", "abc", "", " ", "1.5", "1e3", undefined]) {
      expect(parseOldal(raw, 120), `bemenet: ${String(raw)}`).toBe(1);
    }
  });

  it("üres naplónál is az első oldal", () => {
    expect(parseOldal("1", 0)).toBe(1);
    expect(parseOldal("2", 0)).toBe(1);
  });

  it("az utolsó oldalt még elfogadja", () => {
    // 120 edzés, 50-esével: pontosan 3 oldal.
    expect(parseOldal("3", 120)).toBe(3);
    expect(parseOldal("4", 120)).toBe(1);
  });
});

describe("edzésnapló", () => {
  it("kiírja az edzés minden oszlopát", () => {
    const html = worklogBody([w("2026-09-01")], 1, 1);
    expect(html).toContain("2026-09-01");
    expect(html).toContain("Walking");
    expect(html).toContain("140 kcal");
    expect(html).toContain("iPhone");
  });

  it("a kalória nélküli edzésnél nincs mérést ír", () => {
    const html = worklogBody([w("2026-09-01", "Walking", null)], 1, 1);
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("0 kcal");
  });

  it("a lapozó sosem mutat a tartományon kívülre", () => {
    // 120 edzés = 3 oldal. Az elsőn nincs "előző", az utolsón nincs
    // "következő" — egy link egy nem létező oldalra üres táblát adna, ami
    // azt állítaná, hogy ott nincs edzés.
    const first = worklogBody([w("2026-09-01")], 1, 120);
    expect(first).not.toContain("oldal=0");
    expect(first).toContain("oldal=2");

    const last = worklogBody([w("2026-01-01")], 3, 120);
    expect(last).toContain("oldal=2");
    expect(last).not.toContain("oldal=4");
  });

  it("megmondja, hányadik oldalon áll és hány edzésből", () => {
    const html = worklogBody([w("2026-09-01")], 2, 120);
    expect(html).toContain("2 / 3");
    expect(html).toContain("120");
  });

  it("egyetlen oldalnál egyáltalán nincs lapozó", () => {
    const html = worklogBody([w("2026-09-01")], 1, 4);
    expect(html).not.toContain("oldal=");
  });

  it("üres naplónál kimondja a hiányt, nem üres táblát ad", () => {
    const html = worklogBody([], 1, 0);
    expect(html).toContain("Nincs rögzített edzés");
  });

  it("escape-eli a típust és a forrást", () => {
    const html = worklogBody([{ ...w("2026-09-01"), type: "<b>x</b>", source: "<i>y</i>" }], 1, 1);
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>y</i>");
  });

  it("az oldalméret ötven", () => {
    expect(OLDAL_MERET).toBe(50);
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-worklog.test.ts`
Expected: FAIL — `Cannot find module '.../area/worklog.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/area/worklog.ts` fájlt:

```ts
import { escapeHtml } from "../../markdown.ts";
import { hu } from "../format.ts";
import type { WorkoutRow } from "../../../../infra/health-export/rollup.ts";

export const OLDAL_MERET = 50;

/** How many pages `total` workouts make, never fewer than one. */
function oldalak(total: number): number {
  return Math.max(1, Math.ceil(total / OLDAL_MERET));
}

/**
 * A 1-based page number from the query string, or the first page.
 *
 * Everything unusable falls back to page one rather than to a 404: the log
 * EXISTS, and only the request was meaningless. A 404 would say the page is
 * not there; an empty table would say there are no workouts, and there are
 * 2392 of them. `Number` is deliberately not enough on its own — it accepts
 * "1.5", "1e3" and " " (which becomes 0), so the integer and range checks
 * are what actually do the work here.
 */
export function parseOldal(raw: string | undefined, total: number): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "") return 1;
  if (!Number.isInteger(n) || n < 1 || n > oldalak(total)) return 1;
  return n;
}

/** "1 óra 32 perc" — minutes are what the record holds, hours are what a person reads. */
function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return h === 0 ? `${m} perc` : `${h} óra ${m} perc`;
}

/**
 * The pager: plain links, no JavaScript.
 *
 * Only the neighbours that exist are drawn. A "next" link on the last page
 * would land on an empty table, and an empty table in a log of 2392 workouts
 * reads as "there are none".
 */
function pager(oldal: number, total: number): string {
  const last = oldalak(total);
  if (last === 1) return "";
  const prev = oldal > 1
    ? `<a href="/terulet/terheles/naplo?oldal=${oldal - 1}">← előző</a>`
    : "";
  const next = oldal < last
    ? `<a href="/terulet/terheles/naplo?oldal=${oldal + 1}">következő →</a>`
    : "";
  return `<nav class="lapozo">${prev}`
    + `<span class="halk">${hu(oldal)} / ${hu(last)} · ${hu(total)} edzés</span>`
    + `${next}</nav>`;
}

export function worklogBody(
  rows: readonly WorkoutRow[], oldal: number, total: number,
): string {
  if (total === 0) {
    return `<section><h2>Edzésnapló</h2>`
      + `<p class="halk">Nincs rögzített edzés.</p></section>`;
  }
  const body = rows.map((w, i) => [
    `<tr class="live" style="--i:${Math.min(i, 7)}">`,
    `<td>${escapeHtml(w.date)}</td>`,
    // The stored instant is UTC; only its clock time is shown, which is what
    // "when did I start" means to a reader looking at their own day.
    `<td class="ev"><span class="note">${escapeHtml(w.startedAt.slice(11, 16))}</span></td>`,
    `<td>${escapeHtml(w.type)}</td>`,
    `<td class="value">${escapeHtml(duration(w.durationMin))}</td>`,
    `<td class="ev">${w.energyKcal === null
      ? `<span class="halk">nincs mérés</span>`
      : `${hu(w.energyKcal)} kcal`}</td>`,
    `<td class="ev"><span class="note">${escapeHtml(w.source)}</span></td>`,
    "</tr>",
  ].join("")).join("");

  return `<section><h2>Edzésnapló</h2><table>${body}</table>`
    + `${pager(oldal, total)}</section>`;
}
```

- [ ] **Step 4: Add hozzá a lapozó CSS-ét**

A `theme.ts`-ben a `/* ---- területi oldalak ---- */` blokk végére:

```css
.lapozo { display: flex; align-items: baseline; gap: 1rem; padding: .8rem 0;
  font: .72rem/1.5 var(--mono); }
.lapozo a { color: var(--vaz); text-decoration: none; }
.lapozo a:hover { color: var(--jel); }
```

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/area-worklog.test.ts`
Expected: PASS mind a 13

- [ ] **Step 6: Mutációs ellenőrzés**

A `parseOldal`-ban cseréld a `!Number.isInteger(n) || n < 1 || n > oldalak(total)`
feltételt erre: `Number.isNaN(n)`, és futtasd újra.
Expected: FAIL — „minden értelmetlen bemenet az első oldalra esik".

A `pager`-ben cseréld a `const next = oldal < last ? ... : "";` sort erre:
`const next = \`<a href="/terulet/terheles/naplo?oldal=${oldal + 1}">következő →</a>\`;`
és futtasd újra. Expected: FAIL — „a lapozó sosem mutat a tartományon kívülre".
Állítsd vissza mindkettőt, futtasd újra: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/delivery/http/view/area/worklog.ts src/delivery/http/view/theme.ts test/delivery/area-worklog.test.ts
git commit -m "feat: edzésnapló JS nélküli lapozóval"
```

---

### Task 12: A hat útvonal, és az /elemzes feloldása

Ez zárja a branchet: itt lesz először zöld a teljes suite a Task 4 óta.

**Files:**
- Create: `src/delivery/http/routes/page-shell.ts` (ide költözik a `PageDeps`,
  a `ShellInputs`, a `shellInputs()`, a `render()` és a két dátum-szó segéd)
- Create: `src/delivery/http/routes/areas.ts`
- Modify: `src/delivery/http/routes/page.ts` (a `/elemzes` törlése, a
  költöztetett részek importálása)
- Modify: `src/delivery/http/server.ts` (`registerAreaRoutes` bekötése)
- Modify: `src/delivery/http/view/analyses.ts` (az `analysesBody` törlése)
- Test: `test/delivery/area-routes.test.ts`
- Test: `test/delivery/page.test.ts` (a `/elemzes` tesztjeinek átköltöztetése)

**A körkörös import elkerülése.** A kézenfekvő megoldás — hogy az `areas.ts`
a `page.ts`-ből importálja a `shellInputs`-t, a `page.ts` pedig az
`areas.ts`-ből a regisztrálót — ESM-körre vezet. Node lefuttatja (a
függvénydeklarációk hoistolódnak, a hívások futásidőben történnek), de a
modulok részlegesen inicializált állapotban látják egymást, és az első
top-level konstans, amit valaki áthelyez, csendben `undefined` lesz. Ezért a
közös rész egy harmadik modulba kerül, amiből MINDKETTŐ importál, és a
szerver hívja meg mindkét regisztrálót. A `PageDeps` és a `WEB_CHAT_ID`
ellenőrizve: a `routes/page.ts`-en kívül semmi nem importálja őket, tehát a
költözés senkit nem érint.

**Interfaces:**
- Consumes: minden korábbi task terméke.
- Produces:
  ```ts
  // routes/page-shell.ts
  export interface PageDeps { /* a Task 3-ban meghatározott mezők */ }
  export interface ShellInputs { /* a mai page.ts mezői, változatlanul */ }
  export async function shellInputs(deps: PageDeps, now: Date): Promise<ShellInputs>;
  export function render(section: Section, inputs: ShellInputs, body: string): string;

  // routes/areas.ts
  export function registerAreaRoutes(app: FastifyInstance, deps: PageDeps): void;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/area-routes.test.ts` fájlt:

```ts
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
```

Az `a.analyses.save(...)` szignatúrája ellenőrizve: `Omit<AnalysisRow,
"id">`, tehát pontosan `{ createdAt, domain, markdown, summary, metrics }` —
a fenti hívások ezt adják. A `domain` típusa `"physical" | "recovery" |
"finance" | "synthesis"`.

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/area-routes.test.ts`
Expected: FAIL — mind a hat útvonal 404, és a `page.ts` típushibás a Task 4 óta

- [ ] **Step 3: Emeld ki a közös részt a page-shell.ts-be**

Hozd létre a `src/delivery/http/routes/page-shell.ts` fájlt, és **mozgasd át**
oda a `routes/page.ts`-ből, változtatás nélkül, `export`-tal ellátva:

- a `PageDeps` interfészt (a Task 3-ban kapott alakjában)
- a `ShellInputs` interfészt a doc-kommentjével együtt
- az `ageWords` és a `dayWords` segédfüggvényt
- a `shellInputs` függvényt a doc-kommentjével együtt
- a `render` függvényt

Vidd át a hozzájuk tartozó importokat is (`BriefService`, `ChatService`,
`AnalysisRepo`, `AnalysisRow`, `ConversationRepo`, `HealthRepo`,
`HealthSnapshot`, `WorkoutRepo`, `MealRepo`, `SubscriptionRepo`, `Metrics`,
`Clock`, `Logger`, `readChannels`, `summarise`, `ChannelReading`,
`ChannelSummary`, `layout`, `NavState`, `Section`, `huLongDate`, `isoDate`,
`TZ`).

A `routes/page.ts` ezek helyett egyetlen sort kap:

```ts
import { render, shellInputs, type PageDeps } from "./page-shell.ts";
```

és a `PageDeps`-et onnan re-exportálja, hogy a régi importútvonal se törjön el:

```ts
export type { PageDeps } from "./page-shell.ts";
```

A `WEB_CHAT_ID` marad a `page.ts`-ben — a `/kerdes` és a `/api/chat` használja,
és semmi más.

Ezután a `page-shell.ts`-ben a `shellInputs` `nav` objektumában cseréld az
`elemzes` mezőt:

```ts
    nav: {
      ma: briefMarkdown !== null,
      // Lit while the deep analysis is still fresh. The analysis is started
      // by hand (`npm run analyze`) and reports over 28-day windows, so a
      // week — by which a quarter of that window has turned over — is where
      // its picture stops being the current one. Unlike the old "there is at
      // least one analysis" lamp, this one can actually go dark.
      terulet: analyses.some(
        (a) => now.getTime() - Date.parse(a.createdAt) <= 7 * 86_400_000,
      ),
      kerdes: chatAvailable,
    },
```

Végül a `routes/page.ts`-ben:

- töröld a teljes `app.get("/elemzes", ...)` blokkot
- töröld az `import { analysesBody } from "../view/analyses.ts";` sort

A `src/delivery/http/server.ts`-ben pedig a `registerPageRoutes(app, {...})`
hívás UTÁN vedd fel a másodikat, ugyanazokkal a függőségekkel:

```ts
  const pageDeps = {
    briefs: deps.briefs, chat: deps.chat, analyses: deps.analyses,
    conversations: deps.conversations, health: deps.health,
    workouts: deps.workouts, meals: deps.meals, subscriptions: deps.subscriptions,
    metrics: deps.metrics, clock: deps.clock, logger: deps.logger,
  };
  registerPageRoutes(app, pageDeps);
  registerAreaRoutes(app, pageDeps);
```

(a meglévő inline objektum helyett — így a két regisztráló pontosan ugyanazt
kapja), és az importok közé:

```ts
import { registerAreaRoutes } from "./routes/areas.ts";
```

Az `onRoute` hook mindkét regisztráló útvonalait felveszi a
`registeredRoutes`-ba, tehát az alapból-tiltó hitelesítés az új hatot is
azonnal őrzi — ezt a Task 12 tesztjei ki is mondják.

- [ ] **Step 4: Töröld az analysesBody-t**

A `src/delivery/http/view/analyses.ts` végéről töröld a teljes
`export function analysesBody(...)` blokkot. Az `analysesBlock` és a
`DOMAIN_TITLE` marad — más helyről még használatban lehet, és a saját
tesztje (`test/delivery/view-analyses.test.ts`) rá megy.

Ha a `test/delivery/view-analyses.test.ts` hivatkozik az `analysesBody`-ra,
töröld azt a tesztet: az `/elemzes` sávjának törzsét ellenőrizte, és az a sáv
megszűnt. Az `analysesBlock`-ra menő állítások maradnak.

- [ ] **Step 5: Írd meg a routes/areas.ts-t**

Hozd létre a `src/delivery/http/routes/areas.ts` fájlt:

```ts
import type { FastifyInstance } from "fastify";
import { addDays, isoDate, TZ } from "../../../shared/dates.ts";
import { buildSeries } from "../view/chart/series.ts";
import { SOROZATOK, valuesFrom } from "../view/chart/registry.ts";
import { sparkline } from "../view/chart/sparkline.ts";
import { hu, huFt } from "../view/format.ts";
import type { SeriesTile, AreaAnalysis } from "../view/area/frame.ts";
import { hubBody, type HubCard } from "../view/area/hub.ts";
import { loadBody } from "../view/area/load.ts";
import { recoveryBody } from "../view/area/recovery.ts";
import { nutritionBody } from "../view/area/nutrition.ts";
import { financeBody } from "../view/area/finance.ts";
import { OLDAL_MERET, parseOldal, worklogBody } from "../view/area/worklog.ts";
import { render, shellInputs, type PageDeps } from "./page-shell.ts";
import type { Metrics } from "../../../core/analysis/aggregate.ts";
import type { AnalysisRow } from "../../../infra/db/repositories/analyses.ts";
import type { HealthSnapshot } from "../../../infra/db/repositories/health.ts";

/** How many recorded months an annual projection needs — mirrors aggregate.ts. */
const MIN_MONTHS_TO_ANNUALISE = 6;

/** The longest window any area tile draws. */
const TILE_DAYS = 365;

/**
 * The analysis for one domain, in the shape the area bands want.
 *
 * `latestPerDomain()` mixes vintages by design, so each area gets its own
 * domain's newest row rather than "the last run's output".
 */
function analysisFor(rows: readonly AnalysisRow[], domain: string): AreaAnalysis | undefined {
  const hit = rows.find((a) => a.domain === domain);
  return hit === undefined ? undefined : { markdown: hit.markdown, createdAt: hit.createdAt };
}

export function registerAreaRoutes(app: FastifyInstance, deps: PageDeps): void {
  /**
   * The sparklines for a set of columns, over one shared history read.
   *
   * Its own try/catch, like every other input this app assembles: a failing
   * health query must dim the tiles, never take the page — let alone the
   * numbers next to it — down with it.
   */
  const tilesFor = (
    columns: readonly string[], now: Date,
  ): SeriesTile[] => {
    const out: SeriesTile[] = [];
    try {
      const to = isoDate(now, TZ);
      const from = isoDate(addDays(now, -TILE_DAYS + 1), TZ);
      const snaps: HealthSnapshot[] = deps.health.between(from, to);
      for (const column of columns) {
        const spec = SOROZATOK.get(column);
        if (spec === undefined) continue;
        const series = buildSeries(column, from, to, valuesFrom(snaps, column));
        out.push({ column, label: spec.label, days: TILE_DAYS, chart: sparkline(series, spec) });
      }
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "area page rendered without its tiles");
    }
    return out;
  };

  /** The aggregate, or nothing — never a thrown page. */
  const metricsOf = (): Metrics | null => {
    try {
      return deps.metrics();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "area page rendered without its metrics");
      return null;
    }
  };

  app.get("/terulet", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();

    let measuredDays = 0;
    try {
      const today = isoDate(now, TZ);
      measuredDays = deps.health.between("1970-01-01", today)
        .filter((s) => typeof s.dietKcal === "number").length;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "hub rendered without its nutrition count");
    }

    const summaryOf = (domain: string): { note: string; date: string | null } => {
      const hit = inputs.analyses.find((a) => a.domain === domain);
      return hit === undefined
        ? { note: "Még nem futott mélyelemzés.", date: null }
        : { note: hit.summary, date: hit.createdAt.slice(0, 10) };
    };

    const physical = summaryOf("physical");
    const recovery = summaryOf("recovery");
    const finance = summaryOf("finance");
    const latestMonth = m?.finance.months.at(-1);

    const cards: HubCard[] = [
      {
        href: "/terulet/terheles", title: "Terhelés",
        figure: m?.physical.loadRatio == null ? null : `${hu(m.physical.loadRatio, 2)}×`,
        note: physical.note, noteDate: physical.date,
      },
      {
        href: "/terulet/regeneracio", title: "Regeneráció",
        figure: m?.recovery.hrvDeviation == null
          ? null
          : `${m.recovery.hrvDeviation.sigma > 0 ? "+" : ""}${hu(m.recovery.hrvDeviation.sigma, 2)} σ`,
        note: recovery.note, noteDate: recovery.date,
      },
      {
        // No `nutrition` analysis domain exists yet (S8 will add one), so this
        // card carries a measured line of its own rather than an empty slot.
        href: "/terulet/taplalkozas", title: "Táplálkozás",
        figure: measuredDays === 0 ? null : `${hu(measuredDays)} nap`,
        note: "Rögzített bevitel.", noteDate: null,
      },
      {
        href: "/terulet/penzugy", title: "Pénzügy",
        figure: latestMonth === undefined ? null : huFt(latestMonth.totalHuf),
        note: finance.note, noteDate: finance.date,
      },
    ];

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, hubBody({
      synthesis: analysisFor(inputs.analyses, "synthesis"),
      cards,
    })));
  });

  app.get("/terulet/terheles", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();

    let byType: ReturnType<typeof deps.workouts.byType> = [];
    let recent: ReturnType<typeof deps.workouts.page>["rows"] = [];
    try {
      byType = deps.workouts.byType();
      recent = deps.workouts.page(0, 20).rows;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "load page rendered without its workouts");
    }

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, loadBody({
      loadRatio: m?.physical.loadRatio ?? null,
      strengthPerWeek28d: m?.physical.strengthPerWeek28d ?? null,
      byMonth: m?.physical.byMonth ?? [],
      byType,
      recent,
      tiles: tilesFor(["steps", "distance_km", "move_kcal", "exercise_min"], now),
      analysis: analysisFor(inputs.analyses, "physical"),
    })));
  });

  app.get<{ Querystring: { oldal?: string } }>(
    "/terulet/terheles/naplo", async (request, reply) => {
      const now = deps.clock.now();
      const inputs = await shellInputs(deps, now);

      let rows: ReturnType<typeof deps.workouts.page>["rows"] = [];
      let total = 0;
      let oldal = 1;
      try {
        total = deps.workouts.page(0, 1).total;
        oldal = parseOldal(request.query.oldal, total);
        rows = deps.workouts.page((oldal - 1) * OLDAL_MERET, OLDAL_MERET).rows;
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "worklog rendered without its rows");
      }

      return reply.type("text/html; charset=utf-8")
        .send(render("terulet", inputs, worklogBody(rows, oldal, total)));
    },
  );

  app.get("/terulet/regeneracio", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();
    const EMPTY = { value: null, n: 0, coverage: 0, window: "365d" };

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, recoveryBody({
      deviation: m?.recovery.hrvDeviation ?? null,
      sleepByYear: m?.recovery.sleepByYear ?? [],
      stages: m?.recovery.stages ?? { core: EMPTY, rem: EMPTY, deep: EMPTY },
      awakenings: m?.recovery.awakenings ?? EMPTY,
      tiles: tilesFor(["hrv", "rhr", "hr_recovery", "sleep_h"], now),
      analysis: analysisFor(inputs.analyses, "recovery"),
    })));
  });

  app.get("/terulet/taplalkozas", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);

    // The one figure on the five pages that does NOT come from aggregate():
    // `Metrics` has no nutrition branch yet, so the days are counted from the
    // same snapshot read main.ts performs for the aggregate anyway.
    let measuredDays = 0;
    let lastDate: string | null = null;
    let kcal: number | null = null;
    let proteinG: number | null = null;
    try {
      const today = isoDate(now, TZ);
      const rows = deps.health.between("1970-01-01", today)
        .filter((s) => typeof s.dietKcal === "number");
      measuredDays = rows.length;
      // `between` dátum szerint növekvő sorrendben ad vissza (ellenőrizve a
      // repository-ban), tehát az utolsó elem a legutóbbi mért nap.
      lastDate = rows.at(-1)?.date ?? null;
      if (rows.length > 0) {
        kcal = Math.round(rows.reduce((a, s) => a + (s.dietKcal ?? 0), 0) / rows.length);
        const withProtein = rows.filter((s) => typeof s.dietProteinG === "number");
        proteinG = withProtein.length === 0
          ? null
          : Math.round(withProtein.reduce((a, s) => a + (s.dietProteinG ?? 0), 0) / withProtein.length);
      }
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "nutrition page rendered without its intake");
    }

    let plan: ReturnType<typeof deps.meals.forWeekday> = [];
    try {
      // Seven reads of three rows each. `MealRepo` has no "all" method and
      // does not need one: 21 rows is cheaper than a new query and its test.
      plan = [0, 1, 2, 3, 4, 5, 6].flatMap((w) => deps.meals.forWeekday(w));
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "nutrition page rendered without its plan");
    }

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, nutritionBody({
      measuredDays, lastDate, actual: { kcal, proteinG }, plan,
      tiles: tilesFor(["diet_kcal", "diet_protein_g"], now),
    })));
  });

  app.get("/terulet/penzugy", async (_request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const m = metricsOf();

    let subscriptions: ReturnType<typeof deps.subscriptions.listAll> = [];
    try {
      subscriptions = deps.subscriptions.listAll();
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "finance page rendered without its subscriptions");
    }

    return reply.type("text/html; charset=utf-8").send(render("terulet", inputs, financeBody({
      months: m?.finance.months ?? [],
      monthOverMonth: m?.finance.monthOverMonth ?? null,
      annualisedHuf: m?.finance.annualisedHuf ?? null,
      minMonths: MIN_MONTHS_TO_ANNUALISE,
      subscriptions,
      today: isoDate(now, TZ),
      analysis: analysisFor(inputs.analyses, "finance"),
    })));
  });
}
```

- [ ] **Step 6: Futtasd az új teszteket**

Run: `npx vitest run test/delivery/area-routes.test.ts`
Expected: PASS mind a 12. Ha a `sleep_h` vagy a `hr_recovery` oszlop nem
szerepel a `SOROZATOK`-ban, a `tilesFor` csendben kihagyja — ellenőrizd a
`chart/registry.ts`-ben, és ha más a kulcs, javítsd a hívást.

- [ ] **Step 7: Igazítsd a meglévő teszteket**

Run: `npm test`

A `page.test.ts`-ben és a `server-auth.test.ts`-ben minden `/elemzes`-re és
`section: "elemzes"`-re menő állítás elavult. A KÖVETELMÉNY nem szűnik meg,
csak átköltözik:

- „az elemzés a dátumával jelenik meg" → a `area-routes.test.ts` már állítja a
  területi oldalakon; a `page.test.ts` megfelelő tesztjét töröld
- „a modell által írt tartalom escape-elve jelenik meg" → ugyanígy
- ha egy teszt a négy útvonal listáján megy végig, cseréld benne az
  `/elemzes`-t `/terulet`-re

Semmilyen állítást ne törölj anélkül, hogy meggyőződtél volna: ugyanaz a
követelmény máshol is ki van mondva.

- [ ] **Step 8: Futtasd a teljes suite-ot és a típusellenőrzést**

Run: `npm test && npx tsc --noEmit`
Expected: minden zöld, `tsc` néma

- [ ] **Step 9: Mutációs ellenőrzés**

A `page-shell.ts`-ben cseréld a `terulet:` lámpa kifejezését erre:
`terulet: analyses.length > 0,`, és futtasd újra.
Expected: FAIL — „a Terület jelzője kialszik, ha az elemzés hét napnál
régebbi". Állítsd vissza.

A `areas.ts`-ben cseréld az `analysisFor` visszatérését erre:
`return rows[0] === undefined ? undefined : { markdown: rows[0].markdown, createdAt: rows[0].createdAt };`
és futtasd újra. Expected: FAIL — „a hub az Összegzést mutatja, a területek a
sajátjukat". Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: hat területi útvonal, és az /elemzes feloldása"
```

---

## Önátnézés

**Spec-lefedettség.** Végigmenve a spec szakaszain:

| Spec-szakasz | Feladat |
|---|---|
| Útvonalak (hat új) | Task 12 |
| Navigáció, Terület jelző, almenü | Task 4 (jelző logikája: Task 12 Step 3) |
| Négy közös sáv | Task 5 |
| Hub | Task 10, Task 12 |
| Terhelés | Task 6, Task 12 |
| Edzésnapló | Task 11, Task 12 |
| Regeneráció | Task 7, Task 12 |
| Táplálkozás | Task 8, Task 12 |
| Pénzügy | Task 9, Task 12 |
| Havi oszlopdiagram, kétféle üres | Task 1 |
| Fájlszerkezet | Task 1, 5–12 |
| `PageDeps.metrics`, három új repo | Task 3 |
| `page.ts` szétbontása | Task 12 (`page-shell.ts`) |
| `WorkoutRepo.byType()`, `page()` | Task 2 |
| Hibatűrés (darabonkénti try/catch) | Task 12 |
| Ellenőrzés: jogosultság, `bars`, lapozó, hiány-szabályok, menü | Task 1, 4, 11, 12 |

Nincs lefedetlen spec-követelmény.

**Amit a terv szándékosan másképp old meg, mint a spec betűje.** A spec az
„erősítő alkalmak száma külön sorban a hónap alatt" megfogalmazást használja;
a Task 6 ezt a havi diagram alatti egyetlen mondattá teszi
(`strengthPerWeek28d`, a 28 napos ablakból), mert a `byMonth.strength`
havonkénti kiírása 56 számot jelentene a diagram alatt, ami nem sor, hanem
második tábla. A követelmény — az erősítés mennyisége látszódjon a diagram
mellett, ne külön diagramon — teljesül.

**Sorrendfüggőség.** A Task 4 után a `npm test` szándékosan bukik (a
`routes/page.ts` még `"elemzes"` szekciót ad meg), és a Task 12 zárja. A
Task 5–11 mind tiszta view-modul, egymástól függetlenül tesztelhető, és
egyikük sem érinti a `page.ts`-t.
