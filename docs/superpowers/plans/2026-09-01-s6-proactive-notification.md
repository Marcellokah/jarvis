# S6 — Proaktív értesítés — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis magától szóljon Telegramon, ha van miért — időzaklató teendő, egészségi eltérés vagy új elemzési megállapítás miatt —, és csak akkor.

**Architecture:** Az ütemező negyedóránként ellenőriz. Először két tiszta kapu dönt (eltelt-e négy óra, csendes órán kívül vagyunk-e); csak ezek után gyűlnek a jelöltek, kódban felállított küszöbök szerint. Ami átjut, azt a `SeenStore` szűri ismétlésre, a Groq fogalmazza meg (template-tel a háta mögött), és a bot küldi ki. A kiküldés után a `SeenStore` és egy `notifications` tábla egy tranzakcióban rögzíti, mi ment el.

**Tech Stack:** Node 24 (`.ts` közvetlenül, build nélkül), `node:sqlite`, croner, grammY, vitest, a meglévő `Fetcher` és `groqComplete`.

## Global Constraints

- Node >= 24, build lépés nincs, a `.ts` fájlok közvetlenül futnak — **minden relatív import `.ts` kiterjesztéssel**.
- **Új futásidejű függőség nem vehető fel.**
- `npm run typecheck` (`tsc --noEmit`) tisztán fut.
- A tesztek hálózat nélkül futnak, és soha nem írják az éles adatbázist (`./data/jarvis.db`) — azt egy launchd agent tartja nyitva.
- Felhasználónak szóló szöveg magyarul, kódkommentek angolul. A komment azt magyarázza, **miért**.
- **A jelölt-keresés soha nem indíthat brief-szintézist.** A `BriefService.get` és `generate` Groq-hívást indít; csak a `runOne` használható.
- **Ami nem éri el a küszöböt, az nem gyenge jelölt, hanem nem jelölt.**
- Commit-üzenet utolsó sora: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Kiindulás

Branch: `s6-proactive-notification`, a **`main`-ről**. Kiinduló állapot: 385 teszt / 40 fájl zöld, typecheck tiszta.

## Eltérés a spectől, szándékosan

A spec §3 „kétszintű" jelölt-keresést ír le: olcsó réteg minden ticken, drága
csak a kapuk után. **Ez a terv ehelyett a kapukat futtatja először, és utána
egyben gyűjti a jelölteket.** Az eredmény azonos — a modulok így is legfeljebb
négyóránként futnak —, de egy réteggel kevesebb kódból. Adatbázist olvasni egy
olyan ticken, amelyik semmiképp nem küldhet üzenetet, nem nyereség.

## Fájlszerkezet

| Fájl | Felelősség |
|---|---|
| `src/infra/db/migrations/007_notifications.sql` | A kiküldött értesítések naplója |
| `src/infra/db/repositories/notifications.ts` | `lastSentAt` és `record` |
| `src/core/notify/gates.ts` | A két kapu. Tiszta |
| `src/core/notify/candidates.ts` | Küszöbök → jelöltek. Tiszta |
| `src/core/notify/message.ts` | A szöveg: template és Groq |
| `src/core/notify/tick.ts` | A teljes menet, egy hívásban |
| `src/delivery/telegram/bot.ts` | Módosul: kifelé küldés |
| `src/infra/scheduler.ts` | Módosul: a negyedórás cron |

---

## Task 1: Az értesítés-napló

**Files:**
- Create: `src/infra/db/migrations/007_notifications.sql`
- Create: `src/infra/db/repositories/notifications.ts`
- Modify: `src/app.ts`
- Test: `test/core/notifications-repo.test.ts` (új)

**Interfaces:**
- Consumes: `Db` a `src/infra/db/index.ts`-ből (`get<T>`, `all<T>`, `run`, `transaction<T>`)
- Produces: `SentNotification`, `NotificationRepo`, `createNotificationRepo(db)`; `App.notifications`

**A migrációk sorrendje:** `001`–`006` létezik, tehát ez a `007`. Egy alkalmazott migrációt soha nem nevezünk át.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/notifications-repo.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createNotificationRepo } from "../../src/infra/db/repositories/notifications.ts";

const AT = (iso: string) => new Date(iso);

describe("notification repo", () => {
  it("has no last-sent time before anything was sent", () => {
    const db = memoryDb();
    // Null, not epoch zero: "never notified" must not read as "notified long
    // ago", because the four-hour gate treats those the same way only by luck.
    expect(createNotificationRepo(db).lastSentAt()).toBeNull();
    db.close();
  });

  it("returns the most recent send time", () => {
    const db = memoryDb();
    const repo = createNotificationRepo(db);

    repo.record({ sentAt: AT("2026-09-01T08:00:00.000Z"), kinds: ["deadline"], keys: ["a"], text: "x" });
    repo.record({ sentAt: AT("2026-09-01T13:00:00.000Z"), kinds: ["health"], keys: ["b"], text: "y" });

    expect(repo.lastSentAt()).toBe("2026-09-01T13:00:00.000Z");
    db.close();
  });

  it("keeps what was sent, so it can be checked afterwards", () => {
    const db = memoryDb();
    const repo = createNotificationRepo(db);

    repo.record({
      sentAt: AT("2026-09-01T08:00:00.000Z"),
      kinds: ["deadline", "health"],
      keys: ["deadline:csirke:2026-09-01", "health:hrv-low"],
      text: "Vedd ki a csirkét.",
    });

    const last = repo.recent(1)[0]!;
    expect(last.kinds).toEqual(["deadline", "health"]);
    expect(last.keys).toEqual(["deadline:csirke:2026-09-01", "health:hrv-low"]);
    expect(last.text).toBe("Vedd ki a csirkét.");
    db.close();
  });

  it("returns the newest first", () => {
    const db = memoryDb();
    const repo = createNotificationRepo(db);

    repo.record({ sentAt: AT("2026-09-01T08:00:00.000Z"), kinds: ["health"], keys: ["a"], text: "régi" });
    repo.record({ sentAt: AT("2026-09-01T13:00:00.000Z"), kinds: ["health"], keys: ["b"], text: "friss" });

    expect(repo.recent(2).map((n) => n.text)).toEqual(["friss", "régi"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/notifications-repo.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the migration**

Hozd létre a `src/infra/db/migrations/007_notifications.sql` fájlt:

```sql
-- What the assistant said on its own, and when.
--
-- This table holds the four-hour gate. A key-value store would have been
-- enough for the timestamp alone, and `module_cache` was the obvious candidate
-- -- but it has expiry semantics and the 04:00 sweep deletes its expired rows,
-- which would open the gate silently. A log cannot expire out from under the
-- thing that depends on it.
--
-- It also answers "which analyses arrived since I last spoke", and leaves a
-- record of what was actually sent, so a notification can be checked after the
-- fact rather than taken on trust.
CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at TEXT NOT NULL,
  kinds   TEXT NOT NULL,   -- JSON array
  keys    TEXT NOT NULL,   -- JSON array, the same keys given to SeenStore
  text    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_time ON notifications (sent_at DESC);
```

- [ ] **Step 4: Write the repository**

Hozd létre a `src/infra/db/repositories/notifications.ts` fájlt:

```typescript
import type { Db } from "../index.ts";

export interface SentNotification {
  id: number;
  sentAt: string;
  kinds: string[];
  keys: string[];
  text: string;
}

export interface NotificationRepo {
  /** ISO instant of the most recent send, or null if nothing was ever sent. */
  lastSentAt(): string | null;
  record(entry: { sentAt: Date; kinds: readonly string[]; keys: readonly string[]; text: string }): void;
  /** Newest first. */
  recent(n: number): SentNotification[];
}

interface Row {
  id: number; sent_at: string; kinds: string; keys: string; text: string;
}

const toSent = (r: Row): SentNotification => ({
  id: r.id, sentAt: r.sent_at, text: r.text,
  kinds: JSON.parse(r.kinds) as string[],
  keys: JSON.parse(r.keys) as string[],
});

export function createNotificationRepo(db: Db): NotificationRepo {
  return {
    lastSentAt() {
      return db.get<{ sent_at: string }>(
        "SELECT sent_at FROM notifications ORDER BY sent_at DESC, id DESC LIMIT 1",
      )?.sent_at ?? null;
    },

    record(entry) {
      db.run(
        "INSERT INTO notifications (sent_at, kinds, keys, text) VALUES (?, ?, ?, ?)",
        entry.sentAt.toISOString(),
        JSON.stringify([...entry.kinds]),
        JSON.stringify([...entry.keys]),
        entry.text,
      );
    },

    recent(n) {
      return db.all<Row>(
        "SELECT * FROM notifications ORDER BY sent_at DESC, id DESC LIMIT ?", n,
      ).map(toSent);
    },
  };
}
```

- [ ] **Step 5: Wire it into the composition root**

`src/app.ts` — a többi repó mintájára: importáld a `createNotificationRepo`-t és a `NotificationRepo` típust, vedd fel az `App` interfészbe `notifications: NotificationRepo;` néven, és add a visszatérési objektumhoz `notifications: createNotificationRepo(db),` formában.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/infra/db/migrations/007_notifications.sql \
        src/infra/db/repositories/notifications.ts src/app.ts \
        test/core/notifications-repo.test.ts
git commit -m "feat: a log of what the assistant said on its own"
```

---

## Task 2: A két kapu

**Files:**
- Create: `src/core/notify/gates.ts`
- Test: `test/core/notify-gates.test.ts` (új)

**Interfaces:**
- Consumes: `Tz` és `isoTime` a `src/shared/dates.ts`-ből
- Produces: `GateOptions`, `gateReason(now, tz, lastSentAt, opts): string | null`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/notify-gates.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { gateReason, type GateOptions } from "../../src/core/notify/gates.ts";
import { TZ } from "../../src/shared/dates.ts";

const OPTS: GateOptions = { minHoursBetween: 4, quietFromHour: 22, quietToHour: 7 };
const at = (iso: string) => new Date(iso);

// 2026-09-01T10:00:00Z is 12:00 in Budapest (CEST, UTC+2).
const NOON = "2026-09-01T10:00:00.000Z";

describe("gateReason", () => {
  it("opens when nothing was ever sent and the hour is fine", () => {
    expect(gateReason(at(NOON), TZ, null, OPTS)).toBeNull();
  });

  it("closes inside the four-hour window", () => {
    const threeHoursAgo = "2026-09-01T07:00:00.000Z";
    expect(gateReason(at(NOON), TZ, threeHoursAgo, OPTS)).toMatch(/négy|óra/i);
  });

  it("opens once four hours have passed", () => {
    const fourHoursAgo = "2026-09-01T06:00:00.000Z";
    expect(gateReason(at(NOON), TZ, fourHoursAgo, OPTS)).toBeNull();
  });

  it("closes during quiet hours, on both sides of midnight", () => {
    // 23:00 and 02:00 Budapest.
    expect(gateReason(at("2026-09-01T21:00:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
    expect(gateReason(at("2026-09-02T00:00:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
  });

  it("opens again at the end of quiet hours", () => {
    // 06:59 is still quiet, 07:00 is not.
    expect(gateReason(at("2026-09-01T04:59:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
    expect(gateReason(at("2026-09-01T05:00:00.000Z"), TZ, null, OPTS)).toBeNull();
  });

  it("closes at the start of quiet hours", () => {
    // 21:59 is fine, 22:00 is not.
    expect(gateReason(at("2026-09-01T19:59:00.000Z"), TZ, null, OPTS)).toBeNull();
    expect(gateReason(at("2026-09-01T20:00:00.000Z"), TZ, null, OPTS)).toMatch(/csendes/i);
  });

  it("judges quiet hours in Budapest time, not UTC", () => {
    // 2026-01-15T22:30Z is 23:30 in Budapest (CET, UTC+1) — quiet. Judging in
    // UTC would call it 22:30 and still quiet, so use a case where they differ:
    // 2026-01-15T06:30Z is 07:30 Budapest (allowed) but 06:30 UTC (quiet).
    expect(gateReason(at("2026-01-15T06:30:00.000Z"), TZ, null, OPTS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/notify-gates.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/notify/gates.ts` fájlt:

```typescript
import { isoTime, type Tz } from "../../shared/dates.ts";

export interface GateOptions {
  /** Never speak twice inside this many hours. */
  minHoursBetween: number;
  /** Quiet from this local hour (inclusive). */
  quietFromHour: number;
  /** Quiet until this local hour (exclusive). */
  quietToHour: number;
}

/**
 * Whether the assistant may speak unprompted right now.
 *
 * Returns null when it may, or a Hungarian reason when it may not — the reason
 * is logged, because "nothing happened" and "something was suppressed" look
 * identical otherwise, and only one of them is a bug.
 *
 * Both gates are checked before anything is read from the database or the
 * network. A tick that cannot send has no business doing work.
 */
export function gateReason(
  now: Date,
  tz: Tz,
  lastSentAt: string | null,
  opts: GateOptions,
): string | null {
  // Quiet hours are judged in local time, not UTC: the point is when the
  // person is asleep, and Budapest is one or two hours ahead depending on the
  // season.
  const hour = Number(isoTime(now, tz).slice(0, 2));
  const quiet = opts.quietFromHour > opts.quietToHour
    // The window crosses midnight, which is the normal case for night hours.
    ? hour >= opts.quietFromHour || hour < opts.quietToHour
    : hour >= opts.quietFromHour && hour < opts.quietToHour;

  if (quiet) {
    return `csendes órák (${opts.quietFromHour}:00–${opts.quietToHour}:00), most ${hour}:00`;
  }

  if (lastSentAt !== null) {
    const elapsedH = (now.getTime() - new Date(lastSentAt).getTime()) / 3_600_000;
    if (elapsedH < opts.minHoursBetween) {
      return `az utolsó értesítés ${elapsedH.toFixed(1)} órája ment ki, `
        + `a korlát ${opts.minHoursBetween} óra`;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/notify-gates.test.ts && npm run typecheck`
Expected: PASS.

> Ha egy időzónás elvárás nem jön ki, **ellenőrizd a fixtúra óráit magad** a megadott UTC-időpontokból, és ha a tervem számol rosszul, állj meg és szólj — ne igazítsd sem a tesztet, sem a kódot addig.

- [ ] **Step 5: Commit**

```bash
git add src/core/notify/gates.ts test/core/notify-gates.test.ts
git commit -m "feat: the two gates that decide whether to speak at all"
```

---

## Task 3: A jelöltek

**Files:**
- Create: `src/core/notify/candidates.ts`
- Test: `test/core/notify-candidates.test.ts` (új)

**Interfaces:**
- Consumes: `Metrics` a `src/core/analysis/aggregate.ts`-ből; `Tz`, `isoDate` a `src/shared/dates.ts`-ből
- Produces: `CandidateKind`, `Candidate`, `CandidateInput`, `DeadlineItem`, `DEADLINE_HORIZON_H`, `HRV_SIGMA_THRESHOLD`, `RHR_SLOPE_THRESHOLD`, `candidates(input): Candidate[]`

**A `Metrics` alakja, amire támaszkodsz** (a `src/core/analysis/aggregate.ts`-ből, ne találd ki): `recovery.hrvDeviation` az `{ sigma: number; n7: number; n90: number } | null`, `physical.rhr` pedig egy `{ value, n, coverage, window, slopePer30d }`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/notify-candidates.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import {
  candidates, HRV_SIGMA_THRESHOLD, RHR_SLOPE_THRESHOLD,
  type CandidateInput,
} from "../../src/core/notify/candidates.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";

const EMPTY = { value: null, n: 0, coverage: 0, window: "365d" };
const NOW = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Budapest

function metrics(over: {
  hrvDeviation?: Metrics["recovery"]["hrvDeviation"];
  rhrSlope?: number | null;
  rhrN?: number;
} = {}): Metrics {
  return {
    today: "2026-09-01",
    physical: {
      byMonth: [], loadRatio: null, strengthPerWeek28d: null,
      vo2max: { ...EMPTY, slopePer30d: null },
      rhr: { value: 60, n: over.rhrN ?? 200, coverage: 0.55, window: "365d", slopePer30d: over.rhrSlope ?? null },
      hrRecovery: { ...EMPTY, slopePer30d: null },
      steps: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
    },
    recovery: {
      hrv: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
      hrvDeviation: over.hrvDeviation ?? null,
      asleepMin: { d28: EMPTY, d90: EMPTY, d365: EMPTY },
      stages: { core: EMPTY, rem: EMPTY, deep: EMPTY },
      awakenings: EMPTY, sleepByYear: [],
    },
    finance: { months: [], monthOverMonth: null, annualisedHuf: null },
  };
}

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return { now: NOW, tz: TZ, metrics: metrics(), newAnalyses: [], deadlines: [], ...over };
}

describe("candidates — deadlines", () => {
  it("takes a deadline inside the horizon", () => {
    const found = candidates(input({
      deadlines: [{ label: "csirkemell", dueAt: "2026-09-01T12:00:00.000Z", overdue: false }],
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("deadline");
    expect(found[0]!.text).toContain("csirkemell");
  });

  it("ignores a deadline beyond the horizon", () => {
    const found = candidates(input({
      deadlines: [{ label: "messze", dueAt: "2026-09-03T10:00:00.000Z", overdue: false }],
    }));
    expect(found).toEqual([]);
  });

  it("treats an overdue deadline as urgent now", () => {
    const found = candidates(input({
      deadlines: [{ label: "elkésett", dueAt: "2026-09-01T06:00:00.000Z", overdue: true }],
    }));
    expect(found[0]!.urgency).toBe("now");
  });

  it("gives the same key for the same situation on two different ticks", () => {
    // The key is the whole point of deduplication: if it moved with the clock,
    // every tick would look new and the assistant would repeat itself forever.
    const deadlines = [{ label: "csirkemell", dueAt: "2026-09-01T12:00:00.000Z", overdue: false }];
    const first = candidates(input({ deadlines }))[0]!.key;
    const later = candidates(input({ now: new Date("2026-09-01T10:15:00.000Z"), deadlines }))[0]!.key;
    expect(later).toBe(first);
  });
});

describe("candidates — health", () => {
  it("takes an HRV deviation at the threshold with enough samples", () => {
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -HRV_SIGMA_THRESHOLD, n7: 5, n90: 60 } }),
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("health");
  });

  it("carries its own evidence in the text", () => {
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -2.1, n7: 5, n90: 60 } }),
    }));
    // A notification that does not say what it rests on cannot be checked.
    expect(found[0]!.text).toContain("60");
  });

  it("ignores a deviation below the threshold", () => {
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -1.0, n7: 5, n90: 60 } }),
    }));
    expect(found).toEqual([]);
  });

  it("ignores a large deviation resting on too few samples", () => {
    // Not a weak candidate — no candidate. Three nights cannot establish that
    // a fortnight is unusual.
    const found = candidates(input({
      metrics: metrics({ hrvDeviation: { sigma: -3, n7: 2, n90: 8 } }),
    }));
    expect(found).toEqual([]);
  });

  it("takes a worsening resting heart rate trend", () => {
    const found = candidates(input({ metrics: metrics({ rhrSlope: RHR_SLOPE_THRESHOLD, rhrN: 200 }) }));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toMatch(/nyugalmi pulzus/i);
  });

  it("ignores an improving resting heart rate trend", () => {
    // Falling resting heart rate is good news, and good news is not a push.
    const found = candidates(input({ metrics: metrics({ rhrSlope: -3, rhrN: 200 }) }));
    expect(found).toEqual([]);
  });

  it("says nothing when there are no metrics at all", () => {
    expect(candidates(input({ metrics: null }))).toEqual([]);
  });
});

describe("candidates — analyses", () => {
  it("takes a new analysis summary", () => {
    const found = candidates(input({
      newAnalyses: [{ domain: "physical", summary: "A terhelés magas.", createdAt: "2026-09-01T09:00:00.000Z" }],
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("analysis");
    expect(found[0]!.text).toContain("A terhelés magas.");
  });

  it("keys an analysis by its identity, not by the current time", () => {
    const newAnalyses = [{ domain: "physical", summary: "x", createdAt: "2026-09-01T09:00:00.000Z" }];
    const first = candidates(input({ newAnalyses }))[0]!.key;
    const later = candidates(input({ now: new Date("2026-09-01T10:30:00.000Z"), newAnalyses }))[0]!.key;
    expect(later).toBe(first);
  });
});

describe("candidates — ordering", () => {
  it("puts the urgent first", () => {
    const found = candidates(input({
      deadlines: [{ label: "most", dueAt: "2026-09-01T09:00:00.000Z", overdue: true }],
      newAnalyses: [{ domain: "physical", summary: "ráér", createdAt: "2026-09-01T09:00:00.000Z" }],
    }));
    expect(found[0]!.urgency).toBe("now");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/notify-candidates.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/notify/candidates.ts` fájlt:

```typescript
import type { Metrics } from "../analysis/aggregate.ts";
import { isoDate, type Tz } from "../../shared/dates.ts";

export type CandidateKind = "deadline" | "health" | "analysis";

export interface Candidate {
  /**
   * Stable identity for deduplication.
   *
   * It must be identical on two ticks describing the same situation. A key
   * that moved with the clock would make every tick look new, and the
   * assistant would repeat itself until the retention window pruned it.
   */
  key: string;
  kind: CandidateKind;
  urgency: "now" | "soon";
  /** Hungarian, one line, carrying the evidence it rests on. */
  text: string;
}

export interface DeadlineItem {
  label: string;
  /** ISO instant by which it has to happen. */
  dueAt: string;
  overdue: boolean;
}

export interface CandidateInput {
  now: Date;
  tz: Tz;
  /** Null when the history could not be aggregated; the rest still stands. */
  metrics: Metrics | null;
  newAnalyses: { domain: string; summary: string; createdAt: string }[];
  deadlines: DeadlineItem[];
}

/** A deadline further out than this can wait for the next time we speak. */
export const DEADLINE_HORIZON_H = 4;

/** How far HRV must sit from its own 90-day baseline, in standard deviations. */
export const HRV_SIGMA_THRESHOLD = 1.5;

/** Resting heart rate worsening by at least this many bpm per 30 days. */
export const RHR_SLOPE_THRESHOLD = 2;

/**
 * The sample-size floors, inherited from the aggregation layer rather than
 * invented here: the same gates S3 applies before it will report a deviation
 * at all. A push is a stronger claim than a line in a report, so it must not
 * rest on less.
 */
const MIN_N7 = 3;
const MIN_N90 = 20;
const MIN_RHR_N = 60;

const DOMAIN_LABEL: Record<string, string> = {
  physical: "Fizikai fejlődés",
  recovery: "Regenerálódás",
  finance: "Pénzügy",
  synthesis: "Összegzés",
};

export function candidates(input: CandidateInput): Candidate[] {
  const out: Candidate[] = [];
  const horizonMs = DEADLINE_HORIZON_H * 3_600_000;

  for (const d of input.deadlines) {
    const msLeft = new Date(d.dueAt).getTime() - input.now.getTime();
    if (!d.overdue && msLeft > horizonMs) continue;

    out.push({
      // The due day, not the current time: the same task on the same day is
      // the same task however often we look at it.
      key: `deadline:${d.label}:${d.dueAt.slice(0, 10)}`,
      kind: "deadline",
      urgency: d.overdue || msLeft <= 0 ? "now" : "soon",
      text: d.overdue
        ? `${d.label} — a határidő már lejárt.`
        : `${d.label} — ${Math.max(0, Math.round(msLeft / 60_000))} perc múlva jár le.`,
    });
  }

  const m = input.metrics;
  if (m) {
    const dev = m.recovery.hrvDeviation;
    if (dev && dev.n7 >= MIN_N7 && dev.n90 >= MIN_N90 && Math.abs(dev.sigma) >= HRV_SIGMA_THRESHOLD) {
      const direction = dev.sigma < 0 ? "alatta" : "fölötte";
      out.push({
        key: "health:hrv-deviation",
        kind: "health",
        urgency: "soon",
        text: `A HRV-d ${Math.abs(dev.sigma).toFixed(1)} szórással a 90 napos alapvonalad ${direction} `
          + `van (${dev.n7} nap a friss ablakban, ${dev.n90} az alapvonalban).`,
      });
    }

    const rhr = m.physical.rhr;
    // Only a rising trend: a falling resting heart rate is good news, and good
    // news does not need to interrupt anyone.
    if (rhr.slopePer30d !== null && rhr.slopePer30d >= RHR_SLOPE_THRESHOLD && rhr.n >= MIN_RHR_N) {
      out.push({
        key: "health:rhr-rising",
        kind: "health",
        urgency: "soon",
        text: `A nyugalmi pulzusod 30 naponta ${rhr.slopePer30d.toFixed(1)} bpm-mel emelkedik `
          + `(${rhr.n} nap, ${rhr.window}).`,
      });
    }
  }

  for (const a of input.newAnalyses) {
    out.push({
      key: `analysis:${a.domain}:${a.createdAt.slice(0, 10)}`,
      kind: "analysis",
      urgency: "soon",
      text: `${DOMAIN_LABEL[a.domain] ?? a.domain} — ${a.summary}`,
    });
  }

  // Urgent first; within a group, the order they were produced in.
  return [...out].sort((a, b) => Number(b.urgency === "now") - Number(a.urgency === "now"));
}

/** Exported for the tick's logging: today's date in the configured zone. */
export function candidateDay(input: CandidateInput): string {
  return isoDate(input.now, input.tz);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/notify-candidates.test.ts && npm run typecheck`
Expected: PASS.

> Ha egy elvárt érték nem jön ki, **a fixtúrán ellenőrizd a számtant**, és ha a terv számol rosszul, állj meg és szólj — ne igazítsd a tesztet a kimenethez.

- [ ] **Step 5: Commit**

```bash
git add src/core/notify/candidates.ts test/core/notify-candidates.test.ts
git commit -m "feat: thresholds in code decide what is worth interrupting for"
```

---

## Task 4: A szöveg

**Files:**
- Create: `src/core/notify/message.ts`
- Test: `test/core/notify-message.test.ts` (új)

**Interfaces:**
- Consumes: `Candidate` (Task 3); `groqComplete`, `GROQ_CHAT_URL` a `src/infra/groq.ts`-ből; `withTimeout` a `src/infra/abort.ts`-ből; `Fetcher`; `Logger`
- Produces: `renderNotifyTemplate(cs)`, `buildNotifyPrompt(cs)`, `ComposeOptions`, `composeNotification(cs, opts, signal): Promise<{ text: string; source: "groq" | "template" }>`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/notify-message.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import {
  renderNotifyTemplate, buildNotifyPrompt, composeNotification,
} from "../../src/core/notify/message.ts";
import { GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import { recordingLogger } from "../helpers.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";
import type { Candidate } from "../../src/core/notify/candidates.ts";

const CS: Candidate[] = [
  { key: "deadline:csirke:2026-09-01", kind: "deadline", urgency: "now", text: "csirkemell — a határidő már lejárt." },
  { key: "health:rhr-rising", kind: "health", urgency: "soon", text: "A nyugalmi pulzusod emelkedik (200 nap)." },
];

function fetcherThat(answer: string | Error): Fetcher & { bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      if (!url.startsWith(GROQ_CHAT_URL)) throw new Error(`unexpected url ${url}`);
      bodies.push(String(init?.body ?? ""));
      if (answer instanceof Error) throw answer;
      return { choices: [{ message: { content: answer }, finish_reason: "stop" }] } as T;
    },
    async text(): Promise<string> { throw new Error("not used"); },
  };
}

const opts = (fetcher: Fetcher) => ({
  fetcher, model: "m", systemPromptFile: "jarvis.md",
  maxTokens: 300, temperature: 0.4, timeoutMs: 5_000,
  logger: recordingLogger(), apiKey: async () => "key",
});

const signal = () => new AbortController().signal;

describe("renderNotifyTemplate", () => {
  it("lists every candidate", () => {
    const text = renderNotifyTemplate(CS);
    expect(text).toContain("csirkemell");
    expect(text).toContain("nyugalmi pulzusod");
  });

  it("returns an empty string for no candidates", () => {
    // Nothing to say means no message, not an empty announcement.
    expect(renderNotifyTemplate([])).toBe("");
  });
});

describe("buildNotifyPrompt", () => {
  it("hands over the candidates and forbids adding to them", () => {
    const { system, user } = buildNotifyPrompt(CS);
    expect(user).toContain("csirkemell");
    expect(system).toMatch(/ne tegy|ne találj|csak a megadott/i);
  });
});

describe("composeNotification", () => {
  it("uses the model's wording when it answers", async () => {
    const result = await composeNotification(CS, opts(fetcherThat("Vedd ki a csirkét.")), signal());
    expect(result).toEqual({ text: "Vedd ki a csirkét.", source: "groq" });
  });

  it("falls back to the template when the model fails", async () => {
    // A missed defrost deadline is worse than an ugly sentence.
    const result = await composeNotification(CS, opts(fetcherThat(new Error("429"))), signal());
    expect(result.source).toBe("template");
    expect(result.text).toContain("csirkemell");
  });

  it("falls back to the template with no API key, without calling out", async () => {
    const fetcher = fetcherThat("nem hívódik");
    const result = await composeNotification(
      CS, { ...opts(fetcher), apiKey: async () => undefined }, signal(),
    );
    expect(fetcher.bodies).toHaveLength(0);
    expect(result.source).toBe("template");
  });

  it("never returns an empty text for a non-empty candidate list", async () => {
    // An empty answer from the model must not become a silent notification.
    const result = await composeNotification(CS, opts(fetcherThat("   ")), signal());
    expect(result.source).toBe("template");
    expect(result.text.trim()).not.toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/notify-message.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/notify/message.ts` fájlt:

```typescript
import { readFile } from "node:fs/promises";
import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";
import { groqComplete } from "../../infra/groq.ts";
import { withTimeout } from "../../infra/abort.ts";
import type { Candidate } from "./candidates.ts";

/** The plain listing. It cannot fail, which is the point of having it. */
export function renderNotifyTemplate(cs: readonly Candidate[]): string {
  if (cs.length === 0) return "";
  return cs.map((c) => `• ${c.text}`).join("\n");
}

export function buildNotifyPrompt(cs: readonly Candidate[]): { system: string; user: string } {
  return {
    system: [
      "Egy személyes asszisztens vagy. A feladatod EGYETLEN rövid Telegram-üzenet",
      "megfogalmazása az alábbi, már eldöntött tételekből.",
      "",
      "Szabályok:",
      "- Csak a megadott tételekről írj. Ne tegyél hozzá újat, és ne találj ki adatot.",
      "- Ne mérlegeld, hogy egy tétel fontos-e — ezt már eldöntötték helyetted.",
      "- Tartsd meg a tételekben szereplő számokat, mert azok a bizonyíték.",
      "- Magyarul, tömören. Legfeljebb néhány sor. Ne írj bevezetőt és lezárást.",
    ].join("\n"),
    user: ["A tételek:", ...cs.map((c) => `- [${c.urgency}] ${c.text}`)].join("\n"),
  };
}

export interface ComposeOptions {
  fetcher: Fetcher;
  model: string;
  systemPromptFile: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logger: Logger;
  apiKey: () => Promise<string | undefined>;
}

/**
 * The wording, with a floor under it.
 *
 * The model only phrases what the thresholds already decided to send. If it is
 * unreachable, slow, or returns nothing, the template goes out instead: a
 * notification must never be lost to a failure of phrasing. An ugly sentence
 * is better than a missed defrost deadline.
 */
export async function composeNotification(
  cs: readonly Candidate[],
  opts: ComposeOptions,
  signal: AbortSignal,
): Promise<{ text: string; source: "groq" | "template" }> {
  const fallback = renderNotifyTemplate(cs);

  try {
    const apiKey = await opts.apiKey();
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");

    const { system, user } = buildNotifyPrompt(cs);
    const answer = await withTimeout(signal, opts.timeoutMs, async (abortSignal) => {
      // The persona lives in jarvis.md; the notification rules are appended so
      // one short message still sounds like the rest of the assistant.
      const persona = await readFile(opts.systemPromptFile, "utf8");
      return groqComplete(opts.fetcher, {
        apiKey, model: opts.model,
        system: `${persona}\n\n---\n\n${system}`,
        user, maxTokens: opts.maxTokens, temperature: opts.temperature,
        signal: abortSignal,
      });
    });

    if (!answer.trim()) throw new Error("a modell üres választ adott");
    return { text: answer.trim(), source: "groq" };
  } catch (err) {
    opts.logger.warn({ err: String(err) }, "notification wording fell back to the template");
    return { text: fallback, source: "template" };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/notify-message.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/notify/message.ts test/core/notify-message.test.ts
git commit -m "feat: the model phrases it, the template guarantees it"
```

---

## Task 5: A jelöltek összegyűjtése

**Files:**
- Create: `src/core/notify/gather.ts`
- Test: `test/core/notify-gather.test.ts` (új)

**Interfaces:**
- Consumes: `Candidate`, `DeadlineItem`, `candidates` (Task 4-et megelőző Task 3); `NotificationRepo` (Task 1); `aggregate`, `Metrics`; `AnalysisRepo`; `BriefService`; `HealthRepo`, `WorkoutRepo`, `SubscriptionMonthRepo`; `isoDate`, `Tz`
- Produces: `GatherDeps`, `gatherCandidates(deps, now, signal): Promise<Candidate[]>`

**A modulok pontos mezőnevei** — olvasd el mindkettőt, ne találd ki:

- `src/modules/health-mealprep/index.ts` → a `data.defrost` elemei `{ item, meal, takeOutBy, mealDate, hoursLeft, overdue }`
- `src/modules/finance-subs/index.ts` → a megújulók `{ name, renewsOn, daysUntil, ... }`

A `BriefService.runOne(name, now)` egy `ModuleOutcome | null`-t ad; a modul adata az `outcome.result?.data`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/notify-gather.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { gatherCandidates, type GatherDeps } from "../../src/core/notify/gather.ts";
import { createNotificationRepo } from "../../src/infra/db/repositories/notifications.ts";
import { createAnalysisRepo } from "../../src/infra/db/repositories/analyses.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Db } from "../../src/infra/db/index.ts";

const NOW = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Budapest
const signal = () => new AbortController().signal;

function deps(db: Db, over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    tz: TZ,
    logger: recordingLogger(),
    notifications: createNotificationRepo(db),
    analyses: createAnalysisRepo(db),
    metrics: () => null,
    runModule: async () => null,
    ...over,
  };
}

describe("gatherCandidates", () => {
  it("turns a defrost task into a deadline candidate", async () => {
    const db = memoryDb();
    const d = deps(db, {
      runModule: async (name) => name !== "HealthAndMealPrep" ? null : {
        defrost: [{ item: "csirkemell", takeOutBy: "2026-09-01T12:00:00.000Z", overdue: false }],
      },
    });

    const found = await gatherCandidates(d, NOW, signal());
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    expect(found[0]!.text).toContain("csirkemell");
    db.close();
  });

  it("only offers analyses written since the last notification", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    const notifications = createNotificationRepo(db);

    analyses.save({ createdAt: "2026-09-01T06:00:00.000Z", domain: "physical", markdown: "#", summary: "régi", metrics: "{}" });
    notifications.record({ sentAt: new Date("2026-09-01T07:00:00.000Z"), kinds: ["analysis"], keys: ["k"], text: "t" });
    analyses.save({ createdAt: "2026-09-01T09:00:00.000Z", domain: "recovery", markdown: "#", summary: "friss", metrics: "{}" });

    const found = await gatherCandidates(deps(db, { analyses, notifications }), NOW, signal());
    expect(found.map((c) => c.text).join(" ")).toContain("friss");
    expect(found.map((c) => c.text).join(" ")).not.toContain("régi");
    db.close();
  });

  it("offers every analysis when nothing was ever sent", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    analyses.save({ createdAt: "2026-09-01T06:00:00.000Z", domain: "physical", markdown: "#", summary: "az első", metrics: "{}" });

    const found = await gatherCandidates(deps(db, { analyses }), NOW, signal());
    expect(found.map((c) => c.text).join(" ")).toContain("az első");
    db.close();
  });

  it("keeps the other sources when one of them throws", async () => {
    const db = memoryDb();
    const analyses = createAnalysisRepo(db);
    analyses.save({ createdAt: "2026-09-01T09:00:00.000Z", domain: "physical", markdown: "#", summary: "megmarad", metrics: "{}" });

    // The modules reach the network and the calendar; they are the likeliest
    // thing here to fail, and they must not silence a finding that is already
    // in hand.
    const d = deps(db, { analyses, runModule: async () => { throw new Error("modul elszállt"); } });

    const found = await gatherCandidates(d, NOW, signal());
    expect(found.map((c) => c.text).join(" ")).toContain("megmarad");
    db.close();
  });

  it("keeps the modules when the metrics throw", async () => {
    const db = memoryDb();
    const d = deps(db, {
      metrics: () => { throw new Error("aggregálás elszállt"); },
      runModule: async (name) => name !== "HealthAndMealPrep" ? null : {
        defrost: [{ item: "csirkemell", takeOutBy: "2026-09-01T12:00:00.000Z", overdue: false }],
      },
    });

    const found = await gatherCandidates(d, NOW, signal());
    expect(found.map((c) => c.kind)).toEqual(["deadline"]);
    db.close();
  });

  it("records the failure rather than swallowing it", async () => {
    const db = memoryDb();
    const logger = recordingLogger();
    const d = deps(db, { logger, runModule: async () => { throw new Error("modul elszállt"); } });

    await gatherCandidates(d, NOW, signal());
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/notify-gather.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/notify/gather.ts` fájlt:

```typescript
import type { Logger } from "../../infra/logger.ts";
import type { NotificationRepo } from "../../infra/db/repositories/notifications.ts";
import type { AnalysisRepo } from "../../infra/db/repositories/analyses.ts";
import type { Metrics } from "../analysis/aggregate.ts";
import type { Tz } from "../../shared/dates.ts";
import { candidates, type Candidate, type DeadlineItem } from "./candidates.ts";

export interface GatherDeps {
  tz: Tz;
  logger: Logger;
  notifications: NotificationRepo;
  analyses: AnalysisRepo;
  /** The aggregation over the whole history. May throw; may return null. */
  metrics: () => Metrics | null;
  /**
   * Runs one module and returns its data.
   *
   * Deliberately narrow: the caller wires this to `BriefService.runOne`, which
   * runs a single module. `get` and `generate` synthesise a brief, and a
   * synthesis is a Groq call — this path must never trigger one.
   */
  runModule: (name: string, now: Date) => Promise<unknown>;
}

interface DefrostShape { item?: unknown; takeOutBy?: unknown; overdue?: unknown }
interface RenewalShape { name?: unknown; renewsOn?: unknown }

/** Narrow, defensive readers: a module's shape changing must not throw here. */
function defrostDeadlines(data: unknown): DeadlineItem[] {
  const list = (data as { defrost?: unknown } | null)?.defrost;
  if (!Array.isArray(list)) return [];
  const out: DeadlineItem[] = [];
  for (const raw of list as DefrostShape[]) {
    if (typeof raw.item !== "string" || typeof raw.takeOutBy !== "string") continue;
    out.push({ label: raw.item, dueAt: raw.takeOutBy, overdue: raw.overdue === true });
  }
  return out;
}

function renewalDeadlines(data: unknown): DeadlineItem[] {
  const holder = data as { renewals?: unknown; soon?: unknown } | null;
  const list = Array.isArray(holder?.renewals) ? holder.renewals
    : Array.isArray(holder?.soon) ? holder.soon : null;
  if (!list) return [];
  const out: DeadlineItem[] = [];
  for (const raw of list as RenewalShape[]) {
    if (typeof raw.name !== "string" || typeof raw.renewsOn !== "string") continue;
    // A renewal has a day, not a moment; 09:00 local is when it is worth
    // hearing about, and the horizon check does the rest.
    out.push({ label: `${raw.name} megújul`, dueAt: `${raw.renewsOn}T07:00:00.000Z`, overdue: false });
  }
  return out;
}

/**
 * Collects everything worth considering, with each source isolated.
 *
 * The sources fail in different ways — the modules reach the network and the
 * calendar, the aggregation walks seven years of rows — and one of them
 * falling over must not silence a finding that is already in hand.
 */
export async function gatherCandidates(
  deps: GatherDeps,
  now: Date,
  _signal: AbortSignal,
): Promise<Candidate[]> {
  const deadlines: DeadlineItem[] = [];
  try {
    const health = await deps.runModule("HealthAndMealPrep", now);
    deadlines.push(...defrostDeadlines(health));
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "defrost deadlines unavailable for the notification");
  }

  try {
    const finance = await deps.runModule("FinanceAndSubs", now);
    deadlines.push(...renewalDeadlines(finance));
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "subscription renewals unavailable for the notification");
  }

  let metrics: Metrics | null = null;
  try {
    metrics = deps.metrics();
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "metrics unavailable for the notification");
  }

  let newAnalyses: { domain: string; summary: string; createdAt: string }[] = [];
  try {
    const since = deps.notifications.lastSentAt();
    newAnalyses = deps.analyses.latestPerDomain()
      .filter((a) => since === null || a.createdAt > since)
      .map((a) => ({ domain: a.domain, summary: a.summary, createdAt: a.createdAt }));
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "analyses unavailable for the notification");
  }

  return candidates({ now, tz: deps.tz, metrics, newAnalyses, deadlines });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/notify-gather.test.ts && npm run typecheck`
Expected: PASS.

> A `renewalDeadlines` két lehetséges mezőnevet próbál, mert a `FinanceAndSubs` adatszerkezetét nem olvastam el a terv írásakor. **Nézd meg a modult, és tartsd meg csak a valódit** — a másikat töröld, és írd a riportba, melyik volt. Egy „hátha ez is jó" ág elrejti, ha egyik sem az.

- [ ] **Step 5: Commit**

```bash
git add src/core/notify/gather.ts test/core/notify-gather.test.ts
git commit -m "feat: collect candidates, each source failing on its own"
```

---

## Task 6: A tick, a kiküldés és a bekötés

**Files:**
- Create: `src/core/notify/tick.ts`
- Modify: `src/delivery/telegram/bot.ts`, `src/infra/scheduler.ts`, `src/main.ts`, `config/config.ts`
- Test: `test/core/notify-tick.test.ts` (új)

**Interfaces:**
- Consumes: `gateReason` (Task 2); `candidates`, `Candidate`, `DeadlineItem` (Task 3); `composeNotification` (Task 4); `NotificationRepo` (Task 1); `SeenStore`; `BriefService.runOne`; `AnalysisRepo`; `aggregate`
- Produces: `NotifyDeps`, `runNotifyTick(deps, now, signal): Promise<"sent" | "gated" | "nothing" | "failed">`

**Amit a modulokból ki kell nyerni.** A `BriefService.runOne(name, now)` egy `ModuleOutcome | null`-t ad, aminek a `result.data` mezője a modul saját adatszerkezete. A határidők két helyről jönnek:

- `HealthAndMealPrep` → `data.defrost`, elemenként `{ item, takeOutBy, overdue }`
- `FinanceAndSubs` → a megújuló előfizetések, elemenként `{ name, renewsOn, daysUntil }`

Olvasd el mindkét modult (`src/modules/health-mealprep/index.ts`, `src/modules/finance-subs/index.ts`) a pontos mezőnevekért, és a `DeadlineItem`-re képezd őket. Egy előfizetés `renewsOn` dátumát vedd az adott nap 09:00 helyi idejének.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/notify-tick.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { runNotifyTick, type NotifyDeps } from "../../src/core/notify/tick.ts";
import { createNotificationRepo } from "../../src/infra/db/repositories/notifications.ts";
import { createSeenStore } from "../../src/infra/db/repositories/seen.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";
import type { Db } from "../../src/infra/db/index.ts";
import type { Candidate } from "../../src/core/notify/candidates.ts";

const NOON = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Budapest
const CANDIDATE: Candidate = {
  key: "health:rhr-rising", kind: "health", urgency: "soon", text: "A nyugalmi pulzusod emelkedik (200 nap).",
};

function deps(db: Db, over: Partial<NotifyDeps> = {}): NotifyDeps {
  return {
    db,
    tz: TZ,
    logger: recordingLogger(),
    notifications: createNotificationRepo(db),
    seen: createSeenStore(db),
    gates: { minHoursBetween: 4, quietFromHour: 22, quietToHour: 7 },
    gather: async () => [CANDIDATE],
    compose: async (cs) => ({ text: cs.map((c) => c.text).join(" "), source: "template" as const }),
    send: async () => {},
    ...over,
  };
}

const signal = () => new AbortController().signal;

describe("runNotifyTick", () => {
  it("sends, then records both the log and the dedupe keys", async () => {
    const db = memoryDb();
    const sent: string[] = [];
    const d = deps(db, { send: async (text) => { sent.push(text); } });

    expect(await runNotifyTick(d, NOON, signal())).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(d.notifications.lastSentAt()).toBe(NOON.toISOString());
    expect(d.seen.filterNew("notify", [CANDIDATE.key])).toEqual([]);
    db.close();
  });

  it("does not gather anything when a gate is closed", async () => {
    const db = memoryDb();
    let gathered = 0;
    // 23:00 Budapest — quiet. A tick that cannot send must do no work at all,
    // which is what keeps a 15-minute cron from running modules 96 times a day.
    const d = deps(db, { gather: async () => { gathered++; return [CANDIDATE]; } });

    expect(await runNotifyTick(d, new Date("2026-09-01T21:00:00.000Z"), signal())).toBe("gated");
    expect(gathered).toBe(0);
    db.close();
  });

  it("says nothing when nothing clears the thresholds", async () => {
    const db = memoryDb();
    const sent: string[] = [];
    const d = deps(db, { gather: async () => [], send: async (t) => { sent.push(t); } });

    expect(await runNotifyTick(d, NOON, signal())).toBe("nothing");
    expect(sent).toEqual([]);
    expect(d.notifications.lastSentAt()).toBeNull();
    db.close();
  });

  it("does not repeat a candidate it already sent", async () => {
    const db = memoryDb();
    const sent: string[] = [];
    const d = deps(db, { send: async (t) => { sent.push(t); } });

    await runNotifyTick(d, NOON, signal());
    // Eight hours later the gate is open again, but the candidate is the same.
    const later = new Date("2026-09-01T18:00:00.000Z");
    expect(await runNotifyTick(d, later, signal())).toBe("nothing");
    expect(sent).toHaveLength(1);
    db.close();
  });

  it("leaves no trace when sending fails", async () => {
    const db = memoryDb();
    // Neither half may land: a recorded send that never happened is a message
    // lost for good, and a recorded key with no message is worse.
    const d = deps(db, { send: async () => { throw new Error("telegram down"); } });

    expect(await runNotifyTick(d, NOON, signal())).toBe("failed");
    expect(d.notifications.lastSentAt()).toBeNull();
    expect(d.seen.filterNew("notify", [CANDIDATE.key])).toEqual([CANDIDATE.key]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/notify-tick.test.ts`
Expected: FAIL — a modul nem létezik.

- [ ] **Step 3: Write the tick**

Hozd létre a `src/core/notify/tick.ts` fájlt:

```typescript
import type { Db } from "../../infra/db/index.ts";
import type { Logger } from "../../infra/logger.ts";
import type { NotificationRepo } from "../../infra/db/repositories/notifications.ts";
import type { SeenStore } from "../../infra/db/repositories/seen.ts";
import type { Tz } from "../../shared/dates.ts";
import { gateReason, type GateOptions } from "./gates.ts";
import type { Candidate } from "./candidates.ts";

/** The SeenStore module name the notification keys live under. */
export const NOTIFY_MODULE = "notify";

export interface NotifyDeps {
  db: Db;
  tz: Tz;
  logger: Logger;
  notifications: NotificationRepo;
  seen: SeenStore;
  gates: GateOptions;
  /** Collects candidates. Only called once the gates have opened. */
  gather: (now: Date, signal: AbortSignal) => Promise<Candidate[]>;
  compose: (
    cs: readonly Candidate[], signal: AbortSignal,
  ) => Promise<{ text: string; source: "groq" | "template" }>;
  send: (text: string) => Promise<void>;
}

export type TickResult = "sent" | "gated" | "nothing" | "failed";

/**
 * One pass of the proactive check.
 *
 * The order is the design: gates first, and only then any work. A tick that
 * cannot send must not read the database or run a module — otherwise a
 * fifteen-minute cron would run the modules ninety-six times a day to discover
 * ninety-two times that it was not allowed to speak.
 */
export async function runNotifyTick(
  deps: NotifyDeps,
  now: Date,
  signal: AbortSignal,
): Promise<TickResult> {
  const closed = gateReason(now, deps.tz, deps.notifications.lastSentAt(), deps.gates);
  if (closed) {
    // Logged rather than silent: "nothing happened" and "something was
    // suppressed" look identical otherwise, and only one of them is a bug.
    deps.logger.debug({ reason: closed }, "proactive notification gated");
    return "gated";
  }

  const found = await deps.gather(now, signal);
  // One query for every key rather than one per candidate: that is what the
  // SeenStore's plural signature is for.
  const unseen = new Set(deps.seen.filterNew(NOTIFY_MODULE, found.map((c) => c.key)));
  const fresh = found.filter((c) => unseen.has(c.key));
  if (fresh.length === 0) return "nothing";

  const { text, source } = await deps.compose(fresh, signal);
  if (!text.trim()) return "nothing";

  try {
    await deps.send(text);
  } catch (err) {
    // Nothing is recorded, so the next open gate tries again. A missed message
    // has to be repeated; an unnecessary one does not.
    deps.logger.warn({ err: String(err) }, "proactive notification could not be sent");
    return "failed";
  }

  // Both writes together: a recorded send that never went out is a message
  // lost for good, and a recorded key with no message is the same thing twice.
  deps.db.transaction(() => {
    deps.notifications.record({
      sentAt: now, kinds: fresh.map((c) => c.kind), keys: fresh.map((c) => c.key), text,
    });
    deps.seen.record(NOTIFY_MODULE, fresh.map((c) => c.key), now);
  });

  deps.logger.info({ count: fresh.length, source }, "proactive notification sent");
  return "sent";
}
```

- [ ] **Step 4: Let the bot send unprompted**

`src/delivery/telegram/bot.ts` — a fájl végére, a `chunkText` mellé:

```typescript
/**
 * Sends a message nobody asked for.
 *
 * The bot otherwise only ever replies, so this is the one path that starts a
 * conversation. It reuses the same chunking as `reply`, because Telegram's
 * 4096-character cap does not care who started.
 */
export async function sendTo(bot: Bot, chatId: string, text: string): Promise<void> {
  for (const chunk of chunkText(text, 4000)) {
    await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
  }
}
```

- [ ] **Step 5: Add the configuration**

`config/config.ts` — új blokk:

```typescript
  notify: {
    /** How often the tick runs. The gates decide whether it does anything. */
    cron: "*/15 * * * *",
    /** Never speak twice inside this many hours. */
    minHoursBetween: 4,
    /** Quiet from this local hour (inclusive) until that one (exclusive). */
    quietFromHour: 22,
    quietToHour: 7,
    model: "qwen/qwen3.8-27b",
    maxTokens: 300,
    temperature: 0.4,
    timeoutMs: 30_000,
  },
```

- [ ] **Step 6: Wire the cron**

`src/infra/scheduler.ts` — a `SchedulerOptions`-ba vedd fel:

```typescript
  /**
   * The proactive check. Absent when there is no Telegram bot to speak
   * through, in which case no tick is scheduled at all.
   */
  notify?: { cron: string; run: (now: Date) => Promise<void> };
```

és a `startScheduler`-ben, a takarító cron mellé:

```typescript
  const notify = opts.notify
    ? new Cron(opts.notify.cron, { timezone, protect: true }, async () => {
        try {
          await opts.notify!.run(opts.clock.now());
        } catch (err) {
          // A failing tick must never take the scheduler down with it.
          opts.logger.warn({ err: String(err) }, "proactive notification tick failed");
        }
      })
    : null;
```

A `stop()` állítsa le ezt is.

`src/main.ts` — ha van `bot` és `allowedChatId`, add át a `startScheduler`-nek a `notify` mezőt, ami a `runNotifyTick`-et hívja. A `gather` a Task 5 `gatherCandidates`-e, a `GatherDeps`-szel:

```typescript
      gather: (now, signal) => gatherCandidates({
        tz: TZ,
        logger: app.logger,
        notifications: app.notifications,
        analyses: app.analyses,
        metrics: () => aggregate({
          today: isoDate(now, TZ),
          snapshots: app.health.between("1970-01-01", isoDate(now, TZ)),
          workouts: app.workouts.between("1970-01-01", isoDate(now, TZ)),
          months: app.subscriptionMonths.months().map((month) => ({
            month, subs: app.subscriptionMonths.forMonth(month),
          })),
        }),
        // runOne runs a single module. `get` and `generate` synthesise a brief,
        // which is a Groq call — this path must never trigger one.
        runModule: async (name, at) => (await app.briefs.runOne(name, at))?.result?.data ?? null,
      }, now, signal),
```

**A `briefs.get`-et és a `generate`-et itt tilos használni** — azok szintézist indítanak.

- [ ] **Step 7: Run the tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/core/notify/tick.ts src/delivery/telegram/bot.ts src/infra/scheduler.ts \
        src/main.ts config/config.ts test/core/notify-tick.test.ts
git commit -m "feat: the proactive tick, gated before it does any work"
```

---

## Task 7: Dokumentáció és éles ellenőrzés

**Files:**
- Modify: `README.md`
- Test: nincs új automata teszt; a lépések élesben ellenőriznek

- [ ] **Step 1: Document it**

`README.md` — a „Kérdezni" szakasz után:

```markdown
### Amikor magától szól

Negyedóránként ellenőrzi, van-e miért megszólalnia, és Telegramon szól. Két
kapun kell átjutnia: az utolsó ilyen üzenet óta eltelt négy óra, és 07:00 és
22:00 között vagyunk. Ha bármelyik zár, semmit nem csinál — nem is olvas.

Három dolog éri meg neki:

- **Időzaklató teendő** — kiolvasztási határidő vagy megújuló előfizetés a
  következő négy órán belül.
- **Egészségi eltérés** — a HRV másfél szórásra a saját 90 napos alapvonalától,
  vagy a nyugalmi pulzus 30 naponta legalább 2 bpm-es emelkedése. Mindkettőnek
  át kell mennie ugyanazokon a mintaszám-kapukon, amiket a mélyelemzés használ.
- **Új elemzési megállapítás** — ami az utolsó értesítés óta született.

Amit egyszer elmondott, azt nem mondja újra: a kulcsok a `seen_items` táblába
kerülnek, és a 04:00-s takarítás nyesi őket, tehát egy hónap múlva egy még
mindig fennálló dolog újra felszínre kerülhet.

A megfogalmazás a modellé, de a döntés nem: hogy egyáltalán megszólaljon-e,
azt küszöbök döntik kódban. Ha a modell nem érhető el, a tételek egyszerű
felsorolásként mennek ki — egy elmaradt határidő rosszabb, mint egy csúnya
mondat.

A kiküldött üzenetek a `notifications` táblában maradnak, tehát utólag
megnézhető, mit mondott és mikor.
```

- [ ] **Step 2: Verify the gates against the real clock**

Készíts egy eldobható szkriptet a scratchpadban (**ne** a repóban), ami az éles
adatbázisból **csak olvas**, és kiírja: mit ad a `gateReason` mostani idővel, mit
adna a `candidates` a jelenlegi `aggregate()`-ből és az `analyses` tábla utolsó
sorai alapján, és mit küldene ki a template. **Ne küldj Telegram-üzenetet**, és ne
írj az adatbázisba. Illeszd be a kimenetet a riportba, és mondd meg, értelmes-e
amit látsz — kapna-e most értesítést a felhasználó, és ha igen, jogosan.

- [ ] **Step 3: Run the suite and commit**

Run: `npm test && npm run typecheck && npm run smoke`

```bash
git add README.md
git commit -m "docs: when the assistant speaks first, and what it takes"
```

---

## Amit a terv szándékosan kihagy

- **Nem nyúl a napi briefhez, a modulokhoz és a kérdés-felülethez.**
- **Nem vezet be új értesítési csatornát.**
- **Nem ír adatot** a `notifications` és a `seen_items` táblán kívül, és a modell semmit.
- **Nem ébreszti a gépet.** Ha alszik, az értesítés az ébredés utáni első tickre csúszik.
- **Nem küld jó hírt.** A javuló nyugalmi pulzus nem szakít félbe senkit.
