# S7 — A napi egészség-csatorna kiszélesítése — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A telefon küldje el mindazt, ami *ma* számít — az alvást nyers mintaként, a pillanatnyi méréseket a mai napra, a halmozódó összegeket a tegnapira —, és olvassuk végre azt a tíz mérést, ami 2019 óta gyűlik.

**Architecture:** A telefon nem számol: nyers alvás-mintákat küld ugyanabban az alakban, amit az export-olvasó ad, és a szerver ugyanazon a `rollup()`-on futtatja át, ami az importot is feldolgozza — egy logika, két forrás. A közvetlen mezők a meglévő `READING` térkép bővítésével jönnek, két kérésben szétválasztva aszerint, hogy egy mérés mikor válik teljessé. Tíz új oszlop kerül a sémába, és a `DAILY` térkép is megkapja őket, tehát a havi import visszamenőleg feltölti a történetet.

**Tech Stack:** Node 24 (`.ts` közvetlenül, build nélkül), `node:sqlite`, Fastify 5, zod, vitest.

## Global Constraints

- Node >= 24, build lépés nincs, a `.ts` fájlok közvetlenül futnak — **minden relatív import `.ts` kiterjesztéssel**.
- **Új futásidejű függőség nem vehető fel.**
- `npm run typecheck` (`tsc --noEmit`) tisztán fut.
- A tesztek hálózat nélkül futnak, és soha nem írják az éles adatbázist (`./data/jarvis.db`) — azt egy launchd agent tartja nyitva.
- Felhasználónak szóló szöveg magyarul, kódkommentek angolul. A komment azt magyarázza, **miért**.
- A migrációk folytonos, csak bővülő sorozatot alkotnak: `008_mobility.sql` a `007_notifications.sql` után.
- **A `rollup()` és a `parseAppleDate()` nem módosul.** Az import helyessége nem függhet attól, hogy a telefon útvonala bővül.
- **Ami nem érthető, az jelentés, nem hiba:** a fel nem ismert minta-típus és fázisnév a válasz `ignored` tömbjébe kerül, névvel.
- Commit-üzenet utolsó sora: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Kiindulás

Branch: `s7-wider-daily-channel`, a `main`-ről. Kiinduló állapot: 470 teszt / 48 fájl zöld, typecheck tiszta.

## Fájlszerkezet

| Fájl | Felelősség |
|---|---|
| `src/infra/db/migrations/008_mobility.sql` | A tíz új oszlop |
| `src/infra/health-export/rollup.ts` | Módosul: a `DAILY` térkép megkapja a tíz típust |
| `src/infra/db/repositories/health.ts` | Módosul: `HISTORY_COLUMNS`, `upsert`, új `lastDateWith` |
| `src/core/health/phone-samples.ts` | A két határátalakító: dátumalak és fázisnév. Tiszta |
| `src/delivery/http/routes/ingest.ts` | Módosul: bővített `READING`, nyers-minta útvonal |
| `src/core/notify/candidates.ts` | Módosul: szokás-őrző jelöltek |
| `src/core/notify/gather.ts` | Módosul: a legutóbbi alvás- és étkezés-nap beolvasása |

---

## Task 1: A tíz oszlop, és hogy az import is töltse

**Files:**
- Create: `src/infra/db/migrations/008_mobility.sql`
- Modify: `src/infra/health-export/rollup.ts`, `src/infra/db/repositories/health.ts`
- Test: `test/core/rollup-mobility.test.ts` (új)

**Interfaces:**
- Consumes: a `DAILY` térkép alakja a `rollup.ts`-ben: `Record<string, { column: string; agg: "sum" | "avg"; unit: string }>`
- Produces: tíz új oszlop, és ugyanez a tíz bejegyzés a `DAILY`-ben és a `HISTORY_COLUMNS`-ban

**Az egységek mértek, a tulajdonos valódi exportjából — ne írd át őket.** Az S3 egység-ellenőrzése egy eltérésnél az egész oszlopot eldobja, tehát egy elgépelt egység egy néma, üres oszlopot ad.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/rollup-mobility.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { rollup } from "../../src/infra/health-export/rollup.ts";
import type { ExportEntry } from "../../src/infra/health-export/reader.ts";

async function* stream(entries: ExportEntry[]): AsyncIterable<ExportEntry> {
  for (const e of entries) yield e;
}

function record(type: string, value: string, unit: string, day = "2026-09-01"): ExportEntry {
  return {
    kind: "record", type, value, unit,
    startDate: `${day} 10:00:00 +0200`, endDate: `${day} 10:01:00 +0200`,
    source: "Marcell’s Apple Watch",
  };
}

describe("rollup — mobility", () => {
  it("sums distance across the day", async () => {
    const r = await rollup(stream([
      record("DistanceWalkingRunning", "2.5", "km"),
      record("DistanceWalkingRunning", "1.5", "km"),
    ]));
    expect(r.days[0]!.values.distance_km).toBeCloseTo(4, 6);
  });

  it("averages walking speed rather than summing it", async () => {
    // Speed is a rate: adding two readings would invent a pace nobody walked.
    const r = await rollup(stream([
      record("WalkingSpeed", "4.0", "km/hr"),
      record("WalkingSpeed", "5.0", "km/hr"),
    ]));
    expect(r.days[0]!.values.walking_speed).toBeCloseTo(4.5, 6);
  });

  it("takes every one of the ten new types", async () => {
    const r = await rollup(stream([
      record("DistanceWalkingRunning", "3", "km"),
      record("AppleStandTime", "12", "min"),
      record("WalkingSpeed", "4.4", "km/hr"),
      record("WalkingStepLength", "72", "cm"),
      record("WalkingDoubleSupportPercentage", "27", "%"),
      record("WalkingAsymmetryPercentage", "1.5", "%"),
      record("AppleWalkingSteadiness", "88", "%"),
      record("SixMinuteWalkTestDistance", "540", "m"),
      record("StairAscentSpeed", "0.42", "m/s"),
      record("StairDescentSpeed", "0.55", "m/s"),
    ]));
    const v = r.days[0]!.values;
    expect(Object.keys(v).sort()).toEqual([
      "asymmetry_pct", "distance_km", "double_support_pct", "six_min_walk_m",
      "stair_down_ms", "stair_up_ms", "stand_min", "steadiness_pct",
      "step_length_cm", "walking_speed",
    ]);
  });

  it("drops a type whose unit does not match, and says so", async () => {
    // A silent unit change would rescale a whole column. The skipped map is
    // what makes that visible on the very first import.
    const r = await rollup(stream([record("WalkingSpeed", "4.4", "mph")]));
    expect(r.days).toEqual([]);
    expect(Object.keys(r.skipped).join(" ")).toMatch(/WalkingSpeed.*egység/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/rollup-mobility.test.ts`
Expected: FAIL — a tíz típus nincs a `DAILY` térképben, tehát a `skipped`-be kerülnek.

- [ ] **Step 3: Write the migration**

Hozd létre a `src/infra/db/migrations/008_mobility.sql` fájlt:

```sql
-- Ten measurements the watch and the phone have been collecting all along.
--
-- Nothing here needs a new habit: they accumulate passively. Distance goes back
-- to 2019-02-13 in the owner's export -- the longest continuous series after
-- step count -- and the walking metrics have run since 2021. They were never
-- read because nothing asked for them.
--
-- The aggregation for each is fixed in the rollup's DAILY map and must match
-- what the phone sends, or the same column would hold two different meanings.
ALTER TABLE health_snapshots ADD COLUMN distance_km REAL;
ALTER TABLE health_snapshots ADD COLUMN stand_min REAL;
ALTER TABLE health_snapshots ADD COLUMN walking_speed REAL;
ALTER TABLE health_snapshots ADD COLUMN step_length_cm REAL;
ALTER TABLE health_snapshots ADD COLUMN double_support_pct REAL;
ALTER TABLE health_snapshots ADD COLUMN asymmetry_pct REAL;
ALTER TABLE health_snapshots ADD COLUMN steadiness_pct REAL;
ALTER TABLE health_snapshots ADD COLUMN six_min_walk_m REAL;
ALTER TABLE health_snapshots ADD COLUMN stair_up_ms REAL;
ALTER TABLE health_snapshots ADD COLUMN stair_down_ms REAL;
```

- [ ] **Step 4: Extend the rollup's DAILY map**

`src/infra/health-export/rollup.ts` — a `DAILY` térkép végére, a meglévő tizennégy után:

```typescript
  DistanceWalkingRunning: { column: "distance_km", agg: "sum", unit: "km" },
  AppleStandTime: { column: "stand_min", agg: "sum", unit: "min" },
  WalkingSpeed: { column: "walking_speed", agg: "avg", unit: "km/hr" },
  WalkingStepLength: { column: "step_length_cm", agg: "avg", unit: "cm" },
  WalkingDoubleSupportPercentage: { column: "double_support_pct", agg: "avg", unit: "%" },
  WalkingAsymmetryPercentage: { column: "asymmetry_pct", agg: "avg", unit: "%" },
  AppleWalkingSteadiness: { column: "steadiness_pct", agg: "avg", unit: "%" },
  SixMinuteWalkTestDistance: { column: "six_min_walk_m", agg: "avg", unit: "m" },
  StairAscentSpeed: { column: "stair_up_ms", agg: "avg", unit: "m/s" },
  StairDescentSpeed: { column: "stair_down_ms", agg: "avg", unit: "m/s" },
```

**Semmi mást ne változtass a `rollup.ts`-ben.** A `DAILY` bővítése adat, nem logika; a fájl többi része az importot is kiszolgálja.

- [ ] **Step 5: Extend HISTORY_COLUMNS**

`src/infra/db/repositories/health.ts` — a `HISTORY_COLUMNS` halmazba vedd fel mind a tíz új oszlopnevet. Ez az engedélyezőlista, amin a `fillGaps` átenged egy oszlopot; nélküle a `rollup` kiszámolná az értéket, és a repó eldobná.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/infra/db/migrations/008_mobility.sql src/infra/health-export/rollup.ts \
        src/infra/db/repositories/health.ts test/core/rollup-mobility.test.ts
git commit -m "feat: ten measurements that were already there, finally read"
```

---

## Task 2: A két határátalakító

**Files:**
- Create: `src/core/health/phone-samples.ts`
- Test: `test/core/phone-samples.test.ts` (új)

**Interfaces:**
- Consumes: semmit
- Produces: `toAppleDate(iso)`, `SLEEP_VALUES`, `normaliseSleepValue(raw)`

**A dátum alakja.** Az export nem ISO 8601, hanem `'2026-03-01 23:10:00 +0100'` — és a `rollup` a **első tíz karakterből** veszi a helyi napot, konverzió nélkül. Ezért az átalakítónak az eltolást meg kell tartania: ha `Z`-t kap, az `+0000`, és a nap az UTC szerinti nap lesz, ami akkor is az igazság, ha nem az, amit a telefon tulajdonosa átélt.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/phone-samples.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { toAppleDate, normaliseSleepValue } from "../../src/core/health/phone-samples.ts";

describe("toAppleDate", () => {
  it("keeps the local wall clock and the offset", () => {
    // The rollup reads the local day from the first ten characters, so the
    // conversion must not shift the clock into UTC.
    expect(toAppleDate("2026-09-01T23:10:00+02:00")).toBe("2026-09-01 23:10:00 +0200");
  });

  it("handles a negative offset", () => {
    expect(toAppleDate("2026-01-15T06:30:00-05:00")).toBe("2026-01-15 06:30:00 -0500");
  });

  it("treats Z as +0000 rather than guessing a zone", () => {
    expect(toAppleDate("2026-09-01T23:10:00Z")).toBe("2026-09-01 23:10:00 +0000");
  });

  it("accepts fractional seconds and drops them", () => {
    expect(toAppleDate("2026-09-01T23:10:00.482+02:00")).toBe("2026-09-01 23:10:00 +0200");
  });

  it("returns null for anything it does not recognise", () => {
    // Null is the signal to report the sample as ignored. Guessing a format
    // would put a sample on the wrong day, silently.
    expect(toAppleDate("2026-09-01 23:10:00")).toBeNull();
    expect(toAppleDate("tegnap este")).toBeNull();
    expect(toAppleDate("")).toBeNull();
  });
});

describe("normaliseSleepValue", () => {
  it("passes an Apple constant through unchanged", () => {
    expect(normaliseSleepValue("HKCategoryValueSleepAnalysisAsleepDeep"))
      .toBe("HKCategoryValueSleepAnalysisAsleepDeep");
  });

  it("maps the names the Shortcuts app shows", () => {
    expect(normaliseSleepValue("Deep")).toBe("HKCategoryValueSleepAnalysisAsleepDeep");
    expect(normaliseSleepValue("REM")).toBe("HKCategoryValueSleepAnalysisAsleepREM");
    expect(normaliseSleepValue("Core")).toBe("HKCategoryValueSleepAnalysisAsleepCore");
    expect(normaliseSleepValue("Awake")).toBe("HKCategoryValueSleepAnalysisAwake");
    expect(normaliseSleepValue("In Bed")).toBe("HKCategoryValueSleepAnalysisInBed");
  });

  it("is forgiving about case and spacing, because the source is a UI label", () => {
    expect(normaliseSleepValue("deep")).toBe("HKCategoryValueSleepAnalysisAsleepDeep");
    expect(normaliseSleepValue("in bed")).toBe("HKCategoryValueSleepAnalysisInBed");
    expect(normaliseSleepValue("  Asleep  ")).toBe("HKCategoryValueSleepAnalysisAsleepUnspecified");
  });

  it("returns null for a name it does not know", () => {
    // We could not measure the exact labels — the owner has no staged sleep
    // data yet. So an unknown name must surface, not vanish.
    expect(normaliseSleepValue("Mély alvás")).toBeNull();
    expect(normaliseSleepValue("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/phone-samples.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/health/phone-samples.ts` fájlt:

```typescript
/**
 * The boundary between what the phone can say and what the rollup expects.
 *
 * The rollup is the import's code and stays untouched: its correctness cannot
 * depend on the phone's path growing. These two functions translate at the
 * edge, and return null rather than guess — a guess here would file a sample
 * on the wrong day or under the wrong sleep stage, silently.
 */

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * ISO 8601 -> the export's own format, e.g. '2026-09-01 23:10:00 +0200'.
 *
 * The offset is preserved rather than normalised, because the rollup reads the
 * local day from the first ten characters with no conversion — that is the day
 * the owner actually lived, which is the honest answer when travelling.
 */
export function toAppleDate(iso: string): string | null {
  const m = ISO.exec(iso.trim());
  if (!m) return null;
  const [, day, time, zone] = m;
  const offset = zone === "Z" ? "+0000" : zone!.replace(":", "");
  return `${day} ${time} ${offset}`;
}

/** Apple's constants, and the labels the Shortcuts app shows for them. */
export const SLEEP_VALUES: Record<string, string> = {
  inbed: "HKCategoryValueSleepAnalysisInBed",
  awake: "HKCategoryValueSleepAnalysisAwake",
  core: "HKCategoryValueSleepAnalysisAsleepCore",
  light: "HKCategoryValueSleepAnalysisAsleepCore",
  rem: "HKCategoryValueSleepAnalysisAsleepREM",
  deep: "HKCategoryValueSleepAnalysisAsleepDeep",
  asleep: "HKCategoryValueSleepAnalysisAsleepUnspecified",
  unspecified: "HKCategoryValueSleepAnalysisAsleepUnspecified",
};

/**
 * A sleep sample's value, as either Apple's constant or the app's own label.
 *
 * Deliberately liberal: the exact labels could not be measured, because there
 * is no staged sleep data yet to read them from. Deliberately loud too — an
 * unrecognised name returns null so the route can report it by name, and the
 * first real night tells us what we got wrong instead of losing it.
 */
export function normaliseSleepValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("HKCategoryValueSleepAnalysis")) return trimmed;
  return SLEEP_VALUES[trimmed.toLowerCase().replace(/[\s_-]/g, "")] ?? null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/phone-samples.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/health/phone-samples.ts test/core/phone-samples.test.ts
git commit -m "feat: translate the phone's dialect at the boundary, or say so"
```

---

## Task 3: A nyers-minta útvonal

**Files:**
- Modify: `src/delivery/http/routes/ingest.ts`
- Test: `test/delivery/ingest-samples.test.ts` (új)

**Interfaces:**
- Consumes: `toAppleDate`, `normaliseSleepValue` (Task 2); `rollup` és `ExportEntry` a `src/infra/health-export/`-ból; `HealthRepo.fillGaps`
- Produces: a `samples` mező a `POST /api/ingest/health` törzsében

**A `rollup` szignatúrája:** `rollup(entries: AsyncIterable<ExportEntry>): Promise<RollupResult>`, ahol a `RollupResult` `{ days, workouts, skipped, range }`, és `days[i]` alakja `{ date, values: Record<string, number> }`. Egy `ExportEntry` rekord-változata: `{ kind: "record", type, value, unit, startDate, endDate, source }`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/delivery/ingest-samples.test.ts` fájlt:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, TEST_TOKEN, stubModule, type TestApp } from "../helpers.ts";

let app: TestApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function boot() {
  app = await buildTestApp({ modules: [stubModule({ name: "Teszt" })], now: "2026-09-02T05:00:00.000Z" });
  return app;
}

const post = (a: TestApp, payload: unknown) => a.server.inject({
  method: "POST", url: "/api/ingest/health",
  headers: { authorization: `Bearer ${TEST_TOKEN}` },
  payload: payload as Record<string, unknown>,
});

/** One night: in bed, then core, deep and a brief wake, ending on the 2nd. */
const NIGHT = [
  { type: "SleepAnalysis", value: "In Bed", startDate: "2026-09-01T23:00:00+02:00", endDate: "2026-09-02T07:00:00+02:00" },
  { type: "SleepAnalysis", value: "Core",   startDate: "2026-09-01T23:20:00+02:00", endDate: "2026-09-02T02:00:00+02:00" },
  { type: "SleepAnalysis", value: "Deep",   startDate: "2026-09-02T02:00:00+02:00", endDate: "2026-09-02T03:30:00+02:00" },
  { type: "SleepAnalysis", value: "Awake",  startDate: "2026-09-02T03:30:00+02:00", endDate: "2026-09-02T03:40:00+02:00" },
  { type: "SleepAnalysis", value: "REM",    startDate: "2026-09-02T03:40:00+02:00", endDate: "2026-09-02T06:40:00+02:00" },
];

describe("ingest — raw samples", () => {
  it("computes the night the same way the import would", async () => {
    const a = await boot();
    const res = await post(a, { samples: NIGHT });
    expect(res.statusCode).toBe(202);

    // Attributed to the day the night ENDS on, as the rollup already does.
    const row = a.health.forDate("2026-09-02")!;
    expect(row.coreMin).toBeCloseTo(160, 3);   // 23:20 -> 02:00
    expect(row.deepMin).toBeCloseTo(90, 3);    // 02:00 -> 03:30
    expect(row.remMin).toBeCloseTo(180, 3);    // 03:40 -> 06:40
    expect(row.awakenings).toBe(1);
    expect(row.asleepMin).toBeCloseTo(430, 3); // 160 + 90 + 180
    expect(row.inBedMin).toBeCloseTo(480, 3);  // 23:00 -> 07:00
  });

  it("reports a sleep stage it does not recognise instead of losing it", async () => {
    const a = await boot();
    const res = await post(a, {
      samples: [{ type: "SleepAnalysis", value: "Szendergés",
                  startDate: "2026-09-01T23:00:00+02:00", endDate: "2026-09-02T07:00:00+02:00" }],
    });
    const body = res.json() as { ignored: { field: string; reason: string }[] };
    expect(JSON.stringify(body.ignored)).toContain("Szendergés");
  });

  it("reports a date it cannot parse instead of filing it on the wrong day", async () => {
    const a = await boot();
    const res = await post(a, {
      samples: [{ type: "SleepAnalysis", value: "Core", startDate: "tegnap este", endDate: "ma reggel" }],
    });
    expect(JSON.stringify(res.json())).toMatch(/tegnap este|dátum/i);
    expect(a.health.forDate("2026-09-02")?.coreMin ?? null).toBeNull();
  });

  it("does not overwrite a value that is already there", async () => {
    // fillGaps only fills holes, which is what lets the monthly import run
    // without thought. A second post of the same night must not rewrite it.
    const a = await boot();
    await post(a, { samples: NIGHT });
    await post(a, { samples: [{ type: "SleepAnalysis", value: "Deep",
      startDate: "2026-09-02T02:00:00+02:00", endDate: "2026-09-02T02:05:00+02:00" }] });
    expect(a.health.forDate("2026-09-02")!.deepMin).toBeCloseTo(90, 3);
  });

  it("accepts samples and direct fields in one request", async () => {
    const a = await boot();
    await post(a, { hrv: 68, samples: NIGHT });
    const row = a.health.forDate("2026-09-02")!;
    expect(row.hrv).toBe(68);
    expect(row.asleepMin).toBeCloseTo(430, 3);
  });

  it("still works with no samples at all", async () => {
    const a = await boot();
    const res = await post(a, { hrv: 68 });
    expect(res.statusCode).toBe(202);
    expect(a.health.forDate("2026-09-02")!.hrv).toBe(68);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/delivery/ingest-samples.test.ts`
Expected: FAIL — a `samples` mezőt a route nem ismeri.

- [ ] **Step 3: Write the implementation**

`src/delivery/http/routes/ingest.ts` — vedd fel a fájl tetejére az importokat, és egy új függvényt a `readSnapshot` mellé:

```typescript
import { rollup } from "../../../infra/health-export/rollup.ts";
import type { ExportEntry } from "../../../infra/health-export/reader.ts";
import { toAppleDate, normaliseSleepValue } from "../../../core/health/phone-samples.ts";

interface PhoneSample {
  type?: unknown; value?: unknown; unit?: unknown;
  startDate?: unknown; endDate?: unknown; source?: unknown;
}

export interface SampleResult {
  /** Day -> column -> value, ready for fillGaps. */
  days: { date: string; values: Record<string, number> }[];
  ignored: { field: string; reason: string }[];
}

/**
 * Runs the phone's raw samples through the import's own rollup.
 *
 * One logic, two producers. The watch writes a sleep sample per stage, and a
 * Shortcut cannot sum them — Calculate Statistics works on sample values, and a
 * sleep sample's value is a stage name, not a duration. Taking the latest
 * sample instead would report 0.3 hours for a seven-hour night: not missing
 * data, but confidently wrong. Sending them raw also inherits the overlapping-
 * source resolution the phone could never do.
 */
export async function readSamples(raw: unknown): Promise<SampleResult> {
  const ignored: { field: string; reason: string }[] = [];
  if (!Array.isArray(raw)) return { days: [], ignored };

  const entries: ExportEntry[] = [];
  for (const [i, s] of (raw as PhoneSample[]).entries()) {
    const type = typeof s?.type === "string" ? s.type : null;
    const start = typeof s?.startDate === "string" ? toAppleDate(s.startDate) : null;
    const end = typeof s?.endDate === "string" ? toAppleDate(s.endDate) : null;
    if (!type || !start || !end) {
      ignored.push({ field: `samples[${i}]`, reason: "hiányzó vagy értelmezhetetlen típus/dátum" });
      continue;
    }

    let value = typeof s.value === "string" ? s.value : String(s.value ?? "");
    if (type === "SleepAnalysis") {
      const stage = normaliseSleepValue(value);
      if (!stage) {
        ignored.push({ field: `samples[${i}]`, reason: `ismeretlen alvás-fázis: ${value}` });
        continue;
      }
      value = stage;
    }

    entries.push({
      kind: "record", type, value,
      unit: typeof s.unit === "string" ? s.unit : null,
      startDate: start, endDate: end,
      source: typeof s.source === "string" ? s.source : "iPhone",
    });
  }

  if (entries.length === 0) return { days: [], ignored };

  const result = await rollup((async function* () { for (const e of entries) yield e; })());
  // The rollup's own skipped map carries types it does not store and unit
  // mismatches. Surfacing them here is what keeps a dropped column visible.
  for (const [reason, n] of Object.entries(result.skipped)) {
    ignored.push({ field: "samples", reason: `${reason} (${n})` });
  }
  return { days: result.days, ignored };
}
```

és a route törzsében, közvetlenül a `deps.health.upsert(...)` hívás **után**:

```typescript
    const samples = await readSamples(fields.samples);
    for (const day of samples.days) {
      // fillGaps, not upsert: the phone's samples must not overwrite what the
      // import already established for an older day.
      deps.health.fillGaps(day.date, day.values, now);
    }
```

A válaszban az `ignored` a kettő összefűzése legyen: `[...ignored, ...samples.ignored]`.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`

> Ha az alvás-percek nem jönnek ki, **a fixtúrán ellenőrizd az időtartamokat** — a `NIGHT` fixtúra percei kézzel kiszámolhatók —, és ha a tervem számol rosszul, állj meg és szólj. Ne igazítsd sem a tesztet, sem a `rollup`-ot.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/http/routes/ingest.ts test/delivery/ingest-samples.test.ts
git commit -m "feat: the phone sends raw sleep, the server computes what it means"
```

---

## Task 4: A közvetlen mezők kiszélesítése

**Files:**
- Modify: `src/delivery/http/routes/ingest.ts`, `src/infra/db/repositories/health.ts`
- Test: `test/core/ingest-fields.test.ts` (új)

**Interfaces:**
- Consumes: a meglévő `READING` és `ZERO_MEANS_ABSENT` a `ingest.ts`-ben, a `upsert` a `health.ts`-ben
- Produces: huszonegy közvetlen mező a hat helyett

**A mai `upsert` hat oszlopot ír** (`sleep_h, hrv, rhr, move_kcal, exercise_min, steps`), `COALESCE(excluded.x, health_snapshots.x)` precedenciával — a beérkező nyer, ha nem null. Ez a bővítéssel sem változik; csak az oszloplista nő.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/ingest-fields.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { readSnapshot } from "../../src/delivery/http/routes/ingest.ts";

describe("readSnapshot — the widened channel", () => {
  it("accepts the point-in-time measurements", () => {
    const r = readSnapshot({
      hrv: 68, rhr: 48, vo2max: 38.4, hrRecovery: 24, walkingHr: 96,
      walkingSpeed: 4.4, stepLengthCm: 72, doubleSupportPct: 27,
      asymmetryPct: 1.5, steadinessPct: 88, sixMinWalkM: 540,
      stairUpMs: 0.42, stairDownMs: 0.55,
    });
    expect(r.ignored).toEqual([]);
    expect(r.accepted).toHaveLength(13);
    expect(r.values.walkingSpeed).toBe(4.4);
  });

  it("accepts the accumulating totals", () => {
    const r = readSnapshot({
      steps: 11121, distanceKm: 8.4, moveKcal: 640, basalKcal: 1720,
      exerciseMin: 41, flights: 12, standMin: 540,
      dietKcal: 2210, dietProteinG: 138, dietCarbsG: 210, dietFatG: 78,
    });
    expect(r.ignored).toEqual([]);
    expect(r.accepted).toHaveLength(11);
  });

  it("treats zero as absent where zero is impossible", () => {
    // Nobody walks at zero speed or eats zero calories; a zero here is a
    // Shortcut that found no sample and substituted one.
    const r = readSnapshot({ walkingSpeed: 0, dietKcal: 0, vo2max: 0 });
    expect(r.accepted).toEqual([]);
    expect(r.ignored.map((i) => i.field).sort()).toEqual(["dietKcal", "vo2max", "walkingSpeed"]);
  });

  it("keeps zero where zero is a real reading", () => {
    // A day with no stairs climbed is a fact about the day.
    const r = readSnapshot({ steps: 0, flights: 0, distanceKm: 0, standMin: 0 });
    expect(r.ignored).toEqual([]);
    expect(r.values.flights).toBe(0);
  });

  it("still rejects one bad field without losing the others", () => {
    const r = readSnapshot({ hrv: 68, rhr: 5 });
    expect(r.values.hrv).toBe(68);
    expect(r.ignored.map((i) => i.field)).toEqual(["rhr"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/ingest-fields.test.ts`
Expected: FAIL — a `READING` térkép csak hat mezőt ismer.

- [ ] **Step 3: Extend READING and ZERO_MEANS_ABSENT**

`src/delivery/http/routes/ingest.ts` — a `READING` térkép egészüljön ki. A tartományok azt zárják ki, ami fizikailag lehetetlen, nem azt, ami szokatlan:

```typescript
  vo2max: z.coerce.number().min(10).max(90),
  hrRecovery: z.coerce.number().min(0).max(100),
  walkingHr: z.coerce.number().min(40).max(200),
  walkingSpeed: z.coerce.number().min(0).max(12),
  stepLengthCm: z.coerce.number().min(0).max(200),
  doubleSupportPct: z.coerce.number().min(0).max(100),
  asymmetryPct: z.coerce.number().min(0).max(100),
  steadinessPct: z.coerce.number().min(0).max(100),
  sixMinWalkM: z.coerce.number().min(0).max(2000),
  stairUpMs: z.coerce.number().min(0).max(5),
  stairDownMs: z.coerce.number().min(0).max(5),
  distanceKm: z.coerce.number().min(0).max(300),
  basalKcal: z.coerce.number().min(0).max(10_000),
  standMin: z.coerce.number().min(0).max(1440),
  dietKcal: z.coerce.number().min(0).max(20_000),
  dietProteinG: z.coerce.number().min(0).max(1000),
  dietCarbsG: z.coerce.number().min(0).max(2000),
  dietFatG: z.coerce.number().min(0).max(1000),
```

és a `ZERO_MEANS_ABSENT` halmaz:

```typescript
const ZERO_MEANS_ABSENT: ReadonlySet<Reading> = new Set([
  "sleepH", "hrv", "rhr",
  "vo2max", "hrRecovery", "walkingHr", "basalKcal",
  "walkingSpeed", "stepLengthCm", "doubleSupportPct", "asymmetryPct",
  "steadinessPct", "sixMinWalkM", "stairUpMs", "stairDownMs",
  "dietKcal", "dietProteinG", "dietCarbsG", "dietFatG",
]);
```

**`steps`, `moveKcal`, `exerciseMin`, `flights`, `distanceKm` és `standMin` szándékosan maradnak ki**: azoknál a nulla valódi mérés. Frissítsd a halmaz fölötti kommentet, hogy ezt kimondja.

- [ ] **Step 4: Widen the upsert**

`src/infra/db/repositories/health.ts` — az `upsert` `INSERT` oszloplistája, a
`VALUES` helyőrzői, az `ON CONFLICT DO UPDATE SET` ága és a paraméterlista
egészüljön ki a tizenöt új oszloppal. A minta oszloponként pontosan ez, ahogy a
hat meglévő is csinálja:

```sql
  vo2max = COALESCE(excluded.vo2max, health_snapshots.vo2max),
```

**A precedencia iránya számít, és ellentétes a `fillGaps`-ével.** Itt a beérkező
érték nyer, ha nem null — mert a telefon a saját mérésének a forrása. A
`fillGaps`-nél a meglévő nyer, mert az import nem írhatja felül, amit a telefon
már megállapított. A kettő együtt adja a garanciát; egyiket sem szabad a másik
irányába állítani.

A tizenöt oszlop: `asleep_min`, `in_bed_min`, `core_min`, `rem_min`, `deep_min`,
`awakenings`, `vo2max`, `hr_recovery`, `walking_hr`, `basal_kcal`, `flights`,
`diet_kcal`, `diet_protein_g`, `diet_carbs_g`, `diet_fat_g` — plusz a Task 1 tíz
mobilitás-oszlopa, tehát összesen huszonöt.

Az `ingest.ts` `upsert` hívásában a jelenleg `null`-ra kötött history-mezők
helyére kerüljön `values.<mező> ?? null`.

> Az alvás-oszlopokat (`asleep_min`, `core_min`, `rem_min`, `deep_min`,
> `in_bed_min`, `awakenings`) az `upsert` **nem** kapja meg értékként — azok a
> Task 3 nyers-minta útvonalán, `fillGaps`-szel érkeznek. Az oszlopoknak attól
> még szerepelniük kell az `upsert` listájában, különben egy `ON CONFLICT`
> felülírná őket null-lal. Ez pontosan az a hiba, amit az S5 javított egyszer
> már; ne nyíljon ki újra.

- [ ] **Step 5: Run the tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/delivery/http/routes/ingest.ts src/infra/db/repositories/health.ts \
        test/core/ingest-fields.test.ts
git commit -m "feat: twenty-one fields where there were six"
```

---

## Task 5: Szokás-őrzés

**Files:**
- Modify: `src/infra/db/repositories/health.ts`, `src/core/notify/candidates.ts`, `src/core/notify/gather.ts`
- Test: `test/core/notify-habits.test.ts` (új)

**Interfaces:**
- Consumes: `Candidate`, `CandidateInput` (`src/core/notify/candidates.ts`); `GatherDeps` (`src/core/notify/gather.ts`); `HISTORY_COLUMNS` (`health.ts`)
- Produces: `HealthRepo.lastDateWith(column)`, `HABIT_LAPSE_DAYS`, két új `kind: "habit"` jelölt

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/notify-habits.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { candidates, HABIT_LAPSE_DAYS, type CandidateInput } from "../../src/core/notify/candidates.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { memoryDb } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";

const NOW = new Date("2026-09-10T10:00:00.000Z");

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    now: NOW, tz: TZ, metrics: null, newAnalyses: [], deadlines: [],
    lastSleepDate: null, lastDietDate: null, ...over,
  };
}

describe("candidates — habits", () => {
  it("says nothing while the habit is being kept", () => {
    const found = candidates(input({ lastSleepDate: "2026-09-10", lastDietDate: "2026-09-09" }));
    expect(found).toEqual([]);
  });

  it("speaks once a habit has lapsed", () => {
    const found = candidates(input({ lastSleepDate: "2026-09-01", lastDietDate: "2026-09-10" }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("habit");
    expect(found[0]!.text).toMatch(/alvás/i);
    expect(found[0]!.text).toContain("9");   // nine days
  });

  it("counts both lapses separately", () => {
    const found = candidates(input({ lastSleepDate: "2026-08-01", lastDietDate: "2026-08-01" }));
    expect(found).toHaveLength(2);
    expect(new Set(found.map((c) => c.key)).size).toBe(2);
  });

  it("does not fire on the day the threshold is reached minus one", () => {
    const justInside = new Date(NOW.getTime() - (HABIT_LAPSE_DAYS - 1) * 86_400_000)
      .toISOString().slice(0, 10);
    expect(candidates(input({ lastSleepDate: justInside, lastDietDate: justInside }))).toEqual([]);
  });

  it("says nothing when a habit was never started", () => {
    // Null is "no data ever", and nagging about a habit that never existed is
    // not the assistant's business.
    expect(candidates(input({ lastSleepDate: null, lastDietDate: null }))).toEqual([]);
  });

  it("keys the lapse without a date, so it is not repeated daily", () => {
    const a = candidates(input({ lastSleepDate: "2026-09-01" }))[0]!.key;
    const b = candidates(input({ now: new Date("2026-09-11T10:00:00.000Z"), lastSleepDate: "2026-09-01" }))[0]!.key;
    expect(b).toBe(a);
  });
});

describe("lastDateWith", () => {
  it("returns the most recent day that has a value in the column", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);
    const now = new Date("2026-09-10T00:00:00.000Z");
    repo.fillGaps("2026-09-01", { asleep_min: 400 }, now);
    repo.fillGaps("2026-09-05", { steps: 9000 }, now);
    expect(repo.lastDateWith("asleep_min")).toBe("2026-09-01");
    db.close();
  });

  it("returns null when the column was never filled", () => {
    const db = memoryDb();
    expect(createHealthRepo(db).lastDateWith("diet_kcal")).toBeNull();
    db.close();
  });

  it("refuses a column that is not on the allowlist", () => {
    // The same guard fillGaps uses: a column name reaching SQL from anywhere
    // but the allowlist is a bug worth failing loudly on.
    const db = memoryDb();
    expect(() => createHealthRepo(db).lastDateWith("date; DROP TABLE health_snapshots")).toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/notify-habits.test.ts`
Expected: FAIL — nincs `lastDateWith`, és a `CandidateInput` nem ismeri az új mezőket.

- [ ] **Step 3: Add lastDateWith**

`src/infra/db/repositories/health.ts` — a `HealthRepo` interfészbe és az implementációba:

```typescript
  /** The most recent day holding a value in `column`, or null. */
  lastDateWith(column: string): string | null;
```

```typescript
    lastDateWith(column) {
      // The same allowlist fillGaps uses. A column name is not user input
      // today, but the guard costs nothing and the alternative is a hole.
      if (!HISTORY_COLUMNS.has(column)) throw new Error(`Unknown column: ${column}`);
      return db.get<{ date: string }>(
        `SELECT date FROM health_snapshots WHERE ${column} IS NOT NULL ORDER BY date DESC LIMIT 1`,
      )?.date ?? null;
    },
```

- [ ] **Step 4: Add the habit candidates**

`src/core/notify/candidates.ts` — a `CandidateKind` bővül `"habit"`-tal, a `CandidateInput` két mezővel.

> **Ez eltöri a meglévő teszt-fixtúrát.** A `test/core/notify-candidates.test.ts`
> `input()` segédje nem ismeri az új mezőket, és a typecheck emiatt elhasal.
> Egészítsd ki a segédet `lastSleepDate: null, lastDietDate: null` alapértékkel —
> **a mezők maradjanak kötelezőek**. Opcionálissá tenni kényelmesebb lenne, de egy
> hívó, aki elfelejti átadni őket, csendben soha nem kapna szokás-jelöltet, és a
> néma hiány pont az, amit ez az egész alrendszer meg akar szüntetni.
> Egyetlen meglévő teszt elvárása sem változhat ettől — ha mégis, állj meg és szólj.

```typescript
  /** The most recent day with sleep data, or null if there has never been any. */
  lastSleepDate: string | null;
  lastDietDate: string | null;
```

```typescript
/** A habit is lapsed once this many days have passed with nothing recorded. */
export const HABIT_LAPSE_DAYS = 3;
```

és a `candidates()` végére, az elemzések után:

```typescript
  const lapse = (label: string, key: string, last: string | null) => {
    // Null means the habit was never started, and nagging about one that never
    // existed is not the assistant's business.
    if (last === null) return;
    const days = dayGap(last, isoDate(input.now, input.tz));
    if (days < HABIT_LAPSE_DAYS) return;
    out.push({
      // No date in the key: the same lapse must not resurface every morning.
      key,
      kind: "habit",
      urgency: "soon",
      text: `${label}: ${days} napja nincs adat (utoljára ${last}).`,
    });
  };
  lapse("Alvás", "habit:sleep-lapsed", input.lastSleepDate);
  lapse("Étkezés", "habit:diet-lapsed", input.lastDietDate);
```

A `dayGap` és az `isoDate` a `src/core/analysis/stats.ts`-ből, illetve a `src/shared/dates.ts`-ből jön — mindkettő létezik.

- [ ] **Step 5: Feed them from gather**

`src/core/notify/gather.ts` — a `GatherDeps`-be vedd fel a `health: HealthRepo` mezőt, és a `candidates(...)` hívásba a két új értéket:

```typescript
    lastSleepDate: deps.health.lastDateWith("asleep_min"),
    lastDietDate: deps.health.lastDateWith("diet_kcal"),
```

Ezt is **saját `try`/`catch`-be** tedd, a többi forrás mintájára, és bukás esetén `null`-lal folytasd, naplózott figyelmeztetéssel. A `src/main.ts` bekötésébe add hozzá a `health: app.health` mezőt.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/infra/db/repositories/health.ts src/core/notify/candidates.ts \
        src/core/notify/gather.ts src/main.ts test/core/notify-habits.test.ts
git commit -m "feat: notice when a habit lapses, instead of quietly recording nothing"
```

---

## Task 6: Dokumentáció és éles ellenőrzés

**Files:**
- Modify: `README.md`
- Test: nincs új automata teszt; a lépések élesben ellenőriznek

- [ ] **Step 1: Document the two requests**

`README.md` — az „Egészség-történet" szakasz után:

```markdown
### Mit küld a telefon, és mikor

A Shortcut **két kérést** küld, mert a mérések nem egyszerre válnak teljessé.

**A mai napra** — ami reggel már végleges: HRV, nyugalmi pulzus, az éjszaka
**nyers alvás-mintái**, VO2max, pulzus-visszatérés, séta-pulzus, és a
járás-metrikák napi átlagai.

**A tegnapi napra** — ami csak a nap végén teljes: lépésszám, távolság, aktív és
alap kalória, edzésperc, emelet, állás-idő, és az étkezés.

Ez nem finomítás. A telefon írása felülírja a meglévőt, az importé nem — így egy
reggel elküldött részösszeg (fél nyolckor kétezer lépés) **véglegesen rögzülne**,
és a havi import soha nem tudná tizenegyezerre javítani.

Az alvást a telefon **nem összegzi**: az óra fázisonként külön mintát ír, és
Shortcutban nincs mód összeadni őket. A nyers mintákat küldi, és a szerver
ugyanazzal a logikával számol belőlük, amivel az importot dolgozza fel —
beleértve az átfedő források feloldását, amit a telefon sosem tudna.

Amit a szerver nem ért — ismeretlen alvás-fázis, értelmezhetetlen dátum,
váratlan mértékegység —, azt a válasz `ignored` tömbje **megnevezi**, ahelyett
hogy elnyelné.
```

- [ ] **Step 2: Verify the rollup path against the real export, read-only**

Készíts egy eldobható szkriptet a scratchpadban (**ne** a repóban), ami a valódi
exportból (`~/Downloads/export.zip`) kiolvassa **egyetlen éjszaka** alvás-mintáit
2026-04-30-ról, átalakítja őket a telefon által küldött alakra (ISO-dátum,
megjelenített fázisnév), majd átfuttatja a `readSamples`-en — és összeveti, hogy
ugyanazt adja-e, mint amit az adatbázis abból a napból tárol (`asleep_min: 425`,
`core_min: 197`, `rem_min: 129`, `deep_min: 100`).

**Ne írj az éles adatbázisba**, és ne indíts szervert. Illeszd be a kimenetet a
riportba. Ez bizonyítja élesben, hogy a telefon útvonala és az import útvonala
ugyanoda érkezik.

- [ ] **Step 3: Run the suite and commit**

Run: `npm test && npm run typecheck && npm run smoke`

```bash
git add README.md
git commit -m "docs: two requests, because measurements do not finish together"
```

---

## Amit a terv szándékosan kihagy

- **Nem módosítja a `rollup()`-ot és a `parseAppleDate()`-et.** A `DAILY` térkép bővítése adat, nem logika.
- **Nem generálja a Shortcutot.** Az a következő lépés, és csak akkor véglegesíthető, ha a szerver már tudja, mit fogad. A formátum visszafejtése megvan: `docs/ios-shortcut-format.md`.
- **Nem vezet be testsúlymérést**, és nem veszi fel a futó- és kerékpár-metrikákat.
- **Nem nyúl a briefhez, a kérdés-felülethez és az elemzéshez.**
