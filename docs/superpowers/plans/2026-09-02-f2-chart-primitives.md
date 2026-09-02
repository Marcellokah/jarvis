# F2 diagram-alapkészlet — implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kézzel írt SVG-diagramok, amik nem húznak vonalat olyan napokon át, amikről nincs adat — sparkline a Számok oldal minden mérés-sorába, és egy nagy nézet mérésenként.

**Architecture:** Két tiszta modul (`series.ts`, `buckets.ts`) végzi a döntéseket — hol törik a vonal, mi kerül egy pixeloszlopba —, és két renderelő (`sparkline.ts`, `plot.ts`) csinál belőlük SVG-t. A `registry.ts` mondja meg, melyik oszlopból lehet diagram. Nincs kliensoldali JS: a hover-olvasó tiszta CSS, a tartományválasztó sima link.

**Tech Stack:** Node ≥ 24 (`.ts` közvetlenül), Fastify 5, vitest. Nincs diagram-könyvtár, nincs build lépés.

**Spec:** `docs/superpowers/specs/2026-09-02-f2-chart-primitives-design.md`

## Global Constraints

- Node ≥ 24, nincs build lépés, minden relatív import `.ts` kiterjesztéssel.
- **Nincs új futásidejű függőség, és a diagramokhoz nincs kliensoldali JS.**
- `npm run typecheck` tiszta, `npm test` teljesen zöld minden feladat végén.
- Felhasználónak szóló szöveg **magyarul**, kódkommentek **angolul**, és a WHY-t magyarázzák.
- A tesztek hálózat nélkül futnak, nem írnak a `./data/jarvis.db`-be, nem nyúlnak a launchd ügynökhöz, nem indítanak szervert a 8787-es porton.
- Szín: `--jel` **kizárólag** mért adat, `--vaz` **soha** nem adat, `--racs` a hiány és a chrome, `--riado` **nem jelenik meg diagramon**.
- Ami nincs mérve, az nem animálódik.
- Minden commit utolsó sora: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Fájlszerkezet

| Fájl | Felelőssége |
|---|---|
| `src/delivery/http/view/chart/series.ts` | pontok → törésküszöb, szakaszok, hézagok, tartomány |
| `src/delivery/http/view/chart/buckets.ts` | pixeloszlopokba sűrítés min/max/mediánnal |
| `src/delivery/http/view/chart/registry.ts` | `SOROZATOK`: mely oszlopból lehet diagram, milyen néven |
| `src/delivery/http/view/chart/sparkline.ts` | a kicsi, tengely nélküli diagram |
| `src/delivery/http/view/chart/plot.ts` | a nagy nézet: tengelyek, hézagsávok, sáv, olvasó |
| `src/delivery/http/view/numbers.ts` | `MetricRow.series`, sparkline és link a sorban |
| `src/delivery/http/view/theme.ts` | a diagramok stílusa |
| `src/delivery/http/routes/page.ts` | `/szamok` sorozat-adata és a `/szamok/:metrika` útvonal |

---

### Task 1: `chart/series.ts` — hol törik a vonal

**Files:**
- Create: `src/delivery/http/view/chart/series.ts`
- Test: `test/delivery/chart-series.test.ts`

**Interfaces:**
- Produces:
  - `interface Point { date: string; day: number; value: number }`
  - `interface Gap { fromDate: string; toDate: string; days: number }`
  - `interface Series { column: string; from: string; to: string; fromDay: number; toDay: number; points: Point[]; segments: Point[][]; gaps: Gap[]; medianGapDays: number; breakThreshold: number; min: number; max: number; totalDays: number; coverage: number }`
  - `function dayNumber(isoDate: string): number`
  - `function buildSeries(column: string, from: string, to: string, values: readonly { date: string; value: number | null }[]): Series`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/chart-series.test.ts
import { describe, it, expect } from "vitest";
import { buildSeries, dayNumber } from "../../src/delivery/http/view/chart/series.ts";

/** Napok listája dátum→érték párokká, `null` = nem mért nap. */
const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("sorozat", () => {
  it("a törésküszöb a mediánból jön, nem az átlagból", () => {
    // Napi ritmus egyetlen nagy lyukkal. Az átlagos hézag ~4 nap lenne, a
    // medián 1 — és a küszöbnek a tipikus ritmust kell leírnia, különben egy
    // szakadás elhitetné, hogy a szakadás maga normális.
    const v = days("2026-01-01", 1, 2, 3, 4, 5, ...new Array(20).fill(null), 6, 7, 8);
    const s = buildSeries("steps", "2026-01-01", "2026-01-28", v);
    expect(s.medianGapDays).toBe(1);
    expect(s.breakThreshold).toBe(3);
  });

  it("a küszöbnél nagyobb hézag megtöri a vonalat", () => {
    // A pár első fele.
    const v = days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5);
    const s = buildSeries("steps", "2026-01-01", "2026-01-09", v);
    expect(s.segments).toHaveLength(2);
    expect(s.segments[0]!.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(s.segments[1]!.map((p) => p.value)).toEqual([4, 5]);
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]).toMatchObject({ fromDate: "2026-01-03", toDate: "2026-01-08", days: 5 });
  });

  it("a küszöbnél kisebb hézag nem töri meg", () => {
    // A pár másik fele. Külön-külön mindkettő átmegy egy olyan
    // implementáción, ami a küszöböt figyelmen kívül hagyja — együtt nem.
    const v = days("2026-01-01", 1, 2, null, 3, 4);
    const s = buildSeries("steps", "2026-01-01", "2026-01-05", v);
    expect(s.segments).toHaveLength(1);
    expect(s.gaps).toEqual([]);
  });

  it("kétnapos ritmusnál a hatnapos lyuk a hír", () => {
    // A valódi HRV-alak: minden második nap mérés, a mért legnagyobb hézag 6.
    const v = days("2026-01-01", 1, null, 2, null, 3, null, null, null, null, null, 4);
    const s = buildSeries("hrv", "2026-01-01", "2026-01-11", v);
    expect(s.medianGapDays).toBe(2);
    expect(s.breakThreshold).toBe(6);
    expect(s.segments).toHaveLength(2);
  });

  it("nulla pontnál nincs se vonal, se kivétel", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", null, null, null, null, null));
    expect(s.points).toEqual([]);
    expect(s.segments).toEqual([]);
    expect(s.coverage).toBe(0);
  });

  it("egyetlen pontnál pont van, vonal nincs", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", null, 42, null, null, null));
    expect(s.points).toHaveLength(1);
    expect(s.segments).toEqual([[expect.objectContaining({ value: 42 })]]);
    expect(s.medianGapDays).toBe(0);
  });

  it("a lefedettséget a kért ablakhoz méri, nem a pontokhoz", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-10", days("2026-01-01", 1, 2, null, null, null, null, null, null, null, null));
    expect(s.totalDays).toBe(10);
    expect(s.coverage).toBeCloseTo(0.2, 5);
  });
});
```

- [ ] **Step 2: Futtasd, és győződj meg róla, hogy bukik**

Run: `npx vitest run test/delivery/chart-series.test.ts`
Expected: FAIL — `Failed to resolve import ".../chart/series.ts"`

- [ ] **Step 3: Írd meg az implementációt**

```ts
// src/delivery/http/view/chart/series.ts

export interface Point { date: string; day: number; value: number }

/** An unusual hole: the two measured days it sits between, and its length. */
export interface Gap { fromDate: string; toDate: string; days: number }

export interface Series {
  column: string;
  /** The requested window, which the x axis spans — not the points' own span. */
  from: string; to: string; fromDay: number; toDay: number;
  points: Point[];
  /** Runs of points close enough to be connected by a line. */
  segments: Point[][];
  gaps: Gap[];
  medianGapDays: number;
  breakThreshold: number;
  min: number; max: number;
  totalDays: number;
  coverage: number;
}

/** Days since the epoch. ISO dates are exact here — no timezone enters. */
export function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
}

/**
 * A series knows where its own line may be drawn.
 *
 * No chart may draw through days it has no data for: every library
 * interpolates, and on this owner's history that turns a measured 35-day hole
 * in the step count into a smooth rise that never happened — the confidently
 * wrong number this whole system exists to prevent, in a picture.
 *
 * The break threshold comes from the series' OWN median gap rather than a
 * fixed number of days, because the two shapes in this history need different
 * answers: HRV is measured every other day, so a six-day hole is the news,
 * while steps are daily, so three days already is. A median and not a mean,
 * because one 35-day hole drags a mean far enough to make the hole itself look
 * normal. The LOWER median on an even count, because erring toward a smaller
 * threshold errs toward breaking the line — toward drawing less rather than
 * inventing more.
 */
export function buildSeries(
  column: string, from: string, to: string,
  values: readonly { date: string; value: number | null }[],
): Series {
  const fromDay = dayNumber(from);
  const toDay = dayNumber(to);
  const totalDays = toDay - fromDay + 1;

  const points: Point[] = values
    .filter((v): v is { date: string; value: number } => v.value !== null)
    .map((v) => ({ date: v.date, day: dayNumber(v.date), value: v.value }))
    .sort((a, b) => a.day - b.day);

  const gapsBetween = points.slice(1).map((p, i) => p.day - points[i]!.day);
  const sorted = [...gapsBetween].sort((a, b) => a - b);
  const medianGapDays = sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;
  const breakThreshold = medianGapDays * 3;

  const segments: Point[][] = [];
  const gaps: Gap[] = [];
  for (const [i, p] of points.entries()) {
    const prev = points[i - 1];
    if (prev === undefined || p.day - prev.day >= breakThreshold) {
      if (prev !== undefined) {
        gaps.push({ fromDate: prev.date, toDate: p.date, days: p.day - prev.day });
      }
      segments.push([p]);
    } else {
      segments.at(-1)!.push(p);
    }
  }

  const vals = points.map((p) => p.value);
  return {
    column, from, to, fromDay, toDay,
    points, segments, gaps, medianGapDays, breakThreshold,
    min: vals.length === 0 ? 0 : Math.min(...vals),
    max: vals.length === 0 ? 0 : Math.max(...vals),
    totalDays,
    coverage: totalDays === 0 ? 0 : points.length / totalDays,
  };
}
```

- [ ] **Step 4: Futtasd, és győződj meg róla, hogy átmegy**

Run: `npx vitest run test/delivery/chart-series.test.ts`
Expected: PASS (7 teszt)

- [ ] **Step 5: Ellenőrizd, hogy a tesztek fognak**

Rontsd el egyesével, futtass, majd állítsd vissza:
1. `medianGapDays` helyett átlag (`sorted.reduce((a,b)=>a+b,0)/sorted.length`) — az első teszt bukjon.
2. `p.day - prev.day >= breakThreshold` → `false` — a törés-teszt bukjon.
3. `p.day - prev.day >= breakThreshold` → `p.day - prev.day > 1` — a „nem töri meg" teszt bukjon.
4. `sorted[Math.floor(sorted.length / 2)]` (felső medián) — a kétnapos ritmus tesztje bukjon (5 hézagból a felső medián 2 helyett más lenne).

Ha egy mutáció után minden teszt átmegy, a teszt nem fog — javítsd, mielőtt továbbmész.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/chart/series.ts test/delivery/chart-series.test.ts
git commit -m "$(printf 'feat: a sorozat tudja, hol szabad vonalat húznia\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 2: `chart/buckets.ts` — pixeloszlopokba sűrítés

**Files:**
- Create: `src/delivery/http/view/chart/buckets.ts`
- Test: `test/delivery/chart-buckets.test.ts`

**Interfaces:**
- Consumes: `Series`, `Point` (Task 1).
- Produces:
  - `interface Bucket { min: number; max: number; median: number; n: number }`
  - `function bucketise(series: Series, columns: number): (Bucket | null)[]`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/chart-buckets.test.ts
import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { bucketise } from "../../src/delivery/http/view/chart/buckets.ts";

const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("sűrítés", () => {
  it("az üres oszlop üres marad, nem örökli a szomszédját", () => {
    // Ez a sűrítés egyetlen tilalma: ahol nem mértünk, ott nem lehet érték.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-04", days("2026-01-01", 10, null, null, 20));
    const b = bucketise(s, 4);
    expect(b).toHaveLength(4);
    expect(b[0]).toMatchObject({ min: 10, max: 10, n: 1 });
    expect(b[1]).toBeNull();
    expect(b[2]).toBeNull();
    expect(b[3]).toMatchObject({ min: 20, max: 20, n: 1 });
  });

  it("a kiugrás nem tűnik el a sűrítésben", () => {
    // Ezért min-max sáv és nem átlag: egy évnyi adatban egyetlen 200-as nap
    // átlagolva nyomtalanul eltűnne.
    const vals = new Array(40).fill(50);
    vals[17] = 200;
    const s = buildSeries("hrv", "2026-01-01", "2026-02-09", days("2026-01-01", ...vals));
    const b = bucketise(s, 4);
    expect(b.some((x) => x !== null && x.max === 200)).toBe(true);
  });

  it("egy oszlop min-maxa a benne lévő valódi pontokból jön", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-04", days("2026-01-01", 10, 30, 20, 40));
    const b = bucketise(s, 2);
    expect(b[0]).toMatchObject({ min: 10, max: 30, median: 10, n: 2 });
    expect(b[1]).toMatchObject({ min: 20, max: 40, median: 20, n: 2 });
  });

  it("nulla pontnál minden oszlop üres", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-03", days("2026-01-01", null, null, null));
    expect(bucketise(s, 3)).toEqual([null, null, null]);
  });

  it("egyetlen napos ablakot sem oszt el nullával", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-01", days("2026-01-01", 42));
    const b = bucketise(s, 5);
    expect(b.filter((x) => x !== null)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Futtasd** — FAIL, nem oldható fel az import.

- [ ] **Step 3: Írd meg az implementációt**

```ts
// src/delivery/http/view/chart/buckets.ts
import type { Series } from "./series.ts";

export interface Bucket { min: number; max: number; median: number; n: number }

/**
 * A pixel column's worth of measurements — its range, not its average.
 *
 * 2718 points on an 800-pixel chart is 3.4 points per pixel: pointless detail
 * and 30-40 KB of path data. But averaging is not the answer. An average hides
 * the spikes — one 200 ms HRV night in a year of 50s vanishes without trace —
 * and averaging ACROSS a hole invents a number for days that were never
 * measured. A min-max band with the median inside shows what actually
 * happened, spread included, and invents nothing.
 *
 * A column no measurement falls into stays `null`. It must never inherit its
 * neighbour: that is the same lie as interpolating, one pixel wide.
 */
export function bucketise(series: Series, columns: number): (Bucket | null)[] {
  const out: (Bucket | null)[] = new Array(columns).fill(null);
  if (columns <= 0 || series.points.length === 0) return out;

  const span = series.toDay - series.fromDay;
  const collected: number[][] = Array.from({ length: columns }, () => []);

  for (const p of series.points) {
    // A single-day window has no span to divide by; everything lands in the
    // first column rather than in a NaN one.
    const t = span === 0 ? 0 : (p.day - series.fromDay) / span;
    const i = Math.min(columns - 1, Math.max(0, Math.floor(t * columns)));
    collected[i]!.push(p.value);
  }

  for (const [i, vals] of collected.entries()) {
    if (vals.length === 0) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    out[i] = {
      min: sorted[0]!,
      max: sorted.at(-1)!,
      median: sorted[Math.floor((sorted.length - 1) / 2)]!,
      n: vals.length,
    };
  }
  return out;
}
```

- [ ] **Step 4: Futtasd** — PASS (5 teszt).

- [ ] **Step 5: Ellenőrizd, hogy a tesztek fognak**

1. Töltsd ki az üres oszlopot az előzővel (`out[i] = out[i-1]`) — az első teszt bukjon.
2. `min`/`max` helyett átlag mindkettőnek — a kiugrás-teszt bukjon.
3. Cseréld a `span === 0 ? 0 : (p.day - series.fromDay) / span` kifejezést a védelem nélküli
   `(p.day - series.fromDay) / span`-ra — az egynapos teszt bukjon (0/0 = NaN index).

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/chart/buckets.ts test/delivery/chart-buckets.test.ts
git commit -m "$(printf 'feat: pixeloszlop min-max sávja, sosem átlag\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 3: `chart/registry.ts` — miből lehet diagram

**Files:**
- Create: `src/delivery/http/view/chart/registry.ts`
- Test: `test/delivery/chart-registry.test.ts`

**Interfaces:**
- Consumes: `HealthSnapshot` és `SNAPSHOT_FIELDS` a `src/infra/db/repositories/health.ts`-ből (mindkettő exportált; a `SNAPSHOT_FIELDS` `[oszlop, mező]` párok listája).
- Produces:
  - `interface SeriesSpec { column: string; label: string; unit: string; zeroBased: boolean; format: (v: number) => string }`
  - `const SOROZATOK: ReadonlyMap<string, SeriesSpec>`
  - `function valuesFrom(snapshots: readonly HealthSnapshot[], column: string): { date: string; value: number | null }[]`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/chart-registry.test.ts
import { describe, it, expect } from "vitest";
import { SOROZATOK, valuesFrom } from "../../src/delivery/http/view/chart/registry.ts";
import { HISTORY_COLUMNS } from "../../src/infra/db/repositories/health.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

describe("sorozat-regiszter", () => {
  it("minden bejegyzés valódi történet-oszlopra mutat", () => {
    // Egy diagram, aminek nincs oszlopa, üres marad örökre — jobb, ha a
    // regiszter maga nem tud ilyet tartalmazni.
    for (const column of SOROZATOK.keys()) {
      expect(HISTORY_COLUMNS.has(column), column).toBe(true);
    }
  });

  it("a számlálók nulláról indulnak, a mérések nem", () => {
    // Nem ízlés: a nulla lépés valódi érték és az arányok számítanak, a nulla
    // HRV viszont fizikailag értelmetlen, és egy nulla-alapú tengely a teljes
    // ingadozást egy hajszálvonalba lapítaná.
    expect(SOROZATOK.get("steps")!.zeroBased).toBe(true);
    expect(SOROZATOK.get("move_kcal")!.zeroBased).toBe(true);
    expect(SOROZATOK.get("hrv")!.zeroBased).toBe(false);
    expect(SOROZATOK.get("rhr")!.zeroBased).toBe(false);
    expect(SOROZATOK.get("vo2max")!.zeroBased).toBe(false);
  });

  it("a pillanatképekből a helyes mezőt olvassa ki", () => {
    const snaps = [
      { date: "2026-01-01", hrv: 61.2, steps: 9000 },
      { date: "2026-01-02", hrv: null, steps: 0 },
    ] as unknown as HealthSnapshot[];

    expect(valuesFrom(snaps, "hrv")).toEqual([
      { date: "2026-01-01", value: 61.2 },
      { date: "2026-01-02", value: null },
    ]);
    // A mért nulla valódi mérés, nem hiány.
    expect(valuesFrom(snaps, "steps")[1]).toEqual({ date: "2026-01-02", value: 0 });
  });

  it("ismeretlen oszlopra üres listát ad, nem hibázik", () => {
    expect(valuesFrom([], "nincs_ilyen")).toEqual([]);
  });
});
```

- [ ] **Step 2: Futtasd** — FAIL.

- [ ] **Step 3: Írd meg az implementációt**

```ts
// src/delivery/http/view/chart/registry.ts
import {
  SNAPSHOT_FIELDS, type HealthSnapshot,
} from "../../../../infra/db/repositories/health.ts";

export interface SeriesSpec {
  column: string;
  label: string;
  unit: string;
  /**
   * Whether the y axis starts at zero.
   *
   * Not a matter of taste. A COUNTER — steps, calories, minutes, distance —
   * starts at zero because zero is a real value there and the proportions are
   * the story. A MEASUREMENT — HRV, resting heart rate, VO2max, walking speed
   * — uses the data's own range, because zero is physically meaningless for it
   * and a zero-based axis would flatten the entire variation into a hairline.
   */
  zeroBased: boolean;
  format: (v: number) => string;
}

const hu = (n: number, digits = 0) =>
  n.toLocaleString("hu-HU", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true })
    .replace(/ /g, " ");

const spec = (
  column: string, label: string, unit: string, zeroBased: boolean, digits = 0,
): [string, SeriesSpec] => [
  column,
  { column, label, unit, zeroBased, format: (v) => `${hu(v, digits)}${unit ? ` ${unit}` : ""}` },
];

/** Only a column with a real daily history can carry a chart. */
export const SOROZATOK: ReadonlyMap<string, SeriesSpec> = new Map([
  spec("hrv", "HRV", "ms", false, 1),
  spec("rhr", "Nyugalmi pulzus", "bpm", false),
  spec("vo2max", "VO2max", "", false, 1),
  spec("hr_recovery", "Pulzus-visszatérés", "bpm", false),
  spec("asleep_min", "Alvás", "perc", true),
  spec("sleep_h", "Alvás", "óra", true, 1),
  spec("awakenings", "Ébredés", "", true),
  spec("steps", "Lépés", "lépés", true),
  spec("distance_km", "Táv", "km", true, 2),
  spec("move_kcal", "Aktív kalória", "kcal", true),
  spec("basal_kcal", "Alapanyagcsere", "kcal", true),
  spec("exercise_min", "Mozgás", "perc", true),
  spec("diet_kcal", "Bevitt kalória", "kcal", true),
  spec("diet_protein_g", "Fehérje", "g", true),
  spec("walking_speed", "Járássebesség", "km/h", false, 2),
  spec("step_length_cm", "Lépéshossz", "cm", false),
  spec("six_min_walk_m", "Hatperces séta", "m", false),
  spec("steadiness_pct", "Járásstabilitás", "%", false),
]);

const FIELD = new Map(SNAPSHOT_FIELDS.map(([column, field]) => [column, field]));

/** The snapshot rows for one column, keeping a measured zero as a measurement. */
export function valuesFrom(
  snapshots: readonly HealthSnapshot[], column: string,
): { date: string; value: number | null }[] {
  const field = FIELD.get(column);
  if (field === undefined) return [];
  return snapshots.map((s) => {
    const raw = s[field];
    return { date: s.date, value: typeof raw === "number" ? raw : null };
  });
}
```

- [ ] **Step 4: Futtasd** — PASS (4 teszt).

- [ ] **Step 5: Ellenőrizd** — állítsd `zeroBased: true`-ra a `hrv`-t: a második teszt bukjon. Add hozzá a regiszterhez a `spec("nincs_ilyen", "X", "", true)` sort: az első teszt bukjon.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/chart/registry.ts test/delivery/chart-registry.test.ts
git commit -m "$(printf 'feat: sorozat-regiszter, nulla-alappal ahol a nulla valódi\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 4: `chart/sparkline.ts` — a kicsi diagram

**Files:**
- Create: `src/delivery/http/view/chart/sparkline.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/chart-sparkline.test.ts`

**Interfaces:**
- Consumes: `Series` (Task 1), `SeriesSpec` (Task 3).
- Produces: `function sparkline(series: Series, spec: SeriesSpec): string`

A `theme.ts` `STYLE` sztringje egy blokkal bővül. Az új szabályok:

```css
/* ---- diagram ---- */
.spark { display: block; overflow: visible; }
.spark path { fill: none; stroke: var(--jel); stroke-width: 1.25; stroke-linecap: round; }
.spark circle { fill: var(--jel); }
.spark.ures { opacity: .35; }
@keyframes vonal-be { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
.spark path { stroke-dasharray: 1; stroke-dashoffset: 0; pathLength: 1;
  animation: vonal-be .7s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(320ms + var(--i, 0) * 45ms); }
@media (prefers-reduced-motion: reduce) { .spark path { animation: none; } }
```

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/chart-sparkline.test.ts
import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { sparkline } from "../../src/delivery/http/view/chart/sparkline.ts";
import { SOROZATOK } from "../../src/delivery/http/view/chart/registry.ts";

const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

const hrv = SOROZATOK.get("hrv")!;

describe("sparkline", () => {
  it("szakaszonként külön útvonalat rajzol, nem köt át a hézagon", () => {
    // Ez a diagram egyetlen ígérete: a hézag fölött nincs vonal.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-09", days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5));
    const svg = sparkline(s, hrv);
    expect((svg.match(/<path /g) ?? [])).toHaveLength(2);
  });

  it("egyetlen pontból pontot rajzol, útvonalat nem", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", null, 42, null, null, null));
    const svg = sparkline(s, hrv);
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("<path");
  });

  it("mérés nélkül üres, de nem hibázik", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-03", days("2026-01-01", null, null, null));
    const svg = sparkline(s, hrv);
    expect(svg).toContain('class="spark ures"');
    expect(svg).not.toContain("<path");
    expect(svg).not.toContain("NaN");
  });

  it("szavakban is elmondja, amit a kép", () => {
    // Egy diagram, amit nem lehet elolvasni, nem információ.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 40, 50, null, null, 60));
    const svg = sparkline(s, hrv);
    expect(svg).toMatch(/<title>[^<]*3 mérés[^<]*<\/title>/);
    expect(svg).toContain("60%");
  });

  it("nem használ riasztó színt", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-02", days("2026-01-01", 1, 2));
    expect(sparkline(s, hrv)).not.toContain("--riado");
  });
});
```

- [ ] **Step 2: Futtasd** — FAIL.

- [ ] **Step 3: Írd meg az implementációt**

```ts
// src/delivery/http/view/chart/sparkline.ts
import { escapeHtml } from "../../markdown.ts";
import type { Series, Point } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

const W = 60;
const H = 18;
const PAD = 1.5;

/**
 * The small chart: direction at a glance, no axes, no interaction.
 *
 * One `<path>` per segment, never one for the whole series — a hole this
 * owner's history really contains (35 days without a step count) must read as
 * a hole, not as a smooth rise through days nobody measured. There is no gap
 * band here as there is in the large view: on sixty pixels a band would be
 * noise rather than information, so the line simply stops.
 */
export function sparkline(series: Series, spec: SeriesSpec): string {
  const summary = escapeHtml(
    `${spec.label}: ${series.points.length} mérés, `
    + `${Math.floor(series.coverage * 100)}% lefedettség`
    + (series.points.length === 0 ? "" : `, ${spec.format(series.min)}–${spec.format(series.max)}`),
  );

  const open = (cls: string) =>
    `<svg class="${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
    + `role="img" aria-label="${summary}"><title>${summary}</title>`;

  if (series.points.length === 0) return `${open("spark ures")}</svg>`;

  const span = series.toDay - series.fromDay;
  const lo = spec.zeroBased ? Math.min(0, series.min) : series.min;
  const hi = series.max;
  const range = hi - lo;

  const x = (p: Point) => span === 0 ? W / 2 : PAD + ((p.day - series.fromDay) / span) * (W - 2 * PAD);
  // A flat series sits on the midline rather than dividing by zero.
  const y = (p: Point) => range === 0 ? H / 2 : H - PAD - ((p.value - lo) / range) * (H - 2 * PAD);
  const n = (v: number) => Math.round(v * 100) / 100;

  const body = series.segments.map((seg) => {
    if (seg.length === 1) return `<circle cx="${n(x(seg[0]!))}" cy="${n(y(seg[0]!))}" r="1.4"/>`;
    const d = seg.map((p, i) => `${i === 0 ? "M" : "L"}${n(x(p))} ${n(y(p))}`).join(" ");
    return `<path d="${d}"/>`;
  }).join("");

  return `${open("spark")}${body}</svg>`;
}
```

- [ ] **Step 4: Futtasd** — PASS (5 teszt).

- [ ] **Step 5: Ellenőrizd** — rajzolj egyetlen útvonalat az összes pontból (`series.points` a `segments` helyett): az első teszt bukjon. Vedd ki a `<title>`-t: a negyedik bukjon.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/chart/sparkline.ts src/delivery/http/view/theme.ts test/delivery/chart-sparkline.test.ts
git commit -m "$(printf 'feat: sparkline, szakaszonként külön útvonallal\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 5: A Számok oldal sparkline-jai és linkjei

**Files:**
- Modify: `src/delivery/http/view/numbers.ts`, `src/delivery/http/routes/page.ts`, `src/main.ts`
- Test: `test/delivery/page.test.ts`, `test/delivery/view-numbers.test.ts`

**Interfaces:**
- Consumes: `sparkline` (Task 4), `SOROZATOK`, `valuesFrom` (Task 3), `buildSeries` (Task 1).
- Produces:
  - `MetricRow` bővül: `series: { column: string; days: number } | null`
  - `readout(r: MetricRow, i: number, chart: string)` — a harmadik paraméter a kész SVG vagy üres sztring
  - `numbersBody(rows: readonly MetricRow[], charts: ReadonlyMap<string, string>)` — kulcs a `label`

**A `readout` szignatúrája bővül, tehát a meglévő hívói is.** A
`test/delivery/view-numbers.test.ts` négy helyen hívja `readout(row, 0)`
alakban (13., 19., 27. és 36. sor); ezek `readout(row, 0, "")` lesznek, és az
**állításaik változatlanok maradnak** — a sáv és a halott csatorna viselkedése
nem ez a feladat. Ha egy állítást módosítanod kell ahhoz, hogy átmenjen, állj
meg és szólj: az azt jelenti, hogy a változtatás elrontott valamit.

A `metricsRowsFrom` minden sorához beírja a `series` mezőt: `row("Lépés (7 nap)", m.physical.steps.d7)` → `{ column: "steps", days: 7 }`. Az ablak nélküli sorok (terhelési arány, trendek, előfizetések) `null`-t kapnak.

A route egyszer kéri le a leghosszabb szükséges ablakot, és soronként
szeleteli. Az `addDays` és az `isoDate` a `src/shared/dates.ts`-ből jön, a
`TZ`-vel együtt; a `between` a `deps.health` repositoryn már megvan.

```ts
// /szamok kezelőjében, a metricsRows try-ja után
const charts = new Map<string, string>();
try {
  const to = isoDate(now, TZ);
  const longest = Math.max(0, ...metricsRows.map((r) => r.series?.days ?? 0));
  if (longest > 0) {
    const snaps = deps.health.between(isoDate(addDays(now, -longest + 1), TZ), to);
    for (const r of metricsRows) {
      if (r.series === null) continue;
      const spec = SOROZATOK.get(r.series.column);
      if (spec === undefined) continue;
      const from = isoDate(addDays(now, -r.series.days + 1), TZ);
      const window = snaps.filter((s) => s.date >= from);
      charts.set(r.label, sparkline(buildSeries(r.series.column, from, to, valuesFrom(window, r.series.column)), spec));
    }
  }
} catch (err) {
  deps.logger.warn({ err: String(err) }, "page rendered without its sparklines");
}
```

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/view-numbers.test.ts
it("sorozat nélküli sor nem kap sem sparkline-t, sem linket", () => {
  // A terhelési arány két ablak hányadosa: nincs egyetlen oszlopa, amit ki
  // lehetne rajzolni, és egy link a semmibe vinne.
  const html = numbersBody(
    [{ label: "Terhelési arány", value: "1,41", detail: "28/365", coverage: null, series: null }],
    new Map(),
  );
  expect(html).not.toContain("<svg");
  expect(html).not.toContain("<a ");
});

it("sorozattal rendelkező sor linkel a részletoldalra", () => {
  const html = numbersBody(
    [{ label: "Lépés (7 nap)", value: "9 283", detail: "6 nap", coverage: 6 / 7, series: { column: "steps", days: 7 } }],
    new Map([["Lépés (7 nap)", "<svg class=\"spark\"></svg>"]]),
  );
  expect(html).toContain('href="/szamok/steps?tart=7"');
  expect(html).toContain('class="spark"');
});
```

```ts
// test/delivery/page.test.ts, a "page routes" blokkban
it("a Számok oldal sparkline-t rajzol a mért sorokhoz", async () => {
  const a = await boot();
  a.health.upsert({ ...emptySnapshot("2026-09-01"), steps: 9000 }, {}, new Date("2026-09-01T20:00:00Z"));
  const res = await a.server.inject({
    method: "GET", url: "/szamok", headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.body).toContain('class="spark');
  await a.close();
});
```

Az `emptySnapshot` segédfüggvényt a `test/delivery/page.test.ts` már használt mintája szerint írd meg (minden mező `null`, `date` és `ingestedAt` megadva), vagy emeld ki a `test/helpers.ts`-be, ha ott már van hasonló.

- [ ] **Step 2: Futtasd** — FAIL: a `series` mező nem létezik, a `numbersBody` egy paramétert vár.

- [ ] **Step 3: Írd meg az implementációt** — a `MetricRow` bővítése, a `readout` harmadik paramétere, a `numbersBody` második paramétere, a `metricsRowsFrom` `series` mezői, és a route fenti blokkja. A `readout` a címkét linkké teszi, ha van `series`:

```ts
const label = r.series === null
  ? escapeHtml(r.label)
  : `<a href="/szamok/${encodeURIComponent(r.series.column)}?tart=${r.series.days}">${escapeHtml(r.label)}</a>`;
```

- [ ] **Step 4: Futtasd** — PASS.

- [ ] **Step 5: Ellenőrizd** — adj `series`-t a „Terhelési arány" sornak: az első teszt bukjon.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/numbers.ts src/delivery/http/routes/page.ts src/main.ts test/delivery/view-numbers.test.ts test/delivery/page.test.ts
git commit -m "$(printf 'feat: sparkline és részletoldal-link a Számok sorain\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 6: `chart/plot.ts` — a nagy nézet

**Files:**
- Create: `src/delivery/http/view/chart/plot.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/chart-plot.test.ts`

**Interfaces:**
- Consumes: `Series`, `Point` (Task 1), `bucketise`, `Bucket` (Task 2), `SeriesSpec` (Task 3).
- Produces: `function plot(series: Series, spec: SeriesSpec): string`

A diagram 720×260, bal oldalon 52 pixel tengelyhely, alul 22. Az oszlopszám a rajzterület szélessége egészre kerekítve.

**Rajzolási sorrend, és miért:** hézagsávok → rács → min–max sáv → mediánvonal / szakaszok → olvasó-célpontok. A hézagsáv leghátul van, mert háttér; az olvasó-célpontok legelöl, mert azokra kell rákerülni.

**Az olvasó JS nélkül.** Minden oszlop kap egy láthatatlan, teljes magasságú `<rect tabindex="0">`-t, utána egy `<g class="olvaso">` a szöveggel. A CSS:

```css
/* ---- nagy diagram ---- */
.plot { display: block; width: 100%; height: auto; }
.plot .racs { stroke: var(--vaz); stroke-width: .5; opacity: .35; }
.plot .tengely { fill: var(--vaz); font: .62rem var(--mono); }
.plot .hezag { fill: var(--racs); }
.plot .sav { fill: var(--jel); opacity: .28; }
.plot .vonal { fill: none; stroke: var(--jel); stroke-width: 1.5; stroke-linecap: round; }
.plot .pont { fill: var(--jel); }
.plot .celpont { fill: transparent; outline: none; }
.plot .olvaso { opacity: 0; pointer-events: none; }
.plot .olvaso rect { fill: var(--racs); }
.plot .olvaso text { fill: var(--szoveg); font: .66rem var(--mono); }
.plot .celpont:hover + .olvaso,
.plot .celpont:focus-visible + .olvaso { opacity: 1; }
.plot .celpont:focus-visible { stroke: var(--jel); stroke-width: 1; }
/* A vonal balról jobbra rajzolódik ki; a `pathLength: 1` teszi a hosszát
   mérettől függetlenné, így egy 30 napos és egy 7 éves diagram ugyanannyi idő
   alatt fut ki. A hézagsáv szándékosan NEM animálódik: a hiány attól látszik,
   hogy ott nem történik semmi. */
.plot .vonal { pathLength: 1; stroke-dasharray: 1; animation: vonal-be .7s cubic-bezier(.2,.8,.2,1) both; }
.plot .sav { animation: settle .5s cubic-bezier(.2,.8,.2,1) both; animation-delay: 200ms; }
@media (prefers-reduced-motion: reduce) { .plot .vonal, .plot .sav { animation: none; } }
```

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/chart-plot.test.ts
import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { plot } from "../../src/delivery/http/view/chart/plot.ts";
import { SOROZATOK } from "../../src/delivery/http/view/chart/registry.ts";

const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

const hrv = SOROZATOK.get("hrv")!;

describe("nagy diagram", () => {
  it("a szokatlan hézag helyén sávot rajzol", () => {
    // A megszakadt vonal csak azt mondja, volt lyuk; a sáv azt is, meddig tartott.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-09", days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5));
    expect(plot(s, hrv)).toContain('class="hezag"');
  });

  it("hézag nélkül nincs sáv", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 1, 2, 3, 4, 5));
    expect(plot(s, hrv)).not.toContain('class="hezag"');
  });

  it("a hézagsáv nem riasztó színnel rajzolódik", () => {
    // Egy 2021-es lyuk nem hiba, csak hiány. A magenta az állapotsávé.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-09", days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5));
    expect(plot(s, hrv)).not.toContain("riado");
  });

  it("minden oszlophoz tartozik billentyűzettel elérhető olvasó", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 1, 2, 3, 4, 5));
    const html = plot(s, hrv);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="olvaso"');
  });

  it("mérés nélkül azt mondja, hogy nincs mérés", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-03", days("2026-01-01", null, null, null));
    const html = plot(s, hrv);
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("NaN");
  });

  it("szavakban is elmondja, amit a kép", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 40, 50, null, null, 60));
    expect(plot(s, hrv)).toMatch(/<title>[^<]*3 mérés[^<]*<\/title>/);
  });
});
```

- [ ] **Step 2: Futtasd** — FAIL.

- [ ] **Step 3: Írd meg az implementációt**

```ts
// src/delivery/http/view/chart/plot.ts
import { escapeHtml } from "../../markdown.ts";
import { bucketise } from "./buckets.ts";
import { dayNumber, type Series, type Point } from "./series.ts";
import type { SeriesSpec } from "./registry.ts";

const W = 720, H = 260, L = 52, R = 8, T = 10, B = 22;
const IW = W - L - R;
const IH = H - T - B;

/**
 * The large view: axes, gap bands, a min-max band and a median line.
 *
 * Drawing order carries meaning. Gap bands go furthest back because they are
 * ground, not data; the reader targets go in front of everything because they
 * are what the pointer and the keyboard must reach. The readout needs no
 * JavaScript at all: each column owns a transparent, focusable rect, and CSS
 * reveals the group next to it on `:hover` or `:focus-visible` — which makes
 * it work with a mouse, a keyboard and a tap, on a page that ships no script.
 */
export function plot(series: Series, spec: SeriesSpec): string {
  const summary = escapeHtml(
    `${spec.label}, ${series.totalDays} nap: ${series.points.length} mérés, `
    + `${Math.floor(series.coverage * 100)}% lefedettség`
    + (series.points.length === 0 ? "" : `, ${spec.format(series.min)}–${spec.format(series.max)}`),
  );
  const open = `<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${summary}">`
    + `<title>${summary}</title>`;

  if (series.points.length === 0) {
    return `${open}<text class="tengely" x="${L}" y="${T + IH / 2}">nincs mérés ebben az ablakban</text></svg>`;
  }

  const span = series.toDay - series.fromDay;
  const lo = spec.zeroBased ? Math.min(0, series.min) : series.min;
  const hi = series.max;
  const range = hi - lo === 0 ? 1 : hi - lo;
  const n = (v: number) => Math.round(v * 100) / 100;

  const xOfDay = (day: number) => span === 0 ? L + IW / 2 : L + ((day - series.fromDay) / span) * IW;
  const yOfVal = (v: number) => T + IH - ((v - lo) / range) * IH;

  // Gap bands first: they are the ground the rest is drawn on.
  const gaps = series.gaps.map((g) => {
    const x1 = xOfDay(dayNumber(g.fromDate));
    const x2 = xOfDay(dayNumber(g.toDate));
    // At least one pixel wide: a hole the axis cannot resolve is still a hole,
    // and a zero-width band would hide exactly the gaps a long window packs
    // most tightly.
    return `<rect class="hezag" x="${n(x1)}" y="${T}" width="${n(Math.max(1, x2 - x1))}" height="${IH}"/>`;
  }).join("");

  const grid = [0, 0.5, 1].map((f) => {
    const y = T + IH * f;
    const v = hi - (hi - lo) * f;
    return `<line class="racs" x1="${L}" y1="${n(y)}" x2="${W - R}" y2="${n(y)}"/>`
      + `<text class="tengely" x="4" y="${n(y + 3)}">${escapeHtml(spec.format(v))}</text>`;
  }).join("");

  const axis = `<text class="tengely" x="${L}" y="${H - 6}">${escapeHtml(series.from)}</text>`
    + `<text class="tengely" x="${W - R}" y="${H - 6}" text-anchor="end">${escapeHtml(series.to)}</text>`;

  const columns = Math.max(1, Math.round(IW));
  const dense = series.points.length > columns;

  let data: string;
  if (dense) {
    const buckets = bucketise(series, columns);
    const band: string[] = [];
    const line: string[] = [];
    let connected = false;
    for (const [i, b] of buckets.entries()) {
      if (b === null) { connected = false; continue; }
      const x = L + (i / columns) * IW;
      band.push(`<rect class="sav" x="${n(x)}" y="${n(yOfVal(b.max))}" width="1.2" `
        + `height="${n(Math.max(0.6, yOfVal(b.min) - yOfVal(b.max)))}"/>`);
      line.push(`${connected ? "L" : "M"}${n(x)} ${n(yOfVal(b.median))}`);
      connected = true;
    }
    data = band.join("") + `<path class="vonal" d="${line.join(" ")}"/>`;
  } else {
    data = series.segments.map((seg) => {
      if (seg.length === 1) {
        return `<circle class="pont" cx="${n(xOfDay(seg[0]!.day))}" cy="${n(yOfVal(seg[0]!.value))}" r="2"/>`;
      }
      const d = seg.map((p: Point, i) => `${i === 0 ? "M" : "L"}${n(xOfDay(p.day))} ${n(yOfVal(p.value))}`).join(" ");
      return `<path class="vonal" d="${d}"/>`;
    }).join("");
  }

  // One reader per measured day (or per filled column when dense), each a
  // transparent focusable target with its own readout beside it.
  const targets = series.points.map((p) => {
    const x = xOfDay(p.day);
    const label = escapeHtml(`${p.date} · ${spec.format(p.value)}`);
    const boxW = Math.max(96, label.length * 6);
    const bx = Math.min(W - R - boxW, Math.max(L, x - boxW / 2));
    return `<rect class="celpont" tabindex="0" x="${n(x - 2)}" y="${T}" width="4" height="${IH}"><title>${label}</title></rect>`
      + `<g class="olvaso"><rect x="${n(bx)}" y="${T}" width="${boxW}" height="18" rx="2"/>`
      + `<text x="${n(bx + 6)}" y="${T + 13}">${label}</text></g>`;
  }).join("");

  return `${open}${gaps}${grid}${data}${targets}${axis}</svg>`;
}
```

- [ ] **Step 4: Futtasd** — PASS (6 teszt).

- [ ] **Step 5: Ellenőrizd** — hagyd ki a `gaps` blokkot a kimenetből: az első teszt bukjon. Rajzold a hézagsávot mindig (üres `series.gaps` esetén is egy fixet): a második bukjon. Vedd ki a `tabindex`-et: a negyedik bukjon.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/chart/plot.ts src/delivery/http/view/theme.ts test/delivery/chart-plot.test.ts
git commit -m "$(printf 'feat: nagy nézet hézagsávval és JS nélküli olvasóval\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 7: `/szamok/:metrika` — a részletoldal

**Files:**
- Create: `src/delivery/http/view/chart/detail.ts`
- Modify: `src/delivery/http/routes/page.ts`
- Test: `test/delivery/page.test.ts`

**Interfaces:**
- Consumes: `plot` (Task 6), `SOROZATOK`, `valuesFrom` (Task 3), `buildSeries` (Task 1).
- Produces:
  - `const TARTOMANYOK: readonly { key: string; days: number; label: string }[]`
  - `function parseRange(raw: string | undefined): { key: string; days: number; label: string }`
  - `function detailBody(spec: SeriesSpec, series: Series, active: string, chart: string): string`

`TARTOMANYOK`: `{ key: "30", days: 30, label: "30 nap" }`, `{ key: "365", days: 365, label: "1 év" }`, `{ key: "mind", days: 4000, label: "minden" }`. A `parseRange` ismeretlen vagy hiányzó értékre a `365`-öt adja — **nem hibázik**, mert egy elrontott cím se törhesse el az oldalt.

A `mind` 4000 napja lefedi a 2019-es kezdetet és még hosszú ideig fog; a nap száma a `between` alsó határának kiszámításához kell, nem korlát.

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/page.test.ts, a "page routes" blokkban
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
  expect(res.body).toContain('aria-current="page"');
  await a.close();
});

it("a részletoldal token nélkül elutasít", async () => {
  const a = await boot();
  const res = await a.server.inject({ method: "GET", url: "/szamok/hrv" });
  expect(res.statusCode).toBe(401);
  await a.close();
});
```

- [ ] **Step 2: Futtasd** — FAIL: 401 mindenhol (az útvonal nincs regisztrálva, az alapértelmezett tiltás elkapja).

- [ ] **Step 3: Írd meg az implementációt**

A `detail.ts` a törzset adja: cím, tartományválasztó (linkek, az aktív `aria-current="page"`-dzsel), a diagram, és alatta a szöveges összegzés. A route:

```ts
app.get<{ Params: { metrika: string }; Querystring: { tart?: string } }>(
  "/szamok/:metrika", async (request, reply) => {
    const spec = SOROZATOK.get(request.params.metrika);
    // 404, nem üres diagram: az utóbbi azt állítaná, hogy létezik ez a mérés,
    // csak épp nincs adata — ami a rendszer alapszabályát sértené.
    if (spec === undefined) return reply.code(404).send({ error: "not_found" });

    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);
    const range = parseRange(request.query.tart);
    const to = isoDate(now, TZ);
    const from = isoDate(addDays(now, -range.days + 1), TZ);

    let series = buildSeries(spec.column, from, to, []);
    try {
      series = buildSeries(spec.column, from, to, valuesFrom(deps.health.between(from, to), spec.column));
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "detail page rendered without its series");
    }

    return reply.type("text/html; charset=utf-8")
      .send(render("szamok", inputs, detailBody(spec, series, range.key, plot(series, spec))));
  },
);
```

- [ ] **Step 4: Futtasd** — PASS.

- [ ] **Step 5: Ellenőrizd** — adj vissza üres diagramot 404 helyett: a második teszt bukjon. Dobj kivételt érvénytelen `tart` esetén: a harmadik bukjon.

- [ ] **Step 6: A teljes csomag és a kézi szemrevételezés**

```bash
npm run typecheck && npm test
```

Ne indíts szervert és ne nyúlj a launchd ügynökhöz — a szemrevételezést a terv gazdája végzi.

- [ ] **Step 7: Commit**

```bash
git add src/delivery/http/view/chart/detail.ts src/delivery/http/routes/page.ts test/delivery/page.test.ts
git commit -m "$(printf 'feat: mérésenkénti részletoldal tartományválasztóval\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```
