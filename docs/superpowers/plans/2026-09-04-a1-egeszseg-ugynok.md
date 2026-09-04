# A1 — Az egészség-ügynök: implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Egy nyomozó ügynök, ami az egészség-történetből olyan megállapítást hoz, amit a tulajdonos magától nem venne észre — és inkább hallgat, mint hogy kitaláljon.

**Architecture:** Menüs hurok. A modell zárt kérdés-készletből választ egy következő lépést JSON-ben, a kód végrehajtja, az eredmény visszamegy. A zárás három kódbeli védelmen kell átmenjen: kimondott hipotézis + utána futtatott cáfolat, viszonyítással címkézett adat, és mintaszám-küszöbök. A modell mögötti hívás egy `InvestigatorModel` interfész mögött van, hogy a hurok hálózat nélkül tesztelhető legyen.

**Tech Stack:** TypeScript, Node 24 natív típusstripping, `node:sqlite`, vitest, `@anthropic-ai/sdk` 0.122.0 (`claude-opus-5`).

## Global Constraints

- **A tesztek hálózat nélkül futnak végig.** A `npm test` egyetlen tesztje sem hívhat API-t. A hurok minden tesztje scriptelt `InvestigatorModel`-t használ.
- **Nincs template fallback.** Ha a modell nem elérhető, a nyomozás nem fut le, és ezt megmondja. Egy elmaradt megállapítás jobb, mint egy hamis.
- **A hurok mindig terminál.** Legfeljebb 10 kör; utána `kifutott`, a részeredmény elmentve.
- **Magyar felhasználói szöveg, angol kód és komment.** A `megallapitas` és a `kerdezz` szövege magyarul megy ki; a kód, a típusnevek és a kommentek angolul, ahogy a repó többi része.
- **A brief továbbra sem mért.** A `SYNTHESIS_CHAIN` marad `groq,template`. Csak az ügynök hív fizetős API-t, és arra plafon van.
- **A modell `claude-opus-5`,** `thinking: { type: "adaptive" }`, `output_config: { effort: "high" }`, streaminggel — ugyanaz a minta, mint [`src/core/synthesis/api.ts`](../../../src/core/synthesis/api.ts).
- **Minden kérdés, ami átlagot vagy trendet ad, hordozza a mintaszám-küszöböt.** A küszöb alatti bontás megnevezve elégtelen, nem kiadva számként.

---

### Task 1: Az `investigations` tábla és a repository

**Files:**
- Create: `src/infra/db/migrations/009_investigations.sql`
- Create: `src/infra/db/repositories/investigations.ts`
- Test: `test/core/investigations-repo.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/infra/db/index.ts`
- Produces: `createInvestigationRepo(db: Db): InvestigationRepo`, `type StoredInvestigation`, `type InvestigationRepo` with `record(entry)`, `recent(n)`, `lastAt()`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/investigations-repo.test.ts
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createInvestigationRepo } from "../../src/infra/db/repositories/investigations.ts";

describe("investigations repo", () => {
  it("stores a finished investigation and reads it back whole", () => {
    const repo = createInvestigationRepo(memoryDb());
    repo.record({
      startedAt: new Date("2026-09-04T05:00:00.000Z"),
      goal: "Miért alacsonyabb ma a regeneráció?",
      outcome: "kesz",
      finding: "Két rossz éjszaka után vagy.",
      transcript: [{ step: { name: "nap", args: { datum: "2026-09-04" }, why: "a mai nap" }, observation: "alvas=6.6" }],
      usd: 0.21,
    });

    const [row] = repo.recent(10);
    expect(row!.goal).toBe("Miért alacsonyabb ma a regeneráció?");
    expect(row!.outcome).toBe("kesz");
    expect(row!.finding).toBe("Két rossz éjszaka után vagy.");
    expect(row!.transcript).toHaveLength(1);
    expect(row!.transcript[0]!.step.name).toBe("nap");
    expect(row!.usd).toBeCloseTo(0.21, 4);
  });

  it("keeps a run that ran out of steps, with no finding", () => {
    const repo = createInvestigationRepo(memoryDb());
    repo.record({
      startedAt: new Date("2026-09-04T05:00:00.000Z"),
      goal: "cél", outcome: "kifutott", finding: null, transcript: [], usd: 0.05,
    });
    const [row] = repo.recent(10);
    expect(row!.outcome).toBe("kifutott");
    expect(row!.finding).toBeNull();
  });

  it("returns newest first, and null when nothing was ever run", () => {
    const repo = createInvestigationRepo(memoryDb());
    expect(repo.lastAt()).toBeNull();
    for (const iso of ["2026-09-01T05:00:00.000Z", "2026-09-03T05:00:00.000Z", "2026-09-02T05:00:00.000Z"]) {
      repo.record({ startedAt: new Date(iso), goal: iso, outcome: "kifutott", finding: null, transcript: [], usd: 0 });
    }
    expect(repo.recent(3).map((r) => r.goal)).toEqual([
      "2026-09-03T05:00:00.000Z", "2026-09-02T05:00:00.000Z", "2026-09-01T05:00:00.000Z",
    ]);
    expect(repo.lastAt()).toBe("2026-09-03T05:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/investigations-repo.test.ts`
Expected: FAIL — `Cannot find module '.../repositories/investigations.ts'`

- [ ] **Step 3: Write the migration**

```sql
-- src/infra/db/migrations/009_investigations.sql
-- What the agent looked at, what it concluded, and what it cost.
--
-- The transcript is stored whole, not summarised. An investigation's finding
-- is only worth as much as the steps behind it, and the failure this table
-- exists to make visible -- a fluent, well-cited, wrong conclusion -- is
-- invisible in the finding alone. Reading the steps back is the only way to
-- tell a real inference from a confident invention.
--
-- `usd` is recorded per run because the $0/month rule is gone: this is the
-- one metered path in the system, and a cost that is never written down is a
-- cost nobody notices.
CREATE TABLE IF NOT EXISTS investigations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  goal        TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('kesz', 'kerdezz', 'kifutott', 'hiba')),
  finding     TEXT,
  transcript  TEXT NOT NULL,   -- JSON array of {step, observation}
  usd         REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS investigations_time ON investigations (started_at DESC);
```

- [ ] **Step 4: Write the repository**

```typescript
// src/infra/db/repositories/investigations.ts
import type { Db } from "../index.ts";

export interface TranscriptEntry {
  step: { name: string; args: Record<string, unknown>; why: string };
  observation: string;
}

export type InvestigationOutcome = "kesz" | "kerdezz" | "kifutott" | "hiba";

export interface StoredInvestigation {
  id: number;
  startedAt: string;
  goal: string;
  outcome: InvestigationOutcome;
  /** The finding, the question asked, or null when there was neither. */
  finding: string | null;
  transcript: TranscriptEntry[];
  usd: number;
}

export interface InvestigationRepo {
  record(entry: {
    startedAt: Date;
    goal: string;
    outcome: InvestigationOutcome;
    finding: string | null;
    transcript: readonly TranscriptEntry[];
    usd: number;
  }): void;
  /** Newest first. */
  recent(n: number): StoredInvestigation[];
  /** ISO instant of the most recent run, or null. */
  lastAt(): string | null;
}

interface Row {
  id: number; started_at: string; goal: string; outcome: InvestigationOutcome;
  finding: string | null; transcript: string; usd: number;
}

const toStored = (r: Row): StoredInvestigation => ({
  id: r.id, startedAt: r.started_at, goal: r.goal, outcome: r.outcome,
  finding: r.finding, usd: r.usd,
  transcript: JSON.parse(r.transcript) as TranscriptEntry[],
});

export function createInvestigationRepo(db: Db): InvestigationRepo {
  return {
    record(entry) {
      db.run(
        "INSERT INTO investigations (started_at, goal, outcome, finding, transcript, usd) VALUES (?, ?, ?, ?, ?, ?)",
        entry.startedAt.toISOString(), entry.goal, entry.outcome, entry.finding,
        JSON.stringify([...entry.transcript]), entry.usd,
      );
    },

    recent(n) {
      return db.all<Row>(
        "SELECT * FROM investigations ORDER BY started_at DESC, id DESC LIMIT ?", n,
      ).map(toStored);
    },

    lastAt() {
      return db.get<{ started_at: string }>(
        "SELECT started_at FROM investigations ORDER BY started_at DESC, id DESC LIMIT 1",
      )?.started_at ?? null;
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/investigations-repo.test.ts && npm run typecheck`
Expected: PASS, 3 tests. Typecheck clean.

- [ ] **Step 6: Verify the migration is picked up**

Run: `npx vitest run test/core/db-migrations.test.ts`
Expected: PASS. If that test enumerates migration filenames, add `009_investigations.sql` to its expected list.

- [ ] **Step 7: Commit**

```bash
git add src/infra/db/migrations/009_investigations.sql src/infra/db/repositories/investigations.ts test/core/investigations-repo.test.ts
git commit -m "feat: az investigations tábla — a nyomozás menete, nem csak a végeredménye"
```

---

### Task 2: Viszonyítással címkézés (2. védelem)

**Files:**
- Create: `src/core/agent/annotate.ts`
- Test: `test/core/agent-annotate.test.ts`

**Interfaces:**
- Consumes: `Point`, `mean`, `stdDev`, `shiftDay` from `src/core/analysis/stats.ts`
- Produces: `baselineFor(points, end, days): Baseline | null`, `annotate(value, base): string`, `type Baseline`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-annotate.test.ts
import { describe, it, expect } from "vitest";
import { baselineFor, annotate } from "../../src/core/agent/annotate.ts";
import type { Point } from "../../src/core/analysis/stats.ts";

/** 90 days of HRV around 55, then the 203.6 that started all of this. */
const points: Point[] = Array.from({ length: 90 }, (_, i) => ({
  date: `2026-0${i < 31 ? "6" : i < 61 ? "7" : "8"}-${String((i % 30) + 1).padStart(2, "0")}`,
  value: 55 + (i % 5) - 2,
}));

describe("baselineFor", () => {
  it("returns null below the sample floor rather than a confident number", () => {
    expect(baselineFor(points.slice(0, 5), "2026-08-30", 90)).toBeNull();
  });

  it("computes mean, sd and the all-time extremes", () => {
    const base = baselineFor(points, "2026-08-30", 90)!;
    expect(base.n).toBeGreaterThanOrEqual(20);
    expect(base.mean).toBeCloseTo(55, 0);
    expect(base.sd).toBeGreaterThan(0);
    expect(base.allTimeMax).toBe(57);
  });
});

describe("annotate", () => {
  it("names the sigma distance so a far value cannot read as ordinary", () => {
    const base = { mean: 55.8, sd: 15.2, n: 84, allTimeMax: 157.1, allTimeMin: 9.9 };
    const text = annotate(203.6, base);
    expect(text).toContain("203,6");
    expect(text).toMatch(/\+9,[0-9]σ/);
    expect(text).toContain("minden idők maximuma");
  });

  it("says nothing beyond the number when the value is ordinary", () => {
    const base = { mean: 55.8, sd: 15.2, n: 84, allTimeMax: 157.1, allTimeMin: 9.9 };
    expect(annotate(57, base)).toBe("57 (+0,1σ)");
  });

  it("marks an all-time low too", () => {
    const base = { mean: 55.8, sd: 15.2, n: 84, allTimeMax: 157.1, allTimeMin: 9.9 };
    expect(annotate(9.9, base)).toContain("minden idők minimuma");
  });

  it("refuses to imply a baseline it does not have", () => {
    expect(annotate(203.6, null)).toBe("203,6 (nincs elég mérés a viszonyításhoz)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/agent-annotate.test.ts`
Expected: FAIL — `Cannot find module '.../agent/annotate.ts'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/agent/annotate.ts
import { mean, stdDev, shiftDay, type Point } from "../analysis/stats.ts";

/**
 * The second defence.
 *
 * The measurement that produced this plan had a 9B model look at
 * `hrv=203.59` -- the highest reading in a four-year history, 9.7 standard
 * deviations from its own baseline -- and write "HRV normális" in its
 * reasoning. Nothing in the observation told it otherwise: a bare number
 * carries no scale.
 *
 * So the code does not decide what is interesting; it labels what the model
 * sees. A value that arrives already carrying its distance from the owner's
 * own baseline cannot casually be called ordinary.
 */
export interface Baseline {
  mean: number;
  sd: number;
  n: number;
  allTimeMax: number;
  allTimeMin: number;
}

/**
 * Below this many measurements there is no baseline worth quoting.
 *
 * Same floor `aggregate()` uses for its 90-day windows: a sigma computed from
 * a handful of days is a number with a false air of authority, and this whole
 * module exists to stop exactly that.
 */
export const MIN_BASELINE_N = 20;

export function baselineFor(points: readonly Point[], end: string, days: number): Baseline | null {
  const first = shiftDay(end, -(days - 1));
  const inside = points.filter((p) => p.date >= first && p.date <= end).map((p) => p.value);
  if (inside.length < MIN_BASELINE_N) return null;

  const m = mean(inside);
  const sd = stdDev(inside);
  if (m === null || sd === null || sd === 0) return null;

  const all = points.map((p) => p.value);
  return {
    mean: m, sd, n: inside.length,
    allTimeMax: Math.max(...all),
    allTimeMin: Math.min(...all),
  };
}

/**
 * Hungarian decimal comma, at most one decimal.
 *
 * Exported because `questions.ts` formats the same numbers for the same two
 * readers — a model and the owner — and two copies of a number formatter is
 * how "203.6" and "203,6" end up in the same observation.
 */
export const hu = (x: number): string =>
  (Math.round(x * 10) / 10).toString().replace(".", ",");

export function annotate(value: number, base: Baseline | null): string {
  if (base === null) return `${hu(value)} (nincs elég mérés a viszonyításhoz)`;

  const sigma = (value - base.mean) / base.sd;
  const marks = [`${sigma >= 0 ? "+" : "−"}${hu(Math.abs(sigma))}σ`];
  if (value >= base.allTimeMax) marks.push("minden idők maximuma");
  if (value <= base.allTimeMin) marks.push("minden idők minimuma");

  return `${hu(value)} (${marks.join(", ")})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-annotate.test.ts && npm run typecheck`
Expected: PASS, 6 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent/annotate.ts test/core/agent-annotate.test.ts
git commit -m "feat: viszonyítással címkézett érték — egy +9,7σ szám ne olvasódhasson normálisként"
```

---

### Task 3: A kérdés-készlet váza és a három olvasó kérdés

**Files:**
- Create: `src/core/agent/questions.ts`
- Test: `test/core/agent-questions-read.test.ts`

**Interfaces:**
- Consumes: `HealthRepo`, `WorkoutRepo` from the repositories; `CalendarService`; `annotate`/`baselineFor` from Task 2
- Produces: `type QuestionContext`, `type QuestionName`, `QUESTIONS`, `runQuestion(name, args, ctx): Promise<string>`, `MENU_TEXT`, `METRICS`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-questions-read.test.ts
import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { runQuestion, type QuestionContext } from "../../src/core/agent/questions.ts";

function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  const now = new Date("2026-09-04T05:00:00.000Z");
  // 40 ordinary days, then one extreme — enough to clear MIN_BASELINE_N.
  for (let i = 40; i >= 1; i--) {
    const d = new Date(Date.UTC(2026, 6, 26 + (40 - i)));
    health.upsert(snapshot({ date: d.toISOString().slice(0, 10), hrv: 55, sleepH: 7, rhr: 55 }), {}, now);
  }
  health.upsert(snapshot({ date: "2026-09-04", hrv: 203.6, sleepH: 6.6, rhr: 59 }), {}, now);
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

describe("nap", () => {
  it("annotates every value against its own baseline", async () => {
    const out = await runQuestion("nap", { datum: "2026-09-04" }, ctx());
    expect(out).toContain("2026-09-04");
    expect(out).toMatch(/hrv=203,6 \(\+[0-9]+,[0-9]σ.*minden idők maximuma\)/);
  });

  it("says the row is missing rather than returning nothing", async () => {
    expect(await runQuestion("nap", { datum: "2020-01-01" }, ctx())).toContain("nincs sor");
  });
});

describe("napok", () => {
  it("returns a whole range in one step", async () => {
    const out = await runQuestion("napok", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out).toContain("2026-09-04");
  });

  it("caps the range so one step cannot flood the context", async () => {
    const out = await runQuestion("napok", { tol: "2019-01-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("legfeljebb 60 nap");
  });
});

describe("lefedettseg", () => {
  it("names the current unbroken run and the gap before it", async () => {
    const out = await runQuestion("lefedettseg", { mutato: "hrv" }, ctx());
    expect(out).toMatch(/megszakítatlan sorozat/);
    expect(out).toMatch(/mérés/);
  });

  it("says plainly when a metric was never measured", async () => {
    expect(await runQuestion("lefedettseg", { mutato: "vo2max" }, ctx())).toContain("soha nem mért");
  });
});

describe("unknown questions", () => {
  it("returns a correctable error instead of throwing", async () => {
    const out = await runQuestion("nincsilyen", {}, ctx());
    expect(out).toContain("ismeretlen kérdés");
    expect(out).toContain("nap");
  });
});
```

- [ ] **Step 2: Add the snapshot test helper**

`HealthSnapshot` has 31 fields, so a partial literal will not typecheck and
the test above would need an `as never` cast on every seed row. A cast that
appears in four test files is a cast nobody reads any more — and it would
silently swallow a genuine field-name typo. Add this to `test/helpers.ts`,
next to the existing `meal()` helper:

```typescript
import type { HealthSnapshot } from "../src/infra/db/repositories/health.ts";

/** A snapshot with every field null but the ones the test cares about. */
export function snapshot(
  p: Partial<HealthSnapshot> & Pick<HealthSnapshot, "date">,
): Omit<HealthSnapshot, "ingestedAt"> {
  return {
    sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null,
    steps: null, asleepMin: null, inBedMin: null, coreMin: null, remMin: null,
    deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
    walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
    dietProteinG: null, dietCarbsG: null, dietFatG: null, distanceKm: null,
    standMin: null, walkingSpeed: null, stepLengthCm: null,
    doubleSupportPct: null, asymmetryPct: null, steadinessPct: null,
    sixMinWalkM: null, stairUpMs: null, stairDownMs: null,
    ...p,
  };
}
```

Then use it in the test above and in every later task that seeds health rows
(Tasks 4, 5, 7), replacing `health.upsert({ ... } as never, {}, now)` with
`health.upsert(snapshot({ ... }), {}, now)`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/agent-questions-read.test.ts`
Expected: FAIL — `Cannot find module '.../agent/questions.ts'`

- [ ] **Step 4: Write the registry and the three reading questions**

```typescript
// src/core/agent/questions.ts
import type { HealthRepo, HealthSnapshot } from "../../infra/db/repositories/health.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { CalendarService } from "../../infra/calendar/service.ts";
import { shiftDay, dayGap, type Point } from "../analysis/stats.ts";
import { annotate, baselineFor } from "./annotate.ts";

/**
 * The closed menu.
 *
 * The model never writes SQL. It picks one of these by name, with arguments,
 * and the code runs it. Two reasons, both measured rather than assumed: the
 * step choice is already reliable in a small model, so free tool access buys
 * nothing where it would cost safety; and a closed set is testable one entry
 * at a time, against real data.
 */
export const METRICS = {
  alvas: "sleepH", hrv: "hrv", nyugalmi_pulzus: "rhr", lepes: "steps",
  edzesperc: "exerciseMin", melyalvas: "deepMin", rem: "remMin",
  ebredes: "awakenings", vo2max: "vo2max",
} as const;

export type MetricName = keyof typeof METRICS;

export interface QuestionContext {
  health: HealthRepo;
  workouts: WorkoutRepo;
  calendar: CalendarService;
  /** The day the investigation is anchored to; "today" for every relative window. */
  today: string;
}

export type QuestionName =
  | "elteresek" | "nap" | "napok" | "hasonlo_napok" | "mi_lett_utana"
  | "ritmus" | "naptar" | "edzesek" | "lefedettseg";

export interface Question {
  /** One menu line, as the model reads it. */
  usage: string;
  run(args: Record<string, unknown>, ctx: QuestionContext): Promise<string>;
}

/** A whole range in one step is capped: one observation must not fill the context. */
export const MAX_RANGE_DAYS = 60;

const HISTORY_START = "1970-01-01";

export function metricOf(args: Record<string, unknown>): MetricName | null {
  const raw = String(args.mutato ?? "");
  return raw in METRICS ? raw as MetricName : null;
}

export function seriesOf(ctx: QuestionContext, metric: MetricName, from: string, to: string): Point[] {
  return ctx.health.between(from, to)
    .map((s) => ({ date: s.date, value: s[METRICS[metric]] as number | null }))
    .filter((p): p is Point => p.value !== null);
}

/** Every measured field of one day, each carrying its distance from its own baseline. */
function describeDay(ctx: QuestionContext, snapshot: HealthSnapshot): string {
  const bits: string[] = [];
  for (const name of Object.keys(METRICS) as MetricName[]) {
    const value = snapshot[METRICS[name]] as number | null;
    if (value === null) continue;
    const base = baselineFor(seriesOf(ctx, name, HISTORY_START, ctx.today), ctx.today, 90);
    bits.push(`${name}=${annotate(value, base)}`);
  }
  return bits.join(" ") || "a sor létezik, de minden mezője üres";
}

export const QUESTIONS: Record<QuestionName, Question> = {
  nap: {
    usage: "nap(datum) — egy nap teljes képe, minden mérés a saját alapvonalához viszonyítva",
    async run(args, ctx) {
      const date = String(args.datum ?? "");
      const snapshot = ctx.health.forDate(date);
      if (!snapshot) return `${date}: nincs sor az adatbázisban`;
      const workouts = ctx.workouts.forDate(date);
      return `${date}: ${describeDay(ctx, snapshot)}\n`
        + `  edzés: ${workouts.length
          ? workouts.map((w) => `${w.type} ${Math.round(w.durationMin)} perc`).join(", ")
          : "nincs"}`;
    },
  },

  napok: {
    usage: `napok(tol, ig) — egy tartomány egyben, legfeljebb ${MAX_RANGE_DAYS} nap`,
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      if (dayGap(from, to) > MAX_RANGE_DAYS) {
        return `a tartomány túl hosszú — egy lépés legfeljebb ${MAX_RANGE_DAYS} nap`;
      }
      const rows = ctx.health.between(from, to);
      if (rows.length === 0) return `${from} → ${to}: nincs egyetlen sor sem`;
      return rows.map((s) => {
        const workouts = ctx.workouts.forDate(s.date);
        const bits = (Object.keys(METRICS) as MetricName[])
          .map((n) => [n, s[METRICS[n]] as number | null] as const)
          .filter(([, v]) => v !== null)
          .map(([n, v]) => `${n}=${v}`);
        return `  ${s.date}  ${bits.join(" ") || "üres"}  edzés=${workouts.length}`;
      }).join("\n");
    },
  },

  lefedettseg: {
    usage: "lefedettseg(mutato) — hány mérés van, mikortól, és hol vannak szünetek",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);

      const all = seriesOf(ctx, metric, HISTORY_START, ctx.today);
      if (all.length === 0) return `${metric}: soha nem mért`;

      const dates = all.map((p) => p.date);
      const last90 = dates.filter((d) => d >= shiftDay(ctx.today, -89));

      // The run and the gap before it, not just the counts.
      //
      // Counts alone cannot show that a metric started being measured four
      // days ago after a four-month silence -- and in the measurement that
      // produced this plan, that break WAS the answer to "why is today's
      // reading unlike every earlier one". Without it the model is left to
      // invent a physiological story.
      let runStart = dates.at(-1)!;
      for (let i = dates.length - 1; i > 0; i--) {
        if (shiftDay(dates[i]!, -1) !== dates[i - 1]) break;
        runStart = dates[i - 1]!;
      }
      const beforeRun = dates.filter((d) => d < runStart).at(-1);

      const byYear = new Map<string, number>();
      for (const d of dates) byYear.set(d.slice(0, 4), (byYear.get(d.slice(0, 4)) ?? 0) + 1);

      return `${metric}: ${all.length} mérés, ${dates[0]} → ${dates.at(-1)}\n`
        + `  utolsó 90 nap: ${last90.length} mérés\n`
        + `  évenként: ${[...byYear].map(([y, n]) => `${y}=${n}`).join(" ")}\n`
        + `  a jelenlegi megszakítatlan sorozat kezdete: ${runStart}`
        + (beforeRun ? `; az azt megelőző utolsó mérés: ${beforeRun}` : "; előtte semmi");
    },
  },

  // Filled in by Task 4.
  elteresek: notYet("elteresek"),
  hasonlo_napok: notYet("hasonlo_napok"),
  mi_lett_utana: notYet("mi_lett_utana"),
  ritmus: notYet("ritmus"),
  // Filled in by Task 5.
  naptar: notYet("naptar"),
  edzesek: notYet("edzesek"),
};

function notYet(name: string): Question {
  return {
    usage: `${name} — még nincs implementálva`,
    async run() { return `${name}: még nincs implementálva`; },
  };
}

function unknownMetric(args: Record<string, unknown>): string {
  return `ismeretlen mutató "${String(args.mutato)}" — válassz ezek közül: ${Object.keys(METRICS).join(", ")}`;
}

/** The menu as the model reads it. Built from the questions themselves so the two cannot drift. */
export const MENU_TEXT: string =
  (Object.keys(QUESTIONS) as QuestionName[]).map((n) => QUESTIONS[n].usage).join("\n");

/**
 * Runs one question. An unknown name or a bad argument returns text, never
 * throws: the loop feeds it back as an observation and the model can correct
 * itself. A thrown error would end an investigation over a typo.
 */
export async function runQuestion(
  name: string, args: Record<string, unknown>, ctx: QuestionContext,
): Promise<string> {
  const question = (QUESTIONS as Record<string, Question | undefined>)[name];
  if (!question) {
    return `ismeretlen kérdés "${name}" — válassz a menüből: ${Object.keys(QUESTIONS).join(", ")}`;
  }
  try {
    return await question.run(args, ctx);
  } catch (err) {
    return `a kérdés hibára futott: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-questions-read.test.ts && npm run typecheck`
Expected: PASS, 7 tests. Typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/questions.ts test/helpers.ts test/core/agent-questions-read.test.ts
git commit -m "feat: a kérdés-készlet váza és a három olvasó kérdés"
```

---

### Task 4: A statisztikai kérdések és a mintaszám-küszöbök (3. védelem)

**Files:**
- Modify: `src/core/agent/questions.ts` — replaces the four `notYet` entries
- Test: `test/core/agent-questions-stats.test.ts`

**Interfaces:**
- Consumes: `QuestionContext`, `seriesOf`, `metricOf`, `METRICS` from Task 3; `mean`, `stdDev` from stats
- Produces: `MIN_BUCKET_N` exported from `questions.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-questions-stats.test.ts
import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { runQuestion, MIN_BUCKET_N, type QuestionContext } from "../../src/core/agent/questions.ts";

/** 60 consecutive days of sleep, every value 7.0 except one 3.0 outlier. */
function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  const now = new Date("2026-09-04T05:00:00.000Z");
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 6, 7 + i)).toISOString().slice(0, 10);
    health.upsert(snapshot({ date: d, sleepH: d === "2026-08-20" ? 3 : 7 }), {}, now);
  }
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

describe("elteresek", () => {
  it("finds the day that sits far from the mean, with its sigma", async () => {
    const out = await runQuestion("elteresek", { mutato: "alvas", ablak_nap: 90 }, ctx());
    expect(out).toContain("2026-08-20");
    expect(out).toMatch(/−[0-9]+,[0-9]σ|-[0-9]+,[0-9]σ/);
  });

  it("says so when nothing stands out, rather than listing the least ordinary day", async () => {
    const out = await runQuestion("elteresek", { mutato: "alvas", ablak_nap: 3 }, ctx());
    expect(out).toMatch(/nincs elég mérés|nincs kiugró/);
  });
});

describe("ritmus", () => {
  it("refuses to average a bucket below the sample floor", async () => {
    const out = await runQuestion("ritmus", { mutato: "alvas", bontas: "hetnap" }, ctx());
    // 60 days gives ~8-9 per weekday, all above the floor.
    expect(out).not.toContain("kevés mérés");
    expect(out).toMatch(/hétfő|kedd|szerda/);
  });

  it("names a thin bucket as insufficient instead of printing a number", async () => {
    const thin = ctx();
    const out = await runQuestion("ritmus", { mutato: "alvas", bontas: "honap" }, thin);
    // July has 25 days here, August 31, September 4 — September is below the floor.
    expect(out).toContain("2026-09");
    expect(out).toMatch(/2026-09:.*kevés mérés \(n=4, kell \d+\)/);
  });

  it("exports a floor that is actually enforced", () => {
    expect(MIN_BUCKET_N).toBeGreaterThanOrEqual(5);
  });
});

describe("hasonlo_napok", () => {
  it("returns the closest days by that metric, excluding the day itself", async () => {
    const out = await runQuestion("hasonlo_napok", { datum: "2026-08-20", mutato: "alvas", k: 3 }, ctx());
    expect(out).not.toContain("2026-08-20 ");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("says so when the anchor day has no value to match against", async () => {
    const out = await runQuestion("hasonlo_napok", { datum: "2026-08-20", mutato: "hrv", k: 3 }, ctx());
    expect(out).toContain("nincs");
  });
});

describe("mi_lett_utana", () => {
  it("reports the following days, naming the ones with no data", async () => {
    const out = await runQuestion("mi_lett_utana", { datum: "2026-09-02", napok: 4 }, ctx());
    expect(out).toContain("2026-09-03");
    expect(out).toContain("nincs adat");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/agent-questions-stats.test.ts`
Expected: FAIL — the four questions return "még nincs implementálva".

- [ ] **Step 3: Replace the four `notYet` entries**

Add to the imports at the top of `src/core/agent/questions.ts`:

```typescript
import { mean, stdDev, shiftDay, dayGap, type Point } from "../analysis/stats.ts";
```

Add the floor next to `MAX_RANGE_DAYS`:

```typescript
/**
 * The floor under every bucketed average.
 *
 * During the measurement the weekday breakdown printed "szombat: 4.4 (n=2)"
 * -- a mean of two nights, formatted exactly like a mean of thirty. The
 * system already carries floors for this elsewhere (`MIN_N7`/`MIN_N90` in
 * notify/candidates.ts, `config.analysis.minCorrelationN`); a question that
 * feeds a model has no business being looser than a threshold that merely
 * decides whether to send a push.
 */
export const MIN_BUCKET_N = 5;
```

Replace the four `notYet(...)` entries with:

```typescript
  elteresek: {
    usage: "elteresek(mutato, ablak_nap) — mely napok lógnak ki az ablakban, szórásban kifejezve",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);
      const window = Number(args.ablak_nap ?? 90);
      const points = seriesOf(ctx, metric, shiftDay(ctx.today, -(window - 1)), ctx.today);
      if (points.length < MIN_BUCKET_N) {
        return `${metric}: nincs elég mérés az ablakban (n=${points.length}, kell ${MIN_BUCKET_N})`;
      }
      const values = points.map((p) => p.value);
      const m = mean(values)!;
      const sd = stdDev(values);
      if (sd === null || sd === 0) return `${metric}: minden érték azonos, nincs eltérés`;

      const out = points
        .map((p) => ({ ...p, z: (p.value - m) / sd }))
        .filter((p) => Math.abs(p.z) >= 1.5)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
        .slice(0, 12);

      const head = `${metric}: átlag ${hu(m)}, szórás ${hu(sd)}, n=${points.length}`;
      return out.length === 0
        ? `${head}\n  nincs kiugró nap 1,5 szóráson túl`
        : `${head}\n` + out.map((p) =>
            `  ${p.date}  ${hu(p.value)}  ${p.z >= 0 ? "+" : "−"}${hu(Math.abs(p.z))}σ`).join("\n");
    },
  },

  hasonlo_napok: {
    usage: "hasonlo_napok(datum, mutato, k) — a k legközelebbi nap ugyanabban a mutatóban",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);
      const date = String(args.datum ?? "");
      const k = Math.min(Math.max(Number(args.k ?? 5), 1), 20);

      const anchor = ctx.health.forDate(date)?.[METRICS[metric]] as number | null | undefined;
      if (anchor === null || anchor === undefined) {
        return `${date}: nincs ${metric} érték, amihez hasonlítani lehetne`;
      }
      const others = seriesOf(ctx, metric, HISTORY_START, ctx.today).filter((p) => p.date !== date);
      if (others.length === 0) return `nincs másik nap ${metric} méréssel`;

      return others
        .map((p) => ({ ...p, gap: Math.abs(p.value - anchor) }))
        .sort((a, b) => a.gap - b.gap)
        .slice(0, k)
        .map((p) => `  ${p.date}  ${metric}=${hu(p.value)}`)
        .join("\n");
    },
  },

  mi_lett_utana: {
    usage: "mi_lett_utana(datum, napok) — a rákövetkező napok kimenetei",
    async run(args, ctx) {
      const date = String(args.datum ?? "");
      const days = Math.min(Math.max(Number(args.napok ?? 3), 1), 14);
      const rows: string[] = [];
      for (let i = 1; i <= days; i++) {
        const day = shiftDay(date, i);
        const snapshot = ctx.health.forDate(day);
        if (!snapshot) { rows.push(`  ${day}  nincs adat`); continue; }
        const workouts = ctx.workouts.forDate(day);
        const bits = (Object.keys(METRICS) as MetricName[])
          .map((n) => [n, snapshot[METRICS[n]] as number | null] as const)
          .filter(([, v]) => v !== null)
          .map(([n, v]) => `${n}=${hu(v!)}`);
        rows.push(`  ${day}  ${bits.join(" ") || "üres"}  edzés=${workouts.length}`);
      }
      return rows.join("\n");
    },
  },

  ritmus: {
    usage: "ritmus(mutato, bontas) — átlag a hét napjai (\"hetnap\") vagy hónapok (\"honap\") szerint",
    async run(args, ctx) {
      const metric = metricOf(args);
      if (metric === null) return unknownMetric(args);
      const by = String(args.bontas ?? "hetnap");
      if (by !== "hetnap" && by !== "honap") {
        return `ismeretlen bontás "${by}" — hetnap vagy honap`;
      }
      const points = seriesOf(ctx, metric, shiftDay(ctx.today, -364), ctx.today);
      if (points.length === 0) return `${metric}: nincs mérés az elmúlt évben`;

      const names = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
      const buckets = new Map<string, number[]>();
      for (const p of points) {
        const key = by === "honap"
          ? p.date.slice(0, 7)
          : names[new Date(`${p.date}T12:00:00Z`).getUTCDay()]!;
        const list = buckets.get(key) ?? [];
        list.push(p.value);
        buckets.set(key, list);
      }

      // A thin bucket is named, not averaged. A mean of two nights formatted
      // like a mean of thirty is the most quietly misleading thing this
      // question could produce.
      return [...buckets].map(([key, values]) => values.length < MIN_BUCKET_N
        ? `  ${key}: kevés mérés (n=${values.length}, kell ${MIN_BUCKET_N})`
        : `  ${key}: ${hu(mean(values)!)} (n=${values.length})`).join("\n");
    },
  },
```

Import the formatter rather than redefining it — extend the existing
`annotate` import at the top of `questions.ts`:

```typescript
import { annotate, baselineFor, hu } from "./annotate.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-questions-stats.test.ts test/core/agent-questions-read.test.ts && npm run typecheck`
Expected: PASS, 14 tests total. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent/questions.ts test/core/agent-questions-stats.test.ts
git commit -m "feat: statisztikai kérdések mintaszám-küszöbbel — nincs több 'szombat: 4.4 (n=2)'"
```

---

### Task 5: A külső kérdések — naptár és edzések

**Files:**
- Modify: `src/core/agent/questions.ts` — replaces the last two `notYet` entries
- Test: `test/core/agent-questions-external.test.ts`

**Interfaces:**
- Consumes: `CalendarService.listEvents(from: Date, to: Date)`, `WorkoutRepo.between(from, to)`
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-questions-external.test.ts
import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar, type CalendarService } from "../../src/infra/calendar/service.ts";
import { runQuestion, type QuestionContext } from "../../src/core/agent/questions.ts";

const calendarWith = (titles: string[]): CalendarService => ({
  ...unavailableCalendar("test"),
  async listEvents() {
    return titles.map((title, i) => ({
      uid: `u${i}`, title, start: "2026-09-04T08:00:00.000Z", end: "2026-09-04T09:00:00.000Z",
      allDay: false, calendar: "Naptár",
    }));
  },
});

function ctx(calendar: CalendarService = unavailableCalendar("test")): QuestionContext {
  const db = memoryDb();
  const workouts = createWorkoutRepo(db);
  workouts.save([{
    date: "2026-09-01", type: "TraditionalStrengthTraining",
    startedAt: "2026-09-01T17:00:00.000Z", durationMin: 54.7, energyKcal: 300, source: "Watch",
  }]);
  return { health: createHealthRepo(db), workouts, calendar, today: "2026-09-04" };
}

describe("edzesek", () => {
  it("lists workouts in the range with rounded durations", async () => {
    const out = await runQuestion("edzesek", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("TraditionalStrengthTraining");
    expect(out).toContain("55 perc");
  });

  it("says so when the range is empty", async () => {
    const out = await runQuestion("edzesek", { tol: "2026-01-01", ig: "2026-01-05" }, ctx());
    expect(out).toContain("nincs edzés");
  });
});

describe("naptar", () => {
  it("lists events when the calendar is configured", async () => {
    const out = await runQuestion("naptar", { tol: "2026-09-04", ig: "2026-09-05" }, ctx(calendarWith(["Fogorvos"])));
    expect(out).toContain("Fogorvos");
  });

  it("reports an unconfigured calendar as absent, not as an empty day", async () => {
    const out = await runQuestion("naptar", { tol: "2026-09-04", ig: "2026-09-05" }, ctx());
    expect(out).toContain("nincs bekötve");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/agent-questions-external.test.ts`
Expected: FAIL — both return "még nincs implementálva".

- [ ] **Step 3: Replace the last two `notYet` entries**

```typescript
  edzesek: {
    usage: "edzesek(tol, ig) — edzések egy tartományban: típus, hossz",
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      const rows = ctx.workouts.between(from, to);
      if (rows.length === 0) return `${from} → ${to}: nincs edzés`;
      return rows.slice(0, 40)
        .map((w) => `  ${w.date}  ${w.type}  ${Math.round(w.durationMin)} perc`)
        .join("\n");
    },
  },

  naptar: {
    usage: "naptar(tol, ig) — naptári események egy tartományban",
    async run(args, ctx) {
      const from = String(args.tol ?? "");
      const to = String(args.ig ?? "");
      // An unconfigured calendar reads as empty, and "no events" is a very
      // different claim from "no calendar". Saying which one it is stops the
      // model concluding the owner had a free day.
      let events;
      try {
        events = await ctx.calendar.listEvents(new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`));
      } catch (err) {
        return `a naptár nincs bekötve: ${err instanceof Error ? err.message : String(err)}`;
      }
      // healthCheck only on the empty result, not on every call: an
      // unconfigured calendar returns [] without throwing, so emptiness is
      // the only case that is ambiguous — and on a working CalDAV account
      // this would otherwise be a second network round trip every step.
      if (events.length === 0) {
        const check = await ctx.calendar.healthCheck();
        return check.ok
          ? `${from} → ${to}: nincs esemény`
          : `a naptár nincs bekötve: ${check.detail ?? "ismeretlen ok"}`;
      }
      return events.slice(0, 40)
        .map((e) => `  ${e.start.slice(0, 16).replace("T", " ")}  ${e.title}`)
        .join("\n");
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-questions-external.test.ts && npm run typecheck`
Expected: PASS, 4 tests. Typecheck clean.

- [ ] **Step 5: Verify the menu is now complete**

Run: `node --input-type=module -e "import('./src/core/agent/questions.ts').then(m => { const missing = m.MENU_TEXT.split('\n').filter(l => l.includes('még nincs')); console.log(missing.length === 0 ? 'menü teljes' : 'HIÁNYZIK: ' + missing.join(', ')); })"`
Expected: `menü teljes`

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/questions.ts test/core/agent-questions-external.test.ts
git commit -m "feat: naptár és edzés kérdés — a bekötetlen naptár nem szabad nap"
```

---

### Task 6: A hurok, scriptelt modellel

**Files:**
- Create: `src/core/agent/loop.ts`
- Test: `test/core/agent-loop.test.ts`

**Interfaces:**
- Consumes: `runQuestion`, `QuestionContext` from Task 3; `TranscriptEntry` from Task 1
- Produces: `investigate(opts): Promise<InvestigationResult>`, `type InvestigatorModel`, `type Step`, `type Outcome`, `type InvestigationResult`, `MAX_STEPS`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-loop.test.ts
import { describe, it, expect } from "vitest";
import { memoryDb, silentCtx, snapshot } from "../helpers.ts";
import { investigate, MAX_STEPS, type InvestigatorModel, type Step } from "../../src/core/agent/loop.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { QuestionContext } from "../../src/core/agent/questions.ts";

function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  health.upsert(snapshot({ date: "2026-09-04", sleepH: 6.6 }), {}, new Date("2026-09-04T05:00:00Z"));
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

/** Replays a fixed list of steps — no network, fully deterministic. */
function scripted(steps: Step[]): InvestigatorModel {
  let i = 0;
  return { async nextStep() { return steps[i++] ?? { name: "kifutott", args: {}, why: "" }; } };
}

const run = (steps: Step[]) => investigate({
  goal: "teszt", model: scripted(steps), ctx: ctx(),
  logger: silentLogger(), signal: new AbortController().signal,
});

describe("investigate", () => {
  it("runs each chosen question and records the observation", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "a mai nap" },
      { name: "kerdezz", args: { szoveg: "Aludtál rosszul?" }, why: "nem elég az adat" },
    ]);
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0]!.observation).toContain("2026-09-04");
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "Aludtál rosszul?" });
  });

  it("stops after MAX_STEPS and keeps what it collected", async () => {
    const many = Array.from({ length: MAX_STEPS + 5 }, () =>
      ({ name: "nap", args: { datum: "2026-09-04" }, why: "újra" }));
    const result = await run(many);
    expect(result.transcript).toHaveLength(MAX_STEPS);
    expect(result.outcome.kind).toBe("kifutott");
  });

  it("feeds an unknown question back as an observation instead of failing", async () => {
    const result = await run([
      { name: "nincsilyen", args: {}, why: "elgépelés" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.transcript[0]!.observation).toContain("ismeretlen kérdés");
    expect(result.outcome.kind).toBe("kerdezz");
  });

  it("gives the model the transcript so far on every call", async () => {
    const seen: number[] = [];
    const model: InvestigatorModel = {
      async nextStep(_goal, transcript) {
        seen.push(transcript.length);
        return transcript.length >= 2
          ? { name: "kerdezz", args: { szoveg: "elég" }, why: "" }
          : { name: "nap", args: { datum: "2026-09-04" }, why: "" };
      },
    };
    await investigate({
      goal: "teszt", model, ctx: ctx(),
      logger: silentLogger(), signal: new AbortController().signal,
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it("surfaces a model failure as an outcome, never as a silent empty run", async () => {
    const model: InvestigatorModel = {
      async nextStep() { throw new Error("HTTP 529 overloaded"); },
    };
    const result = await investigate({
      goal: "teszt", model, ctx: ctx(),
      logger: silentLogger(), signal: new AbortController().signal,
    });
    expect(result.outcome).toEqual({ kind: "hiba", reason: "HTTP 529 overloaded" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/agent-loop.test.ts`
Expected: FAIL — `Cannot find module '.../agent/loop.ts'`

- [ ] **Step 3: Write the loop**

```typescript
// src/core/agent/loop.ts
import type { Logger } from "../../infra/logger.ts";
import type { TranscriptEntry } from "../../infra/db/repositories/investigations.ts";
import { runQuestion, type QuestionContext } from "./questions.ts";

export interface Step {
  name: string;
  args: Record<string, unknown>;
  /** The model's own reason for this step. Kept for the transcript, never acted on. */
  why: string;
}

export interface InvestigatorModel {
  nextStep(goal: string, transcript: readonly TranscriptEntry[], signal: AbortSignal): Promise<Step>;
}

export type Outcome =
  | { kind: "kesz"; finding: string; cites: number[]; falsifiedBy: number }
  | { kind: "kerdezz"; question: string }
  | { kind: "kifutott" }
  | { kind: "hiba"; reason: string };

export interface InvestigationResult {
  goal: string;
  transcript: TranscriptEntry[];
  outcome: Outcome;
}

/**
 * Ten, not eight.
 *
 * During the measurement a 9B model ran out at eight while still making
 * progress -- it was pulling one day at a time. `napok(tol, ig)` removes most
 * of that waste, and two more rounds cover the hypothesis and falsification
 * steps the gate now requires.
 */
export const MAX_STEPS = 10;

/** Steps that end the investigation rather than producing an observation. */
const TERMINAL = new Set(["kesz", "kerdezz"]);

export async function investigate(opts: {
  goal: string;
  model: InvestigatorModel;
  ctx: QuestionContext;
  logger: Logger;
  signal: AbortSignal;
}): Promise<InvestigationResult> {
  const transcript: TranscriptEntry[] = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    let step: Step;
    try {
      step = await opts.model.nextStep(opts.goal, transcript, opts.signal);
    } catch (err) {
      // No template fallback here, deliberately: the brief degrades to plain
      // text because its content comes from the modules, but here the
      // inference IS the product. A missing finding beats a false one.
      const reason = err instanceof Error ? err.message : String(err);
      opts.logger.warn({ reason }, "investigation model failed");
      return { goal: opts.goal, transcript, outcome: { kind: "hiba", reason } };
    }

    if (TERMINAL.has(step.name)) {
      return { goal: opts.goal, transcript, outcome: terminalOutcome(step) };
    }

    const observation = await runQuestion(step.name, step.args, opts.ctx);
    transcript.push({ step, observation });
    opts.logger.debug({ step: step.name, args: step.args }, "investigation step");
  }

  opts.logger.info({ steps: transcript.length }, "investigation ran out of steps");
  return { goal: opts.goal, transcript, outcome: { kind: "kifutott" } };
}

function terminalOutcome(step: Step): Outcome {
  if (step.name === "kerdezz") {
    return { kind: "kerdezz", question: String(step.args.szoveg ?? "") };
  }
  return {
    kind: "kesz",
    finding: String(step.args.megallapitas ?? ""),
    cites: Array.isArray(step.args.tamaszkodik) ? step.args.tamaszkodik.map(Number) : [],
    falsifiedBy: Number(step.args.cafolat ?? 0),
  };
}
```

- [ ] **Step 4: Fix the deliberate bad import**

`test/helpers.ts` has no `silentCtx` — the test above imports it on purpose,
so the failure is met once, early, rather than in a later task. Drop just that
name; `memoryDb` and `snapshot` are both real and both needed:

```typescript
import { memoryDb, snapshot } from "../helpers.ts";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-loop.test.ts && npm run typecheck`
Expected: PASS, 5 tests. Typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/loop.ts test/core/agent-loop.test.ts
git commit -m "feat: a nyomozó hurok, scriptelt modellel tesztelve — hálózat nélkül"
```

---

### Task 7: A cáfolat-kapu (1. védelem) és a T3 regresszió

**Files:**
- Modify: `src/core/agent/loop.ts` — adds the hypothesis step and the gate
- Modify: `src/core/agent/questions.ts` — adds `hipotezis` to the menu text
- Test: `test/core/agent-falsification.test.ts`

**Interfaces:**
- Consumes: `investigate`, `Step`, `InvestigatorModel` from Task 6
- Produces: `HYPOTHESIS_STEP` constant; `Outcome` gains no new variant — a rejected `kesz` re-enters the loop

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-falsification.test.ts
import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { investigate, type InvestigatorModel, type Step } from "../../src/core/agent/loop.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { QuestionContext } from "../../src/core/agent/questions.ts";

function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  const now = new Date("2026-09-04T05:00:00.000Z");
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 6, 26 + i)).toISOString().slice(0, 10);
    health.upsert(snapshot({ date: d, hrv: 55 }), {}, now);
  }
  health.upsert(snapshot({ date: "2026-09-04", hrv: 203.6 }), {}, now);
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

function scripted(steps: Step[]): InvestigatorModel {
  let i = 0;
  return { async nextStep() { return steps[i++] ?? { name: "kifutott", args: {}, why: "" }; } };
}

const run = (steps: Step[]) => investigate({
  goal: "Miért 203,6 a HRV?", model: scripted(steps), ctx: ctx(),
  logger: silentLogger(), signal: new AbortController().signal,
});

describe("the falsification gate", () => {
  it("rejects a finding with no hypothesis behind it", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "" },
      { name: "kesz", args: { megallapitas: "Kiváló regeneráció.", tamaszkodik: [1], cafolat: 1 }, why: "" },
      { name: "kerdezz", args: { szoveg: "Mi történt?" }, why: "" },
    ]);
    // The kesz was pushed back into the loop, so the run ends on the kerdezz.
    expect(result.outcome.kind).toBe("kerdezz");
    expect(result.transcript.at(-1)!.observation).toContain("hipotezis");
  });

  it("rejects a falsification step that came before the hypothesis", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "" },
      { name: "hipotezis", args: { allitas: "Az edzés utáni regeneráció okozta." }, why: "" },
      { name: "kesz", args: { megallapitas: "Az edzés okozta.", tamaszkodik: [1], cafolat: 1 }, why: "" },
      { name: "kerdezz", args: { szoveg: "Mi történt?" }, why: "" },
    ]);
    expect(result.outcome.kind).toBe("kerdezz");
    expect(result.transcript.at(-1)!.observation).toMatch(/a cáfolatnak a hipotézis UTÁN/);
  });

  it("accepts a finding whose falsification step followed the hypothesis", async () => {
    const result = await run([
      { name: "hipotezis", args: { allitas: "Az edzés utáni regeneráció okozta." }, why: "" },
      { name: "hasonlo_napok", args: { datum: "2026-09-04", mutato: "hrv", k: 5 }, why: "cáfolat" },
      { name: "kesz", args: { megallapitas: "Nem az edzés.", tamaszkodik: [1, 2], cafolat: 2 }, why: "" },
    ]);
    expect(result.outcome).toMatchObject({ kind: "kesz", finding: "Nem az edzés.", falsifiedBy: 2 });
  });

  it("records the hypothesis in the transcript as a step of its own", async () => {
    const result = await run([
      { name: "hipotezis", args: { allitas: "A mérési mód változott." }, why: "" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.transcript[0]!.step.name).toBe("hipotezis");
    expect(result.transcript[0]!.observation).toContain("A mérési mód változott.");
  });
});

/**
 * The regression that this whole plan exists for.
 *
 * These are the exact steps qwen3.5:9b took on 2026-09-04 before concluding
 * that a 203.6 ms HRV reflected "kiváló regeneráció" after a strength
 * training session three days earlier. The reading was real; the cause was a
 * change of measurement, not of physiology. Every step it cited was really
 * run, and every number it quoted was true -- which is why citations alone
 * were never going to catch this.
 *
 * Replayed here, the gate must refuse the conclusion.
 */
describe("T3 regression: the fabricated workout explanation", () => {
  it("does not let the recorded fabrication through as a finding", async () => {
    const recorded: Step[] = [
      { name: "nap", args: { datum: "2026-09-04" }, why: "megerősítem az értéket" },
      { name: "lefedettseg", args: { mutato: "hrv" }, why: "milyen mélyre nyúlik a történet" },
      { name: "ritmus", args: { mutato: "hrv", bontas: "honap" }, why: "fokozatos növekedés?" },
      { name: "edzesek", args: { tol: "2026-08-31", ig: "2026-09-04" }, why: "volt-e edzés" },
      { name: "elteresek", args: { mutato: "hrv", ablak_nap: 365 }, why: "kiugró-e" },
      {
        name: "kesz",
        args: {
          megallapitas: "A 2026-09-04-i HRV kiugróan magas, ami a 2026-09-01-i "
            + "erősítő edzés utáni kiváló regenerációt jelzi.",
          tamaszkodik: [1, 2, 3, 4, 5],
        },
        why: "az edzés magyarázza",
      },
      { name: "kerdezz", args: { szoveg: "Változott valami a mérésben?" }, why: "nem tudom bizonyítani" },
    ];
    const result = await run(recorded);
    expect(result.outcome.kind).not.toBe("kesz");
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "Változott valami a mérésben?" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/agent-falsification.test.ts`
Expected: FAIL — the `kesz` steps are accepted, so the outcomes are `kesz` rather than `kerdezz`.

- [ ] **Step 3: Add the hypothesis step and the gate to `loop.ts`**

Replace the `TERMINAL` constant and the main loop body:

```typescript
/** Steps that end the investigation rather than producing an observation. */
const TERMINAL = new Set(["kesz", "kerdezz"]);

/**
 * The step that makes falsification checkable.
 *
 * A gate that only asked "name a step you cite" is not a gate: the model that
 * produced this plan's motivating failure cited five real steps and still
 * invented the causal link. Citations prove lookup, not inference.
 *
 * So the claim has to be on the record BEFORE the evidence that tests it. The
 * model states a hypothesis as its own step, and `kesz` is only accepted when
 * it names a falsification step that ran after that hypothesis -- a step
 * taken while the claim was already fixed, and therefore capable of killing
 * it.
 */
export const HYPOTHESIS_STEP = "hipotezis";
```

Now **delete** the whole `if (TERMINAL.has(step.name)) { ... }` block and the
now-unused `TERMINAL` constant, and put this in its place — the three step
kinds are handled separately because only one of them has a gate:

```typescript
    if (step.name === HYPOTHESIS_STEP) {
      const claim = String(step.args.allitas ?? "");
      transcript.push({
        step,
        observation: `rögzített hipotézis: ${claim}\n`
          + "Most futtass egy lépést, ami ezt MEGDÖNTENÉ, ha hamis.",
      });
      continue;
    }

    if (step.name === "kerdezz") {
      return { goal: opts.goal, transcript, outcome: terminalOutcome(step) };
    }

    if (step.name === "kesz") {
      const refusal = gateFinding(step, transcript);
      if (refusal === null) {
        return { goal: opts.goal, transcript, outcome: terminalOutcome(step) };
      }
      // Rejected, not fatal: the observation goes back and the model can
      // do the work the gate is asking for.
      transcript.push({ step, observation: refusal });
      opts.logger.info({ refusal }, "finding rejected by the falsification gate");
      continue;
    }
```

Add the gate below `terminalOutcome`:

```typescript
/**
 * Returns null when the finding may stand, or the refusal text to feed back.
 *
 * Indices in `cafolat` are 1-based, matching the step numbers the model sees
 * in its own transcript.
 */
function gateFinding(step: Step, transcript: readonly TranscriptEntry[]): string | null {
  const hypothesisAt = transcript.findIndex((e) => e.step.name === HYPOTHESIS_STEP);
  if (hypothesisAt === -1) {
    return "a megállapítás elutasítva: előbb rögzítsd a hipotézisedet a "
      + "\"hipotezis\" lépéssel, majd futtass egy lépést, ami megdöntené.";
  }

  const falsifiedBy = Number(step.args.cafolat ?? 0);
  if (!Number.isInteger(falsifiedBy) || falsifiedBy < 1 || falsifiedBy > transcript.length) {
    return `a megállapítás elutasítva: a "cafolat" mezőben nevezd meg a cáfolatra `
      + `futtatott lépés sorszámát (1—${transcript.length}).`;
  }

  // 1-based in the model's view, 0-based here.
  if (falsifiedBy - 1 <= hypothesisAt) {
    return "a megállapítás elutasítva: a cáfolatnak a hipotézis UTÁN futtatott "
      + `lépésnek kell lennie (a hipotézis a ${hypothesisAt + 1}. lépés volt).`;
  }

  return null;
}
```

- [ ] **Step 4: Add `hipotezis` to the menu the model reads**

In `src/core/agent/questions.ts`, append to `MENU_TEXT`:

```typescript
export const MENU_TEXT: string = [
  ...(Object.keys(QUESTIONS) as QuestionName[]).map((n) => QUESTIONS[n].usage),
  "hipotezis(allitas) — rögzíted, mit gondolsz az okról; kötelező a kesz előtt",
  "kerdezz(szoveg) — visszakérdezel a tulajdonosnak; lezárja a nyomozást",
  "kesz(megallapitas, tamaszkodik, cafolat) — kimondod a megállapítást; lezárja a nyomozást",
].join("\n");
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-falsification.test.ts test/core/agent-loop.test.ts && npm run typecheck`
Expected: PASS, 10 tests. Typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/loop.ts src/core/agent/questions.ts test/core/agent-falsification.test.ts
git commit -m "feat: cáfolat-kapu — hipotézis előbb, cáfolat utána, különben nincs megállapítás"
```

---

### Task 8: A rendszerprompt és az Anthropic-adapter

**Files:**
- Create: `src/core/agent/prompt.ts`
- Create: `src/infra/anthropic.ts`
- Test: `test/core/agent-prompt.test.ts`

**Interfaces:**
- Consumes: `MENU_TEXT` from Task 3/7; `InvestigatorModel`, `Step` from Task 6
- Produces: `buildSystemPrompt(today: string): string`, `buildUserTurn(goal, transcript): string`, `parseStep(raw: string): Step`, `anthropicInvestigator(opts): InvestigatorModel`, `ANTHROPIC_KEY_VAR`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserTurn, parseStep } from "../../src/core/agent/prompt.ts";

describe("buildSystemPrompt", () => {
  it("carries the whole menu, so the model cannot invent a question", () => {
    const prompt = buildSystemPrompt("2026-09-04");
    for (const name of ["nap", "napok", "lefedettseg", "elteresek", "ritmus", "hipotezis", "kesz"]) {
      expect(prompt).toContain(name);
    }
  });

  it("states today, and that the finding must be Hungarian", () => {
    const prompt = buildSystemPrompt("2026-09-04");
    expect(prompt).toContain("2026-09-04");
    expect(prompt.toLowerCase()).toContain("hungarian");
  });

  it("is byte-stable for the same day, so it caches", () => {
    expect(buildSystemPrompt("2026-09-04")).toBe(buildSystemPrompt("2026-09-04"));
  });
});

describe("buildUserTurn", () => {
  it("numbers the steps from 1, matching what cafolat refers to", () => {
    const turn = buildUserTurn("cél", [
      { step: { name: "nap", args: { datum: "2026-09-04" }, why: "" }, observation: "alvas=6,6" },
      { step: { name: "hipotezis", args: { allitas: "X" }, why: "" }, observation: "rögzítve" },
    ]);
    expect(turn).toContain("1. nap");
    expect(turn).toContain("2. hipotezis");
    expect(turn).toContain("alvas=6,6");
  });

  it("asks for the first step when the transcript is empty", () => {
    expect(buildUserTurn("cél", [])).toContain("cél");
  });
});

describe("parseStep", () => {
  it("reads a well-formed step", () => {
    const step = parseStep('{"lepes":"nap","parameterek":{"datum":"2026-09-04"},"miert":"a mai nap"}');
    expect(step).toEqual({ name: "nap", args: { datum: "2026-09-04" }, why: "a mai nap" });
  });

  it("tolerates a missing parameterek object", () => {
    expect(parseStep('{"lepes":"kifutott","miert":"kész"}').args).toEqual({});
  });

  it("throws on unparseable output rather than inventing a step", () => {
    expect(() => parseStep("nem json")).toThrow(/nem értelmezhető/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/agent-prompt.test.ts`
Expected: FAIL — `Cannot find module '.../agent/prompt.ts'`

- [ ] **Step 3: Write the prompt module**

```typescript
// src/core/agent/prompt.ts
import type { TranscriptEntry } from "../../infra/db/repositories/investigations.ts";
import type { Step } from "./loop.ts";
import { MENU_TEXT } from "./questions.ts";

/**
 * Instructions in English, finding in Hungarian.
 *
 * Measured, not assumed: in the local-model evaluation the two candidates
 * held English instructions reliably while their Hungarian prose quality
 * differed sharply. The split survives here because the finding has to reach
 * a Hungarian reader either way, and the instructions are the part that must
 * not be misread.
 *
 * Byte-stable for a given day so the whole thing caches: it goes in the
 * `system` block behind a `cache_control` breakpoint, and the volatile
 * transcript goes in the user turn after it.
 */
export function buildSystemPrompt(today: string): string {
  return `You are investigating one person's health history. You cannot see the data
directly — you must ask for it, one question at a time, from this menu:

${MENU_TEXT}

Dates are YYYY-MM-DD. Today is ${today}.

Rules:
- Reply with ONE step as JSON: {"lepes": ..., "parameterek": {...}, "miert": "..."}
- Look before you conclude. A finding that rests on no observation is worthless.
- Values arrive labelled with their distance from this person's own baseline.
  A value marked as many sigma from baseline is NOT ordinary — never describe
  it as normal.
- If a metric might simply not be measured, or might have started being
  measured differently, check "lefedettseg" before theorising. A change of
  instrument looks exactly like a change of body.
- When the data cannot answer the goal, use "kerdezz" — do not guess.
- Before "kesz" you MUST state your hypothesis with "hipotezis", and then run
  a step that would DISPROVE it if it were false. "kesz" is rejected without
  that, and the rejection tells you what is missing.
- "megallapitas" must be written in Hungarian, for the person themselves.
- "tamaszkodik" lists the step numbers the finding rests on; "cafolat" is the
  single step number that tested it.`;
}

/** The volatile half: the goal and everything observed so far, numbered from 1. */
export function buildUserTurn(goal: string, transcript: readonly TranscriptEntry[]): string {
  if (transcript.length === 0) {
    return `Goal: ${goal}\n\nPick your first step.`;
  }
  const steps = transcript.map((entry, i) =>
    `${i + 1}. ${entry.step.name}(${JSON.stringify(entry.step.args)}) — ${entry.step.why}\n`
    + entry.observation.split("\n").map((l) => `   ${l}`).join("\n"),
  ).join("\n");
  return `Goal: ${goal}\n\nSteps so far:\n${steps}\n\nNext step.`;
}

interface RawStep { lepes?: string; parameterek?: Record<string, unknown>; miert?: string }

export function parseStep(raw: string): Step {
  let parsed: RawStep;
  try {
    parsed = JSON.parse(raw) as RawStep;
  } catch {
    throw new Error(`a modell válasza nem értelmezhető JSON-ként: ${raw.slice(0, 200)}`);
  }
  if (!parsed.lepes) throw new Error("a modell válasza nem értelmezhető: hiányzik a \"lepes\" mező");
  return { name: parsed.lepes, args: parsed.parameterek ?? {}, why: parsed.miert ?? "" };
}
```

- [ ] **Step 4: Write the Anthropic adapter**

```typescript
// src/infra/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "./logger.ts";
import type { InvestigatorModel, Step } from "../core/agent/loop.ts";
import type { TranscriptEntry } from "./db/repositories/investigations.ts";
import { buildSystemPrompt, buildUserTurn, parseStep } from "../core/agent/prompt.ts";

/** The Anthropic API key, from the login Keychain. */
export const ANTHROPIC_KEY_VAR = "ANTHROPIC_API_KEY";

/** Claude Opus 5 list pricing. Logged per step so the metered path is never invisible. */
export function estimateUsd(usage: Anthropic.Usage): number {
  const input = (usage.input_tokens ?? 0) / 1e6 * 5;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) / 1e6 * 6.25;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) / 1e6 * 0.5;
  const output = (usage.output_tokens ?? 0) / 1e6 * 25;
  return Number((input + cacheWrite + cacheRead + output).toFixed(4));
}

export interface AnthropicInvestigatorOptions {
  apiKey: string;
  today: string;
  logger: Logger;
  model?: string;
  /** Hard ceiling for one investigation. Reaching it aborts the run. */
  maxUsd: number;
}

export interface AnthropicInvestigator extends InvestigatorModel {
  /** What this investigation has cost so far. */
  spentUsd(): number;
}

/**
 * The measured brain.
 *
 * The local-model evaluation showed the loop's navigation is easy and its
 * closing judgement is not: a 9B model produced a fluent, well-cited, wrong
 * causal claim. This is the part that was bought, and nothing else.
 */
export function anthropicInvestigator(opts: AnthropicInvestigatorOptions): AnthropicInvestigator {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const system = buildSystemPrompt(opts.today);
  let spent = 0;

  return {
    spentUsd: () => Number(spent.toFixed(4)),

    async nextStep(goal: string, transcript: readonly TranscriptEntry[], signal: AbortSignal): Promise<Step> {
      if (spent >= opts.maxUsd) {
        throw new Error(`elérte a nyomozásonkénti költségplafont ($${opts.maxUsd})`);
      }

      const stream = client.messages.stream({
        model: opts.model ?? "claude-opus-5",
        max_tokens: 4_000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                lepes: { type: "string" },
                parameterek: { type: "object" },
                miert: { type: "string" },
              },
              required: ["lepes", "parameterek", "miert"],
              additionalProperties: false,
            },
          },
        },
        // The menu and the rules never change within a run, so they sit
        // behind the breakpoint and the growing transcript sits after it.
        // The loop is append-only, which is the best case for a prefix cache.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: buildUserTurn(goal, transcript) }],
      }, { signal });

      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        throw new Error(`a modell elutasította: ${message.stop_details?.explanation ?? "nincs indoklás"}`);
      }

      const cost = estimateUsd(message.usage);
      spent += cost;
      opts.logger.info(
        {
          usd: cost, spentUsd: Number(spent.toFixed(4)),
          cacheRead: message.usage.cache_read_input_tokens,
        },
        "investigation step (THIS COSTS MONEY)",
      );

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text).join("").trim();

      return parseStep(text);
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-prompt.test.ts && npm run typecheck`
Expected: PASS, 8 tests. Typecheck clean. Note the adapter itself has no unit test — it is a thin binding over the SDK, and its behaviour is verified live in Task 10.

- [ ] **Step 6: Remove the duplicate cost estimator**

`src/core/synthesis/api.ts` carries its own private `estimateUsd` with the
same Claude Opus 5 pricing. Two copies of a price table drift the moment one
is updated. Delete the one in `api.ts` and import the exported one:

```typescript
import { estimateUsd } from "../../infra/anthropic.ts";
```

Run: `npm run typecheck && npx vitest run test/core/cost-guard.test.ts`
Expected: clean, and the cost guards still pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/agent/prompt.ts src/infra/anthropic.ts src/core/synthesis/api.ts test/core/agent-prompt.test.ts
git commit -m "feat: a rendszerprompt és az Anthropic-adapter, nyomozásonkénti költségplafonnal"
```

---

### Task 9: A belépési pont

**Files:**
- Create: `scripts/investigate.ts`
- Modify: `package.json` — adds the `investigate` script
- Modify: `config/config.ts` — adds the `agent` block
- Test: `test/core/agent-config.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8; `createApp` from `src/app.ts`
- Produces: `config.agent.{ model, maxUsdPerRun, maxSteps }`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/agent-config.test.ts
import { describe, it, expect } from "vitest";
import { config } from "../../config/config.ts";
import { MAX_STEPS } from "../../src/core/agent/loop.ts";

describe("agent config", () => {
  it("carries a per-run cost ceiling, because the $0 rule no longer covers this path", () => {
    expect(config.agent.maxUsdPerRun).toBeGreaterThan(0);
    expect(config.agent.maxUsdPerRun).toBeLessThanOrEqual(2);
  });

  it("names the measured model", () => {
    expect(config.agent.model).toBe("claude-opus-5");
  });

  it("agrees with the loop's own step ceiling", () => {
    expect(config.agent.maxSteps).toBe(MAX_STEPS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/agent-config.test.ts`
Expected: FAIL — `config.agent` is undefined.

- [ ] **Step 3: Add the config block**

In `config/config.ts`, after the `analysis` block:

```typescript
  agent: {
    /**
     * The measured choice, and the one thing this project pays for.
     *
     * Three local models were evaluated on this Mac against three real
     * investigations (`npm run eval-agent`). The loop's navigation was fine
     * even at 8B — 32 steps, zero malformed replies — but the closing
     * judgement was not: a 9B model concluded a 203.6 ms HRV reading showed
     * "excellent recovery" after a workout three days earlier, citing five
     * real steps. The reading was a change of measurement, not of body.
     * This buys the judgement and nothing else.
     */
    model: "claude-opus-5",
    /** Hard ceiling per investigation. A measured run is ~$0.23. */
    maxUsdPerRun: 1.0,
    /** Must equal MAX_STEPS in core/agent/loop.ts; the test pins them together. */
    maxSteps: 10,
  },
```

- [ ] **Step 4: Write the entry point**

```typescript
// scripts/investigate.ts
/**
 * Runs one investigation and prints the whole transcript.
 *
 *   npm run investigate -- "Miért alacsonyabb ma a regenerációm?"
 *
 * Prints every step, not just the finding: a fluent wrong conclusion is
 * invisible in the finding alone, and reading the steps back is the only way
 * to tell inference from invention.
 *
 * THIS COSTS MONEY — the one metered path in the system.
 */
import { config } from "../config/config.ts";
import { createApp } from "../src/app.ts";
import { investigate } from "../src/core/agent/loop.ts";
import { anthropicInvestigator, ANTHROPIC_KEY_VAR } from "../src/infra/anthropic.ts";
import { createInvestigationRepo } from "../src/infra/db/repositories/investigations.ts";
import { createHealthRepo } from "../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../src/infra/db/repositories/workouts.ts";
import { isoDate } from "../src/shared/dates.ts";

process.env.LOG_LEVEL ??= "info";
const app = createApp();

const goal = process.argv.slice(2).join(" ").trim();
if (!goal) {
  console.error("Adj meg egy célt:  npm run investigate -- \"Miért alacsonyabb ma a regenerációm?\"");
  app.close();
  process.exit(1);
}

const apiKey = await app.runner.secrets.get(ANTHROPIC_KEY_VAR);
if (!apiKey) {
  console.error(`Nincs ${ANTHROPIC_KEY_VAR}. Tárold: ./scripts/set-secret.sh ${ANTHROPIC_KEY_VAR}`);
  app.close();
  process.exit(1);
}

const startedAt = new Date();
const today = isoDate(startedAt);
const model = anthropicInvestigator({
  apiKey, today, logger: app.runner.logger,
  model: config.agent.model, maxUsd: config.agent.maxUsdPerRun,
});

const result = await investigate({
  goal, model,
  ctx: {
    health: createHealthRepo(app.db),
    workouts: createWorkoutRepo(app.db),
    calendar: app.runner.calendar,
    today,
  },
  logger: app.runner.logger,
  signal: AbortSignal.timeout(10 * 60_000),
});

console.log(`\nCél: ${goal}\n${"═".repeat(72)}`);
result.transcript.forEach((entry, i) => {
  console.log(`${i + 1}. ${entry.step.name}(${JSON.stringify(entry.step.args)})`);
  if (entry.step.why) console.log(`   — ${entry.step.why}`);
  console.log(entry.observation.split("\n").map((l) => `   ${l}`).join("\n"));
});

console.log("═".repeat(72));
switch (result.outcome.kind) {
  case "kesz":
    console.log(`\nMEGÁLLAPÍTÁS: ${result.outcome.finding}`);
    console.log(`támaszkodik: ${result.outcome.cites.join(", ")} · cáfolat: ${result.outcome.falsifiedBy}. lépés`);
    break;
  case "kerdezz":
    console.log(`\nKÉRDÉS HOZZÁD: ${result.outcome.question}`);
    break;
  case "kifutott":
    console.log(`\nKifutott a ${config.agent.maxSteps} lépésből, megállapítás nélkül.`);
    break;
  case "hiba":
    console.log(`\nA nyomozás nem futott le: ${result.outcome.reason}`);
    break;
}
console.log(`\n[${model.spentUsd()} USD]`);

createInvestigationRepo(app.db).record({
  startedAt, goal, outcome: result.outcome.kind,
  finding: result.outcome.kind === "kesz" ? result.outcome.finding
    : result.outcome.kind === "kerdezz" ? result.outcome.question : null,
  transcript: result.transcript,
  usd: model.spentUsd(),
});

app.close();
```

- [ ] **Step 5: Add the npm script**

In `package.json`, next to `analyze`:

```json
    "investigate": "node --env-file-if-exists=.env scripts/investigate.ts",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/core/agent-config.test.ts && npm run typecheck && npm test`
Expected: PASS. Full suite green, still with no network access.

- [ ] **Step 7: Verify the entry point refuses cleanly without a key**

Run: `npm run investigate`
Expected: exits 1 with `Adj meg egy célt:` — no API call, no cost.

- [ ] **Step 8: Commit**

```bash
git add scripts/investigate.ts config/config.ts package.json test/core/agent-config.test.ts
git commit -m "feat: npm run investigate — a belépési pont, teljes átirattal"
```

---

### Task 10: A költség-őr átírása és élő ellenőrzés

**Files:**
- Modify: `test/core/cost-guard.test.ts`
- Modify: `scripts/smoke.ts:24-42`
- Modify: `README.md` — the "Hogyan marad ingyenes" section
- Test: the modified `cost-guard.test.ts`

**Interfaces:**
- Consumes: `config.agent` from Task 9; `ANTHROPIC_KEY_VAR` from Task 8
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

Add to `test/core/cost-guard.test.ts`:

```typescript
import { config } from "../../config/config.ts";

/**
 * The $0/month rule is gone, and that has to be stated rather than implied.
 *
 * It is replaced by two narrower rules, and both need to be pinned: the daily
 * brief stays free, and the one metered path has a ceiling. The danger a
 * dropped rule leaves behind is not the agent's cost — it is that a later
 * edit quietly makes the brief metered too, under cover of "we pay for the
 * API now anyway".
 */
describe("the metered path", () => {
  it("keeps the brief free even though the agent is not", () => {
    const chain = buildSynthesisChain(loadEnv(base), silentLogger());
    expect(chain.map((s) => s.name)).toEqual(["groq", "template"]);
    expect(chain.map((s) => s.name)).not.toContain("api");
  });

  it("caps what one investigation may spend", () => {
    expect(config.agent.maxUsdPerRun).toBeGreaterThan(0);
    expect(config.agent.maxUsdPerRun).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/cost-guard.test.ts`
Expected: FAIL — `config` is not imported in that file yet.

- [ ] **Step 3: Make it pass**

The import added in Step 1 is the fix. Run the test again to confirm.

- [ ] **Step 4: Update the smoke check**

In `scripts/smoke.ts`, replace the two `add(...)` calls in the cost-guard block:

```typescript
  add(
    "cost: brief never metered",
    paid.length === 0,
    paid.length === 0
      ? `a brief lánca végig ingyenes: ${chain.join(" → ")}`
      : `FIZETŐS SZINTETIZÁLÓ A BRIEF LÁNCÁBAN: ${paid.join(", ")}`,
  );
  // No longer "must be unset": the agent is the one metered path, and it
  // needs this key. What matters is that it is present deliberately and that
  // the per-run ceiling is real.
  const anthropicKey = await app.runner.secrets.get(ANTHROPIC_KEY_VAR);
  add(
    "cost: az ügynök plafonja",
    config.agent.maxUsdPerRun > 0,
    anthropicKey
      ? `${config.agent.model}, legfeljebb $${config.agent.maxUsdPerRun}/nyomozás`
      : `nincs ${ANTHROPIC_KEY_VAR} — az ügynök nem fut, a brief igen`,
  );
```

Add the import at the top of `scripts/smoke.ts`:

```typescript
import { ANTHROPIC_KEY_VAR } from "../src/infra/anthropic.ts";
```

- [ ] **Step 5: Update the README**

In `README.md`, replace the "Hogyan marad ingyenes" heading and its first paragraph with:

```markdown
## Mi ingyenes, és mi nem

A **brief és a chat** a Groq ingyenes tierjén fut, és ez nem változik — a
`npm run smoke` ellenőrzi, hogy a lánc végig ingyenes marad.

A **nyomozó ügynök** (`npm run investigate`) az egyetlen mért útvonal:
`claude-opus-5` az Anthropic API-n, nyomozásonként ~$0,23, kemény plafonnal
(`config.agent.maxUsdPerRun`). Azért ez, mert a lokális modellek mérése
megmutatta, hogy a hurok navigációja már egy 8B-vel is megy, a záró ítélet
viszont nem — és pontosan az hiányzott.
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck && npm run smoke`
Expected: all tests pass; smoke shows `cost: brief never metered` ✓ and `cost: az ügynök plafonja` ✓.

- [ ] **Step 7: Live verification — the one step that costs money**

Store the key first, then run the two investigations that matter:

```bash
./scripts/set-secret.sh ANTHROPIC_API_KEY
npm run investigate -- "A HRV-m 2026-09-04-én 203,6 ms volt, miközben minden korábbi mérés 158 alatt van. Mi történt?"
```

Expected, and this is the acceptance criterion for the whole plan: the run
must **not** conclude that a workout caused it. Either it finds the
measurement change (sleep data begins 2026-09-01 after a four-month gap), or
it ends with `kerdezz`. A confident physiological story means the falsification
gate is not enough, and the plan stops here for a design decision rather than
continuing.

Then a second, open-ended one:

```bash
npm run investigate -- "Van-e a hetemben olyan visszatérő minta, ami rontja az alvásomat?"
```

Record both transcripts in the commit message.

- [ ] **Step 8: Commit**

```bash
git add test/core/cost-guard.test.ts scripts/smoke.ts README.md
git commit -m "chore: a költség-őr átírása — a brief ingyenes marad, az ügynök plafonos"
```

---

## Önellenőrzés

**Spec-lefedettség.** Végigmentem az A1 spec szakaszain:

| Spec-követelmény | Feladat |
|---|---|
| `investigations` tábla, teljes átirat | 1 |
| 11 elemű kérdés-készlet | 3, 4, 5 |
| 1. védelem — kötelező cáfolat-lépés | 7 |
| 2. védelem — viszonyítással címkézett adat | 2, beépítve a `nap`-ba (3) |
| 3. védelem — mintaszám-küszöbök | 4 (`MIN_BUCKET_N`), 2 (`MIN_BASELINE_N`) |
| `claude-opus-5`, caching, streaming | 8 |
| Nincs template fallback | 6 (`hiba` kimenet), 10 (README) |
| A hurok mindig terminál | 6 (`MAX_STEPS`), 8 (költségplafon) |
| Érvénytelen lépés nem öli meg a nyomozást | 3 (`runQuestion`), 6 |
| Költség-plafon | 8, 9 (`config.agent.maxUsdPerRun`), 10 |
| `npm run investigate` | 9 |
| Tesztek hálózat nélkül | 6, 7 (scriptelt modell) |
| Költség-őr tudatos átírása | 10 |
| T3 regresszió | 7 |

**Ami szándékosan kimaradt a tervből is:** felület (Ma oldal, Telegram), a
`hipotezis` lépés naplózása külön táblába, és a nyomozás ütemezése. Mind a D
darabhoz tartozik.

**Két dolog, amit a végrehajtónak tudnia kell:**

1. **A Task 6 tesztje szándékosan hibás importot tartalmaz** (`silentCtx`), és a
   Step 4 javítja. Ez nem elírás: a `test/helpers.ts`-ben nincs ilyen export, és
   jobb, ha a végrehajtó a saját tesztjén tanulja meg, mint ha a hatodik
   feladatnál derülne ki.
2. **A Task 10 Step 7 az egyetlen pont, ahol pénz folyik el**, és az egyetlen,
   ahol a terv megállhat. Ha az Opus 5 ugyanúgy kitalálja az edzés-magyarázatot,
   mint a `qwen3.5:9b`, az nem folytatandó implementációs hiba, hanem tervezési
   döntés, ami visszakerül a tulajdonoshoz.
