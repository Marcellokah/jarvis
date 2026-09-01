# S2 — Adatalap · implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hét és fél év Apple Health adata kerüljön be napi felbontásban, plusz egy havi előfizetés-napló — hogy az S3 elemzési rétegnek legyen mit elemeznie.

**Architecture:** Egy streaming olvasó a `export.zip`-ből, egy tiszta összesítő függvény, ami rekordokból napi sorokat és edzéseket állít elő, és egy import parancs, ami ezeket írja. Az összesítő pure — semmi I/O —, ezért fixture-rel teljesen tesztelhető. Az import **soha nem ír felül létező mérést**, csak hiányzó mezőt tölt ki.

**Tech Stack:** Node 24 (`node:sqlite`, `node:readline`, `node:child_process`), vitest. Új futásidejű függőség nincs.

## Global Constraints

- **Node `>=24`**, build-lépés nincs, a `.ts` fájlok közvetlenül futnak.
- **Nincs új futásidejű függőség.** A Node-nak nincs beépített zip-olvasója; a
  megoldás `unzip -p` spawnolása, nem egy npm csomag.
- **`npm run typecheck` mindig tiszta** (`tsc --noEmit`).
- **Tesztek hálózat nélkül futnak, és soha nem olvassák a valódi exportot.**
  A valódi fájl 1054 MB; a tesztek kézzel írt, néhány száz soros fixture-t
  használnak.
- **Az import soha nem ír felül létező mérést** — csak `NULL` mezőt tölt ki.
- **Az import idempotens.** Ugyanaz a zip kétszer futtatva ugyanazt az állapotot
  adja.
- Felhasználónak szóló szöveg magyarul, kódkomment angolul.
- A kommentek azt magyarázzák, **miért** — a meglévő fájlok sűrűsége az irányadó.
- Titok soha nem kerül logba vagy hibaüzenetbe.

## Az export formátuma — mért tények

A felhasználó valódi exportjából (2026-08-31), a terv ezekre épül:

```
<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Marcell's Apple Watch"
        unit="count/min" creationDate="2022-02-17 12:22:00 +0200"
        startDate="2022-02-16 17:56:39 +0200" endDate="2022-02-17 00:57:49 +0200" value="71"/>

<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="18.185"
         durationUnit="min" sourceName="Marcell's Apple Watch" ...>
```

- **A dátum `YYYY-MM-DD HH:MM:SS +ZZZZ`**, nem ISO 8601. A helyi eltolás benne
  van, tehát az első 10 karakter **már a helyi nap** — nem kell időzóna-váltás.
- Egy `<Record>` **nyitó tagje egyetlen sorban** van, minden attribútummal.
  Némelyik önzáró (`/>`), némelyiket `<MetadataEntry>` gyerekek követik és egy
  `</Record>` zárja. A soronkénti olvasás emiatt működik: a nyitó sort kell
  elkapni.
- 2 400 520 rekord van 4 732 964 sorban — a különbség a gyerek-elemekből jön.
- `SleepAnalysis` értékei: `HKCategoryValueSleepAnalysisAsleepCore` / `AsleepREM`
  / `AsleepDeep` / `AsleepUnspecified` / `Awake` / `InBed`.
- Az étkezési adat forrása `Yazio`, az alvásé régen `Clock`, ma az óra. A
  forrásnév nem szűrési szempont — ami a Health-ben van, az adat.

---

## File Structure

**Új fájlok**

| Fájl | Felelősség |
|---|---|
| `src/infra/health-export/reader.ts` | Út → rekord-folyam. Zip vagy sima XML |
| `src/infra/health-export/rollup.ts` | Rekord-folyam → napi sorok + edzések. Pure |
| `src/infra/db/migrations/004_health_history.sql` | Új oszlopok és két új tábla |
| `src/infra/db/repositories/workouts.ts` | Edzés-tár |
| `src/infra/db/repositories/subscription-months.ts` | Havi előfizetés-pillanatkép |
| `scripts/import-health.ts` | A parancs |
| `test/fixtures/health/export.xml` | Kézzel írt mini export |

**Módosított fájlok**

| Fájl | Változás |
|---|---|
| `src/infra/db/repositories/health.ts` | Új mezők; `fillGaps()` a nem-felülíró íráshoz |
| `src/core/brief-service.ts` vagy `src/app.ts` | Havi előfizetés-pillanatkép rögzítése |
| `package.json` | `import-health` script |
| `README.md`, `deploy/README.md` | Dokumentáció |

---

## Task 1: A streaming olvasó

**Files:**
- Create: `src/infra/health-export/reader.ts`
- Create: `test/fixtures/health/export.xml`
- Test: `test/core/health-reader.test.ts` (új)

**Interfaces:**
- Consumes: semmit
- Produces: `ExportEntry` tagged union (`{kind:"record",…} | {kind:"workout",…}`) és `readExport(path: string): AsyncGenerator<ExportEntry>` a `src/infra/health-export/reader.ts`-ből.

- [ ] **Step 1: Write the fixture**

Hozd létre a `test/fixtures/health/export.xml` fájlt. Ez **kézzel írt**, nem a
valódi exportból kivágott — néhány száz byte, minden érdekes esettel:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="hu_HU">
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2026-03-01 08:00:00 +0100" endDate="2026-03-01 08:00:00 +0100" value="52"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2026-03-01 20:00:00 +0100" endDate="2026-03-01 20:00:00 +0100" value="56"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-03-01 09:00:00 +0100" endDate="2026-03-01 09:30:00 +0100" value="1200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-03-01 18:00:00 +0100" endDate="2026-03-01 18:30:00 +0100" value="800"/>
 <Record type="HKQuantityTypeIdentifierDietaryProtein" sourceName="Yazio" unit="g" startDate="2026-03-01 12:00:00 +0100" endDate="2026-03-01 12:00:00 +0100" value="4.4">
  <MetadataEntry key="meal" value="lunch"/>
 </Record>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-01 23:10:00 +0100" endDate="2026-03-02 02:40:00 +0100" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-02 02:40:00 +0100" endDate="2026-03-02 03:10:00 +0100" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-02 03:10:00 +0100" endDate="2026-03-02 03:20:00 +0100" value="HKCategoryValueSleepAnalysisAwake"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-02 03:20:00 +0100" endDate="2026-03-02 06:50:00 +0100" value="HKCategoryValueSleepAnalysisAsleepREM"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-01 23:00:00 +0100" endDate="2026-03-02 07:00:00 +0100" value="HKCategoryValueSleepAnalysisInBed"/>
 <Record type="HKQuantityTypeIdentifierHandwashingEvent" sourceName="Watch" unit="s" startDate="2026-03-01 10:00:00 +0100" endDate="2026-03-01 10:00:20 +0100" value="20"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="47.5" durationUnit="min" sourceName="Watch" startDate="2026-03-01 17:00:00 +0100" endDate="2026-03-01 17:47:30 +0100">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="312.4" unit="kcal"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="18.2" durationUnit="min" sourceName="Watch" startDate="2026-03-02 12:00:00 +0100" endDate="2026-03-02 12:18:12 +0100"/>
</HealthData>
```

- [ ] **Step 2: Write the failing test**

Hozd létre a `test/core/health-reader.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readExport, type ExportEntry } from "../../src/infra/health-export/reader.ts";

const FIXTURE = resolve("test/fixtures/health/export.xml");

async function collect(path: string): Promise<ExportEntry[]> {
  const out: ExportEntry[] = [];
  for await (const e of readExport(path)) out.push(e);
  return out;
}

describe("readExport", () => {
  it("reads a plain xml file, so tests never need a zip", async () => {
    const all = await collect(FIXTURE);
    expect(all.length).toBe(13);
  });

  it("strips the Apple identifier prefix from the type", async () => {
    const all = await collect(FIXTURE);
    const types = all.filter((e) => e.kind === "record").map((e) => e.type);
    expect(types).toContain("RestingHeartRate");
    expect(types).toContain("SleepAnalysis");
    expect(types.some((t) => t.startsWith("HK"))).toBe(false);
  });

  it("keeps the raw value and unit — parsing belongs to the rollup", async () => {
    const rhr = (await collect(FIXTURE)).find(
      (e) => e.kind === "record" && e.type === "RestingHeartRate",
    );
    expect(rhr).toMatchObject({ kind: "record", value: "52", unit: "count/min" });
  });

  it("reads a record whose opening tag is followed by child elements", async () => {
    // DietaryProtein is not self-closing: <MetadataEntry> children follow and a
    // </Record> closes it. Only the opening line carries the attributes.
    const protein = (await collect(FIXTURE)).filter(
      (e) => e.kind === "record" && e.type === "DietaryProtein",
    );
    expect(protein).toHaveLength(1);
    expect(protein[0]).toMatchObject({ value: "4.4" });
  });

  it("reads workouts, with duration and the energy from WorkoutStatistics", async () => {
    const workouts = (await collect(FIXTURE)).filter((e) => e.kind === "workout");
    expect(workouts).toHaveLength(2);
    expect(workouts[0]).toMatchObject({
      type: "TraditionalStrengthTraining",
      durationMin: 47.5,
      energyKcal: 312.4,
    });
    // The second workout has no statistics block at all.
    expect(workouts[1]).toMatchObject({ type: "Walking", energyKcal: null });
  });

  it("carries dates through verbatim — the rollup decides what a day is", async () => {
    const sleep = (await collect(FIXTURE)).filter(
      (e) => e.kind === "record" && e.type === "SleepAnalysis",
    );
    expect(sleep[0]).toMatchObject({
      startDate: "2026-03-01 23:10:00 +0100",
      endDate: "2026-03-02 02:40:00 +0100",
    });
  });

  it("reports a missing file rather than yielding nothing", async () => {
    await expect(collect("./does-not-exist.xml")).rejects.toThrow(/does-not-exist/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/health-reader.test.ts`
Expected: FAIL — `Failed to load url .../reader.ts`.

- [ ] **Step 4: Write minimal implementation**

Hozd létre a `src/infra/health-export/reader.ts` fájlt:

```typescript
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface HealthRecordEntry {
  kind: "record";
  /** Apple's identifier prefix stripped: 'RestingHeartRate', 'SleepAnalysis'. */
  type: string;
  unit: string | null;
  /** Raw. Numeric parsing belongs to the rollup, which knows what each type means. */
  value: string;
  /** Verbatim, e.g. '2026-03-01 23:10:00 +0100'. Not ISO 8601. */
  startDate: string;
  endDate: string;
  source: string;
}

export interface WorkoutEntry {
  kind: "workout";
  type: string;
  durationMin: number;
  energyKcal: number | null;
  startDate: string;
  endDate: string;
  source: string;
}

export type ExportEntry = HealthRecordEntry | WorkoutEntry;

const ATTR = /(\w+)="([^"]*)"/g;

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(ATTR)) out[m[1]!] = m[2]!;
  return out;
}

/** 'HKQuantityTypeIdentifierRestingHeartRate' -> 'RestingHeartRate'. */
function shortType(raw: string): string {
  return raw
    .replace("HKQuantityTypeIdentifier", "")
    .replace("HKCategoryTypeIdentifier", "")
    .replace("HKWorkoutActivityType", "");
}

/**
 * Streams the export.
 *
 * Node has no built-in zip reader and this project takes no new runtime
 * dependencies, so a `.zip` is piped through `unzip -p`. Accepting a plain
 * `.xml` as well is what lets the tests use a hand-written fixture with no
 * archive machinery at all — the 1 GB real export never belongs in a test.
 */
export async function* readExport(path: string): AsyncGenerator<ExportEntry> {
  if (!existsSync(path)) throw new Error(`No such export file: ${path}`);

  let stream: Readable;
  let child: ReturnType<typeof spawn> | undefined;

  if (path.endsWith(".zip")) {
    child = spawn("unzip", ["-p", path, "apple_health_export/export.xml"]);
    stream = child.stdout!;
  } else {
    stream = createReadStream(path);
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  // A workout's energy arrives in a child element after its opening tag, so the
  // workout is held back until its block closes.
  let pending: WorkoutEntry | undefined;

  try {
    for await (const line of lines) {
      const t = line.trimStart();

      if (t.startsWith("<Record ")) {
        const a = attrs(t);
        if (!a.type || !a.startDate) continue;
        yield {
          kind: "record",
          type: shortType(a.type),
          unit: a.unit ?? null,
          value: a.value ?? "",
          startDate: a.startDate,
          endDate: a.endDate ?? a.startDate,
          source: a.sourceName ?? "",
        };
        continue;
      }

      if (t.startsWith("<Workout ")) {
        if (pending) yield pending;
        const a = attrs(t);
        pending = {
          kind: "workout",
          type: shortType(a.workoutActivityType ?? ""),
          durationMin: Number(a.duration ?? 0),
          energyKcal: null,
          startDate: a.startDate ?? "",
          endDate: a.endDate ?? a.startDate ?? "",
          source: a.sourceName ?? "",
        };
        // A self-closing workout has no statistics to wait for.
        if (t.endsWith("/>")) { yield pending; pending = undefined; }
        continue;
      }

      if (pending && t.startsWith("<WorkoutStatistics ")) {
        const a = attrs(t);
        if (a.type?.endsWith("ActiveEnergyBurned") && a.sum) {
          pending.energyKcal = Number(a.sum);
        }
        continue;
      }

      if (pending && t.startsWith("</Workout>")) {
        yield pending;
        pending = undefined;
      }
    }
    if (pending) yield pending;
  } finally {
    lines.close();
    child?.kill();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/core/health-reader.test.ts`
Expected: PASS (7 teszt)

- [ ] **Step 6: Commit**

```bash
git add src/infra/health-export/reader.ts test/fixtures/health/export.xml test/core/health-reader.test.ts
git commit -m "feat: streaming reader for the Apple Health export"
```

---

## Task 2: Az összesítő

A terv szíve, és **pure**: rekord-folyam megy be, napi sorok és edzések jönnek
ki, semmi I/O. Ezért teljesen tesztelhető, és ezért lehet biztosan tudni, hogy az
éjfélen átnyúló alvás a jó naphoz kerül.

**Files:**
- Create: `src/infra/health-export/rollup.ts`
- Test: `test/core/health-rollup.test.ts` (új)

**Interfaces:**
- Consumes: `ExportEntry`, `readExport` (Task 1)
- Produces: `rollup(entries: AsyncIterable<ExportEntry>): Promise<RollupResult>` ahol `RollupResult = { days: DailyValues[]; workouts: WorkoutRow[]; skipped: Record<string, number>; range: {from,to} | null }`, `DailyValues = { date: string; values: Record<string, number> }`, `WorkoutRow = { date, type, startedAt, durationMin, energyKcal, source }`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/health-rollup.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readExport } from "../../src/infra/health-export/reader.ts";
import { rollup } from "../../src/infra/health-export/rollup.ts";

const FIXTURE = resolve("test/fixtures/health/export.xml");
const run = () => rollup(readExport(FIXTURE));
const day = async (d: string) => (await run()).days.find((x) => x.date === d);

describe("rollup", () => {
  it("sums what accumulates through the day", async () => {
    // 1200 + 800 steps on 2026-03-01
    expect((await day("2026-03-01"))!.values.steps).toBe(2000);
  });

  it("averages what is a point measurement", async () => {
    // Two resting heart rates, 52 and 56.
    expect((await day("2026-03-01"))!.values.rhr).toBe(54);
  });

  /**
   * A night crosses midnight, and the brief means "last night" when it says
   * sleep. Attributing a segment to its start date would file most of every
   * night under the previous day.
   */
  it("files a night under the day you woke up on", async () => {
    const first = await day("2026-03-01");
    const second = await day("2026-03-02");

    expect(first?.values.asleep_min).toBeUndefined();
    expect(second!.values.asleep_min).toBe(450); // 210 core + 30 deep + 210 rem
  });

  it("keeps the sleep stages apart", async () => {
    const d = (await day("2026-03-02"))!.values;
    expect(d.core_min).toBe(210);
    expect(d.deep_min).toBe(30);
    expect(d.rem_min).toBe(210);
  });

  it("counts awakenings and keeps time-in-bed separate from time asleep", async () => {
    const d = (await day("2026-03-02"))!.values;
    expect(d.awakenings).toBe(1);
    expect(d.in_bed_min).toBe(480);
    expect(d.in_bed_min).toBeGreaterThan(d.asleep_min!);
  });

  it("derives sleep_h from the minutes, for the existing brief", async () => {
    expect((await day("2026-03-02"))!.values.sleep_h).toBe(7.5);
  });

  it("skips types this product has no use for, and says which", async () => {
    const { skipped, days } = await run();
    expect(skipped.HandwashingEvent).toBe(1);
    for (const d of days) expect(Object.keys(d.values)).not.toContain("HandwashingEvent");
  });

  it("extracts workouts on the day they started", async () => {
    const { workouts } = await run();
    expect(workouts).toHaveLength(2);
    expect(workouts[0]).toMatchObject({
      date: "2026-03-01",
      type: "TraditionalStrengthTraining",
      durationMin: 47.5,
      energyKcal: 312.4,
    });
    expect(workouts[1]).toMatchObject({ date: "2026-03-02", type: "Walking", energyKcal: null });
  });

  it("reports the range it covered", async () => {
    expect((await run()).range).toEqual({ from: "2026-03-01", to: "2026-03-02" });
  });

  it("returns days in date order, so an import writes them predictably", async () => {
    const dates = (await run()).days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/health-rollup.test.ts`
Expected: FAIL — `Failed to load url .../rollup.ts`.

- [ ] **Step 3: Write minimal implementation**

Hozd létre a `src/infra/health-export/rollup.ts` fájlt:

```typescript
import type { ExportEntry } from "./reader.ts";

export interface DailyValues {
  /** YYYY-MM-DD, already local: the export carries the offset it was recorded in. */
  date: string;
  values: Record<string, number>;
}

export interface WorkoutRow {
  date: string;
  type: string;
  /** ISO instant, the natural key together with type. */
  startedAt: string;
  durationMin: number;
  energyKcal: number | null;
  source: string;
}

export interface RollupResult {
  days: DailyValues[];
  workouts: WorkoutRow[];
  /** Types deliberately not stored, with counts — so the import can report them. */
  skipped: Record<string, number>;
  range: { from: string; to: string } | null;
}

/**
 * The fifteen types worth keeping, of the forty-seven the export contains.
 *
 * `sum` is for what accumulates through a day (steps, calories eaten); `avg` is
 * for point measurements taken more than once (resting heart rate). Everything
 * absent from this map is skipped: handwashing events, headphone volume and
 * gait asymmetry are not what a morning assistant reasons about.
 */
const DAILY: Record<string, { column: string; agg: "sum" | "avg" }> = {
  RestingHeartRate: { column: "rhr", agg: "avg" },
  HeartRateVariabilitySDNN: { column: "hrv", agg: "avg" },
  VO2Max: { column: "vo2max", agg: "avg" },
  WalkingHeartRateAverage: { column: "walking_hr", agg: "avg" },
  HeartRateRecoveryOneMinute: { column: "hr_recovery", agg: "avg" },
  ActiveEnergyBurned: { column: "move_kcal", agg: "sum" },
  BasalEnergyBurned: { column: "basal_kcal", agg: "sum" },
  StepCount: { column: "steps", agg: "sum" },
  AppleExerciseTime: { column: "exercise_min", agg: "sum" },
  FlightsClimbed: { column: "flights", agg: "sum" },
  DietaryEnergyConsumed: { column: "diet_kcal", agg: "sum" },
  DietaryProtein: { column: "diet_protein_g", agg: "sum" },
  DietaryCarbohydrates: { column: "diet_carbs_g", agg: "sum" },
  DietaryFatTotal: { column: "diet_fat_g", agg: "sum" },
};

const STAGE: Record<string, string> = {
  HKCategoryValueSleepAnalysisAsleepCore: "core_min",
  HKCategoryValueSleepAnalysisAsleepREM: "rem_min",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep_min",
};

/**
 * '2026-03-01 23:10:00 +0100' -> a local day and an instant.
 *
 * The export is not ISO 8601, but it carries the offset it was recorded in —
 * so the first ten characters are already the local calendar day, with no
 * conversion. That is also the honest answer when you travel: the day you
 * actually lived.
 */
function parseAppleDate(s: string): { day: string; ms: number } {
  const day = s.slice(0, 10);
  const iso = `${day}T${s.slice(11, 19)}${s.slice(20, 23)}:${s.slice(23, 25)}`;
  return { day, ms: Date.parse(iso) };
}

const minutes = (fromMs: number, toMs: number) => Math.round((toMs - fromMs) / 60_000);

export async function rollup(entries: AsyncIterable<ExportEntry>): Promise<RollupResult> {
  const sums = new Map<string, Record<string, number>>();
  const counts = new Map<string, Record<string, number>>();
  const workouts: WorkoutRow[] = [];
  const skipped: Record<string, number> = {};
  let from: string | undefined;
  let to: string | undefined;

  const bump = (day: string, column: string, value: number) => {
    const s = sums.get(day) ?? {};
    const c = counts.get(day) ?? {};
    s[column] = (s[column] ?? 0) + value;
    c[column] = (c[column] ?? 0) + 1;
    sums.set(day, s);
    counts.set(day, c);
    if (!from || day < from) from = day;
    if (!to || day > to) to = day;
  };

  for await (const e of entries) {
    if (e.kind === "workout") {
      const started = parseAppleDate(e.startDate);
      workouts.push({
        date: started.day,
        type: e.type,
        startedAt: new Date(started.ms).toISOString(),
        durationMin: e.durationMin,
        energyKcal: e.energyKcal,
        source: e.source,
      });
      if (!from || started.day < from) from = started.day;
      if (!to || started.day > to) to = started.day;
      continue;
    }

    if (e.type === "SleepAnalysis") {
      const start = parseAppleDate(e.startDate);
      const end = parseAppleDate(e.endDate);
      // The day you woke up on, not the day you lay down.
      const day = end.day;
      const mins = minutes(start.ms, end.ms);

      if (e.value === "HKCategoryValueSleepAnalysisInBed") {
        bump(day, "in_bed_min", mins);
      } else if (e.value === "HKCategoryValueSleepAnalysisAwake") {
        bump(day, "awakenings", 1);
      } else {
        // Core, REM, Deep and Unspecified all count as asleep; only the three
        // named stages also get their own column.
        bump(day, "asleep_min", mins);
        const stage = STAGE[e.value];
        if (stage) bump(day, stage, mins);
      }
      continue;
    }

    const spec = DAILY[e.type];
    if (!spec) {
      skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }

    const value = Number(e.value);
    if (!Number.isFinite(value)) {
      skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }
    bump(parseAppleDate(e.startDate).day, spec.column, value);
  }

  const days: DailyValues[] = [...sums.keys()].sort().map((date) => {
    const s = sums.get(date)!;
    const c = counts.get(date)!;
    const values: Record<string, number> = {};

    for (const [column, total] of Object.entries(s)) {
      const spec = Object.values(DAILY).find((d) => d.column === column);
      values[column] = spec?.agg === "avg"
        ? Math.round((total / c[column]!) * 100) / 100
        : total;
    }

    // The existing brief reads sleep in hours; keep it derived rather than
    // stored twice from two sources.
    if (values.asleep_min !== undefined) {
      values.sleep_h = Math.round((values.asleep_min / 60) * 10) / 10;
    }
    return { date, values };
  });

  return {
    days,
    workouts,
    skipped,
    range: from && to ? { from, to } : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/health-rollup.test.ts`
Expected: PASS (10 teszt)

- [ ] **Step 5: Commit**

```bash
git add src/infra/health-export/rollup.ts test/core/health-rollup.test.ts
git commit -m "feat: roll Apple Health records into daily values and workouts"
```

---

## Task 3: Séma és a nem-felülíró írás

**Files:**
- Create: `src/infra/db/migrations/004_health_history.sql`
- Modify: `src/infra/db/repositories/health.ts`
- Test: `test/core/health-fillgaps.test.ts` (új)

**Interfaces:**
- Consumes: semmit
- Produces: `HISTORY_COLUMNS: ReadonlySet<string>` és `HealthRepo.fillGaps(date: string, values: Record<string, number>, now: Date): void` a `src/infra/db/repositories/health.ts`-ből.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/health-fillgaps.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";

const NOW = new Date("2026-08-31T10:00:00Z");

describe("fillGaps", () => {
  it("writes a day that did not exist", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52, steps: 8400, sleep_h: 7.2 }, NOW);

    const row = repo.forDate("2026-03-02")!;
    expect(row.rhr).toBe(52);
    expect(row.steps).toBe(8400);
    db.close();
  });

  /**
   * The phone posts today's readings each morning. A monthly re-import must
   * not overwrite them with whatever the export happened to contain — the
   * export is a snapshot taken at some point, the POST is what arrived today.
   */
  it("never overwrites a measurement that is already there", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(
      { date: "2026-08-31", sleepH: null, hrv: 87, rhr: 57,
        moveKcal: null, exerciseMin: null, steps: null },
      { hrv: 87, rhr: 57 },
      NOW,
    );
    repo.fillGaps("2026-08-31", { hrv: 12, rhr: 99, steps: 5000 }, NOW);

    const row = repo.forDate("2026-08-31")!;
    expect(row.hrv).toBe(87);   // untouched
    expect(row.rhr).toBe(57);   // untouched
    expect(row.steps).toBe(5000); // was NULL, so filled
    db.close();
  });

  it("is idempotent — running it twice changes nothing", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52 }, NOW);
    repo.fillGaps("2026-03-02", { rhr: 99 }, NOW);

    expect(repo.forDate("2026-03-02")!.rhr).toBe(52);
    db.close();
  });

  it("refuses a column that is not in the allowlist", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    // The column names come from the rollup, but they still reach SQL — an
    // allowlist is what keeps that boundary honest.
    expect(() => repo.fillGaps("2026-03-02", { "steps; DROP TABLE briefs": 1 }, NOW))
      .toThrow(/unknown column/i);
    db.close();
  });

  it("does nothing at all when given no values", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);
    repo.fillGaps("2026-03-02", {}, NOW);
    expect(repo.forDate("2026-03-02")).toBeUndefined();
    db.close();
  });

  it("exposes the new history columns on the snapshot", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { asleep_min: 430, deep_min: 30, vo2max: 41.2, diet_protein_g: 118 }, NOW);

    const row = repo.forDate("2026-03-02")!;
    expect(row.asleepMin).toBe(430);
    expect(row.deepMin).toBe(30);
    expect(row.vo2max).toBe(41.2);
    expect(row.dietProteinG).toBe(118);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/health-fillgaps.test.ts`
Expected: FAIL — `fillGaps` nem létezik, és az új oszlopok sincsenek meg.

- [ ] **Step 3: Write the migration**

Hozd létre a `src/infra/db/migrations/004_health_history.sql` fájlt:

```sql
-- Seven and a half years of Apple Health history, at daily resolution.
--
-- The export holds 2.4 million raw samples and re-reads in nine seconds, so
-- storing raw samples would buy nothing that a re-import cannot: the source of
-- truth stays in the zip, and the database holds what the analysis layer
-- actually reads.
--
-- One row per day whatever the source. The iOS Shortcut writes today's
-- readings; the import fills gaps in any day. They never compete, because the
-- import only ever writes a column that is NULL.

ALTER TABLE health_snapshots ADD COLUMN asleep_min     REAL;
ALTER TABLE health_snapshots ADD COLUMN in_bed_min     REAL;
ALTER TABLE health_snapshots ADD COLUMN core_min       REAL;
ALTER TABLE health_snapshots ADD COLUMN rem_min        REAL;
ALTER TABLE health_snapshots ADD COLUMN deep_min       REAL;
ALTER TABLE health_snapshots ADD COLUMN awakenings     REAL;
ALTER TABLE health_snapshots ADD COLUMN vo2max         REAL;
ALTER TABLE health_snapshots ADD COLUMN hr_recovery    REAL;
ALTER TABLE health_snapshots ADD COLUMN walking_hr     REAL;
ALTER TABLE health_snapshots ADD COLUMN basal_kcal     REAL;
ALTER TABLE health_snapshots ADD COLUMN flights        REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_kcal      REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_protein_g REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_carbs_g   REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_fat_g     REAL;

-- Workouts do not fit the daily row: there can be several in a day, and each
-- has its own type, length and cost. (started_at, type) is the natural key —
-- re-importing the same export must not duplicate them.
CREATE TABLE IF NOT EXISTS workouts (
  started_at    TEXT NOT NULL,
  type          TEXT NOT NULL,
  date          TEXT NOT NULL,           -- YYYY-MM-DD, the day it began
  duration_min  REAL NOT NULL,
  energy_kcal   REAL,
  source        TEXT,
  PRIMARY KEY (started_at, type)
);
CREATE INDEX IF NOT EXISTS workouts_date_idx ON workouts (date DESC);
```

- [ ] **Step 4: Extend the repository**

`src/infra/db/repositories/health.ts` — bővítsd a `HealthSnapshot` interfészt az
új mezőkkel camelCase néven (`asleepMin`, `inBedMin`, `coreMin`, `remMin`,
`deepMin`, `awakenings`, `vo2max`, `hrRecovery`, `walkingHr`, `basalKcal`,
`flights`, `dietKcal`, `dietProteinG`, `dietCarbsG`, `dietFatG`), mindegyik
`number | null`. Bővítsd a `Row` interfészt és a `toSnapshot` leképezést a
megfelelő snake_case oszlopokkal.

Told a fájl tetejére az oszlop-engedélylistát és a fájl végére a `fillGaps`-t:

```typescript
/**
 * Every column the import is allowed to write.
 *
 * The names come from the rollup's own configuration, not from user input —
 * but they are interpolated into SQL, and a boundary that is only safe by
 * convention stops being safe the first time someone extends the rollup.
 */
export const HISTORY_COLUMNS: ReadonlySet<string> = new Set([
  "sleep_h", "hrv", "rhr", "move_kcal", "exercise_min", "steps",
  "asleep_min", "in_bed_min", "core_min", "rem_min", "deep_min", "awakenings",
  "vo2max", "hr_recovery", "walking_hr", "basal_kcal", "flights",
  "diet_kcal", "diet_protein_g", "diet_carbs_g", "diet_fat_g",
]);
```

és a `HealthRepo` interfészbe:

```typescript
  /**
   * Writes only the columns that are currently NULL.
   *
   * This is what lets a monthly re-import run without thought: today's row
   * already holds what the phone posted this morning, and the export must not
   * replace it. COALESCE says exactly that, declaratively — no provenance
   * tracking needed.
   */
  fillGaps(date: string, values: Record<string, number>, now: Date): void;
```

implementációval:

```typescript
    fillGaps(date, values, now) {
      const columns = Object.keys(values);
      if (columns.length === 0) return;

      for (const c of columns) {
        if (!HISTORY_COLUMNS.has(c)) throw new Error(`Unknown column: ${c}`);
      }

      const placeholders = columns.map(() => "?").join(", ");
      const keep = columns
        .map((c) => `${c} = COALESCE(health_snapshots.${c}, excluded.${c})`)
        .join(", ");

      db.run(
        `INSERT INTO health_snapshots (date, ${columns.join(", ")}, ingested_at)
         VALUES (?, ${placeholders}, ?)
         ON CONFLICT (date) DO UPDATE SET ${keep}`,
        date, ...columns.map((c) => values[c]!), now.toISOString(),
      );
    },
```

> Az `ingested_at` szándékosan nincs az `ON CONFLICT` listájában: azt jelenti,
> mikor küldött a telefon, és egy import nem hazudhatja azt, hogy ő volt.

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run typecheck`
Expected: minden zöld. Ha egy meglévő teszt a `HealthSnapshot` teljes alakját
építi, told bele az új mezőket `null`-ként.

- [ ] **Step 6: Commit**

```bash
git add src/infra/db/migrations/004_health_history.sql src/infra/db/repositories/health.ts test/core/health-fillgaps.test.ts
git commit -m "feat: daily history columns and a write that never overwrites"
```

---

## Task 4: Edzés-tár

**Files:**
- Create: `src/infra/db/repositories/workouts.ts`
- Modify: `src/app.ts`
- Test: `test/core/workouts.test.ts` (új)

**Interfaces:**
- Consumes: `WorkoutRow` (Task 2), a `workouts` tábla (Task 3)
- Produces: `createWorkoutRepo(db: Db): WorkoutRepo` `save(rows: readonly WorkoutRow[]): number`, `forDate(date)`, `between(from, to)` metódusokkal. `App.workouts`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/workouts.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import type { WorkoutRow } from "../../src/infra/health-export/rollup.ts";

const strength = (startedAt: string, date: string): WorkoutRow => ({
  date, type: "TraditionalStrengthTraining", startedAt,
  durationMin: 47.5, energyKcal: 312.4, source: "Watch",
});

describe("workout store", () => {
  it("saves and reports how many were new", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    expect(repo.save([strength("2026-03-01T16:00:00.000Z", "2026-03-01")])).toBe(1);
    db.close();
  });

  it("is idempotent — a re-import adds nothing", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    const rows = [strength("2026-03-01T16:00:00.000Z", "2026-03-01")];

    repo.save(rows);
    expect(repo.save(rows)).toBe(0);
    expect(repo.forDate("2026-03-01")).toHaveLength(1);
    db.close();
  });

  it("keeps two different workouts that started at the same moment", () => {
    // Rare but real: the key is (started_at, type), not started_at alone.
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      strength("2026-03-01T16:00:00.000Z", "2026-03-01"),
      { ...strength("2026-03-01T16:00:00.000Z", "2026-03-01"), type: "Cooldown" },
    ]);
    expect(repo.forDate("2026-03-01")).toHaveLength(2);
    db.close();
  });

  it("returns a range in date order, for trend queries", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      strength("2026-03-03T16:00:00.000Z", "2026-03-03"),
      strength("2026-03-01T16:00:00.000Z", "2026-03-01"),
      strength("2026-03-05T16:00:00.000Z", "2026-03-05"),
    ]);

    const range = repo.between("2026-03-01", "2026-03-03");
    expect(range.map((w) => w.date)).toEqual(["2026-03-01", "2026-03-03"]);
    db.close();
  });

  it("keeps a workout with no energy reading", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([{ ...strength("2026-03-02T11:00:00.000Z", "2026-03-02"), energyKcal: null }]);
    expect(repo.forDate("2026-03-02")[0]!.energyKcal).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/workouts.test.ts`
Expected: FAIL — `Failed to load url .../workouts.ts`.

- [ ] **Step 3: Write minimal implementation**

Hozd létre a `src/infra/db/repositories/workouts.ts` fájlt:

```typescript
import type { Db } from "../index.ts";
import type { WorkoutRow } from "../../health-export/rollup.ts";

export interface WorkoutRepo {
  /** Inserts what is new. Returns how many rows were actually added. */
  save(rows: readonly WorkoutRow[]): number;
  forDate(date: string): WorkoutRow[];
  /** Inclusive on both ends, oldest first. */
  between(from: string, to: string): WorkoutRow[];
}

interface Row {
  started_at: string; type: string; date: string;
  duration_min: number; energy_kcal: number | null; source: string | null;
}

const toWorkout = (r: Row): WorkoutRow => ({
  date: r.date,
  type: r.type,
  startedAt: r.started_at,
  durationMin: r.duration_min,
  energyKcal: r.energy_kcal,
  source: r.source ?? "",
});

/**
 * Workouts, keyed by when they started and what they were.
 *
 * A monthly re-import replays years of the same workouts, so the insert has to
 * be a no-op for anything already stored — `INSERT OR IGNORE` against the
 * natural key, rather than a read-then-write that would be slower and racier.
 */
export function createWorkoutRepo(db: Db): WorkoutRepo {
  return {
    save(rows) {
      if (rows.length === 0) return 0;

      const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workouts")?.n ?? 0;
      db.transaction(() => {
        for (const w of rows) {
          db.run(
            `INSERT OR IGNORE INTO workouts
               (started_at, type, date, duration_min, energy_kcal, source)
             VALUES (?, ?, ?, ?, ?, ?)`,
            w.startedAt, w.type, w.date, w.durationMin, w.energyKcal, w.source,
          );
        }
      });
      const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workouts")?.n ?? 0;
      return after - before;
    },

    forDate(date) {
      return db
        .all<Row>("SELECT * FROM workouts WHERE date = ? ORDER BY started_at", date)
        .map(toWorkout);
    },

    between(from, to) {
      return db
        .all<Row>(
          "SELECT * FROM workouts WHERE date >= ? AND date <= ? ORDER BY date, started_at",
          from, to,
        )
        .map(toWorkout);
    },
  };
}
```

- [ ] **Step 4: Expose it from the composition root**

`src/app.ts` — importáld a `createWorkoutRepo`-t és a `WorkoutRepo` típust, vedd
fel az `App` interfészbe `workouts: WorkoutRepo;` néven, hozd létre a többi repo
mellett, és told bele a visszatérési objektumba.

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 6: Commit**

```bash
git add src/infra/db/repositories/workouts.ts src/app.ts test/core/workouts.test.ts
git commit -m "feat: workout store, idempotent under re-import"
```

---

## Task 5: Az import parancs

**Files:**
- Create: `scripts/import-health.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `readExport` (T1), `rollup` (T2), `HealthRepo.fillGaps` (T3), `WorkoutRepo.save` (T4)
- Produces: `npm run import-health -- <path>`

- [ ] **Step 1: Write the script**

Hozd létre a `scripts/import-health.ts` fájlt:

```typescript
/**
 * Imports an Apple Health export into the daily history.
 *
 *   npm run import-health -- ~/Downloads/export.zip
 *   npm run import-health -- ./export.xml          # already unzipped
 *
 * Safe to re-run. The export is a snapshot of everything Health holds, so a
 * monthly run replays years of the same days — the writes are built to be
 * no-ops for anything already stored, and to never overwrite a measurement the
 * phone posted.
 */
import { createApp } from "../src/app.ts";
import { readExport } from "../src/infra/health-export/reader.ts";
import { rollup } from "../src/infra/health-export/rollup.ts";

process.env.LOG_LEVEL ??= "error";

const path = process.argv[2];
if (!path) {
  console.error("Használat: npm run import-health -- <export.zip vagy export.xml>");
  process.exit(64);
}

const app = createApp();
const started = Date.now();

console.log(`Olvasás: ${path}`);
const { days, workouts, skipped, range } = await rollup(readExport(path));

if (!range) {
  console.error("Az export nem tartalmazott feldolgozható rekordot.");
  app.close();
  process.exit(1);
}

console.log(`  ${days.length} nap · ${workouts.length} edzés · ${range.from} .. ${range.to}`);

// One transaction for ~2,750 statements: without it each write would fsync on
// its own and the import would take minutes instead of seconds.
app.db.transaction(() => {
  const now = app.clock.now();
  for (const day of days) app.health.fillGaps(day.date, day.values, now);
});
const newWorkouts = app.workouts.save(workouts);

// What actually landed, counted from the database rather than from what we
// intended to write.
const stored = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM health_snapshots")?.n ?? 0;
const totalWorkouts = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workouts")?.n ?? 0;

console.log();
console.log(`✓ ${stored} nap az adatbázisban · ${totalWorkouts} edzés (ebből most új: ${newWorkouts})`);
console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} másodperc`);

const ignored = Object.entries(skipped).sort((a, b) => b[1] - a[1]);
if (ignored.length > 0) {
  console.log();
  console.log(`Kihagyott típusok (${ignored.length}), a legnagyobbak:`);
  for (const [type, n] of ignored.slice(0, 8)) {
    console.log(`  ${type.padEnd(34)} ${n.toLocaleString("hu-HU")}`);
  }
}

app.close();
```

- [ ] **Step 2: Add the npm script**

`package.json` — a `scripts` blokkba:

```json
    "import-health": "node --env-file-if-exists=.env scripts/import-health.ts",
```

- [ ] **Step 3: Record today's row before importing**

Az élesen futó adatbázisban a mai sor **már tartalmazza** a telefon adatát. Írd
ki, mielőtt importálnál, hogy a következő lépésben bizonyítható legyen, hogy nem
változott:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('./data/jarvis.db',{readOnly:true});
console.log(JSON.stringify(db.prepare('SELECT * FROM health_snapshots WHERE date=?').get(new Date().toISOString().slice(0,10))));
db.close();
"
```

- [ ] **Step 4: Run the real import**

```bash
npm run import-health -- ~/Downloads/export.zip
```

Expected: néhány ezer nap, ~2390 edzés, `2019-02-13 .. 2026-08-31`, és a kihagyott
típusok listája. Illeszd be a teljes kimenetet a riportba.

- [ ] **Step 5: Prove the phone's data survived**

Futtasd újra a 3. lépés parancsát, és hasonlítsd össze. A `hrv` és `rhr` mezőnek
**változatlannak** kell lennie.

Ezután futtasd az importot **még egyszer** ugyanazzal a zippel, és nézd meg, hogy
az „ebből most új" szám **0** — ez az idempotencia bizonyítéka éles adaton.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test && npm run typecheck`

```bash
git add scripts/import-health.ts package.json
git commit -m "feat: import an Apple Health export into the daily history"
```

---

## Task 6: Havi előfizetés-pillanatkép

**Files:**
- Create: `src/infra/db/migrations/005_subscription_months.sql`
- Create: `src/infra/db/repositories/subscription-months.ts`
- Modify: `src/app.ts`, `src/main.ts`, `src/infra/scheduler.ts`
- Test: `test/core/subscription-months.test.ts` (új)

**Interfaces:**
- Consumes: `SubscriptionRepo` (meglévő)
- Produces: `createSubscriptionMonthRepo(db): SubscriptionMonthRepo` `record(month, subs, now)`, `forMonth(month)`, `months()` metódusokkal. `App.subscriptionMonths`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/subscription-months.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createSubscriptionMonthRepo } from "../../src/infra/db/repositories/subscription-months.ts";

const NOW = new Date("2026-08-31T10:00:00Z");
const subs = [
  { name: "Netflix", amountHuf: 4490, cycle: "monthly" as const, active: true },
  { name: "Gym", amountHuf: 19900, cycle: "monthly" as const, active: true },
];

describe("monthly subscription snapshot", () => {
  it("records what was active in a month", () => {
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-08", subs, NOW);

    const august = repo.forMonth("2026-08");
    expect(august.map((s) => s.name).sort()).toEqual(["Gym", "Netflix"]);
    expect(august.find((s) => s.name === "Netflix")!.amountHuf).toBe(4490);
    db.close();
  });

  it("overwrites the same month rather than accumulating duplicates", () => {
    // It runs on every start and every night: the month-end state is what counts.
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-08", subs, NOW);
    repo.record("2026-08", [{ ...subs[0]!, amountHuf: 4990 }], NOW);

    const august = repo.forMonth("2026-08");
    expect(august).toHaveLength(1);
    expect(august[0]!.amountHuf).toBe(4990);
    db.close();
  });

  it("keeps months apart, which is the whole point", () => {
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-07", [{ ...subs[0]!, amountHuf: 3990 }], NOW);
    repo.record("2026-08", [{ ...subs[0]!, amountHuf: 4490 }], NOW);

    expect(repo.forMonth("2026-07")[0]!.amountHuf).toBe(3990);
    expect(repo.forMonth("2026-08")[0]!.amountHuf).toBe(4490);
    expect(repo.months()).toEqual(["2026-07", "2026-08"]);
    db.close();
  });

  it("records an inactive subscription too, so a cancellation is visible", () => {
    const db = memoryDb();
    const repo = createSubscriptionMonthRepo(db);

    repo.record("2026-08", [{ ...subs[0]!, active: false }], NOW);
    expect(repo.forMonth("2026-08")[0]!.active).toBe(false);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/subscription-months.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the migration**

Hozd létre a `src/infra/db/migrations/005_subscription_months.sql` fájlt:

```sql
-- What you were paying for, month by month.
--
-- The `subscriptions` table only ever knew the present: `last_used_at` is
-- overwritten in place and a price change leaves no trace. So "how does this
-- month compare to spring" was not a hard query — it was an unanswerable one.
--
-- This table has no history before the day it was created, and that is
-- deliberate: reconstructing past months from `next_renewal` and `cycle` would
-- assume prices never changed. That would be an estimate wearing the clothes
-- of a measurement.
CREATE TABLE IF NOT EXISTS subscription_months (
  month       TEXT NOT NULL,             -- YYYY-MM
  name        TEXT NOT NULL,
  amount_huf  INTEGER NOT NULL,
  cycle       TEXT NOT NULL,
  active      INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (month, name)
);
```

- [ ] **Step 4: Write the repository**

Hozd létre a `src/infra/db/repositories/subscription-months.ts` fájlt:

```typescript
import type { Db } from "../index.ts";

export interface MonthlySubscription {
  name: string;
  amountHuf: number;
  cycle: string;
  active: boolean;
}

export interface SubscriptionMonthRepo {
  /** Replaces the month's snapshot. The month-end state is what is kept. */
  record(month: string, subs: readonly MonthlySubscription[], now: Date): void;
  forMonth(month: string): MonthlySubscription[];
  /** Every month on record, oldest first. */
  months(): string[];
}

interface Row {
  name: string; amount_huf: number; cycle: string; active: number;
}

export function createSubscriptionMonthRepo(db: Db): SubscriptionMonthRepo {
  return {
    record(month, subs, now) {
      db.transaction(() => {
        for (const s of subs) {
          db.run(
            `INSERT INTO subscription_months (month, name, amount_huf, cycle, active, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (month, name) DO UPDATE SET
               amount_huf = excluded.amount_huf,
               cycle = excluded.cycle,
               active = excluded.active,
               recorded_at = excluded.recorded_at`,
            month, s.name, s.amountHuf, s.cycle, s.active ? 1 : 0, now.toISOString(),
          );
        }
      });
    },

    forMonth(month) {
      return db
        .all<Row>("SELECT * FROM subscription_months WHERE month = ? ORDER BY name", month)
        .map((r) => ({
          name: r.name, amountHuf: r.amount_huf, cycle: r.cycle, active: r.active === 1,
        }));
    },

    months() {
      return db
        .all<{ month: string }>("SELECT DISTINCT month FROM subscription_months ORDER BY month")
        .map((r) => r.month);
    },
  };
}
```

- [ ] **Step 5: Record the snapshot from the two hooks that already exist**

Ez nem kerül a kérés-útvonalba. Két meglévő pont elég:

`src/app.ts` — vedd fel a repót az `App`-ba (`subscriptionMonths`), a többi mellé.

`src/main.ts` — indulás után, a szerver elindítása előtt:

```typescript
// Recorded at start-up and again in the nightly sweep. Neither is in the request
// path, and between them a month cannot pass unrecorded while the Mac is used.
recordSubscriptionMonth(app);
```

`src/infra/scheduler.ts` — a 04:00-s takarításba is told be ugyanezt a hívást.

A közös függvény a `src/app.ts`-be kerül:

```typescript
/** The current month's subscription state, as it stands right now. */
export function recordSubscriptionMonth(app: Pick<App, "subscriptions" | "subscriptionMonths" | "clock">): void {
  const now = app.clock.now();
  const month = isoDate(now, TZ).slice(0, 7);
  app.subscriptionMonths.record(
    month,
    app.subscriptions.listAll().map((s) => ({
      name: s.name, amountHuf: s.amountHuf, cycle: s.cycle, active: s.active,
    })),
    now,
  );
}
```

> **A `SubscriptionRepo`-nak ma nincs ilyen metódusa** — ellenőrizve: `listActive()`,
> `replaceAll()`, `markUsed()`, `count()`. A `listActive()` **nem elég**: a
> lemondott előfizetésnek is látszania kell a havi képen, különben a hó/hó
> különbségből épp az tűnik el, ami a legérdekesebb.
>
> Ezért ehhez a taskhoz **hozzátartozik egy `listAll(): Subscription[]` felvétele**
> a `src/infra/db/repositories/subscriptions.ts`-be — `SELECT * FROM subscriptions
> ORDER BY name`, szűrés nélkül —, és egy teszt, ami bizonyítja, hogy az inaktív
> sorokat is visszaadja, a `listActive()` pedig változatlanul nem.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/infra/db/migrations/005_subscription_months.sql src/infra/db/repositories/subscription-months.ts src/app.ts src/main.ts src/infra/scheduler.ts test/core/subscription-months.test.ts
git commit -m "feat: monthly subscription snapshot, so spend can be compared over time"
```

---

## Task 7: Dokumentáció és éles ellenőrzés

**Files:**
- Modify: `README.md`, `deploy/README.md`

- [ ] **Step 1: Document the import**

`README.md` — a „Parancsok" szakaszba:

```markdown
npm run import-health -- ~/Downloads/export.zip   # Apple Health export beolvasása
```

és utána:

```markdown
### Egészség-történet

Az iPhone Health appjából (Profil → Összes egészségügyi adat exportálása) kapott
zip évekre visszamenőleg tartalmaz mindent. Egy import beolvassa napi bontásban.

Havonta érdemes újrafuttatni. Biztonságos: a meglévő méréseket soha nem írja
felül, csak a hiányzó mezőket tölti ki, és ugyanaz a zip kétszer futtatva
ugyanazt az állapotot adja.

A napi Shortcut ettől független — az a mai adatot hozza, az import a múltat.
```

- [ ] **Step 2: Verify the whole thing end to end**

```bash
npm test && npm run typecheck && npm run smoke
npm run brief
```

Expected: minden zöld, és a brief továbbra is `synthesizer: "groq"`.

Majd nézd meg, mit tud most az adatbázis:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('./data/jarvis.db',{readOnly:true});
const q=(s)=>db.prepare(s).get();
console.log('napok:      ', q('SELECT COUNT(*) n FROM health_snapshots').n);
console.log('tartomany:  ', q('SELECT MIN(date) a, MAX(date) b FROM health_snapshots').a, '..', q('SELECT MIN(date) a, MAX(date) b FROM health_snapshots').b);
console.log('edzesek:    ', q('SELECT COUNT(*) n FROM workouts').n);
console.log('alvas-napok:', q('SELECT COUNT(*) n FROM health_snapshots WHERE asleep_min IS NOT NULL').n);
console.log('etkezes:    ', q('SELECT COUNT(*) n FROM health_snapshots WHERE diet_protein_g IS NOT NULL').n);
console.log('vo2max:     ', q('SELECT COUNT(*) n FROM health_snapshots WHERE vo2max IS NOT NULL').n);
db.close();
"
```

Írd be a riportba a tényleges számokat. Ezek lesznek az S3 aggregációs réteg
kiindulópontja — és ez az első alkalom, hogy a rendszerben egyáltalán van
történet.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: importing the Apple Health history"
```

---

## Self-review

**Spec coverage**

| Spec szakasz | Task |
|---|---|
| `npm run import-health -- <zip>`, explicit útvonal | 5 |
| Streamelt olvasás, kicsomagolás nélkül | 1 |
| Nincs új futásidejű függőség | 1 (`unzip -p`, nem npm csomag) |
| Idempotencia | 3 (COALESCE), 4 (INSERT OR IGNORE), 5 (éles bizonyítás) |
| Napi összesítés, 15 metrika | 2, 3 |
| Alvás a felébredés napjához | 2 (saját teszt) |
| Alvás-szakaszok, ébredések, ágyban töltött idő | 2 |
| `workouts` tábla | 3, 4 |
| Import nem ír felül létező mérést | 3 (saját teszt), 5 (éles bizonyítás) |
| `subscription_months`, rekonstrukció nélkül | 6 |
| Kézzel írt fixture, a valódi export soha tesztben | 1 |
| Fixture-esetek: éjfél, átfedés, duplikátum, hiányzó mező, ismeretlen típus | 1, 2, 3 |

**Placeholder-ellenőrzés.** Minden lépés tényleges kódot vagy parancsot ad. Ahol
a terv nem tudhat valamit — a `SubscriptionRepo` pontos metódusneve —, ott a
lépés megmondja, hogyan derítsd ki, és mi a követelmény.

**Típus-konzisztencia.** `ExportEntry` / `HealthRecordEntry` / `WorkoutEntry` ·
`readExport` · `rollup` → `RollupResult` / `DailyValues` / `WorkoutRow` ·
`HISTORY_COLUMNS` · `HealthRepo.fillGaps` · `createWorkoutRepo` →
`save`/`forDate`/`between` · `createSubscriptionMonthRepo` →
`record`/`forMonth`/`months` · `recordSubscriptionMonth`. Mindegyik ugyanazzal a
névvel szerepel a definíciójánál és a használatánál. A `WorkoutRow` a
`rollup.ts`-ben születik és a `workouts.ts` importálja — szándékosan, hogy az
összesítő maradjon a forma egyetlen forrása.

**Két dolog, amit a végrehajtó lásson előre.**

A Task 3 bővíti a `HealthSnapshot` típust tizenöt mezővel. Minden teszt, ami
teljes snapshotot épít, `null`-t kell hogy adjon rájuk — a typecheck megtalálja
őket, de a task több fájlt fog érinteni, mint amennyit a fejléce felsorol.

A Task 5 **éles adatbázison fut**, és ez az egyetlen task, ami így tesz. A 3. és
5. lépés együtt bizonyítja, hogy a telefon mai adata túlélte; ezt ne hagyd ki,
mert ez az egész terv legfontosabb viselkedési garanciája.
