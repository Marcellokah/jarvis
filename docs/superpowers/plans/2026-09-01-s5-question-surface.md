# S5 — Kérdés-felület — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kérdezni lehessen a rendszertől a hét év történetéről, az S3 elemzéseiről és a mai napról — egy helyi weboldalról és Telegramról, szálanként emlékezve.

**Architecture:** A `groqChat` már be van kötve; ez a munka megeteti és emlékezetet ad neki. Egy kontextus-összeállító modul rakja össze, amit a modell lát (elemzés-összegzések, megnyirbált statisztikák, a mai brief, a szál előzménye), a `conversations` tábla viszi a szálakat, és egy kiszolgáló-oldalon renderelt HTML-oldal ad felületet. Új futásidejű függőség nincs — a markdown→HTML egy tesztelt részhalmaz-renderelő.

**Tech Stack:** Node 24 (`.ts` közvetlenül, build nélkül), `node:sqlite`, Fastify 5, grammY, vitest, a meglévő `Fetcher` és `groqComplete`.

## Global Constraints

- Node >= 24, build lépés nincs, a `.ts` fájlok közvetlenül futnak — **minden relatív import `.ts` kiterjesztéssel**.
- **Új futásidejű függőség nem vehető fel.**
- `npm run typecheck` (`tsc --noEmit`) tisztán fut.
- A tesztek hálózat nélkül futnak, és soha nem írják az éles adatbázist (`./data/jarvis.db`) — azt egy launchd agent tartja nyitva.
- Felhasználónak szóló szöveg magyarul, kódkommentek angolul. A komment azt magyarázza, **miért**.
- **Minden HTML-be kerülő szöveg escape-elve megy ki** — a modell válasza sem kivétel.
- **Az LLM nem ír adatot.** A kérdés-felület olvas és beszél.
- Commit-üzenet utolsó sora: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Kiindulás

Branch: `s5-question-surface`, az **`s3-aggregation`-ről** (nem a `main`-ről — ez a munka az S3 `aggregate()`-jére és `analyses` tábláljára épül, és az S3 PR-je még nyitva van). Kiinduló állapot: 308 teszt / 34 fájl zöld, typecheck tiszta.

## Fájlszerkezet

| Fájl | Felelősség |
|---|---|
| `src/infra/db/repositories/conversations.ts` | A szálak tára. A 002-es migráció táblája végre használatba kerül |
| `src/core/ask/context.ts` | Amit a modell lát: elemzések, nyírt statisztikák, brief, előzmény |
| `src/core/chat.ts` | Módosul: új `ask` szignatúra, a `claudeChat` törlése |
| `src/delivery/http/markdown.ts` | Markdown-részhalmaz → HTML, escape-eléssel |
| `src/delivery/http/page.ts` | Az oldal HTML-je |
| `src/delivery/http/routes/page.ts` | `GET /` és `POST /api/chat` |
| `src/delivery/telegram/bot.ts` | Módosul: az új `ask` szignatúrára kötve |
| `src/infra/scheduler.ts` | Módosul: a beszélgetések nyesése a 04:00-s takarításba |

---

## Task 1: A szálak tára

**Files:**
- Create: `src/infra/db/repositories/conversations.ts`
- Modify: `src/app.ts`, `src/infra/scheduler.ts`
- Test: `test/core/conversations-repo.test.ts` (új)

**Interfaces:**
- Consumes: `Db` a `src/infra/db/index.ts`-ből (`get<T>`, `all<T>`, `run`, `transaction<T>`)
- Produces: `Role`, `Turn`, `ConversationRepo`, `createConversationRepo(db)`; `App.conversations`

**A tábla már létezik**, a 002-es migrációban, és nem kell hozzányúlni:

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_chat_idx ON conversations (chat_id, created_at DESC);
```

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/conversations-repo.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";

const AT = (iso: string) => new Date(iso);

describe("conversation repo", () => {
  it("stores an exchange as two turns, question first", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "Miért esett a VO2max-om?", "Mert kevesebbet futottál.", AT("2026-09-01T08:00:00.000Z"));

    const turns = repo.recent("web", 10);
    expect(turns.map((t) => [t.role, t.content])).toEqual([
      ["user", "Miért esett a VO2max-om?"],
      ["assistant", "Mert kevesebbet futottál."],
    ]);
    db.close();
  });

  it("returns the thread oldest first, because a prompt reads it forwards", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "első", "válasz1", AT("2026-09-01T08:00:00.000Z"));
    repo.appendExchange("web", "második", "válasz2", AT("2026-09-01T09:00:00.000Z"));

    expect(repo.recent("web", 10).map((t) => t.content))
      .toEqual(["első", "válasz1", "második", "válasz2"]);
    db.close();
  });

  it("keeps the LAST n turns when the thread is longer, still oldest first", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "régi", "régi-válasz", AT("2026-09-01T08:00:00.000Z"));
    repo.appendExchange("web", "friss", "friss-válasz", AT("2026-09-01T09:00:00.000Z"));

    // A limit must drop the oldest, not the newest: the recent turns are the
    // ones a follow-up question depends on.
    expect(repo.recent("web", 2).map((t) => t.content)).toEqual(["friss", "friss-válasz"]);
    db.close();
  });

  it("keeps threads apart", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "gépnél", "válasz", AT("2026-09-01T08:00:00.000Z"));
    repo.appendExchange("123456", "telefonon", "válasz", AT("2026-09-01T08:00:00.000Z"));

    expect(repo.recent("web", 10)).toHaveLength(2);
    expect(repo.recent("123456", 10).map((t) => t.content)).toEqual(["telefonon", "válasz"]);
    db.close();
  });

  it("prunes strictly before the cutoff, and reports how many went", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.appendExchange("web", "régi", "válasz", AT("2026-08-01T08:00:00.000Z"));
    repo.appendExchange("web", "határon", "válasz", AT("2026-08-15T00:00:00.000Z"));
    repo.appendExchange("web", "friss", "válasz", AT("2026-09-01T08:00:00.000Z"));

    // The boundary turn is kept: `before` means before, not up to and including.
    expect(repo.prune(AT("2026-08-15T00:00:00.000Z"))).toBe(2);
    expect(repo.recent("web", 10).map((t) => t.content))
      .toEqual(["határon", "válasz", "friss", "válasz"]);
    db.close();
  });

  it("writes both turns or neither", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    // A question stored without its answer would read, on the next turn, as a
    // model that declined to reply — and the model would explain that instead
    // of answering. The pair is written in one transaction for that reason.
    expect(() => repo.appendExchange("web", "kérdés", "", AT("2026-09-01T08:00:00.000Z")))
      .toThrow(/üres/);
    expect(repo.recent("web", 10)).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/conversations-repo.test.ts`
Expected: FAIL — a `src/infra/db/repositories/conversations.ts` modul nem létezik.

- [ ] **Step 3: Write the repository**

Hozd létre a `src/infra/db/repositories/conversations.ts` fájlt:

```typescript
import type { Db } from "../index.ts";

export type Role = "user" | "assistant";

export interface Turn {
  id: number;
  chatId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface ConversationRepo {
  /**
   * A question and its answer, written together.
   *
   * There is deliberately no way to store a question on its own: a thread
   * containing a question with no answer reads, on the next turn, as a model
   * that refused to reply, and the model then explains the refusal instead of
   * answering. Storing only after a successful call keeps that state
   * unreachable.
   */
  appendExchange(chatId: string, question: string, answer: string, now: Date): void;
  /** The last `n` turns of a thread, oldest first — a prompt reads forwards. */
  recent(chatId: string, n: number): Turn[];
  /** Deletes turns created strictly before `before`; returns how many. */
  prune(before: Date): number;
}

interface Row {
  id: number; chat_id: string; role: Role; content: string; created_at: string;
}

const toTurn = (r: Row): Turn => ({
  id: r.id, chatId: r.chat_id, role: r.role, content: r.content, createdAt: r.created_at,
});

export function createConversationRepo(db: Db): ConversationRepo {
  return {
    appendExchange(chatId, question, answer, now) {
      if (!question.trim() || !answer.trim()) {
        throw new Error("A kérdés és a válasz sem lehet üres.");
      }
      const at = now.toISOString();
      db.transaction(() => {
        const insert = "INSERT INTO conversations (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)";
        db.run(insert, chatId, "user", question, at);
        db.run(insert, chatId, "assistant", answer, at);
      });
    },

    recent(chatId, n) {
      // Newest-first with a limit, then reversed: taking the last n turns and
      // presenting them forwards. Ordering by id as well as time matters
      // because both turns of one exchange share a timestamp.
      return db.all<Row>(
        `SELECT * FROM (
           SELECT * FROM conversations WHERE chat_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         ) ORDER BY created_at, id`,
        chatId, n,
      ).map(toTurn);
    },

    prune(before) {
      const cutoff = before.toISOString();
      const doomed = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM conversations WHERE created_at < ?", cutoff,
      )?.n ?? 0;
      db.run("DELETE FROM conversations WHERE created_at < ?", cutoff);
      return doomed;
    },
  };
}
```

- [ ] **Step 4: Wire it into the composition root**

`src/app.ts` — a többi repó mintájára: importáld a `createConversationRepo`-t és a `ConversationRepo` típust, vedd fel az `App` interfészbe `conversations: ConversationRepo;` néven, és add a visszatérési objektumhoz `conversations: createConversationRepo(db),` formában.

- [ ] **Step 5: Prune in the nightly cleanup**

`src/infra/scheduler.ts` — a `cleanup` cron törzsében, a `prunedSeen` sor mellé:

```typescript
      const prunedTurns = createConversationRepo(opts.db).prune(
        new Date(now.getTime() - opts.conversationRetentionDays * 86_400_000),
      );
```

és a naplósorba vedd fel a `prunedTurns`-t a `prunedSeen` mellé. A `SchedulerOptions`-ba jöjjön egy `conversationRetentionDays: number;` mező, és a `src/main.ts`-ben, ahol a `startScheduler` hívódik, add át `conversationRetentionDays: 30` értékkel.

Kommentben indokold: a beszélgetés nem tartós emlékezet — az az `analyses` tábla dolga —, itt a friss szál számít, és egy hónapnál régebbi fordulóra soha senki nem kérdez vissza.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

```bash
git add src/infra/db/repositories/conversations.ts src/app.ts src/infra/scheduler.ts \
        src/main.ts test/core/conversations-repo.test.ts
git commit -m "feat: conversation threads, in the table that waited two years for them"
```

---

## Task 2: A kontextus összeállítása

**Files:**
- Create: `src/core/ask/context.ts`
- Test: `test/core/ask-context.test.ts` (új)

**Interfaces:**
- Consumes: `Metrics`, `aggregate`, `AggregateInput` a `src/core/analysis/aggregate.ts`-ből; `AnalysisRepo`, `AnalysisRow` a `src/infra/db/repositories/analyses.ts`-ből; `ConversationRepo`, `Turn` (Task 1); `HealthRepo`, `WorkoutRepo`, `SubscriptionMonthRepo`; `BriefService` a `src/core/brief-service.ts`-ből; `Clock`; `isoDate`, `TZ`
- Produces: `TrimmedMetrics`, `AskContext`, `AskContextDeps`, `trimMetrics(m)`, `buildAskContext(deps, chatId)`, `renderAskPrompt(ctx, question)`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/ask-context.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { trimMetrics, renderAskPrompt, type AskContext } from "../../src/core/ask/context.ts";
import type { Metrics } from "../../src/core/analysis/aggregate.ts";

const EMPTY = { value: null, n: 0, coverage: 0, window: "365d" };

function metrics(over: Partial<Metrics["physical"]> = {}): Metrics {
  return {
    today: "2026-09-01",
    physical: {
      byMonth: [], loadRatio: null, strengthPerWeek28d: null,
      vo2max: { ...EMPTY, slopePer30d: null },
      rhr: { ...EMPTY, slopePer30d: null },
      hrRecovery: { ...EMPTY, slopePer30d: null },
      steps: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
      ...over,
    },
    recovery: {
      hrv: { d7: EMPTY, d28: EMPTY, d90: EMPTY, d365: EMPTY },
      hrvDeviation: null,
      asleepMin: { d28: EMPTY, d90: EMPTY, d365: EMPTY },
      stages: { core: EMPTY, rem: EMPTY, deep: EMPTY },
      awakenings: EMPTY, sleepByYear: [],
    },
    finance: { months: [], monthOverMonth: null, annualisedHuf: null },
  };
}

describe("trimMetrics", () => {
  it("keeps only the last twelve months of training", () => {
    // The real database holds 55 months since 2019; sending them all costs
    // roughly 4,985 characters, more than the statistics they accompany.
    const byMonth = Array.from({ length: 55 }, (_, i) => ({
      month: `20${22 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      hours: i, sessions: i, strength: i,
    }));
    const trimmed = trimMetrics(metrics({ byMonth }));
    expect(trimmed.physical.byMonth).toHaveLength(12);
    // The last twelve, not the first twelve.
    expect(trimmed.physical.byMonth.at(-1)).toEqual(byMonth.at(-1));
  });

  it("leaves a shorter history alone", () => {
    const byMonth = [{ month: "2026-08", hours: 20, sessions: 18, strength: 9 }];
    expect(trimMetrics(metrics({ byMonth })).physical.byMonth).toEqual(byMonth);
  });

  it("rounds long decimals that carry no information", () => {
    const trimmed = trimMetrics(metrics({ loadRatio: 1.4123456789 }));
    expect(trimmed.physical.loadRatio).toBe(1.41);
  });

  it("keeps null as null rather than rounding it to zero", () => {
    // The whole project rests on this distinction; a rounder that turns an
    // absent measurement into 0 would undo every guard upstream of it.
    const trimmed = trimMetrics(metrics());
    expect(trimmed.physical.loadRatio).toBeNull();
    expect(trimmed.physical.vo2max.value).toBeNull();
  });

  it("leaves integers untouched", () => {
    const trimmed = trimMetrics(metrics({
      steps: { d7: { value: 10608, n: 7, coverage: 1, window: "7d" }, d28: EMPTY, d90: EMPTY, d365: EMPTY },
    }));
    expect(trimmed.physical.steps.d7.value).toBe(10608);
  });
});

describe("renderAskPrompt", () => {
  const base: AskContext = {
    today: "2026-09-01",
    briefMarkdown: "# 2026. szeptember 1.\n\n## Nap\nEbéd: csirke.",
    analyses: [
      { domain: "physical", summary: "A terhelés magas.", createdAt: "2026-09-01T07:08:45.487Z" },
      { domain: "finance", summary: "Stabil költés.", createdAt: "2026-06-01T07:00:00.000Z" },
    ],
    metrics: trimMetrics(metrics()),
    history: [],
  };

  it("dates every analysis, so a stale finding is not quoted as fresh", () => {
    const prompt = renderAskPrompt(base, "Mi a helyzet?");
    expect(prompt).toContain("2026-09-01");
    expect(prompt).toContain("2026-06-01");
  });

  it("says plainly when there is no analysis yet", () => {
    const prompt = renderAskPrompt({ ...base, analyses: [] }, "Mi a helyzet?");
    expect(prompt).toContain("Még nem készült mélyelemzés");
  });

  it("says plainly when there is no brief", () => {
    const prompt = renderAskPrompt({ ...base, briefMarkdown: null }, "Mi a helyzet?");
    expect(prompt).toContain("Ma nem készült briefing");
  });

  it("warns that the monthly breakdown is truncated", () => {
    // Without this the model reads the missing months as missing data and
    // comments on the gap.
    expect(renderAskPrompt(base, "?")).toContain("utolsó tizenkét hónap");
  });

  it("carries the thread forwards, oldest first", () => {
    const prompt = renderAskPrompt({
      ...base,
      history: [
        { id: 1, chatId: "web", role: "user", content: "KERDES_REGI", createdAt: "2026-09-01T08:00:00.000Z" },
        { id: 2, chatId: "web", role: "assistant", content: "VALASZ_REGI", createdAt: "2026-09-01T08:00:00.000Z" },
      ],
    }, "KERDES_UJ");
    expect(prompt.indexOf("KERDES_REGI")).toBeLessThan(prompt.indexOf("VALASZ_REGI"));
    expect(prompt.indexOf("VALASZ_REGI")).toBeLessThan(prompt.indexOf("KERDES_UJ"));
  });

  it("ends with the question", () => {
    const prompt = renderAskPrompt(base, "EZ_A_KERDES");
    expect(prompt.trimEnd().endsWith("EZ_A_KERDES")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/ask-context.test.ts`
Expected: FAIL — a `src/core/ask/context.ts` modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/core/ask/context.ts` fájlt:

```typescript
import type { Metrics } from "../analysis/aggregate.ts";
import { aggregate } from "../analysis/aggregate.ts";
import type { AnalysisRepo } from "../../infra/db/repositories/analyses.ts";
import type { ConversationRepo, Turn } from "../../infra/db/repositories/conversations.ts";
import type { HealthRepo } from "../../infra/db/repositories/health.ts";
import type { WorkoutRepo } from "../../infra/db/repositories/workouts.ts";
import type { SubscriptionMonthRepo } from "../../infra/db/repositories/subscription-months.ts";
import type { BriefService } from "../brief-service.ts";
import type { Clock } from "../../infra/clock.ts";
import type { Logger } from "../../infra/logger.ts";
import { isoDate, TZ } from "../../shared/dates.ts";

/** How many months of training history survive the trim. */
const MONTHS_KEPT = 12;

export type TrimmedMetrics = Metrics;

export interface AskContext {
  today: string;
  /** Null when today's brief could not be produced — the question still stands. */
  briefMarkdown: string | null;
  analyses: { domain: string; summary: string; createdAt: string }[];
  metrics: TrimmedMetrics;
  history: Turn[];
}

export interface AskContextDeps {
  health: HealthRepo;
  workouts: WorkoutRepo;
  subscriptionMonths: SubscriptionMonthRepo;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  briefs: BriefService;
  clock: Clock;
  logger: Logger;
  /** How many previous turns of the thread the model sees. */
  historyDepth: number;
}

/** Rounds to two decimals, leaving null alone. */
function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

/**
 * Walks the metrics rounding every number, leaving null untouched.
 *
 * The null case is the reason this is hand-written rather than a blanket
 * `JSON.parse(JSON.stringify(...))` pass: turning an absent measurement into 0
 * would undo every guard the aggregation layer puts in place.
 */
function roundDeep<T>(value: T): T {
  if (typeof value === "number") return round2(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(roundDeep) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = roundDeep(v);
  return out as T;
}

/**
 * The context's view of the statistics.
 *
 * The full `Metrics` object is too large for a question: `physical.byMonth`
 * carries a row per month since 2019 and runs to roughly 4,985 characters on
 * its own — more than the statistics it accompanies, against a 6,000
 * token/minute ceiling. The analysis still gets the whole picture; only the
 * question's view is trimmed.
 */
export function trimMetrics(m: Metrics): TrimmedMetrics {
  const trimmed: Metrics = {
    ...m,
    physical: { ...m.physical, byMonth: m.physical.byMonth.slice(-MONTHS_KEPT) },
  };
  return roundDeep(trimmed);
}

export async function buildAskContext(
  deps: AskContextDeps,
  chatId: string,
  signal: AbortSignal,
): Promise<AskContext> {
  const now = deps.clock.now();
  const today = isoDate(now, TZ);

  // A brief that will not come must not cost the answer: the history alone
  // answers most questions, and the day is only one part of the context.
  let briefMarkdown: string | null = null;
  try {
    briefMarkdown = (await deps.briefs.get(now, { wait: false })).markdown;
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "no brief for the ask context");
  }
  signal.throwIfAborted();

  const metrics = trimMetrics(aggregate({
    today,
    snapshots: deps.health.between("1970-01-01", today),
    workouts: deps.workouts.between("1970-01-01", today),
    months: deps.subscriptionMonths.months().map((month) => ({
      month, subs: deps.subscriptionMonths.forMonth(month),
    })),
  }));

  return {
    today,
    briefMarkdown,
    analyses: deps.analyses.latestPerDomain().map((a) => ({
      domain: a.domain, summary: a.summary, createdAt: a.createdAt,
    })),
    metrics,
    history: deps.conversations.recent(chatId, deps.historyDepth),
  };
}

const ROLE_LABEL: Record<Turn["role"], string> = { user: "Te", assistant: "Jarvis" };

export function renderAskPrompt(ctx: AskContext, question: string): string {
  const parts: string[] = [`Mai dátum: ${ctx.today}`, ""];

  parts.push(ctx.analyses.length === 0
    ? "Még nem készült mélyelemzés — erről a területről nem tudsz nyilatkozni, és ne következtess elemzést a nyers számokból."
    : [
      "A legutóbbi mélyelemzés összegzései, területenként, a keletkezés dátumával:",
      ...ctx.analyses.map((a) => `- [${a.domain}, ${a.createdAt.slice(0, 10)}] ${a.summary}`),
      "",
      "Egy régebbi megállapítás lehet, hogy már nem áll. A dátumot vedd figyelembe,",
      "és ha egy elemzés régi, mondd ki, hogy azóta nem készült új.",
    ].join("\n"));

  parts.push("", "A friss statisztikák. A havi bontásból csak az **utolsó tizenkét hónap**");
  parts.push("látszik — a korábbi hónapok léteznek, csak nincsenek itt, tehát ne olvasd");
  parts.push("adathiánynak. Minden metrika mellett ott van, hány napból származik (`n`)");
  parts.push("és mekkora a lefedettség; a `null` azt jelenti, hogy nincs mérés.");
  parts.push("", JSON.stringify(ctx.metrics));

  parts.push("", ctx.briefMarkdown === null
    ? "Ma nem készült briefing, tehát a mai napról csak a fenti számok alapján nyilatkozz."
    : `A mai briefing:\n\n${ctx.briefMarkdown}`);

  if (ctx.history.length > 0) {
    parts.push("", "A beszélgetés eddig:");
    for (const turn of ctx.history) parts.push(`${ROLE_LABEL[turn.role]}: ${turn.content}`);
  }

  parts.push(
    "",
    "Válaszolj magyarul, tömören, a persona szerint. Csak a fenti adatokra támaszkodj,",
    "és ha valamit nem tudsz belőlük, mondd ki ahelyett, hogy kitalálnád. Ha egy",
    "állításod mérésen alapul, tedd oda, hány napból.",
    "",
    "A kérdés:",
    question,
  );

  return parts.join("\n");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/core/ask-context.test.ts && npm run typecheck`
Expected: PASS, typecheck tiszta.

- [ ] **Step 5: Commit**

```bash
git add src/core/ask/context.ts test/core/ask-context.test.ts
git commit -m "feat: assemble what the model sees, trimmed to the token budget"
```

---

## Task 3: A kérdés-mag és a Telegram átkötése

**Files:**
- Modify: `src/core/chat.ts`, `src/app.ts`, `src/delivery/telegram/bot.ts`, `config/config.ts`
- Test: `test/core/ask.test.ts` (új)

**Interfaces:**
- Consumes: `AskContext`, `AskContextDeps`, `buildAskContext`, `renderAskPrompt` (Task 2); `ConversationRepo` (Task 1); `groqComplete`, `GROQ_CHAT_URL` a `src/infra/groq.ts`-ből; `withTimeout` a `src/infra/abort.ts`-ből
- Produces: az új `ChatService.ask(chatId, question, signal)` szignatúra

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/ask.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { groqChat } from "../../src/core/chat.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";
import { GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";
import type { AskContext } from "../../src/core/ask/context.ts";

const CONTEXT: AskContext = {
  today: "2026-09-01",
  briefMarkdown: "# Ma",
  analyses: [],
  metrics: {} as AskContext["metrics"],
  history: [],
};

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

function chatWith(fetcher: Fetcher, conversations = createConversationRepo(memoryDb())) {
  return {
    conversations,
    service: groqChat({
      fetcher,
      model: "test-model",
      systemPromptFile: "jarvis.md",
      maxTokens: 800,
      temperature: 0.4,
      timeoutMs: 5_000,
      logger: recordingLogger(),
      apiKey: async () => "key",
      clock: { now: () => new Date("2026-09-01T08:00:00.000Z") },
      conversations,
      context: async () => CONTEXT,
    }),
  };
}

const signal = () => new AbortController().signal;

describe("ask", () => {
  it("answers and stores both turns", async () => {
    const { service, conversations } = chatWith(fetcherThat("Ez a válasz."));

    const answer = await service.ask("web", "Ez a kérdés?", signal());

    expect(answer).toBe("Ez a válasz.");
    expect(conversations.recent("web", 10).map((t) => [t.role, t.content])).toEqual([
      ["user", "Ez a kérdés?"],
      ["assistant", "Ez a válasz."],
    ]);
  });

  it("stores nothing when the call fails", async () => {
    // A question stored without its answer would read as a refusal next turn.
    const { service, conversations } = chatWith(fetcherThat(new Error("groq exploded")));

    await expect(service.ask("web", "Ez a kérdés?", signal())).rejects.toThrow(/groq exploded/);
    expect(conversations.recent("web", 10)).toEqual([]);
  });

  it("sends the assembled context, not the raw question alone", async () => {
    const fetcher = fetcherThat("ok");
    await chatWith(fetcher).service.ask("web", "KERDES", signal());

    expect(fetcher.bodies[0]).toContain("KERDES");
    expect(fetcher.bodies[0]).toContain("2026-09-01");
  });

  it("keeps threads apart", async () => {
    const conversations = createConversationRepo(memoryDb());
    const { service } = chatWith(fetcherThat("válasz"), conversations);

    await service.ask("web", "gépnél", signal());
    await service.ask("123456", "telefonon", signal());

    expect(conversations.recent("web", 10).map((t) => t.content)).toEqual(["gépnél", "válasz"]);
    expect(conversations.recent("123456", 10).map((t) => t.content)).toEqual(["telefonon", "válasz"]);
  });

  it("fails without an API key and stores nothing", async () => {
    const fetcher = fetcherThat("nem hívódik");
    const conversations = createConversationRepo(memoryDb());
    const service = groqChat({
      fetcher, model: "m", systemPromptFile: "jarvis.md", maxTokens: 800,
      temperature: 0.4, timeoutMs: 5_000, logger: recordingLogger(),
      apiKey: async () => undefined,
      clock: { now: () => new Date("2026-09-01T08:00:00.000Z") },
      conversations, context: async () => CONTEXT,
    });

    await expect(service.ask("web", "k", signal())).rejects.toThrow(/GROQ_API_KEY/);
    expect(fetcher.bodies).toHaveLength(0);
    expect(conversations.recent("web", 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/ask.test.ts`
Expected: FAIL — a `groqChat` még a régi szignatúrát viszi, és nem ismeri a `conversations`/`context`/`clock` opciókat.

- [ ] **Step 3: Rewrite the chat core**

`src/core/chat.ts` — cseréld le a `ChatService` interfészt és a `groqChat`-et erre, és **töröld a `claudeChat`-et, a `ClaudeChatOptions`-t, valamint a `claude-cli.ts`-ből érkező importot** (a `groqChat` váltotta le; a holt ág fenntartása azt sugallja, hogy van visszaút, ami nincs):

```typescript
import { readFile } from "node:fs/promises";
import type { Logger } from "../infra/logger.ts";
import type { Fetcher } from "../infra/http-client.ts";
import type { Clock } from "../infra/clock.ts";
import { groqComplete } from "../infra/groq.ts";
import { withTimeout } from "../infra/abort.ts";
import type { ConversationRepo } from "../infra/db/repositories/conversations.ts";
import { renderAskPrompt, type AskContext } from "./ask/context.ts";

export interface ChatService {
  available(): Promise<boolean>;
  /**
   * Answers a question in one thread, and remembers the exchange.
   *
   * `chatId` is the thread: a Telegram chat id, or "web" for the local page.
   * The two are deliberately separate threads — a question asked on the phone
   * and one asked at the desk are different situations.
   */
  ask(chatId: string, question: string, signal: AbortSignal): Promise<string>;
}

export interface GroqChatOptions {
  fetcher: Fetcher;
  model: string;
  systemPromptFile: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logger: Logger;
  apiKey: () => Promise<string | undefined>;
  clock: Clock;
  conversations: ConversationRepo;
  /** Assembles the analyses, statistics, brief and thread for this chat. */
  context: (chatId: string, signal: AbortSignal) => Promise<AskContext>;
}

/**
 * Questions on the same provider that writes the brief.
 *
 * Deliberately no output contract: a chat answer is prose, and demanding a
 * heading would reject every useful reply. The brief's shape check protects
 * the brief; a bad answer here costs you a re-ask.
 */
export function groqChat(opts: GroqChatOptions): ChatService {
  return {
    async available() {
      return Boolean(await opts.apiKey());
    },

    async ask(chatId, question, signal) {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error("GROQ_API_KEY is not set");

      const context = await opts.context(chatId, signal);

      // The disk read sits behind withTimeout's abort guard, not in front of
      // it: an already-aborted signal should fail immediately, without a
      // wasted read of jarvis.md.
      const answer = await withTimeout(signal, opts.timeoutMs, async (abortSignal) => {
        const system = await readFile(opts.systemPromptFile, "utf8");
        return groqComplete(opts.fetcher, {
          apiKey, model: opts.model, system,
          user: renderAskPrompt(context, question),
          maxTokens: opts.maxTokens, temperature: opts.temperature,
          signal: abortSignal,
        });
      });

      // Only now, and both turns together: a thrown call must leave the thread
      // exactly as it was.
      opts.conversations.appendExchange(chatId, question, answer, opts.clock.now());
      opts.logger.debug({ chatId, chars: answer.length, model: opts.model }, "groq chat complete");
      return answer;
    },
  };
}

export function unavailableChat(reason: string): ChatService {
  return {
    async available() { return false; },
    async ask() { throw new Error(reason); },
  };
}
```

- [ ] **Step 4: Wire the new options in the composition root**

`src/app.ts` — a `groqChat({...})` híváshoz add hozzá:

```typescript
    clock,
    conversations,
    context: (chatId, signal) => buildAskContext({
      health, workouts,
      subscriptionMonths: createSubscriptionMonthRepo(db),
      analyses, conversations, briefs, clock, logger,
      historyDepth: config.groq.chatHistoryDepth,
    }, chatId, signal),
```

Használd a már meglévő lokális változókat, ahol vannak; ahol nincs, olvasd ki ugyanabból a forrásból, ahonnan az `App` mezője kapja. **Ne hozz létre második `BriefService`-t vagy második repót ugyanarra a táblára** — a kompozíciós gyökér lényege, hogy egy példány van.

`config/config.ts` — a `groq` blokkba, a `chatMaxTokens` mellé:

```typescript
    /** How many previous turns of a thread the model sees. Each costs budget. */
    chatHistoryDepth: 6,
```

- [ ] **Step 5: Rewire Telegram**

`src/delivery/telegram/bot.ts` — a `bot.on("message:text")` ágban a brief lekérése **fölöslegessé válik** (a kontextust a mag állítja össze), a hívás pedig a szálazonosítót kapja:

```typescript
      const answer = await opts.chat.ask(String(ctx.chat.id), question, controller.signal);
```

Töröld a `const brief = await opts.briefs.get(...)` sort ebből az ágból — de **csak ebből**; a `/brief` parancs változatlan.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test && npm run typecheck`
Expected: minden zöld. Ha egy meglévő teszt a régi `ask(question, briefMarkdown, signal)` szignatúrára hivatkozik, igazítsd az újhoz — ez a változás szándékos.

```bash
git add src/core/chat.ts src/app.ts src/delivery/telegram/bot.ts config/config.ts test/core/ask.test.ts
git commit -m "feat: questions see the history and remember the thread"
```

---

## Task 4: Markdown → HTML, könyvtár nélkül

**Files:**
- Create: `src/delivery/http/markdown.ts`
- Test: `test/delivery/markdown.test.ts` (új)

**Interfaces:**
- Consumes: semmit
- Produces: `escapeHtml(s)`, `renderMarkdown(md)`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/delivery/markdown.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { escapeHtml, renderMarkdown } from "../../src/delivery/http/markdown.ts";

describe("escapeHtml", () => {
  it("neutralises every character that could open a tag or attribute", () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`))
      .toBe("&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;");
  });
});

describe("renderMarkdown", () => {
  it("renders the heading levels the briefs and analyses actually use", () => {
    expect(renderMarkdown("# Egy")).toBe("<h1>Egy</h1>");
    expect(renderMarkdown("## Kettő")).toBe("<h2>Kettő</h2>");
    expect(renderMarkdown("### Három")).toBe("<h3>Három</h3>");
  });

  it("renders a bullet list", () => {
    expect(renderMarkdown("- egy\n- kettő"))
      .toBe("<ul><li>egy</li><li>kettő</li></ul>");
  });

  it("renders a checkbox item as a checkbox, checked or not", () => {
    expect(renderMarkdown("- [ ] tennivaló"))
      .toBe(`<ul><li class="task"><input type="checkbox" disabled> tennivaló</li></ul>`);
    expect(renderMarkdown("- [x] kész"))
      .toBe(`<ul><li class="task"><input type="checkbox" checked disabled> kész</li></ul>`);
  });

  it("renders bold and inline code", () => {
    expect(renderMarkdown("sima **vastag** és `kód`"))
      .toBe("<p>sima <strong>vastag</strong> és <code>kód</code></p>");
  });

  it("separates paragraphs on a blank line", () => {
    expect(renderMarkdown("első\n\nmásodik")).toBe("<p>első</p><p>második</p>");
  });

  it("joins the lines of one paragraph with a space, not a break", () => {
    expect(renderMarkdown("első sor\nmásodik sor")).toBe("<p>első sor második sor</p>");
  });

  it("escapes the content of every element it renders", () => {
    expect(renderMarkdown("# <b>cím</b>")).toBe("<h1>&lt;b&gt;cím&lt;/b&gt;</h1>");
    expect(renderMarkdown("- <img src=x onerror=1>"))
      .toBe("<ul><li>&lt;img src=x onerror=1&gt;</li></ul>");
  });

  it("never executes a script the model wrote", () => {
    // The answer comes from a language model; treating it as trusted markup
    // would be the one way this local page could hurt anything.
    const html = renderMarkdown("<script>fetch('/api')</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders syntax it does not know as plain text rather than guessing", () => {
    // A misread format is worse than an ugly line.
    expect(renderMarkdown("| a | b |")).toBe("<p>| a | b |</p>");
    expect(renderMarkdown("> idézet")).toBe("<p>&gt; idézet</p>");
  });

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n\n  \n")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/delivery/markdown.test.ts`
Expected: FAIL — a `src/delivery/http/markdown.ts` modul nem létezik.

- [ ] **Step 3: Write the implementation**

Hozd létre a `src/delivery/http/markdown.ts` fájlt:

```typescript
/**
 * A markdown subset, rendered without a dependency.
 *
 * Justified only because the markdown shown on this page is our own prompts'
 * output, with a known shape: headings, bullets, `- [ ]` tasks, bold, inline
 * code, blank-line paragraphs. Anything outside that set is printed as escaped
 * text rather than guessed at — a misread format is worse than an ugly line.
 *
 * Escaping happens before any markup is added, and on every path. The text
 * being rendered includes a language model's answer, which is the one way a
 * local page like this could be made to hurt anything.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline marks, applied to already-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const TASK = /^-\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^-\s+(.*)$/;

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    out.push(`<ul>${list.join("")}</ul>`);
    list = [];
  };
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.join(" ")}</p>`);
    paragraph = [];
  };
  const flush = () => { flushList(); flushParagraph(); };

  for (const raw of md.split("\n")) {
    const line = raw.trim();

    if (line === "") { flush(); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }

    const task = TASK.exec(line);
    if (task) {
      flushParagraph();
      const checked = task[1]!.toLowerCase() === "x" ? " checked" : "";
      list.push(
        `<li class="task"><input type="checkbox"${checked} disabled> ${inline(escapeHtml(task[2]!))}</li>`,
      );
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(`<li>${inline(escapeHtml(bullet[1]!))}</li>`);
      continue;
    }

    flushList();
    paragraph.push(inline(escapeHtml(line)));
  }

  flush();
  return out.join("");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/delivery/markdown.test.ts && npm run typecheck`
Expected: PASS, typecheck tiszta.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/http/markdown.ts test/delivery/markdown.test.ts
git commit -m "feat: render our own markdown subset, escaping everything first"
```

---

## Task 5: Az oldal és a végpontok

**Files:**
- Create: `src/delivery/http/page.ts`, `src/delivery/http/routes/page.ts`
- Modify: `src/delivery/http/server.ts`
- Test: `test/delivery/page.test.ts` (új)

**Interfaces:**
- Consumes: `renderMarkdown`, `escapeHtml` (Task 4); `Turn` (Task 1); `AnalysisRow` a `src/infra/db/repositories/analyses.ts`-ből; `Brief` a `src/core/brief-service.ts`-ből; `TrimmedMetrics` (Task 2); `ChatService` (Task 3)
- Produces: `PageData`, `renderPage(data)`, `registerPageRoutes(app, deps)`

**A `Brief` alakja** (a `src/core/brief-service.ts`-ből, ne találd ki): `{ date, dateLabel, generatedAt, synthesizer, markdown, actions, durationMs, fromCache, outcomes }`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/delivery/page.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { renderPage, type PageData } from "../../src/delivery/http/page.ts";

const base: PageData = {
  dateLabel: "2026. szeptember 1., kedd",
  briefMarkdown: "## Nap\n- [ ] Ebéd kivétele",
  analyses: [
    { domain: "physical", markdown: "### Fizikai\n- A terhelés magas.", createdAt: "2026-09-01T07:08:45.487Z" },
  ],
  metricsRows: [
    { label: "Terhelési arány", value: "1,41", detail: "28 nap / 365 nap" },
    { label: "Alvás (90 nap)", value: "nincs mérés", detail: "0 nap · 0% lefedettség" },
  ],
  history: [
    { id: 1, chatId: "web", role: "user", content: "Kérdés?", createdAt: "2026-09-01T08:00:00.000Z" },
    { id: 2, chatId: "web", role: "assistant", content: "Válasz.", createdAt: "2026-09-01T08:00:00.000Z" },
  ],
  chatAvailable: true,
};

describe("renderPage", () => {
  it("renders one document with the four blocks in order", () => {
    const html = renderPage(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    const order = ["Briefing", "Elemzés", "Számok", "Kérdés"];
    const positions = order.map((s) => html.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  it("renders the brief's markdown, checkboxes included", () => {
    expect(renderPage(base)).toContain(`<li class="task"><input type="checkbox" disabled> Ebéd kivétele</li>`);
  });

  it("dates each analysis, so a stale one is visibly stale", () => {
    expect(renderPage(base)).toContain("2026-09-01");
  });

  it("shows a missing measurement as missing, not as zero", () => {
    const html = renderPage(base);
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain(">0<");
  });

  it("escapes everything a model or a person typed", () => {
    const html = renderPage({
      ...base,
      history: [{ id: 1, chatId: "web", role: "assistant", content: "<script>x()</script>", createdAt: "2026-09-01T08:00:00.000Z" }],
    });
    expect(html).not.toContain("<script>x()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says so when there is no brief", () => {
    expect(renderPage({ ...base, briefMarkdown: null })).toContain("Ma még nem készült briefing");
  });

  it("says so when there is no analysis yet", () => {
    expect(renderPage({ ...base, analyses: [] })).toContain("Még nem futott mélyelemzés");
  });

  it("keeps the page usable when the model is unreachable", () => {
    // The content never depends on the model: the brief, the analyses and the
    // numbers are all there, and only the question box is disabled.
    const html = renderPage({ ...base, chatAvailable: false });
    expect(html).toContain("Terhelési arány");
    expect(html).toContain("nem érhető el");
    expect(html).toContain("disabled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/delivery/page.test.ts`
Expected: FAIL — a `src/delivery/http/page.ts` modul nem létezik.

- [ ] **Step 3: Write the page**

Hozd létre a `src/delivery/http/page.ts` fájlt:

```typescript
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import type { Turn } from "../../infra/db/repositories/conversations.ts";

export interface MetricRow {
  label: string;
  /** Already formatted for a person — "nincs mérés" where there is none. */
  value: string;
  detail: string;
}

export interface PageData {
  dateLabel: string;
  briefMarkdown: string | null;
  analyses: { domain: string; markdown: string; createdAt: string }[];
  metricsRows: MetricRow[];
  history: Turn[];
  chatAvailable: boolean;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fbfbfa; --muted: #6b6b6b; --line: #e3e3e0; --accent: #2f6f4f; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e6; --bg: #16181a; --muted: #9a9a97; --line: #2c2f33; --accent: #7fb99a; } }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 2rem 1.25rem 6rem; max-width: 46rem; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2.5rem 0 .5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 1.5rem 0 .4rem; }
.date { color: var(--muted); margin: 0 0 2rem; }
ul { padding-left: 1.2rem; } li { margin: .2rem 0; } li.task { list-style: none; margin-left: -1.2rem; }
table { border-collapse: collapse; width: 100%; font-size: .95rem; }
td { padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
td.value { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
td.detail { color: var(--muted); font-size: .85rem; }
.turn { margin: .75rem 0; padding: .6rem .8rem; border-radius: .5rem; border: 1px solid var(--line); }
.turn.user { border-color: var(--accent); }
.who { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.muted { color: var(--muted); }
form { display: flex; gap: .5rem; margin-top: 1rem; }
input[type=text] { flex: 1; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: .5rem;
  background: var(--bg); color: var(--fg); font: inherit; }
button { padding: .6rem 1rem; border: 0; border-radius: .5rem; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
button[disabled], input[disabled] { opacity: .5; cursor: not-allowed; }
`;

// Kept inline: there is no build step and no asset pipeline, and a second
// request for a few lines of script would need its own route and its own auth.
const SCRIPT = `
const q = new URLSearchParams(location.search).get("token");
if (q) { sessionStorage.setItem("jarvis-token", q); history.replaceState({}, "", location.pathname); }
const form = document.querySelector("form");
if (form) form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = form.querySelector("input[type=text]");
  const question = input.value.trim();
  if (!question) return;
  const button = form.querySelector("button");
  input.disabled = button.disabled = true;
  button.textContent = "Kérdezek…";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (sessionStorage.getItem("jarvis-token") || "") },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    location.reload();
  } catch (err) {
    button.textContent = "Nem sikerült: " + err.message;
    input.disabled = button.disabled = false;
  }
});
`;

const DOMAIN_TITLE: Record<string, string> = {
  physical: "Fizikai fejlődés",
  recovery: "Regenerálódás és alvás",
  finance: "Pénzügy",
  synthesis: "Összegzés",
};

function analysesBlock(data: PageData): string {
  if (data.analyses.length === 0) {
    return `<p class="muted">Még nem futott mélyelemzés. Indítsd: <code>npm run analyze</code></p>`;
  }
  return data.analyses.map((a) => [
    `<h3>${escapeHtml(DOMAIN_TITLE[a.domain] ?? a.domain)}`,
    ` <span class="muted">· ${escapeHtml(a.createdAt.slice(0, 10))}</span></h3>`,
    renderMarkdown(a.markdown),
  ].join("")).join("");
}

function chatBlock(data: PageData): string {
  const turns = data.history.map((t) => [
    `<div class="turn ${t.role === "user" ? "user" : "assistant"}">`,
    `<div class="who">${t.role === "user" ? "Te" : "Jarvis"}</div>`,
    renderMarkdown(t.content),
    "</div>",
  ].join("")).join("");

  const disabled = data.chatAvailable ? "" : " disabled";
  const notice = data.chatAvailable
    ? ""
    : `<p class="muted">A modell most nem érhető el, de a fenti tartalom teljes.</p>`;

  return [
    turns,
    notice,
    `<form><input type="text" placeholder="Kérdezz valamit…"${disabled}>`,
    `<button type="submit"${disabled}>Kérdés</button></form>`,
  ].join("");
}

export function renderPage(data: PageData): string {
  const metrics = data.metricsRows.map((r) => [
    "<tr>",
    `<td>${escapeHtml(r.label)}</td>`,
    `<td class="value">${escapeHtml(r.value)}</td>`,
    `<td class="detail">${escapeHtml(r.detail)}</td>`,
    "</tr>",
  ].join("")).join("");

  return [
    "<!doctype html>",
    `<html lang="hu"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    "<title>Jarvis</title>",
    `<style>${STYLE}</style></head><body>`,
    "<h1>Jarvis</h1>",
    `<p class="date">${escapeHtml(data.dateLabel)}</p>`,
    "<h2>Briefing</h2>",
    data.briefMarkdown === null
      ? `<p class="muted">Ma még nem készült briefing.</p>`
      : renderMarkdown(data.briefMarkdown),
    "<h2>Elemzés</h2>",
    analysesBlock(data),
    "<h2>Számok</h2>",
    `<table>${metrics}</table>`,
    "<h2>Kérdés</h2>",
    chatBlock(data),
    `<script>${SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}
```

- [ ] **Step 4: Write the routes**

Hozd létre a `src/delivery/http/routes/page.ts` fájlt:

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { ChatService } from "../../../core/chat.ts";
import type { AnalysisRepo } from "../../../infra/db/repositories/analyses.ts";
import type { ConversationRepo } from "../../../infra/db/repositories/conversations.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";
import { huLongDate, TZ } from "../../../shared/dates.ts";
import { renderPage, type MetricRow, type PageData } from "../page.ts";

/** The web page is one thread; Telegram chats are their own. */
export const WEB_CHAT_ID = "web";

export interface PageDeps {
  briefs: BriefService;
  chat: ChatService;
  analyses: AnalysisRepo;
  conversations: ConversationRepo;
  metricsRows: () => MetricRow[];
  clock: Clock;
  logger: Logger;
}

const body = z.object({ question: z.string().trim().min(1).max(2000) });

export function registerPageRoutes(app: FastifyInstance, deps: PageDeps): void {
  app.get("/", async (_request, reply) => {
    const now = deps.clock.now();

    // Each piece fails on its own. The page's job is to show what exists, and
    // a missing brief must not take the analyses and the numbers with it.
    let briefMarkdown: string | null = null;
    try {
      briefMarkdown = (await deps.briefs.get(now, { wait: false })).markdown;
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without a brief");
    }

    const data: PageData = {
      dateLabel: huLongDate(now, TZ),
      briefMarkdown,
      analyses: deps.analyses.latestPerDomain().map((a) => ({
        domain: a.domain, markdown: a.markdown, createdAt: a.createdAt,
      })),
      metricsRows: deps.metricsRows(),
      history: deps.conversations.recent(WEB_CHAT_ID, 20),
      chatAvailable: await deps.chat.available(),
    };

    return reply.type("text/html; charset=utf-8").send(renderPage(data));
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = body.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", detail: "a `question` mező kötelező" });
    }

    try {
      // The page waits on this request, so the deadline lives here rather than
      // in the browser: a hung call must free the connection, not hold it open
      // until the client gives up with nothing to show.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      try {
        const answer = await deps.chat.ask(WEB_CHAT_ID, parsed.data.question, controller.signal);
        return reply.send({ answer });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Named, not swallowed: a question that silently produced nothing looks
      // exactly like a question nobody asked.
      deps.logger.warn({ err: String(err) }, "chat question failed");
      return reply.code(502).send({ error: "chat_failed", detail: String(err) });
    }
  });
}
```

- [ ] **Step 5: Register the routes**

`src/delivery/http/server.ts` — importáld a `registerPageRoutes`-ot, vedd fel a `ServerDeps`-be a szükséges mezőket (`chat`, `analyses`, `conversations`, `metricsRows`), és regisztráld a többi mellé:

```typescript
  registerPageRoutes(app, {
    briefs: deps.briefs, chat: deps.chat, analyses: deps.analyses,
    conversations: deps.conversations, metricsRows: deps.metricsRows,
    clock: deps.clock, logger: deps.logger,
  });
```

A `src/main.ts`-ben, ahol a `buildServer` hívódik, add át az új mezőket az `app`-ról.

A `metricsRows` a friss `aggregate()`-ből épít sorokat. Vedd fel a
`src/delivery/http/page.ts`-be:

```typescript
import type { Metric } from "../../core/analysis/stats.ts";
import type { Metrics } from "../../core/analysis/aggregate.ts";

const hu = (n: number, digits = 0) =>
  n.toLocaleString("hu-HU", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * One row per metric, formatted for a person.
 *
 * A missing measurement reads "nincs mérés" and never 0 — the whole system is
 * built on that distinction, and a table is where it would be easiest to lose.
 * The detail column always carries the evidence: how many days, what coverage.
 */
function row(label: string, m: Metric, digits = 0, unit = ""): MetricRow {
  const pct = Math.round(m.coverage * 100);
  return {
    label,
    value: m.value === null ? "nincs mérés" : `${hu(m.value, digits)}${unit}`,
    detail: `${m.n} nap · ${pct}% lefedettség (${m.window})`,
  };
}

export function metricsRowsFrom(m: Metrics): MetricRow[] {
  const rows: MetricRow[] = [
    {
      label: "Terhelési arány",
      value: m.physical.loadRatio === null ? "nincs alap" : hu(m.physical.loadRatio, 2),
      detail: "28 napos napi átlag a 365 naposhoz mérve",
    },
    row("Lépés (7 nap)", m.physical.steps.d7),
    row("Lépés (365 nap)", m.physical.steps.d365),
    row("VO2max", m.physical.vo2max, 1),
    row("Nyugalmi pulzus", m.physical.rhr, 1, " bpm"),
    row("HRV (7 nap)", m.recovery.hrv.d7, 1, " ms"),
    row("HRV (90 nap)", m.recovery.hrv.d90, 1, " ms"),
    row("Alvás (90 nap)", m.recovery.asleepMin.d90, 0, " perc"),
  ];

  const trend = (label: string, slope: number | null, unit: string) => {
    if (slope === null) return;
    rows.push({
      label: `${label} trendje`,
      value: `${slope > 0 ? "+" : ""}${hu(slope, 2)}${unit}`,
      detail: "30 naponta, 365 napos ablakon",
    });
  };
  trend("VO2max", m.physical.vo2max.slopePer30d, "");
  trend("Nyugalmi pulzus", m.physical.rhr.slopePer30d, " bpm");

  rows.push({
    label: "Előfizetések",
    value: m.finance.months.at(-1) === undefined
      ? "nincs adat"
      : `${hu(m.finance.months.at(-1)!.totalHuf)} Ft`,
    detail: `${m.finance.months.length} rögzített hónap`,
  });

  return rows;
}
```

Írj hozzá két tesztet a `test/delivery/page.test.ts`-be:

```typescript
import { metricsRowsFrom } from "../../src/delivery/http/page.ts";

describe("metricsRowsFrom", () => {
  it("shows a missing measurement as missing, never as zero", () => {
    const rows = metricsRowsFrom(metricsFixture());
    const sleep = rows.find((r) => r.label === "Alvás (90 nap)")!;
    expect(sleep.value).toBe("nincs mérés");
    expect(sleep.detail).toContain("0 nap");
  });

  it("carries the evidence beside a real value", () => {
    const rows = metricsRowsFrom(metricsFixture({
      hrv7: { value: 68.7, n: 6, coverage: 6 / 7, window: "7d" },
    }));
    const hrv = rows.find((r) => r.label === "HRV (7 nap)")!;
    expect(hrv.value).toContain("68,7");
    expect(hrv.detail).toContain("6 nap");
    expect(hrv.detail).toContain("86%");
  });
});
```

Írd meg a `metricsFixture(over)` segédfüggvényt ugyanabban a fájlban, a
`test/core/ask-context.test.ts` `metrics()` helperje mintájára — egy teljes
`Metrics` objektum csupa üres metrikával, ahol az `over.hrv7` felülírja a
`recovery.hrv.d7` mezőt. **Ne importáld a másik tesztfájlból**; egy teszt
segédje ne legyen másik teszt függősége.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

```bash
git add src/delivery/http/page.ts src/delivery/http/routes/page.ts src/delivery/http/server.ts \
        src/main.ts test/delivery/page.test.ts
git commit -m "feat: the local page — brief, analyses, numbers and a question box"
```

---

## Task 6: Dokumentáció és ellenőrzés

**Files:**
- Modify: `README.md`
- Test: nincs új automata teszt; a lépések a meglévő harnesszel és egy renderelési próbával ellenőriznek

- [ ] **Step 1: Document it**

`README.md` — a „Parancsok" blokk után új szakasz:

```markdown
### Kérdezni

A rendszer két helyen fogad kérdést, és mindkettő ugyanazt a magot használja:

- **A helyi oldal** — `http://127.0.0.1:8787/?token=<JARVIS_TOKEN>`. A token
  egyszer kell; a böngésző elteszi a munkamenetre. Az oldalon fent a mai
  briefing, alatta a legutóbbi mélyelemzés területenként, a számok táblázatban,
  legalul a kérdés-mező.
- **Telegram** — bármilyen sima szöveges üzenet a botnak. A parancsok
  (`/brief`, `/uj`, `/modules`, `/undo`, `/used`) változatlanok.

A modell területenként a legutóbbi elemzés összegzését látja a keletkezés
dátumával, a friss statisztikákat, a mai briefinget és a szál előző fordulóit.
A két felület **külön szálat** visz: a telefonon és a gép előtt feltett kérdés
más helyzet.

A beszélgetéseket a 04:00-s takarítás 30 nap után nyesi. A tartós emlékezet nem
ez, hanem az `analyses` tábla.
```

- [ ] **Step 2: Verify the page renders from real data**

Készíts egy eldobható szkriptet a scratchpadban (**ne** a repóban), ami az éles adatbázisból **csak olvas**, összerakja a `PageData`-t és kiírja a HTML hosszát meg az első 40 sorát. Illeszd be a kimenetet a riportba.

Az éles adatbázist egy launchd agent tartja nyitva; olvasni szabad. **Ne írj bele**, és ne indíts szervert — a 8787-es porton az agent figyel.

- [ ] **Step 3: Verify the routes through the existing harness**

A `test/helpers.ts` `buildTestApp` harnesze in-process Fastify-t ad. Egészítsd ki
az új `ServerDeps` mezőkkel (`chat`, `analyses`, `conversations`, `metricsRows`),
és add hozzá ezt a tesztet a `test/delivery/page.test.ts` végéhez:

```typescript
import { buildTestApp, TEST_TOKEN } from "../helpers.ts";
import { stubModule } from "../helpers.ts";

describe("page routes", () => {
  const boot = () => buildTestApp({ modules: [stubModule({ name: "Teszt" })], now: "2026-09-01T08:00:00.000Z" });

  it("serves the page as HTML without a token", async () => {
    // `/` is not under `/api/`, and the server binds to 127.0.0.1 only.
    const app = await boot();
    const res = await app.server.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  it("refuses a question without the token", async () => {
    const app = await boot();
    const res = await app.server.inject({
      method: "POST", url: "/api/chat", payload: { question: "Mi újság?" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an empty question", async () => {
    const app = await boot();
    const res = await app.server.inject({
      method: "POST", url: "/api/chat",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { question: "   " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

```bash
git add README.md test/delivery/page.test.ts test/helpers.ts
git commit -m "docs: how to ask, and what the model sees when you do"
```

---

## Amit a terv szándékosan kihagy

- **Nem ír adatot LLM-en keresztül.** A modell olvas és beszél.
- **Nem küld proaktív értesítést** — az az S6.
- **Nincs bejelentkező felület, élő frissítés, offline működés.**
- **Nem ad az LLM-nek adatbázis-lekérdező eszközt.** A kontextus előre
  összeállított marad, ahogy az S3-ban is.
- **Nem nyúl a `/brief` parancshoz és a modulokhoz.**
