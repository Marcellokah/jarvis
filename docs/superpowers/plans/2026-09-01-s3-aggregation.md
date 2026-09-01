# S3 — Aggregációs réteg és mélyelemzés — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kézzel indított mélyelemzés, ami a 2 715 napos történetből rövid- és hosszútávú diagnosztikát ad, területenként külön, a korábbi megállapításait megjegyezve.

**Architecture:** Két fél, éles határral. Az aggregációs réteg tiszta kód — gördülő ablakok, trendek, korrelációk, lefedettséggel —, hálózat és véletlen nélkül, fixtúrákkal tesztelve. Az elemző négy Groq-hívást futtat sorban (fizikai, regenerálódás, pénzügy, majd összegzés), a hívások között várakozva a 6 000 token/perc keret miatt. Minden lefutás az `analyses` táblába kerül, és a következő futás területenként az utolsó három összegzést kapja vissza.

**Tech Stack:** Node 24 (`.ts` közvetlenül, build nélkül), `node:sqlite`, vitest, a meglévő `Fetcher` és `groqComplete`. Új futásidejű függőség nincs.

## Global Constraints

- Node >= 24, build lépés nincs, a `.ts` fájlok közvetlenül futnak.
- **Új futásidejű függőség nem vehető fel.**
- `npm run typecheck` (`tsc --noEmit`) tisztán fut.
- A tesztek hálózat nélkül futnak, és soha nem olvassák a valódi exportot vagy az éles adatbázist.
- Felhasználónak szóló szöveg magyarul, kódkommentek angolul. A komment azt magyarázza, **miért**, nem azt, hogy mit.
- A migrációs fájlok folytonos, csak bővülő sorozatot alkotnak: `006_analyses.sql` a `005_subscription_months.sql` után.
- **Hiányzó metrika `null`, nem nulla és nem becslés.** Minden metrika mellett utazik `n`, `coverage` és `window`.
- Az éles adatbázist (`./data/jarvis.db`) egy launchd agent tartja nyitva; alatta másik folyamat írásai nem véglegesülnek. **Egyik task sem ír az éles adatbázisba** — a Task 7 élesben csak olvas és az ott leírt módon jár el.
- Commit-üzenet utolsó sora: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Kiindulás

Branch: `s3-aggregation`, a `main`-ről (`cb350a4`). Kiinduló állapot: 244 teszt / 27 fájl zöld, typecheck tiszta.

## Fájlszerkezet

| Fájl | Felelősség |
|---|---|
| `src/core/analysis/stats.ts` | Statisztikai alapok: átlag, szórás, meredekség, Pearson, ablakolás. Tiszta |
| `src/core/analysis/aggregate.ts` | Repó-sorok → `Metrics` területenként. Tiszta |
| `src/core/analysis/relations.ts` | A zárt korrelációs lista és a mintaszám-kapu. Tiszta |
| `src/infra/db/migrations/006_analyses.sql` | Az `analyses` tábla |
| `src/infra/db/repositories/analyses.ts` | Az elemzések tára — ez a memória |
| `src/core/analysis/prompts.ts` | Területenkénti prompt és az összegzés kinyerése |
| `src/core/analysis/analyst.ts` | A négy hívás, ütemezés, hibaelkülönítés |
| `scripts/analyze.ts` | Az `npm run analyze` parancs |

---

## Task 1: Statisztikai alapok

**Files:**
- Create: `src/core/analysis/stats.ts`
- Test: `test/core/analysis-stats.test.ts` (új)

**Interfaces:**
- Consumes: semmit — ez a legalsó réteg
- Produces: `Point`, `Metric`, `shiftDay`, `mean`, `stdDev`, `slopePer30d`, `pearson`, `windowed`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/analysis-stats.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import {
  shiftDay, mean, stdDev, slopePer30d, pearson, windowed,
} from "../../src/core/analysis/stats.ts";

describe("shiftDay", () => {
  it("does calendar arithmetic, unaffected by daylight saving", () => {
    // Budapest switches on 2026-03-29. A naive local-time shift would land on
    // the wrong day here; these are plain date labels, so the answer is exact.
    expect(shiftDay("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftDay("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2024-02-28", 1)).toBe("2024-02-29");
  });
});

describe("mean and stdDev", () => {
  it("returns null rather than a number it cannot justify", () => {
    expect(mean([])).toBeNull();
    expect(stdDev([])).toBeNull();
    // One sample has no spread; a zero here would read as "perfectly stable".
    expect(stdDev([5])).toBeNull();
  });

  it("computes the sample standard deviation", () => {
    expect(mean([2, 4, 6])).toBe(4);
    // sample sd of [2,4,6]: sqrt(((-2)^2 + 0 + 2^2) / 2) = sqrt(4) = 2
    expect(stdDev([2, 4, 6])).toBe(2);
  });
});

describe("slopePer30d", () => {
  it("expresses the trend per 30 days, not per day", () => {
    // -0.1 per day over 60 days => -3.0 per 30 days.
    const points = Array.from({ length: 61 }, (_, i) => ({
      date: shiftDay("2026-01-01", i),
      value: 40 - i * 0.1,
    }));
    expect(slopePer30d(points)).toBeCloseTo(-3, 6);
  });

  it("uses the real day gaps, not the position in the array", () => {
    // Two points 100 days apart, rising by 10: 3 per 30 days.
    const points = [
      { date: "2026-01-01", value: 0 },
      { date: "2026-02-01", value: 3.1 },
      { date: "2026-04-11", value: 10 },
    ];
    expect(slopePer30d(points)).toBeCloseTo(3, 1);
  });

  it("returns null below three points", () => {
    expect(slopePer30d([{ date: "2026-01-01", value: 1 }])).toBeNull();
    expect(slopePer30d([
      { date: "2026-01-01", value: 1 }, { date: "2026-01-02", value: 2 },
    ])).toBeNull();
  });
});

describe("pearson", () => {
  it("is 1 for a perfect rise and -1 for a perfect fall", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 9);
  });

  it("refuses when a side has no variance", () => {
    // A flat series correlates with nothing; 0 would be a claim, null is honest.
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("returns null below three pairs and on a length mismatch", () => {
    expect(pearson([1, 2], [2, 4])).toBeNull();
    expect(pearson([1, 2, 3], [1, 2])).toBeNull();
  });
});

describe("windowed", () => {
  const points = [
    { date: "2026-08-25", value: 10 },
    { date: "2026-08-30", value: 20 },
    { date: "2026-08-31", value: 30 },
    // Outside a 7-day window ending 2026-08-31.
    { date: "2026-08-01", value: 1000 },
  ];

  it("averages only what falls inside the window", () => {
    const w = windowed(points, "2026-08-31", 7, "7d");
    expect(w.value).toBe(20);
    expect(w.n).toBe(3);
    expect(w.window).toBe("7d");
  });

  it("reports coverage as the share of days that had a reading", () => {
    const w = windowed(points, "2026-08-31", 7, "7d");
    expect(w.coverage).toBeCloseTo(3 / 7, 9);
  });

  it("is empty, not zero, when nothing falls inside", () => {
    const w = windowed(points, "2027-01-01", 7, "7d");
    expect(w.value).toBeNull();
    expect(w.n).toBe(0);
    expect(w.coverage).toBe(0);
  });

  it("includes the end day and excludes the day that falls off the far edge", () => {
    // A 7-day window ending 2026-08-31 covers 08-25..08-31 inclusive.
    expect(windowed([{ date: "2026-08-25", value: 1 }], "2026-08-31", 7, "7d").n).toBe(1);
    expect(windowed([{ date: "2026-08-24", value: 1 }], "2026-08-31", 7, "7d").n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/analysis-stats.test.ts`
Expected: FAIL — a `src/core/analysis/stats.ts` modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/analysis/stats.ts` fájlt:

```typescript
/**
 * Statistical primitives for the aggregation layer.
 *
 * Everything here is pure and returns `null` rather than a number it cannot
 * justify. That is the project's rule stated in arithmetic: a mean of nothing
 * is not zero, and a standard deviation of one sample is not stability.
 */

/** A dated observation. `date` is a plain YYYY-MM-DD label, not an instant. */
export interface Point {
  date: string;
  value: number;
}

/** A windowed statistic, always travelling with the evidence behind it. */
export interface Metric {
  value: number | null;
  /** How many days inside the window actually had a reading. */
  n: number;
  /** `n` divided by the window length, 0..1. */
  coverage: number;
  /** Human label for the window, e.g. "28d". */
  window: string;
}

const DAY_MS = 86_400_000;

/**
 * Calendar arithmetic on date labels.
 *
 * Built on UTC deliberately: these are labels for days, not moments, so a
 * local-time shift across a daylight-saving boundary would move the wrong day.
 */
export function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function dayGap(from: string, to: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / DAY_MS);
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation. Null below two values — one has no spread. */
export function stdDev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Least-squares slope, scaled to 30 days.
 *
 * Per-day slopes are unreadable at this scale ("-0.023 VO2max/day" says
 * nothing); per-month is the unit a person actually thinks in. The regression
 * runs on real day gaps rather than array positions, because the series are
 * full of holes and treating a 40-day gap as one step would invent a trend.
 */
export function slopePer30d(points: readonly Point[]): number | null {
  if (points.length < 3) return null;
  const origin = points[0]!.date;
  const xs = points.map((p) => dayGap(origin, p.date));
  const ys = points.map((p) => p.value);
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 30;
}

/** Pearson correlation. Null below three pairs, or when either side is flat. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ma = mean(a)!;
  const mb = mean(b)!;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * Mean of the points inside a window of `days` ending on `end` (inclusive).
 *
 * Missing days are skipped, never counted as zero — a day with no step count
 * is a day the phone was off, not a day without walking. `coverage` is what
 * keeps that honest downstream.
 */
export function windowed(
  points: readonly Point[],
  end: string,
  days: number,
  window: string,
): Metric {
  const first = shiftDay(end, -(days - 1));
  const inside = points.filter((p) => p.date >= first && p.date <= end);
  return {
    value: mean(inside.map((p) => p.value)),
    n: inside.length,
    coverage: inside.length / days,
    window,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/analysis-stats.test.ts && npm run typecheck`
Expected: PASS, typecheck tiszta.

- [ ] **Step 5: Commit**

```bash
git add src/core/analysis/stats.ts test/core/analysis-stats.test.ts
git commit -m "feat: statistical primitives that return null instead of guessing"
```

---

## Task 2: Az aggregációs réteg

**Files:**
- Create: `src/core/analysis/aggregate.ts`
- Test: `test/core/analysis-aggregate.test.ts` (új)

**Interfaces:**
- Consumes: `Point`, `Metric`, `windowed`, `slopePer30d`, `shiftDay`, `mean` (Task 1); `HealthSnapshot` a `src/infra/db/repositories/health.ts`-ből; `WorkoutRow` a `src/infra/health-export/rollup.ts`-ből; `MonthlySubscription` a `src/infra/db/repositories/subscription-months.ts`-ből
- Produces: `AggregateInput`, `Metrics`, `PhysicalMetrics`, `RecoveryMetrics`, `FinanceMetrics`, `TrendMetric`, `aggregate(input): Metrics`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/analysis-aggregate.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { aggregate, type AggregateInput } from "../../src/core/analysis/aggregate.ts";
import { shiftDay } from "../../src/core/analysis/stats.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";
import type { WorkoutRow } from "../../src/infra/health-export/rollup.ts";

const TODAY = "2026-08-31";

function snap(date: string, p: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    date, sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null,
    steps: null, asleepMin: null, inBedMin: null, coreMin: null, remMin: null,
    deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
    walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
    dietProteinG: null, dietCarbsG: null, dietFatG: null,
    ingestedAt: "2026-08-31T00:00:00.000Z", ...p,
  };
}

function workout(date: string, durationMin: number, type = "Walking"): WorkoutRow {
  return { date, type, startedAt: `${date}T10:00:00.000Z`, durationMin, energyKcal: null, source: "Watch" };
}

function input(p: Partial<AggregateInput> = {}): AggregateInput {
  return { today: TODAY, snapshots: [], workouts: [], months: [], ...p };
}

describe("aggregate — physical", () => {
  it("computes the load ratio from daily averages, not raw totals", () => {
    // 60 minutes every day for a full year: the 28-day and 365-day daily
    // averages are equal, so the ratio is 1 whatever the totals are.
    const workouts = Array.from({ length: 365 }, (_, i) => workout(shiftDay(TODAY, -i), 60));
    const m = aggregate(input({ workouts }));
    expect(m.physical.loadRatio).toBeCloseTo(1, 6);
  });

  it("shows a ratio below 1 when recent training has dropped off", () => {
    // Trained daily for the year, but nothing in the last 28 days.
    const workouts = Array.from({ length: 365 }, (_, i) => workout(shiftDay(TODAY, -(i + 28)), 60));
    const m = aggregate(input({ workouts }));
    expect(m.physical.loadRatio).toBe(0);
  });

  it("is null when there is no long-run baseline to compare against", () => {
    const m = aggregate(input({ workouts: [workout(TODAY, 60)] }));
    // One day of training is not a 365-day baseline; a ratio here would be
    // arithmetically computable and completely meaningless.
    expect(m.physical.loadRatio).toBeNull();
  });

  it("counts strength sessions per week over 28 days", () => {
    const workouts = [
      workout(shiftDay(TODAY, -1), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -3), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -8), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -10), 60, "TraditionalStrengthTraining"),
      workout(shiftDay(TODAY, -40), 60, "TraditionalStrengthTraining"), // outside
      workout(shiftDay(TODAY, -2), 60, "Walking"),                      // not strength
    ];
    const m = aggregate(input({ workouts }));
    expect(m.physical.strengthPerWeek28d).toBeCloseTo(4 / 4, 6);
  });

  it("groups training by month with hours, sessions and strength count", () => {
    const workouts = [
      workout("2026-08-02", 90, "TraditionalStrengthTraining"),
      workout("2026-08-03", 30),
      workout("2026-07-15", 60),
    ];
    const m = aggregate(input({ workouts }));
    expect(m.physical.byMonth).toEqual([
      { month: "2026-07", hours: 1, sessions: 1, strength: 0 },
      { month: "2026-08", hours: 2, sessions: 2, strength: 1 },
    ]);
  });

  it("carries the VO2max trend as a slope per 30 days", () => {
    // 40.0 falling by 0.1/day for 60 days => -3.0 per 30 days.
    const snapshots = Array.from({ length: 61 }, (_, i) =>
      snap(shiftDay(TODAY, -60 + i), { vo2max: 40 - (60 - i) * 0.1 }));
    const m = aggregate(input({ snapshots }));
    expect(m.physical.vo2max.slopePer30d).toBeCloseTo(3, 5);
    expect(m.physical.vo2max.n).toBe(61);
  });
});

describe("aggregate — recovery", () => {
  it("expresses the recent HRV deviation in standard deviations", () => {
    // 90 days at 50 with a spread, then 7 days at 60.
    const snapshots = [
      ...Array.from({ length: 83 }, (_, i) =>
        snap(shiftDay(TODAY, -(i + 7)), { hrv: i % 2 === 0 ? 45 : 55 })),
      ...Array.from({ length: 7 }, (_, i) => snap(shiftDay(TODAY, -i), { hrv: 60 })),
    ];
    const m = aggregate(input({ snapshots }));
    expect(m.recovery.hrvDeviationSigma).not.toBeNull();
    expect(m.recovery.hrvDeviationSigma!).toBeGreaterThan(0);
  });

  it("reports sleep coverage per year, because the sparsity is the finding", () => {
    const snapshots = [
      snap("2025-01-01", { asleepMin: 400 }),
      snap("2025-01-02"),
      snap("2026-01-01", { asleepMin: 420 }),
    ];
    const m = aggregate(input({ snapshots }));
    expect(m.recovery.sleepByYear).toEqual([
      { year: "2025", days: 2, withSleep: 1 },
      { year: "2026", days: 1, withSleep: 1 },
    ]);
  });

  it("leaves a metric null rather than zero when nothing was measured", () => {
    const m = aggregate(input({ snapshots: [snap(TODAY)] }));
    expect(m.recovery.hrv.d28.value).toBeNull();
    expect(m.recovery.hrv.d28.n).toBe(0);
    expect(m.recovery.asleepMin.d90.value).toBeNull();
  });
});

describe("aggregate — finance", () => {
  const months = [
    { month: "2026-07", subs: [
      { name: "Netflix", amountHuf: 4490, cycle: "monthly", active: true },
      { name: "Gym", amountHuf: 19900, cycle: "monthly", active: true },
    ] },
    { month: "2026-08", subs: [
      { name: "Netflix", amountHuf: 4990, cycle: "monthly", active: true },
      { name: "Gym", amountHuf: 19900, cycle: "monthly", active: false },
    ] },
  ];

  it("totals only what was active in the month", () => {
    const m = aggregate(input({ months }));
    expect(m.finance.months).toEqual([
      { month: "2026-07", totalHuf: 24390, activeCount: 2 },
      { month: "2026-08", totalHuf: 4990, activeCount: 1 },
    ]);
  });

  it("names what changed between the last two months", () => {
    const m = aggregate(input({ months }));
    expect(m.finance.monthOverMonth).toEqual({
      from: "2026-07", to: "2026-08", deltaHuf: -19400,
      changes: [
        { name: "Gym", fromHuf: 19900, toHuf: null },
        { name: "Netflix", fromHuf: 4490, toHuf: 4990 },
      ],
    });
  });

  it("has nothing to compare in the first month, and says so with null", () => {
    const m = aggregate(input({ months: months.slice(0, 1) }));
    // The table was created in S2; there is no history before it, and an
    // invented comparison would be an estimate wearing a measurement's clothes.
    expect(m.finance.monthOverMonth).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/analysis-aggregate.test.ts`
Expected: FAIL — a `src/core/analysis/aggregate.ts` modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/analysis/aggregate.ts` fájlt:

```typescript
import type { HealthSnapshot } from "../../infra/db/repositories/health.ts";
import type { WorkoutRow } from "../../infra/health-export/rollup.ts";
import type { MonthlySubscription } from "../../infra/db/repositories/subscription-months.ts";
import {
  mean, shiftDay, slopePer30d, stdDev, windowed, type Metric, type Point,
} from "./stats.ts";

export interface AggregateInput {
  /** YYYY-MM-DD, the day every window ends on. */
  today: string;
  snapshots: readonly HealthSnapshot[];
  workouts: readonly WorkoutRow[];
  months: readonly { month: string; subs: readonly MonthlySubscription[] }[];
}

export interface TrendMetric extends Metric {
  slopePer30d: number | null;
}

export interface PhysicalMetrics {
  byMonth: { month: string; hours: number; sessions: number; strength: number }[];
  /** 28-day daily average training minutes over the 365-day daily average. */
  loadRatio: number | null;
  strengthPerWeek28d: number | null;
  vo2max: TrendMetric;
  rhr: TrendMetric;
  hrRecovery: TrendMetric;
  steps: { d7: Metric; d28: Metric; d90: Metric; d365: Metric };
}

export interface RecoveryMetrics {
  hrv: { d7: Metric; d28: Metric; d90: Metric; d365: Metric };
  /** (7-day mean − 90-day mean) in units of the 90-day standard deviation. */
  hrvDeviationSigma: number | null;
  asleepMin: { d28: Metric; d90: Metric; d365: Metric };
  stages: { core: Metric; rem: Metric; deep: Metric };
  awakenings: Metric;
  sleepByYear: { year: string; days: number; withSleep: number }[];
}

export interface FinanceMetrics {
  months: { month: string; totalHuf: number; activeCount: number }[];
  monthOverMonth: {
    from: string;
    to: string;
    deltaHuf: number;
    changes: { name: string; fromHuf: number | null; toHuf: number | null }[];
  } | null;
  annualisedHuf: number | null;
}

export interface Metrics {
  today: string;
  physical: PhysicalMetrics;
  recovery: RecoveryMetrics;
  finance: FinanceMetrics;
}

const STRENGTH = "TraditionalStrengthTraining";

/** Pulls one nullable column out as dated points, dropping the days without it. */
function series(snapshots: readonly HealthSnapshot[], key: keyof HealthSnapshot): Point[] {
  const out: Point[] = [];
  for (const s of snapshots) {
    const v = s[key];
    if (typeof v === "number") out.push({ date: s.date, value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function trend(points: Point[], today: string, days: number, window: string): TrendMetric {
  const first = shiftDay(today, -(days - 1));
  const inside = points.filter((p) => p.date >= first && p.date <= today);
  return { ...windowed(points, today, days, window), slopePer30d: slopePer30d(inside) };
}

/** Total training minutes per day, so a day with three sessions counts once. */
function minutesByDay(workouts: readonly WorkoutRow[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const w of workouts) byDay.set(w.date, (byDay.get(w.date) ?? 0) + w.durationMin);
  return byDay;
}

function dailyAverageMinutes(
  byDay: Map<string, number>, today: string, days: number,
): { avg: number; daysWithTraining: number } {
  const first = shiftDay(today, -(days - 1));
  let total = 0;
  let n = 0;
  for (const [date, minutes] of byDay) {
    if (date >= first && date <= today) { total += minutes; n++; }
  }
  // Divided by the window, not by the days trained: rest days are part of the
  // load, and dividing by sessions would make training less often look harder.
  return { avg: total / days, daysWithTraining: n };
}

export function aggregate(input: AggregateInput): Metrics {
  const { today, snapshots, workouts, months } = input;

  // ---- physical ----------------------------------------------------------
  const byDay = minutesByDay(workouts);
  const acute = dailyAverageMinutes(byDay, today, 28);
  const chronic = dailyAverageMinutes(byDay, today, 365);

  // A ratio needs a baseline to be a ratio. Under a month of history in the
  // long window there is nothing to be "relative to", so it stays null.
  const loadRatio = chronic.daysWithTraining >= 28 && chronic.avg > 0
    ? acute.avg / chronic.avg
    : null;

  const monthly = new Map<string, { hours: number; sessions: number; strength: number }>();
  for (const w of workouts) {
    const month = w.date.slice(0, 7);
    const cur = monthly.get(month) ?? { hours: 0, sessions: 0, strength: 0 };
    cur.hours += w.durationMin / 60;
    cur.sessions += 1;
    if (w.type === STRENGTH) cur.strength += 1;
    monthly.set(month, cur);
  }
  const byMonth = [...monthly.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({
      month, hours: Math.round(v.hours * 10) / 10, sessions: v.sessions, strength: v.strength,
    }));

  const first28 = shiftDay(today, -27);
  const strength28 = workouts.filter(
    (w) => w.type === STRENGTH && w.date >= first28 && w.date <= today,
  ).length;

  const steps = series(snapshots, "steps");

  // ---- recovery ----------------------------------------------------------
  const hrv = series(snapshots, "hrv");
  const hrv7 = windowed(hrv, today, 7, "7d");
  const hrv90 = windowed(hrv, today, 90, "90d");
  const first90 = shiftDay(today, -89);
  const sd90 = stdDev(
    hrv.filter((p) => p.date >= first90 && p.date <= today).map((p) => p.value),
  );
  const hrvDeviationSigma = hrv7.value !== null && hrv90.value !== null && sd90 !== null && sd90 > 0
    ? (hrv7.value - hrv90.value) / sd90
    : null;

  const yearly = new Map<string, { days: number; withSleep: number }>();
  for (const s of snapshots) {
    const year = s.date.slice(0, 4);
    const cur = yearly.get(year) ?? { days: 0, withSleep: 0 };
    cur.days += 1;
    if (typeof s.asleepMin === "number") cur.withSleep += 1;
    yearly.set(year, cur);
  }
  const sleepByYear = [...yearly.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, v]) => ({ year, ...v }));

  const asleep = series(snapshots, "asleepMin");

  // ---- finance -----------------------------------------------------------
  const ordered = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const financeMonths = ordered.map((m) => {
    const active = m.subs.filter((s) => s.active);
    return {
      month: m.month,
      totalHuf: active.reduce((a, s) => a + s.amountHuf, 0),
      activeCount: active.length,
    };
  });

  let monthOverMonth: FinanceMetrics["monthOverMonth"] = null;
  if (ordered.length >= 2) {
    const prev = ordered[ordered.length - 2]!;
    const curr = ordered[ordered.length - 1]!;
    const amountOf = (subs: readonly MonthlySubscription[], name: string) => {
      const hit = subs.find((s) => s.name === name && s.active);
      return hit ? hit.amountHuf : null;
    };
    const names = [...new Set([...prev.subs, ...curr.subs].map((s) => s.name))].sort();
    const changes = names
      .map((name) => ({
        name, fromHuf: amountOf(prev.subs, name), toHuf: amountOf(curr.subs, name),
      }))
      .filter((c) => c.fromHuf !== c.toHuf);
    const totalOf = (month: string) =>
      financeMonths.find((m) => m.month === month)!.totalHuf;
    monthOverMonth = {
      from: prev.month, to: curr.month,
      deltaHuf: totalOf(curr.month) - totalOf(prev.month),
      changes,
    };
  }

  const latestTotal = financeMonths.at(-1)?.totalHuf ?? null;

  return {
    today,
    physical: {
      byMonth,
      loadRatio,
      strengthPerWeek28d: workouts.length > 0 ? strength28 / 4 : null,
      vo2max: trend(series(snapshots, "vo2max"), today, 365, "365d"),
      rhr: trend(series(snapshots, "rhr"), today, 365, "365d"),
      hrRecovery: trend(series(snapshots, "hrRecovery"), today, 365, "365d"),
      steps: {
        d7: windowed(steps, today, 7, "7d"),
        d28: windowed(steps, today, 28, "28d"),
        d90: windowed(steps, today, 90, "90d"),
        d365: windowed(steps, today, 365, "365d"),
      },
    },
    recovery: {
      hrv: {
        d7: hrv7,
        d28: windowed(hrv, today, 28, "28d"),
        d90: hrv90,
        d365: windowed(hrv, today, 365, "365d"),
      },
      hrvDeviationSigma,
      asleepMin: {
        d28: windowed(asleep, today, 28, "28d"),
        d90: windowed(asleep, today, 90, "90d"),
        d365: windowed(asleep, today, 365, "365d"),
      },
      stages: {
        core: windowed(series(snapshots, "coreMin"), today, 90, "90d"),
        rem: windowed(series(snapshots, "remMin"), today, 90, "90d"),
        deep: windowed(series(snapshots, "deepMin"), today, 90, "90d"),
      },
      awakenings: windowed(series(snapshots, "awakenings"), today, 90, "90d"),
      sleepByYear,
    },
    finance: {
      months: financeMonths,
      monthOverMonth,
      annualisedHuf: latestTotal === null ? null : latestTotal * 12,
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/analysis-aggregate.test.ts && npm run typecheck`
Expected: PASS, typecheck tiszta.

> Ha egy elvárt szám nem jön ki, **először a fixtúrán ellenőrizd a számtant, és ne a tesztet igazítsd a kimenethez.** Ebben a projektben már kétszer fordult elő, hogy a terv számolt rosszul és a fixtúrának volt igaza. Ha eltérést találsz, állj meg és jelezd.

- [ ] **Step 5: Commit**

```bash
git add src/core/analysis/aggregate.ts test/core/analysis-aggregate.test.ts
git commit -m "feat: aggregate history into per-domain metrics with coverage"
```

---

## Task 3: Összefüggések — a zárt lista

**Files:**
- Create: `src/core/analysis/relations.ts`
- Test: `test/core/analysis-relations.test.ts` (új)

**Interfaces:**
- Consumes: `AggregateInput` (Task 2); `pearson`, `shiftDay`, `type Point` (Task 1)
- Produces: `Relation`, `relations(input: AggregateInput, minN: number): Relation[]`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/analysis-relations.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { relations } from "../../src/core/analysis/relations.ts";
import { shiftDay } from "../../src/core/analysis/stats.ts";
import type { AggregateInput } from "../../src/core/analysis/aggregate.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

const TODAY = "2026-08-31";

function snap(date: string, p: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    date, sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null,
    steps: null, asleepMin: null, inBedMin: null, coreMin: null, remMin: null,
    deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
    walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
    dietProteinG: null, dietCarbsG: null, dietFatG: null,
    ingestedAt: "2026-08-31T00:00:00.000Z", ...p,
  };
}

function input(snapshots: HealthSnapshot[]): AggregateInput {
  return { today: TODAY, snapshots, workouts: [], months: [] };
}

describe("relations", () => {
  it("drops a pair below the minimum sample size entirely", () => {
    // 10 days of a flawless relationship is still 10 days. It must not appear
    // as a weak correlation — it must not appear at all.
    const snapshots = Array.from({ length: 10 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50 + i, asleepMin: 300 + i * 10 }));
    expect(relations(input(snapshots), 30)).toEqual([]);
  });

  it("reports a pair once it clears the minimum, with n and the window", () => {
    const snapshots = Array.from({ length: 40 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50 + i, asleepMin: 300 + i * 10 }));
    const found = relations(input(snapshots), 30);
    const pair = found.find((r) => r.key === "hrv_vs_sleep");
    expect(pair).toBeDefined();
    expect(pair!.n).toBe(40);
    expect(pair!.r).toBeCloseTo(1, 6);
    expect(pair!.window).toBe("teljes átfedés");
  });

  it("pairs only the days where both values are present", () => {
    const snapshots = [
      ...Array.from({ length: 35 }, (_, i) =>
        snap(shiftDay(TODAY, -i), { hrv: 50 + i, asleepMin: 300 + i * 10 })),
      // Fifty days carrying only one side of the pair — they cannot join it.
      ...Array.from({ length: 50 }, (_, i) => snap(shiftDay(TODAY, -(i + 40)), { hrv: 99 })),
    ];
    const pair = relations(input(snapshots), 30).find((r) => r.key === "hrv_vs_sleep");
    expect(pair!.n).toBe(35);
  });

  it("omits a pair whose correlation cannot be computed", () => {
    // HRV never varies: there is no relationship to measure, and 0 would be
    // a claim rather than an absence.
    const snapshots = Array.from({ length: 40 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50, asleepMin: 300 + i * 10 }));
    expect(relations(input(snapshots), 30).find((r) => r.key === "hrv_vs_sleep")).toBeUndefined();
  });

  it("keeps every pair it returns inside the closed list", () => {
    const snapshots = Array.from({ length: 400 }, (_, i) =>
      snap(shiftDay(TODAY, -i), { hrv: 50 + (i % 7), rhr: 60 + (i % 5), steps: 8000 + i, asleepMin: 400 + (i % 9) }));
    const keys = relations(input(snapshots), 30).map((r) => r.key);
    for (const k of keys) {
      expect(["load_vs_rhr", "load_vs_hrv", "hrv_vs_sleep", "steps_vs_rhr"]).toContain(k);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/analysis-relations.test.ts`
Expected: FAIL — a `src/core/analysis/relations.ts` modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/analysis/relations.ts` fájlt:

```typescript
import type { AggregateInput } from "./aggregate.ts";
import type { HealthSnapshot } from "../../infra/db/repositories/health.ts";
import { pearson, shiftDay } from "./stats.ts";

export interface Relation {
  /** Stable identifier, so a test can name a pair without matching prose. */
  key: "load_vs_rhr" | "load_vs_hrv" | "hrv_vs_sleep" | "steps_vs_rhr";
  /** Hungarian label, shown to the model and in the report. */
  label: string;
  r: number;
  n: number;
  window: string;
}

/**
 * The closed list of relationships the analysis is allowed to discuss.
 *
 * Not a limitation to work around: 2,715 days and a dozen metrics will hand a
 * pattern to anyone who goes looking, and a language model always finds one.
 * Adding a pair is a code change on purpose, so the decision is made once,
 * deliberately, rather than improvised inside a prompt.
 */

/** Trailing 28-day training minutes per day, as a series aligned to dates. */
function loadSeries(input: AggregateInput, days: number): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const w of input.workouts) {
    byDay.set(w.date, (byDay.get(w.date) ?? 0) + w.durationMin);
  }
  const out = new Map<string, number>();
  const first = shiftDay(input.today, -(days - 1));
  for (let d = first; d <= input.today; d = shiftDay(d, 1)) {
    let total = 0;
    for (let k = 0; k < 28; k++) total += byDay.get(shiftDay(d, -k)) ?? 0;
    out.set(d, total);
  }
  return out;
}

function column(
  snapshots: readonly HealthSnapshot[], key: keyof HealthSnapshot,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of snapshots) {
    const v = s[key];
    if (typeof v === "number") out.set(s.date, v);
  }
  return out;
}

/** Pairs the two maps on the dates they share, in date order. */
function paired(a: Map<string, number>, b: Map<string, number>): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const date of [...a.keys()].sort()) {
    const y = b.get(date);
    if (y !== undefined) { xs.push(a.get(date)!); ys.push(y); }
  }
  return { xs, ys };
}

export function relations(input: AggregateInput, minN: number): Relation[] {
  const load365 = loadSeries(input, 365);
  const within365 = (m: Map<string, number>) => {
    const first = shiftDay(input.today, -364);
    return new Map([...m].filter(([d]) => d >= first && d <= input.today));
  };

  const rhr = column(input.snapshots, "rhr");
  const hrv = column(input.snapshots, "hrv");
  const steps = column(input.snapshots, "steps");
  const sleep = column(input.snapshots, "asleepMin");

  const candidates: { key: Relation["key"]; label: string; window: string; a: Map<string, number>; b: Map<string, number> }[] = [
    { key: "load_vs_rhr", label: "28 napos edzésterhelés ↔ nyugalmi pulzus", window: "365 nap", a: load365, b: within365(rhr) },
    { key: "load_vs_hrv", label: "28 napos edzésterhelés ↔ HRV", window: "365 nap", a: load365, b: within365(hrv) },
    { key: "hrv_vs_sleep", label: "HRV ↔ alváshossz", window: "teljes átfedés", a: hrv, b: sleep },
    { key: "steps_vs_rhr", label: "lépésszám ↔ nyugalmi pulzus", window: "365 nap", a: within365(steps), b: within365(rhr) },
  ];

  const out: Relation[] = [];
  for (const c of candidates) {
    const { xs, ys } = paired(c.a, c.b);
    // Below the threshold the pair is not weak evidence — it is no evidence,
    // and it never reaches the prompt.
    if (xs.length < minN) continue;
    const r = pearson(xs, ys);
    if (r === null) continue;
    out.push({ key: c.key, label: c.label, r, n: xs.length, window: c.window });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/analysis-relations.test.ts && npm run typecheck`
Expected: PASS, typecheck tiszta.

- [ ] **Step 5: Commit**

```bash
git add src/core/analysis/relations.ts test/core/analysis-relations.test.ts
git commit -m "feat: closed correlation list with a sample-size gate"
```

---

## Task 4: Tárolás — az elemzések tára

**Files:**
- Create: `src/infra/db/migrations/006_analyses.sql`
- Create: `src/infra/db/repositories/analyses.ts`
- Modify: `src/infra/db/repositories/health.ts` (új `between` metódus)
- Modify: `src/app.ts`
- Test: `test/core/analyses-repo.test.ts` (új)

**Interfaces:**
- Consumes: `Db` a `src/infra/db/index.ts`-ből
- Produces: `Domain`, `AnalysisRow`, `AnalysisRepo`, `createAnalysisRepo(db)`; `HealthRepo.between(from, to): HealthSnapshot[]`; `App.analyses`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/analyses-repo.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createAnalysisRepo } from "../../src/infra/db/repositories/analyses.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";

const base = { markdown: "# szöveg", summary: "összegzés", metrics: "{}" };

describe("analysis repo", () => {
  it("returns the most recent entries for one domain, newest first", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);

    repo.save({ createdAt: "2026-06-01T08:00:00.000Z", domain: "physical", ...base, summary: "első" });
    repo.save({ createdAt: "2026-07-01T08:00:00.000Z", domain: "physical", ...base, summary: "második" });
    repo.save({ createdAt: "2026-08-01T08:00:00.000Z", domain: "physical", ...base, summary: "harmadik" });
    repo.save({ createdAt: "2026-08-02T08:00:00.000Z", domain: "recovery", ...base, summary: "más terület" });

    expect(repo.recent("physical", 2).map((r) => r.summary)).toEqual(["harmadik", "második"]);
    db.close();
  });

  it("keeps domains apart", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);
    repo.save({ createdAt: "2026-08-01T08:00:00.000Z", domain: "finance", ...base });
    expect(repo.recent("physical", 3)).toEqual([]);
    db.close();
  });

  it("returns every domain from the latest run", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);
    repo.save({ createdAt: "2026-07-01T08:00:00.000Z", domain: "physical", ...base, summary: "régi" });
    repo.save({ createdAt: "2026-08-01T09:00:00.000Z", domain: "physical", ...base, summary: "friss fizikai" });
    repo.save({ createdAt: "2026-08-01T09:01:00.000Z", domain: "recovery", ...base, summary: "friss regen" });

    const run = repo.latestRun();
    expect(run.map((r) => r.summary).sort()).toEqual(["friss fizikai", "friss regen"]);
    db.close();
  });

  it("stores the metrics that produced a finding, so it can be checked later", () => {
    const db = memoryDb();
    const repo = createAnalysisRepo(db);
    repo.save({ createdAt: "2026-08-01T08:00:00.000Z", domain: "physical", ...base, metrics: '{"loadRatio":0.8}' });
    expect(JSON.parse(repo.recent("physical", 1)[0]!.metrics)).toEqual({ loadRatio: 0.8 });
    db.close();
  });
});

describe("health repo between", () => {
  it("returns the range inclusive at both ends, oldest first", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);
    const now = new Date("2026-08-31T00:00:00.000Z");
    for (const d of ["2026-08-01", "2026-08-15", "2026-08-31", "2026-09-01"]) {
      repo.fillGaps(d, { steps: 1000 }, now);
    }
    expect(repo.between("2026-08-01", "2026-08-31").map((r) => r.date))
      .toEqual(["2026-08-01", "2026-08-15", "2026-08-31"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/analyses-repo.test.ts`
Expected: FAIL — nincs `analyses.ts`, és a `HealthRepo`-nak nincs `between` metódusa.

- [ ] **Step 3: Write the migration**

Hozd létre a `src/infra/db/migrations/006_analyses.sql` fájlt:

```sql
-- What the analysis concluded, and the numbers it concluded it from.
--
-- This is the memory. Without it every run would start from zero and could
-- never say "the third month running", nor notice that something it flagged
-- has since resolved.
--
-- `summary` is not a convenience copy of `markdown`: the next run feeds the
-- last three summaries back into the prompt, and three full reports would be
-- roughly 3,600 tokens -- more than the statistics they are supposed to
-- accompany, against a 6,000 token/minute ceiling.
--
-- `metrics` keeps the input beside the conclusion, so an old finding can be
-- checked against the numbers that produced it rather than taken on trust.
CREATE TABLE IF NOT EXISTS analyses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  domain     TEXT NOT NULL,
  markdown   TEXT NOT NULL,
  summary    TEXT NOT NULL,
  metrics    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS analyses_domain_time ON analyses (domain, created_at DESC);
```

- [ ] **Step 4: Write the repository**

Hozd létre a `src/infra/db/repositories/analyses.ts` fájlt:

```typescript
import type { Db } from "../index.ts";

export type Domain = "physical" | "recovery" | "finance" | "synthesis";

export interface AnalysisRow {
  id: number;
  createdAt: string;
  domain: Domain;
  markdown: string;
  /** One paragraph. This, not `markdown`, is what the next run reads back. */
  summary: string;
  /** The metrics the finding came from, as JSON. */
  metrics: string;
}

export interface AnalysisRepo {
  save(row: Omit<AnalysisRow, "id">): void;
  /** Newest first — the prompt wants the most recent context at the top. */
  recent(domain: Domain, n: number): AnalysisRow[];
  /** Every domain written by the most recent run. */
  latestRun(): AnalysisRow[];
}

interface Row {
  id: number; created_at: string; domain: Domain;
  markdown: string; summary: string; metrics: string;
}

const toAnalysis = (r: Row): AnalysisRow => ({
  id: r.id, createdAt: r.created_at, domain: r.domain,
  markdown: r.markdown, summary: r.summary, metrics: r.metrics,
});

export function createAnalysisRepo(db: Db): AnalysisRepo {
  return {
    save(row) {
      db.run(
        `INSERT INTO analyses (created_at, domain, markdown, summary, metrics)
         VALUES (?, ?, ?, ?, ?)`,
        row.createdAt, row.domain, row.markdown, row.summary, row.metrics,
      );
    },

    recent(domain, n) {
      return db.all<Row>(
        "SELECT * FROM analyses WHERE domain = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        domain, n,
      ).map(toAnalysis);
    },

    latestRun() {
      // A run writes its domains seconds apart, so "the latest run" is the
      // latest row per domain rather than everything sharing one timestamp.
      return db.all<Row>(
        `SELECT * FROM analyses WHERE id IN (
           SELECT MAX(id) FROM analyses GROUP BY domain
         ) ORDER BY domain`,
      ).map(toAnalysis);
    },
  };
}
```

- [ ] **Step 5: Add `between` to the health repository**

A `src/infra/db/repositories/health.ts`-ben az interfészbe, a `baseline` alá:

```typescript
  /** Every snapshot in an inclusive date range, oldest first. */
  between(from: string, to: string): HealthSnapshot[];
```

és az implementációba, a `baseline` mellé:

```typescript
    between(from, to) {
      // The aggregation layer works over ranges; `baseline` answers "the last
      // N days", which is a different question and cannot express a range.
      return db.all<Row>(
        "SELECT * FROM health_snapshots WHERE date >= ? AND date <= ? ORDER BY date",
        from, to,
      ).map(toSnapshot);
    },
```

- [ ] **Step 6: Wire the repository into the composition root**

A `src/app.ts`-ben a többi repó mintájára: importáld a `createAnalysisRepo`-t és az `AnalysisRepo` típust, vedd fel az `App` interfészbe `analyses: AnalysisRepo;` néven, és add hozzá a visszatérési objektumhoz `analyses: createAnalysisRepo(db),` formában.

- [ ] **Step 7: Run the tests and commit**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

```bash
git add src/infra/db/migrations/006_analyses.sql src/infra/db/repositories/analyses.ts \
        src/infra/db/repositories/health.ts src/app.ts test/core/analyses-repo.test.ts
git commit -m "feat: store analyses, so a later run can remember what it said"
```

---

## Task 5: Promptok és az összegzés kinyerése

**Files:**
- Create: `src/core/analysis/prompts.ts`
- Test: `test/core/analysis-prompts.test.ts` (új)

**Interfaces:**
- Consumes: `Metrics` (Task 2); `Relation` (Task 3); `Domain` (Task 4)
- Produces: `SUMMARY_HEADING`, `buildDomainPrompt(domain, metrics, memories)`, `buildSynthesisPrompt(summaries, relations)`, `extractSummary(markdown)`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/analysis-prompts.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import {
  SUMMARY_HEADING, buildDomainPrompt, buildSynthesisPrompt, extractSummary,
} from "../../src/core/analysis/prompts.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";

const metrics: Metrics = {
  today: "2026-08-31",
  physical: {
    byMonth: [{ month: "2026-08", hours: 20, sessions: 18, strength: 9 }],
    loadRatio: 0.82, strengthPerWeek28d: 2.25,
    vo2max: { value: 38.4, n: 101, coverage: 0.28, window: "365d", slopePer30d: -0.4 },
    rhr: { value: 65.2, n: 221, coverage: 0.61, window: "365d", slopePer30d: 1.1 },
    hrRecovery: { value: null, n: 0, coverage: 0, window: "365d", slopePer30d: null },
    steps: {
      d7: { value: 9000, n: 7, coverage: 1, window: "7d" },
      d28: { value: 9500, n: 28, coverage: 1, window: "28d" },
      d90: { value: 9800, n: 90, coverage: 1, window: "90d" },
      d365: { value: 10100, n: 365, coverage: 1, window: "365d" },
    },
  },
  recovery: {
    hrv: {
      d7: { value: 61, n: 6, coverage: 6 / 7, window: "7d" },
      d28: { value: 59, n: 25, coverage: 25 / 28, window: "28d" },
      d90: { value: 58, n: 80, coverage: 80 / 90, window: "90d" },
      d365: { value: 57, n: 230, coverage: 230 / 365, window: "365d" },
    },
    hrvDeviationSigma: 0.4,
    asleepMin: {
      d28: { value: null, n: 0, coverage: 0, window: "28d" },
      d90: { value: 402, n: 12, coverage: 12 / 90, window: "90d" },
      d365: { value: 410, n: 41, coverage: 41 / 365, window: "365d" },
    },
    stages: {
      core: { value: 210, n: 12, coverage: 12 / 90, window: "90d" },
      rem: { value: 95, n: 12, coverage: 12 / 90, window: "90d" },
      deep: { value: 60, n: 12, coverage: 12 / 90, window: "90d" },
    },
    awakenings: { value: 3, n: 12, coverage: 12 / 90, window: "90d" },
    sleepByYear: [{ year: "2026", days: 243, withSleep: 41 }],
  },
  finance: {
    months: [{ month: "2026-09", totalHuf: 24390, activeCount: 5 }],
    monthOverMonth: null,
    annualisedHuf: 292680,
  },
};

describe("buildDomainPrompt", () => {
  it("sends only the domain's own metrics", () => {
    const { user } = buildDomainPrompt("finance", metrics, []);
    expect(user).toContain("24390");
    // The financial pass has no business seeing HRV; a smaller prompt is also
    // a cheaper one against a 6,000 token/minute ceiling.
    expect(user).not.toContain("hrvDeviationSigma");
  });

  it("includes the previous summaries as memory, newest first", () => {
    const { user } = buildDomainPrompt("physical", metrics, ["legfrissebb", "korábbi"]);
    expect(user.indexOf("legfrissebb")).toBeLessThan(user.indexOf("korábbi"));
  });

  it("says plainly when there is no earlier finding", () => {
    const { user } = buildDomainPrompt("physical", metrics, []);
    expect(user).toContain("Ez az első elemzés ezen a területen");
  });

  it("requires the summary block by name in the system prompt", () => {
    const { system } = buildDomainPrompt("recovery", metrics, []);
    expect(system).toContain(SUMMARY_HEADING);
  });

  it("orders the model to carry coverage into any claim", () => {
    const { system } = buildDomainPrompt("recovery", metrics, []);
    expect(system).toMatch(/lefedettség/i);
  });
});

describe("buildSynthesisPrompt", () => {
  it("passes correlations through with n, and forbids inventing others", () => {
    const { system, user } = buildSynthesisPrompt(
      [{ domain: "physical", summary: "a" }, { domain: "recovery", summary: "b" }],
      [{ key: "load_vs_rhr", label: "terhelés ↔ nyugalmi pulzus", r: -0.42, n: 210, window: "365 nap" }],
    );
    expect(user).toContain("terhelés ↔ nyugalmi pulzus");
    expect(user).toContain("210");
    expect(system).toContain("Csak a megadott összefüggésekről írhatsz");
  });

  it("states outright when nothing cleared the threshold", () => {
    const { user } = buildSynthesisPrompt([{ domain: "physical", summary: "a" }], []);
    expect(user).toContain("Egyetlen összefüggés sem érte el a mintaszám-küszöböt");
  });
});

describe("extractSummary", () => {
  it("takes the text under the summary heading", () => {
    const md = `# Fizikai\n\nHosszabb elemzés.\n\n${SUMMARY_HEADING}\n\nEz az összegzés.`;
    expect(extractSummary(md)).toBe("Ez az összegzés.");
  });

  it("stops at the next heading", () => {
    const md = `${SUMMARY_HEADING}\n\nEz kell.\n\n## Valami más\n\nEz nem.`;
    expect(extractSummary(md)).toBe("Ez kell.");
  });

  it("falls back to the first paragraph when the block is missing", () => {
    // A missing summary must not cost us a finished report.
    const md = "# Fizikai\n\nElső bekezdés.\n\nMásodik bekezdés.";
    expect(extractSummary(md)).toBe("Első bekezdés.");
  });

  it("never returns an empty string for non-empty markdown", () => {
    expect(extractSummary("csak egy sor")).toBe("csak egy sor");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/analysis-prompts.test.ts`
Expected: FAIL — a `src/core/analysis/prompts.ts` modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/analysis/prompts.ts` fájlt:

```typescript
import type { Metrics } from "./aggregate.ts";
import type { Relation } from "./relations.ts";
import type { Domain } from "../../infra/db/repositories/analyses.ts";

/** The heading each domain answer must end with. The memory depends on it. */
export const SUMMARY_HEADING = "## Rövid összegzés";

const TITLE: Record<Domain, string> = {
  physical: "Fizikai fejlődés",
  recovery: "Regenerálódás és alvás",
  finance: "Pénzügy",
  synthesis: "Összegzés",
};

const BRIEF: Record<Exclude<Domain, "synthesis">, string> = {
  physical:
    "Edzésterhelés és keringési fittség. A `loadRatio` a 28 napos napi átlagos "
    + "edzésperc a 365 naposhoz mérve: 1 körül állandó terhelés.",
  recovery:
    "HRV, alvás és ébredések. Az alvásadat ritka, és a ritkasága maga is "
    + "megállapítás.",
  finance:
    "Előfizetések havi képe. A tábla az S2-ben született, előtte nincs "
    + "történet, és visszamenőleg szándékosan nem gyártunk.",
};

/**
 * The shared rules. Coverage is not decoration here: a 90-day sleep mean drawn
 * from twelve nights is a different claim from one drawn from ninety, and the
 * difference has to reach the reader.
 */
function systemFor(domain: Domain, extra: string): string {
  return [
    `Egy személyes asszisztens elemzője vagy. A területed: ${TITLE[domain]}.`,
    "",
    "Szabályok:",
    "- Kizárólag a megadott számokra támaszkodj. Ne találj ki adatot, és ne becsülj.",
    "- Minden állítás mellé tedd oda, hány napból származik (`n`) és mekkora a"
    + " lefedettség. Egy 90 napos átlag tizenkét mérésből más állítás, mint"
    + " kilencvenből.",
    "- A `null` azt jelenti, hogy nincs mérés. Nem nulla, és nem baj — mondd ki,"
    + " hogy erről nem tudsz nyilatkozni.",
    "- Írj magyarul, tömören, felsorolásokkal. Ne írj bevezetőt és lezárást.",
    extra,
    "",
    `A válaszod UTOLSÓ blokkja pontosan ez a cím legyen: "${SUMMARY_HEADING}",`,
    "alatta EGYETLEN bekezdés, ami a lényeget összefoglalja. Ezt az egy",
    "bekezdést fogja a következő elemzés visszakapni emlékezetként.",
  ].join("\n");
}

export function buildDomainPrompt(
  domain: Exclude<Domain, "synthesis">,
  metrics: Metrics,
  memories: readonly string[],
): { system: string; user: string } {
  // Each pass gets only its own slice. A narrower prompt is both a cheaper one
  // and a harder one to wander out of.
  const slice = metrics[domain];

  const memoryBlock = memories.length === 0
    ? "Ez az első elemzés ezen a területen — nincs mihez viszonyítanod."
    : [
      "A korábbi megállapításaid, a legfrissebbel kezdve:",
      ...memories.map((m, i) => `${i + 1}. ${m}`),
      "",
      "Ha egy korábbi aggodalom azóta megszűnt, mondd ki. Ha harmadszor tér",
      "vissza ugyanaz, azt is.",
    ].join("\n");

  return {
    system: systemFor(domain, `- ${BRIEF[domain]}`),
    user: [
      `Dátum: ${metrics.today}`,
      "",
      memoryBlock,
      "",
      "A terület statisztikái:",
      JSON.stringify(slice, null, 2),
    ].join("\n"),
  };
}

export function buildSynthesisPrompt(
  summaries: readonly { domain: Domain; summary: string }[],
  relations: readonly Relation[],
): { system: string; user: string } {
  const system = systemFor(
    "synthesis",
    "- Csak a megadott összefüggésekről írhatsz. Nem kereshetsz továbbiakat, és"
    + " nem állíthatsz olyan kapcsolatot, ami nincs a listán — a korrelációk"
    + " kiszámolva érkeznek, mintaszámmal együtt, és a mintaszámot ki kell írnod."
    + " A korreláció nem ok-okozat; ezt a szóhasználatod tükrözze.",
  );

  const relationBlock = relations.length === 0
    ? "Egyetlen összefüggés sem érte el a mintaszám-küszöböt, tehát erről a"
      + " futásról nem mondhatsz kapcsolatról semmit."
    : [
      "A kiszámolt összefüggések:",
      ...relations.map((r) =>
        `- ${r.label}: r = ${r.r.toFixed(2)}, n = ${r.n}, ablak: ${r.window}`),
    ].join("\n");

  return {
    system,
    user: [
      "A területi elemzések összegzései:",
      ...summaries.map((s) => `### ${TITLE[s.domain]}\n${s.summary}`),
      "",
      relationBlock,
    ].join("\n"),
  };
}

/**
 * Pulls the summary block out of a domain answer.
 *
 * Falls back to the first paragraph when the model skipped the heading. Losing
 * the memory of one run is a small harm; throwing away a finished analysis
 * because its last heading was missing would be a much larger one.
 */
export function extractSummary(markdown: string): string {
  const text = markdown.trim();
  const start = text.indexOf(SUMMARY_HEADING);
  if (start !== -1) {
    const after = text.slice(start + SUMMARY_HEADING.length);
    const end = after.search(/\n#{1,6} /);
    const block = (end === -1 ? after : after.slice(0, end)).trim();
    if (block) return block;
  }
  const paragraph = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#"));
  return paragraph ?? text;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/analysis-prompts.test.ts && npm run typecheck`
Expected: PASS, typecheck tiszta.

- [ ] **Step 5: Commit**

```bash
git add src/core/analysis/prompts.ts test/core/analysis-prompts.test.ts
git commit -m "feat: per-domain prompts, with coverage and memory built in"
```

---

## Task 6: A szakaszos elemző

**Files:**
- Create: `src/core/analysis/analyst.ts`
- Test: `test/core/analyst.test.ts` (új)

**Interfaces:**
- Consumes: `Metrics` (Task 2); `Relation` (Task 3); `Domain`, `AnalysisRepo` (Task 4); `buildDomainPrompt`, `buildSynthesisPrompt`, `extractSummary` (Task 5); `groqComplete` és `GROQ_KEY_VAR` a `src/infra/groq.ts`-ből; `withTimeout` a `src/infra/abort.ts`-ből; `Fetcher` a `src/infra/http-client.ts`-ből
- Produces: `AnalystOptions`, `DomainOutcome`, `AnalysisRun`, `runAnalysis(metrics, relations, opts, signal)`

**A `groqComplete` pontos alakja** (ezt hívod, ne találj ki mást):

```typescript
groqComplete(fetcher, {
  apiKey, model, system, user, maxTokens, temperature, signal,
}): Promise<string>
```

A `fixtureFetcher` a `src/infra/http-client.ts`-ből URL-prefix szerint szolgál ki rögzített válaszokat, és minden nem várt URL-re dob. A Groq chat végpontja a `GROQ_CHAT_URL` konstans ugyanabban a `src/infra/groq.ts`-ben.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/analyst.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { runAnalysis, type AnalystOptions } from "../../src/core/analysis/analyst.ts";
import { SUMMARY_HEADING } from "../../src/core/analysis/prompts.ts";
import { createAnalysisRepo } from "../../src/infra/db/repositories/analyses.ts";
import { GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";
import type { Relation } from "../../src/core/analysis/relations.ts";

const EMPTY_METRIC = { value: null, n: 0, coverage: 0, window: "365d" };
const metrics: Metrics = {
  today: "2026-08-31",
  physical: {
    byMonth: [], loadRatio: null, strengthPerWeek28d: null,
    vo2max: { ...EMPTY_METRIC, slopePer30d: null },
    rhr: { ...EMPTY_METRIC, slopePer30d: null },
    hrRecovery: { ...EMPTY_METRIC, slopePer30d: null },
    steps: { d7: EMPTY_METRIC, d28: EMPTY_METRIC, d90: EMPTY_METRIC, d365: EMPTY_METRIC },
  },
  recovery: {
    hrv: { d7: EMPTY_METRIC, d28: EMPTY_METRIC, d90: EMPTY_METRIC, d365: EMPTY_METRIC },
    hrvDeviationSigma: null,
    asleepMin: { d28: EMPTY_METRIC, d90: EMPTY_METRIC, d365: EMPTY_METRIC },
    stages: { core: EMPTY_METRIC, rem: EMPTY_METRIC, deep: EMPTY_METRIC },
    awakenings: EMPTY_METRIC, sleepByYear: [],
  },
  finance: { months: [], monthOverMonth: null, annualisedHuf: null },
};

const relations: Relation[] = [];

/** Answers each call in order; a `null` entry throws instead of answering. */
function scriptedFetcher(answers: (string | null)[]): Fetcher & { calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const self = {
    calls,
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      if (!url.startsWith(GROQ_CHAT_URL)) throw new Error(`unexpected url ${url}`);
      calls.push(String(init?.body ?? ""));
      const answer = answers[i++];
      if (answer === null || answer === undefined) throw new Error("groq exploded");
      return { choices: [{ message: { content: answer }, finish_reason: "stop" }] } as T;
    },
    async text(): Promise<string> { throw new Error("not used"); },
  };
  return self;
}

function answer(body: string): string {
  return `# Cím\n\n${body}\n\n${SUMMARY_HEADING}\n\n${body} összegzés.`;
}

function options(fetcher: Fetcher, over: Partial<AnalystOptions> = {}): AnalystOptions {
  const db = memoryDb();
  return {
    fetcher, model: "test-model", maxTokens: 1200, temperature: 0.3,
    timeoutMs: 5_000, paceMs: 60_000, memoryDepth: 3, minCorrelationN: 30,
    apiKey: async () => "key",
    analyses: createAnalysisRepo(db),
    logger: recordingLogger(),
    clock: { now: () => new Date("2026-08-31T08:00:00.000Z") },
    // Injected so the suite never actually waits a minute per call.
    sleep: async () => {},
    ...over,
  };
}

const signal = () => new AbortController().signal;

describe("runAnalysis", () => {
  it("runs the three domains and then the synthesis", async () => {
    const fetcher = scriptedFetcher([answer("fizikai"), answer("regen"), answer("pénz"), answer("össze")]);
    const run = await runAnalysis(metrics, relations, options(fetcher), signal());

    expect(run.outcomes.map((o) => o.domain))
      .toEqual(["physical", "recovery", "finance", "synthesis"]);
    expect(run.outcomes.every((o) => o.error === null)).toBe(true);
    expect(fetcher.calls).toHaveLength(4);
  });

  it("keeps the other domains when one fails, and names the failure", async () => {
    // The finance call throws; physical and recovery must survive it.
    const fetcher = scriptedFetcher([answer("fizikai"), answer("regen"), null, answer("össze")]);
    const run = await runAnalysis(metrics, relations, options(fetcher), signal());

    const finance = run.outcomes.find((o) => o.domain === "finance")!;
    expect(finance.markdown).toBeNull();
    expect(finance.error).toContain("groq exploded");
    expect(run.outcomes.find((o) => o.domain === "physical")!.markdown).not.toBeNull();
    expect(run.outcomes.find((o) => o.domain === "synthesis")!.markdown).not.toBeNull();
  });

  it("skips the synthesis when fewer than two domains succeeded", async () => {
    const fetcher = scriptedFetcher([answer("fizikai"), null, null]);
    const run = await runAnalysis(metrics, relations, options(fetcher), signal());

    // One domain has nothing to be related to; a synthesis call would spend
    // tokens restating it.
    expect(run.outcomes.find((o) => o.domain === "synthesis")).toBeUndefined();
    expect(fetcher.calls).toHaveLength(3);
  });

  it("waits between calls, because two in one minute breaks the token ceiling", async () => {
    const waits: number[] = [];
    const fetcher = scriptedFetcher([answer("a"), answer("b"), answer("c"), answer("d")]);
    await runAnalysis(metrics, relations, options(fetcher, {
      sleep: async (ms: number) => { waits.push(ms); },
    }), signal());

    // Three gaps between four calls, and never before the first.
    expect(waits).toEqual([60_000, 60_000, 60_000]);
  });

  it("stores every successful domain with its summary and metrics", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    const fetcher = scriptedFetcher([answer("fizikai"), answer("regen"), answer("pénz"), answer("össze")]);
    await runAnalysis(metrics, relations, options(fetcher, { analyses }), signal());

    const stored = analyses.recent("physical", 1)[0]!;
    expect(stored.summary).toBe("fizikai összegzés.");
    expect(JSON.parse(stored.metrics)).toHaveProperty("loadRatio");
    db.close();
  });

  it("feeds the previous summaries back as memory", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    analyses.save({
      createdAt: "2026-07-01T08:00:00.000Z", domain: "physical",
      markdown: "#", summary: "MÚLTKORI MEGÁLLAPÍTÁS", metrics: "{}",
    });
    const fetcher = scriptedFetcher([answer("a"), answer("b"), answer("c"), answer("d")]);
    await runAnalysis(metrics, relations, options(fetcher, { analyses }), signal());

    expect(fetcher.calls[0]).toContain("MÚLTKORI MEGÁLLAPÍTÁS");
    db.close();
  });

  it("fails every domain cleanly when there is no API key", async () => {
    const fetcher = scriptedFetcher([]);
    const run = await runAnalysis(metrics, relations, options(fetcher, {
      apiKey: async () => undefined,
    }), signal());

    expect(fetcher.calls).toHaveLength(0);
    expect(run.outcomes).toHaveLength(3);
    for (const o of run.outcomes) expect(o.error).toContain("GROQ_API_KEY");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/analyst.test.ts`
Expected: FAIL — a `src/core/analysis/analyst.ts` modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/analysis/analyst.ts` fájlt:

```typescript
import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";
import type { Metrics } from "./aggregate.ts";
import type { Relation } from "./relations.ts";
import type { AnalysisRepo, Domain } from "../../infra/db/repositories/analyses.ts";
import { GROQ_KEY_VAR, groqComplete } from "../../infra/groq.ts";
import { withTimeout } from "../../infra/abort.ts";
import { buildDomainPrompt, buildSynthesisPrompt, extractSummary } from "./prompts.ts";

const DOMAINS = ["physical", "recovery", "finance"] as const;

export interface AnalystOptions {
  fetcher: Fetcher;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Wait between calls; two in one minute would breach the token ceiling. */
  paceMs: number;
  memoryDepth: number;
  minCorrelationN: number;
  /** Resolved lazily so the key can live in the Keychain, not the environment. */
  apiKey: () => Promise<string | undefined>;
  analyses: AnalysisRepo;
  logger: Logger;
  clock: { now(): Date };
  /** Injected so tests do not spend three real minutes waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DomainOutcome {
  domain: Domain;
  markdown: string | null;
  summary: string | null;
  error: string | null;
}

export interface AnalysisRun {
  outcomes: DomainOutcome[];
  relations: readonly Relation[];
  metrics: Metrics;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The staged analysis: one call per domain, then one that looks across them.
 *
 * Sequential rather than parallel, and paced, because the free tier allows
 * 6,000 tokens a minute and each call wants roughly 3,700. Running them
 * together would earn a 429 and produce nothing at all; running them apart
 * lets each domain have the whole budget to itself.
 *
 * Each domain stands or falls alone. A failed pass costs its own findings and
 * nothing else, and the reason is carried out rather than swallowed.
 */
export async function runAnalysis(
  metrics: Metrics,
  relations: readonly Relation[],
  opts: AnalystOptions,
  signal: AbortSignal,
): Promise<AnalysisRun> {
  const pause = opts.sleep ?? wait;
  const outcomes: DomainOutcome[] = [];
  let calls = 0;

  const ask = async (domain: Domain, system: string, user: string): Promise<DomainOutcome> => {
    try {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error(`${GROQ_KEY_VAR} is not set`);

      // The gap goes before the call and never before the first one, so a
      // single-domain run is not punished for the ceiling it cannot reach.
      if (calls > 0) await pause(opts.paceMs);
      calls++;

      const markdown = await withTimeout(signal, opts.timeoutMs, (abortSignal) =>
        groqComplete(opts.fetcher, {
          apiKey, model: opts.model, system, user,
          maxTokens: opts.maxTokens, temperature: opts.temperature, signal: abortSignal,
        }));

      const summary = extractSummary(markdown);
      opts.analyses.save({
        createdAt: opts.clock.now().toISOString(),
        domain,
        markdown,
        summary,
        metrics: JSON.stringify(
          domain === "synthesis" ? { relations } : metrics[domain as Exclude<Domain, "synthesis">],
        ),
      });
      opts.logger.info({ domain, chars: markdown.length }, "analysis domain complete");
      return { domain, markdown, summary, error: null };
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      opts.logger.warn({ domain, err: error }, "analysis domain failed");
      return { domain, markdown: null, summary: null, error };
    }
  };

  for (const domain of DOMAINS) {
    const { system, user } = buildDomainPrompt(
      domain,
      metrics,
      opts.analyses.recent(domain, opts.memoryDepth).map((r) => r.summary),
    );
    outcomes.push(await ask(domain, system, user));
  }

  const succeeded = outcomes.filter((o) => o.summary !== null);
  if (succeeded.length >= 2) {
    const { system, user } = buildSynthesisPrompt(
      succeeded.map((o) => ({ domain: o.domain, summary: o.summary! })),
      relations,
    );
    outcomes.push(await ask("synthesis", system, user));
  } else {
    // One surviving domain has nothing to be related to; the call would spend
    // tokens restating what we already have.
    opts.logger.warn({ succeeded: succeeded.length }, "skipping synthesis");
  }

  return { outcomes, relations, metrics };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/analyst.test.ts && npm run typecheck`
Expected: PASS, typecheck tiszta.

- [ ] **Step 5: Commit**

```bash
git add src/core/analysis/analyst.ts test/core/analyst.test.ts
git commit -m "feat: staged analysis, paced and isolated per domain"
```

---

## Task 7: A parancs, a beállítás és a dokumentáció

**Files:**
- Create: `scripts/analyze.ts`
- Create: `src/infra/db/holder.ts`
- Modify: `scripts/import-health.ts`, `config/config.ts`, `package.json`, `README.md`
- Test: `test/infra/db-holder.test.ts` (új)

**Interfaces:**
- Consumes: `createApp` (`src/app.ts`), `aggregate` (Task 2), `relations` (Task 3), `runAnalysis` (Task 6), `config` (`config/config.ts`)
- Produces: `npm run analyze`

- [ ] **Step 1: Extract the holder check so both commands share it**

A `scripts/import-health.ts` ma maga hordozza az `assertDatabaseFree()`-t és az
`AGENT_FIX` szöveget. Az elemzés is ír (az `analyses` táblába), tehát ugyanaz
vonatkozik rá — és **két másolat előbb-utóbb elcsúszik**, pontosan úgy, ahogy az
S2-ben a havi pillanatkép két példánya csúszott el.

Hozd létre a `src/infra/db/holder.ts` fájlt, és told bele a meglévő logikát a
`scripts/import-health.ts`-ből **szó szerint**, egyetlen viselkedésbeli
változtatás nélkül:

```typescript
import { execFileSync } from "node:child_process";

export const AGENT_FIX =
  "  launchctl bootout gui/$(id -u)/local.jarvis.agent\n"
  + "  <a parancs>\n"
  + "  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.jarvis.agent.plist";

/**
 * Pids holding the database open.
 *
 * `lsof -t` lists them; nothing here opens the file, so the calling process
 * cannot match itself. It fails open on purpose: a missing or unhappy `lsof`
 * must not block a legitimate run, because the durability check after the
 * write is the actual guarantee -- this is only the early, friendly warning.
 */
export function holdersOf(dbPath: string): string[] {
  try {
    return execFileSync("lsof", ["-t", dbPath], { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
```

A pontos tartalmat a `scripts/import-health.ts` 44–100. sorai adják — **onnan
emeld át**, ne írd újra emlékezetből, és az `AGENT_FIX`-ben a parancs sorát
tedd paraméterezhetővé, hogy mindkét hívó a sajátját írhassa bele.

Ezután a `scripts/import-health.ts` ezt a modult importálja a saját másolata
helyett. Az import viselkedése **nem változhat**: továbbra is elutasítja a
futást, ha valaki fogja az adatbázist.

Írd meg hozzá a `test/infra/db-holder.test.ts`-t:

```typescript
import { describe, it, expect } from "vitest";
import { holdersOf } from "../../src/infra/db/holder.ts";

describe("holdersOf", () => {
  it("reports nobody for a path that does not exist", () => {
    // lsof exits non-zero here, which is the same path a missing lsof takes.
    // Failing open is deliberate: this check warns, it does not guarantee.
    expect(holdersOf("/tmp/jarvis-nonexistent-database.db")).toEqual([]);
  });
});
```

Az elemző parancs ezt használva **figyelmeztet, de nem áll meg**: az importtal
ellentétben itt az elveszett írás egy újrafuttatható elemzés, nem hét év
egészség-történet. A figyelmeztetés szövege mondja meg, mit tegyen a felhasználó.

- [ ] **Step 2: Add the configuration block**

A `config/config.ts`-ben, a `groq` blokk után:

```typescript
  analysis: {
    /** The same model the brief settled on after measurement. */
    model: "qwen/qwen3.8-27b",
    maxTokens: 1_200,
    temperature: 0.3,
    timeoutMs: 60_000,
    /** Wait between calls: the free tier allows 6,000 tokens a minute. */
    paceMs: 60_000,
    /** How many previous summaries a domain sees. Each one costs budget. */
    memoryDepth: 3,
    /** Below this many paired days a correlation never reaches the prompt. */
    minCorrelationN: 30,
  },
```

- [ ] **Step 3: Write the command**

Hozd létre a `scripts/analyze.ts` fájlt:

```typescript
/**
 * The deep analysis.
 *
 *   npm run analyze
 *
 * Four Groq calls a minute apart, so it takes about three minutes. That is the
 * price of giving each domain the whole token budget instead of a quarter of it.
 *
 * The numbers are computed here, in code, and printed whatever happens to the
 * model. If Groq is unreachable the statistics still land -- they are the
 * durable product, and the prose is commentary on them.
 */
import { createApp } from "../src/app.ts";
import { config } from "../config/config.ts";
import { aggregate } from "../src/core/analysis/aggregate.ts";
import { relations } from "../src/core/analysis/relations.ts";
import { runAnalysis } from "../src/core/analysis/analyst.ts";
import { GROQ_KEY_VAR } from "../src/infra/groq.ts";
import { isoDate, TZ } from "../src/shared/dates.ts";

process.env.LOG_LEVEL ??= "error";

const app = createApp();
const now = app.clock.now();
const today = isoDate(now, TZ);

const input = {
  today,
  snapshots: app.health.between("1970-01-01", today),
  workouts: app.workouts.between("1970-01-01", today),
  months: app.subscriptionMonths.months().map((month) => ({
    month, subs: app.subscriptionMonths.forMonth(month),
  })),
};

console.log(
  `Adat: ${input.snapshots.length} nap · ${input.workouts.length} edzés · `
  + `${input.months.length} hónap előfizetés`,
);

const metrics = aggregate(input);
const rels = relations(input, config.analysis.minCorrelationN);

console.log();
console.log("## Számok");
console.log(JSON.stringify(metrics, null, 2));
console.log();
console.log(rels.length === 0
  ? `Összefüggés: egyik pár sem érte el a ${config.analysis.minCorrelationN} napos küszöböt.`
  : rels.map((r) => `${r.label}: r = ${r.r.toFixed(2)} (n = ${r.n}, ${r.window})`).join("\n"));

console.log();
console.log(`Elemzés indul — ${config.analysis.paceMs / 1000} másodperc szünet a hívások között.`);

const run = await runAnalysis(metrics, rels, {
  fetcher: app.runner.http,
  model: config.analysis.model,
  maxTokens: config.analysis.maxTokens,
  temperature: config.analysis.temperature,
  timeoutMs: config.analysis.timeoutMs,
  paceMs: config.analysis.paceMs,
  memoryDepth: config.analysis.memoryDepth,
  minCorrelationN: config.analysis.minCorrelationN,
  apiKey: () => app.runner.secrets.get(GROQ_KEY_VAR),
  analyses: app.analyses,
  logger: app.logger,
  clock: app.clock,
}, new AbortController().signal);

for (const outcome of run.outcomes) {
  console.log();
  if (outcome.markdown) {
    console.log(outcome.markdown);
  } else {
    // Naming the gap is the point: a silently missing domain reads exactly
    // like a domain with nothing to say.
    console.log(`⚠ A(z) ${outcome.domain} terület kimaradt: ${outcome.error}`);
  }
}

app.close();
```

> **Az `App` felülete, ellenőrizve:** `logger`, `clock`, `health`, `workouts`,
> `subscriptionMonths` és `analyses` (ez utóbbit a Task 4 veszi fel) a legfelső
> szinten van, a `http` és a `secrets` viszont **nem** — azok az `app.runner`-en
> ülnek (`RunnerDeps`), ezért `app.runner.http` és `app.runner.secrets`. Ha
> bármelyik név mégsem stimmel, a `scripts/analyze.ts`-t igazítsd a valósághoz —
> **ne az `app.ts`-t** —, és jelezd a riportban.

- [ ] **Step 4: Add the npm script**

`package.json` — a `scripts` blokkba, az `import-health` után:

```json
    "analyze": "node --env-file-if-exists=.env scripts/analyze.ts",
```

- [ ] **Step 5: Document it**

`README.md` — a „Parancsok" blokkba:

```markdown
npm run analyze                    # mélyelemzés a teljes történetből (~3 perc)
```

és a „Egészség-történet" szakasz után egy új szakasz:

```markdown
### Mélyelemzés

`npm run analyze` végigmegy a teljes történeten, és területenként külön elemzést
ad: fizikai fejlődés, regenerálódás, pénzügy, majd egy összegzés, ami a
kiszámolt összefüggéseket nézi.

A számokat kód számolja, nem a modell — gördülő átlagok, trendek, korrelációk,
mindegyik mellett a lefedettséggel. A modell ezekre mond véleményt. Ha a Groq
nem elérhető, a számok akkor is kiíródnak.

Nagyjából három percig tart: hívásonként egy perc szünet, mert az ingyenes szint
6 000 tokent enged percenként, és így minden terület a teljes keretet kapja.

Minden lefutás elmentődik, és a következő elemzés területenként az utolsó három
összegzést látja — ettől tud olyat mondani, hogy „harmadik hónapja jelzem".
```

- [ ] **Step 6: Verify the suite**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 7: Run it against the live database, numbers first**

Az élesen futó adatbázist egy launchd agent tartja nyitva. Az elemzés **ír** is
(az `analyses` táblába), ezért ugyanaz vonatkozik rá, mint az importra.

Először győződj meg róla, hogy az aggregáció helyes számokat ad. Ehhez elég a
parancs első fele, hívás nélkül:

```bash
GROQ_API_KEY= npm run analyze 2>&1 | head -60
```

Kulcs nélkül mind a három terület tisztán elbukik, a számok viszont kiíródnak —
pontosan ezt a viselkedést írja elő a terv. Illeszd be a kimenetet a riportba,
és **nézd meg értelmesek-e a számok**: a `loadRatio` 1 körüli, a `vo2max.n`
néhány száz, a `sleepByYear` mutatja a ritkulást.

- [ ] **Step 8: Commit**

```bash
git add scripts/analyze.ts src/infra/db/holder.ts scripts/import-health.ts \\
        config/config.ts package.json README.md test/infra/db-holder.test.ts
git commit -m "feat: npm run analyze, the staged deep analysis command"
```

---

## Amit a terv szándékosan kihagy

- **Nem nyúl a napi briefhez, a modulokhoz és a Shortcuthoz.**
- **Nem küld Telegramot** — az az S6.
- **Nem épít felületet** — az az S5.
- **Nem ütemez.** A parancs kézzel indul; ha később kell heti futás, a meglévő
  croner-ütemezőbe egy hívás.
- **Nem gyárt visszamenőleges pénzügyi történetet.** A `subscription_months` az
  S2-ben született; az első hónapokban a `monthOverMonth` helyesen `null`.
