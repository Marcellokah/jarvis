# S1 + S4 — Leépítés és Groq · implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rendszer megszűnik magától ébredni és magától briefet gyártani, a háttér-LLM pedig a céges Claude fiókról átkerül a saját Groq kulcsodra.

**Architecture:** Az S1 kód-eltávolítás: a `startScheduler`-ből kikerül a pre-warm és a kapcsolat-ellenőrzés, a HTTP hookból a kapcsolat-rögzítés. Az S4 új szolgáltató a **meglévő** `Synthesizer` és `ChatService` interfészek mögé — a `BriefService` és a lánc-logika nem változik. A Groq OpenAI-kompatibilis REST, amit a meglévő `Fetcher` hív; új függőség nincs.

**Tech Stack:** Node 24, Fastify 5, zod, vitest. `fetch` a `createFetcher`-en keresztül.

## Global Constraints

- **Node `>=24`**, build-lépés nincs, a `.ts` fájlok közvetlenül futnak.
- **Nincs új futásidejű függőség.** A Groq hívása a meglévő `Fetcher`-rel megy — se `openai`, se `groq-sdk`.
- **`npm run typecheck` mindig tiszta** (`tsc --noEmit`).
- **Tesztek hálózat nélkül futnak.** Groq-hívás tesztben soha nem megy ki — stub `Fetcher`.
- **A szintézis lánca soha nem tartalmazhat fizetős elemet.** Az `api` szintetizáló tiltva marad.
- **A `template` marad a lánc utolsó eleme.** Ez a garancia, hogy a brief mindig elkészül.
- **Felhasználónak szóló szöveg magyarul, kódkomment angolul.**
- **A kommentek azt magyarázzák, MIÉRT** — a meglévő fájlok sűrűsége az irányadó.
- **Titok soha nem kerül logba vagy hibaüzenetbe.** A `GROQ_API_KEY` a login Kulcskarikában él.
- A projekt **git repó** (az előző terv Task 0-ja hozta létre). Ha még nem az, azt a taskot előbb végre kell hajtani.

---

## File Structure

**Új fájlok**

| Fájl | Felelősség |
|---|---|
| `src/infra/groq.ts` | A Groq HTTP kliens: egy kérés, egy válasz, semmi több |
| `src/core/synthesis/prompt.ts` | A szintézis promptja és a kimeneti szerződés — szolgáltató-független |
| `src/core/synthesis/groq.ts` | `groqSynthesizer()` |
| `scripts/eval-models.ts` | Ugyanazt a valódi briefet több modellen lefuttatja, egymás mellé teszi |
| `test/core/groq.test.ts` | A kliens és a szintetizáló viselkedése |
| `test/core/request-log.test.ts` | A `contact.test.ts`-ből megmaradó két teszt |

**Módosított fájlok**

| Fájl | Változás |
|---|---|
| `src/infra/scheduler.ts` | Pre-warm és kapcsolat-ellenőrzés ki; marad a takarítás |
| `src/delivery/http/server.ts` | A `contacts.record(...)` kikerül a hookból; a kérés-log marad |
| `src/core/synthesis/claude-code.ts` | A prompt és a szerződés-ellenőrzés átkerül a `prompt.ts`-be |
| `src/core/chat.ts` | `groqChat()` a `claudeChat()` mellé |
| `src/app.ts` | `groq` ág a láncban; a `contacts` repo kivezetése megszűnik |
| `src/main.ts` | A megszűnt függőségek kivezetése |
| `config/config.ts` | `synthesis.chain`, `synthesis.model`, `chat.model` |
| `scripts/smoke.ts` | Cost guard szétválasztása; Groq elérhetőség jelentése |
| `deploy/README.md`, `README.md`, `shortcuts/README.md` | Dokumentáció |

**Törölt fájlok**

| Fájl | Miért |
|---|---|
| `src/infra/db/repositories/contacts.ts` | Egy őrizetlen reggel őre volt |
| `test/core/contact.test.ts` | Két tesztje átköltözik a `request-log.test.ts`-be |

A `client_contact` **tábla és a 003-as migráció marad.** Egy üres tábla ártalmatlan; egy `DROP TABLE` migráció visszafordíthatatlan.

---

## Task 1: Leépítés

**Files:**
- Modify: `src/infra/scheduler.ts`
- Modify: `src/delivery/http/server.ts`
- Modify: `src/app.ts`, `src/main.ts`, `test/helpers.ts`
- Delete: `src/infra/db/repositories/contacts.ts`, `test/core/contact.test.ts`
- Create: `test/core/request-log.test.ts`

**Interfaces:**
- Consumes: semmit
- Produces: `startScheduler` opciói leszűkülnek `{ db, clock, logger, seenRetentionDays }`-re. A `ServerDeps`-ből eltűnik a `contacts`. Az `App`-ból eltűnik a `contacts`.

- [ ] **Step 1: Preserve the tests that are still true**

Hozd létre a `test/core/request-log.test.ts` fájlt a `test/core/contact.test.ts`
két megmaradó tesztjével:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, stubModule, recordingLogger, TEST_TOKEN, type TestApp } from "../helpers.ts";

let app: TestApp | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const auth = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * The contact tracking that used to live here is gone: it watched an unattended
 * morning, and there is no longer one. The request log stays — it is what makes
 * a failed call visible after the fact, whoever triggered it.
 */
describe("request log", () => {
  it("logs every request", async () => {
    const logger = recordingLogger();
    app = await buildTestApp({
      modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z", logger,
    });

    await app.server.inject({ method: "GET", url: "/api/morning-brief?format=text", headers: auth });

    const request = logger.entries.find((e) => e.msg === "request" && e.level === "info");
    expect(request).toBeDefined();
    expect(request!.obj).toMatchObject({ method: "GET", status: 200 });
  });

  it("keeps the liveness probe out of the info log", async () => {
    const logger = recordingLogger();
    app = await buildTestApp({
      modules: [stubModule({ name: "M" })], now: "2026-09-04T05:30:00Z", logger,
    });

    await app.server.inject({ method: "GET", url: "/healthz" });

    expect(logger.entries.some((e) => e.msg === "request" && e.level === "info")).toBe(false);
    expect(logger.entries.some((e) => e.msg === "request" && e.level === "debug")).toBe(true);
  });
});
```

> A `recordingLogger` és a `buildTestApp` `logger` opciója **nem létezik még** —
> az előző terv vezette volna be. Ha hiányzik, told be a `test/helpers.ts`-be:
> egy `LogEntry`-ket gyűjtő `Logger`, és a `buildTestApp` opcióihoz egy
> `logger?: Logger`, amit a `buildServer` kap meg a `silentLogger()` helyett.

- [ ] **Step 2: Delete the old test file**

```bash
rm test/core/contact.test.ts
```

- [ ] **Step 3: Run the tests to see what breaks**

Run: `npm test`
Expected: FAIL — a törölt teszt hivatkozásai eltűntek, de a `contacts` kód még él,
és a `request-log.test.ts` átmegy vagy a `recordingLogger` hiánya miatt bukik.
Ez a lépés a leltár: jegyezd fel, mi bukik.

- [ ] **Step 4: Strip the scheduler**

`src/infra/scheduler.ts` — a `SchedulerOptions` szűküljön erre:

```typescript
export interface SchedulerOptions {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** Drop seen_items older than this, so a re-released item can resurface. */
  seenRetentionDays: number;
}
```

A `preWarm` és a `contactCheck` cron, a `checkClientContact` függvény, és a
`BriefService` / `ContactRepo` importok kikerülnek. A `startScheduler` törzse:

```typescript
export function startScheduler(opts: SchedulerOptions): Scheduler {
  const timezone = "Europe/Budapest";

  // The only thing still on a timer. Not automation — the process's own hygiene:
  // expired cache entries and dedupe records that have outlived their purpose.
  const cleanup = new Cron("0 4 * * *", { timezone, protect: true }, () => {
    const now = opts.clock.now();
    try {
      const prunedSeen = createSeenStore(opts.db).prune(opts.seenRetentionDays, now);
      opts.db.run("DELETE FROM module_cache WHERE expires_at < ?", now.toISOString());
      opts.logger.info({ prunedSeen }, "nightly cleanup complete");
    } catch (err) {
      opts.logger.warn({ err: String(err) }, "nightly cleanup failed");
    }
  });

  opts.logger.info({ cleanup: "0 4 * * *" }, "scheduler started");

  return { stop() { cleanup.stop(); } };
}
```

Frissítsd a fájl fejléc-kommentjét is: a „Builds the brief before the Shortcut
asks for it" magyarázat tárgytalan. Helyette:

```typescript
/**
 * The only timer left in the system.
 *
 * The brief used to be pre-warmed at 07:20 so an unattended 07:30 request could
 * be served from cache. There is no unattended request any more — the brief is
 * generated when you ask for it. What remains is housekeeping.
 */
```

- [ ] **Step 5: Stop recording contacts in the HTTP hook**

`src/delivery/http/server.ts` — az `onResponse` hookból vedd ki a
`deps.contacts.record(...)` blokkot (a `try/catch`-csel együtt), a **log-részt
hagyd meg**. A `ServerDeps`-ből törölj a `contacts: ContactRepo;` mezőt és az
importját.

- [ ] **Step 6: Remove the repository and its wiring**

```bash
rm src/infra/db/repositories/contacts.ts
```

`src/app.ts`: a `createContactRepo` import, a `contacts: ContactRepo;` mező, a
`const contacts = ...` sor és a visszatérési objektum `contacts` kulcsa.
`src/main.ts`: a `contacts: app.contacts,` a `buildServer` és a `startScheduler`
hívásokból, a `contactCheckCron` / `contactAlert` / `notify` opciók, és a
`notify` konstans egésze.
`test/helpers.ts`: a `contacts` mező, a `createContactRepo` import és a
`buildServer` hívás `contacts` argumentuma.
`config/config.ts`: a `preWarmCron`, `contactCheckCron` és `contactAlert` mezők.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck`
Expected: minden zöld. A tesztszám ~17-tel csökken.

- [ ] **Step 8: Cancel the wake schedule**

Ez a **te** parancsod, jelszót kér:

```bash
sudo pmset repeat cancel
pmset -g sched
```

Expected: a „Repeating power events" szakasz eltűnik.

- [ ] **Step 9: Reinstall and verify the agent still runs**

```bash
launchctl kickstart -k gui/$(id -u)/local.jarvis.agent
sleep 6
launchctl print gui/$(id -u)/local.jarvis.agent | grep -E '^\s+(state|pid)'
tail -3 data/jarvis.log
```

Expected: `state = running`, és a logban `scheduler started {cleanup: "0 4 * * *"}` —
pre-warm és contactCheck **nélkül**.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove the unattended-morning machinery"
```

---

## Task 2: Groq HTTP kliens

**Files:**
- Create: `src/infra/groq.ts`
- Test: `test/core/groq.test.ts` (új)

**Interfaces:**
- Consumes: `Fetcher` (`src/infra/http-client.ts`)
- Produces: `GROQ_CHAT_URL: string`, `GROQ_MODELS_URL: string`, `groqComplete(fetcher: Fetcher, req: GroqRequest): Promise<string>` ahol `GroqRequest = { apiKey, model, system, user, maxTokens, temperature, signal }`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/groq.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { groqComplete, GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";

const signal = new AbortController().signal;

/** A fetcher that records what it was asked and returns what the test dictates. */
function stub(answer: unknown, seen: { url?: string; init?: RequestInit } = {}): Fetcher {
  return {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      seen.url = url;
      seen.init = init;
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
    async text() { throw new Error("unused"); },
  };
}

const ok = {
  choices: [{ message: { role: "assistant", content: "# nap\n\n## A\n\nvalami" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};

const req = {
  apiKey: "gsk-test", model: "llama-3.3-70b-versatile",
  system: "te vagy jarvis", user: "írd meg a briefet",
  maxTokens: 1500, temperature: 0.3, signal,
};

describe("groqComplete", () => {
  it("returns the assistant's text", async () => {
    expect(await groqComplete(stub(ok), req)).toBe("# nap\n\n## A\n\nvalami");
  });

  it("posts to the chat completions endpoint with the key in a header", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await groqComplete(stub(ok, seen), req);

    expect(seen.url).toBe(GROQ_CHAT_URL);
    expect(seen.init?.method).toBe("POST");
    expect((seen.init?.headers as Record<string, string>).authorization).toBe("Bearer gsk-test");

    const body = JSON.parse(String(seen.init?.body)) as {
      model: string; messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.messages[0]).toEqual({ role: "system", content: "te vagy jarvis" });
    expect(body.messages[1]).toEqual({ role: "user", content: "írd meg a briefet" });
  });

  it("rejects a truncated completion — a half-written brief is not a brief", async () => {
    const truncated = { choices: [{ message: { content: "# nap\n\n## A" }, finish_reason: "length" }] };
    await expect(groqComplete(stub(truncated), req)).rejects.toThrow(/truncated/i);
  });

  it("rejects an empty completion", async () => {
    const empty = { choices: [{ message: { content: "   " }, finish_reason: "stop" }] };
    await expect(groqComplete(stub(empty), req)).rejects.toThrow(/empty/i);
  });

  it("rejects a response with no choices at all", async () => {
    await expect(groqComplete(stub({}), req)).rejects.toThrow(/no completion/i);
  });

  it("lets a transport error through so the chain can demote", async () => {
    await expect(groqComplete(stub(new Error("HTTP 429 for groq")), req))
      .rejects.toThrow(/429/);
  });

  it("never puts the key anywhere but the header", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await groqComplete(stub(ok, seen), req);

    expect(seen.url).not.toContain("gsk-test");
    expect(String(seen.init?.body)).not.toContain("gsk-test");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/groq.test.ts`
Expected: FAIL — `Failed to load url .../groq.ts`.

- [ ] **Step 3: Write minimal implementation**

Hozd létre a `src/infra/groq.ts` fájlt:

```typescript
import type { Fetcher } from "./http-client.ts";

/** OpenAI-compatible, which is why this needs no SDK — one endpoint, one shape. */
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

export interface GroqRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}

interface GroqResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * One completion, returned as text.
 *
 * Everything that could produce a half-brief throws instead of returning:
 * the synthesis chain reads a thrown error as "demote to the next
 * synthesizer", and the template renderer below it cannot fail. A truncated
 * or empty answer that got returned would be published as your brief.
 */
export async function groqComplete(fetcher: Fetcher, req: GroqRequest): Promise<string> {
  const res = await fetcher.json<GroqResponse>(GROQ_CHAT_URL, {
    method: "POST",
    signal: req.signal,
    headers: {
      // The key travels in the header and nowhere else — not the URL, not the
      // body, so a logged request line can never carry it.
      authorization: `Bearer ${req.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      temperature: req.temperature,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
  });

  const choice = res.choices?.[0];
  if (!choice) throw new Error("Groq returned no completion");

  if (choice.finish_reason === "length") {
    throw new Error("Groq completion was truncated — raise maxTokens or shorten the prompt");
  }

  const text = (choice.message?.content ?? "").trim();
  if (!text) throw new Error("Groq returned an empty completion");

  return text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/groq.test.ts`
Expected: PASS (7 teszt)

- [ ] **Step 5: Commit**

```bash
git add src/infra/groq.ts test/core/groq.test.ts
git commit -m "feat: Groq chat completions client"
```

---

## Task 3: A prompt és a szerződés kiemelése

A `claude-code.ts` ma tartalmazza a szintézis promptját és a kimenet
szerződés-ellenőrzését. Mindkettő **szolgáltató-független** — a Groq
szintetizálónak ugyanaz kell. Kiemeljük, mielőtt a második fogyasztó megszületne.

**Files:**
- Create: `src/core/synthesis/prompt.ts`
- Modify: `src/core/synthesis/claude-code.ts`
- Test: `test/core/prompt.test.ts` (új)

**Interfaces:**
- Consumes: `BriefContext` (`src/core/synthesis/synthesizer.ts`)
- Produces: `buildPrompt(ctx: BriefContext): string`, `assertContract(markdown: string): string` a `src/core/synthesis/prompt.ts`-ből.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/prompt.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { buildPrompt, assertContract } from "../../src/core/synthesis/prompt.ts";
import type { BriefContext } from "../../src/core/synthesis/synthesizer.ts";

const ctx: BriefContext = {
  date: "2026-08-31",
  dateLabel: "2026. augusztus 31., hétfő",
  time: "06:20",
  outcomes: [{
    name: "HealthAndMealPrep", title: "🥦 Egészség & Meal Prep",
    priority: "critical", status: "ok",
    result: { data: { proteinTargetG: 115 }, actions: [], priority: "critical" },
    plain: "Fallback szöveg.",
    actions: [{ id: "a1", kind: "checkbox", text: "Vedd ki a csirkét" }],
    durationMs: 3,
  }],
};

describe("buildPrompt", () => {
  it("carries the module data and the section title verbatim", () => {
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain("HealthAndMealPrep");
    expect(prompt).toContain("🥦 Egészség & Meal Prep");
    expect(prompt).toContain("115");
  });

  it("carries the actions, which become the todo lines", () => {
    expect(buildPrompt(ctx)).toContain("Vedd ki a csirkét");
  });

  it("tells the model not to invent facts", () => {
    expect(buildPrompt(ctx)).toContain("ne találj ki tényeket");
  });
});

describe("assertContract", () => {
  it("passes a brief that opens with the date heading", () => {
    expect(assertContract("# 2026. augusztus 31.\n\n## A\n\nx")).toBe("# 2026. augusztus 31.\n\n## A\n\nx");
  });

  it("rejects prose that is not a brief", () => {
    // A tool-less model that wants a tool writes the call out as text. That is
    // non-empty, so only a shape check keeps it out of your morning.
    expect(() => assertContract("Megkeresem a fájlt.\n\n**Tool: bash**"))
      .toThrow(/did not start with/i);
  });

  it("rejects an empty result", () => {
    expect(() => assertContract("   ")).toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/prompt.test.ts`
Expected: FAIL — `Failed to load url .../prompt.ts`.

- [ ] **Step 3: Move the code**

Hozd létre a `src/core/synthesis/prompt.ts` fájlt, és **vágd bele** a
`claude-code.ts`-ből a `buildPrompt` függvényt változatlanul, valamint a
kimenet-ellenőrzést függvénnyé alakítva:

```typescript
import type { BriefContext } from "./synthesizer.ts";

/**
 * The synthesis prompt. Provider-independent on purpose: every synthesizer
 * sends the same thing, so a model comparison measures the model and not an
 * accidental difference in what it was asked.
 */
export function buildPrompt(ctx: BriefContext): string {
  const payload = {
    date: ctx.date,
    dateLabel: ctx.dateLabel,
    time: ctx.time,
    sections: ctx.outcomes
      .filter((o) => o.status !== "empty")
      .map((o) => ({
        module: o.name,
        title: o.title,
        priority: o.priority,
        status: o.status,
        facts: o.result?.data ?? null,
        degraded: o.result?.degraded ?? null,
        actions: o.actions.map((a) => ({
          text: a.text,
          kind: a.kind,
          ...(a.kind === "proposal" ? { proposal: a.proposal } : {}),
        })),
        fallbackText: o.plain,
      })),
  };

  return [
    "Az alábbi JSON a mai modulok nyers adata. Írd meg belőle a reggeli briefinget",
    "PONTOSAN az OPERATIONAL CONTRACT szerint (lásd a rendszerpromptot).",
    "",
    "Fontos:",
    "- A `title` mezőket szó szerint használd `## ` szekciócímként.",
    "- Minden `actions` elemből legyen egy `- [ ] ` sor, a szekciója végén.",
    "- Csak a megadott adatra támaszkodj; ne találj ki tényeket.",
    "- Ne írj bevezetőt és lezárást.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

/**
 * The contract in jarvis.md opens with exactly one `#` date heading, and the
 * renderer splits on that. A model that wants a tool it does not have writes
 * the call out as prose instead — non-empty, so only a shape check keeps it
 * out of your morning. Throwing hands the brief to the template renderer,
 * which is the whole point of having one.
 */
export function assertContract(markdown: string): string {
  const text = markdown.trim();
  if (!text) throw new Error("synthesizer returned an empty result");
  if (!text.startsWith("#")) {
    throw new Error(`output did not start with a '#' heading: ${text.slice(0, 80)}`);
  }
  return markdown;
}
```

`src/core/synthesis/claude-code.ts` — töröld a `buildPrompt` függvényt és a
`if (!markdown.startsWith("#"))` blokkot, importáld helyette:

```typescript
import { buildPrompt, assertContract } from "./prompt.ts";
```

és a `synthesize` végét:

```typescript
      opts.logger.debug({ chars: markdown.length }, "claude-code synthesis complete");
      return assertContract(markdown);
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: minden zöld. A `claude-code.test.ts` kimenet-ellenőrző tesztjei
változatlanul mennek, mert a viselkedés nem változott — csak a helye.

- [ ] **Step 5: Commit**

```bash
git add src/core/synthesis/prompt.ts src/core/synthesis/claude-code.ts test/core/prompt.test.ts
git commit -m "refactor: extract the provider-independent prompt and output contract"
```

---

## Task 4: Groq szintetizáló

**Files:**
- Create: `src/core/synthesis/groq.ts`
- Test: `test/core/groq.test.ts` (bővítés)

**Interfaces:**
- Consumes: `groqComplete` (Task 2), `buildPrompt` / `assertContract` (Task 3), `Fetcher`, `Synthesizer`
- Produces: `groqSynthesizer(opts: GroqSynthOptions): Synthesizer`, ahol `GroqSynthOptions = { fetcher, model, systemPromptFile, maxTokens, temperature, timeoutMs, logger, apiKey }` és `apiKey: () => Promise<string | undefined>`.

- [ ] **Step 1: Write the failing test**

Told hozzá a `test/core/groq.test.ts` fájlhoz:

```typescript
import { groqSynthesizer } from "../../src/core/synthesis/groq.ts";
import { templateSynthesizer } from "../../src/core/synthesis/template.ts";
import { synthesizeWithFallback, type BriefContext } from "../../src/core/synthesis/synthesizer.ts";
import { silentLogger } from "../../src/infra/logger.ts";

const ctx: BriefContext = {
  date: "2026-08-31",
  dateLabel: "2026. augusztus 31., hétfő",
  time: "06:20",
  outcomes: [{
    name: "HealthAndMealPrep", title: "🥦 Egészség & Meal Prep",
    priority: "critical", status: "ok",
    result: { data: { proteinTargetG: 115 }, actions: [], priority: "critical" },
    plain: "Fallback szöveg.",
    actions: [{ id: "a1", kind: "checkbox", text: "Vedd ki a csirkét" }],
    durationMs: 3,
  }],
};

function synth(answer: unknown, key: string | undefined = "gsk-test") {
  return groqSynthesizer({
    fetcher: stub(answer),
    model: "llama-3.3-70b-versatile",
    systemPromptFile: "./jarvis.md",
    maxTokens: 1500,
    temperature: 0.3,
    timeoutMs: 5_000,
    logger: silentLogger(),
    apiKey: async () => key,
  });
}

describe("groqSynthesizer", () => {
  it("is unavailable without a key, so the chain skips it cheaply", async () => {
    expect(await synth(ok, undefined).available()).toBe(false);
  });

  it("is available with one", async () => {
    expect(await synth(ok).available()).toBe(true);
  });

  it("returns the brief", async () => {
    const out = await synth(ok).synthesize(ctx, signal);
    expect(out).toBe("# nap\n\n## A\n\nvalami");
  });

  it("sends jarvis.md as the system message and the payload as the user message", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await groqSynthesizer({
      fetcher: stub(ok, seen), model: "llama-3.3-70b-versatile",
      systemPromptFile: "./jarvis.md", maxTokens: 1500, temperature: 0.3,
      timeoutMs: 5_000, logger: silentLogger(), apiKey: async () => "gsk-test",
    }).synthesize(ctx, signal);

    const body = JSON.parse(String(seen.init?.body)) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain("OPERATIONAL CONTRACT");
    expect(body.messages[1]!.content).toContain("🥦 Egészség & Meal Prep");
  });

  it("falls back to the template when the model breaks the contract", async () => {
    const prose = { choices: [{ message: { content: "Megkeresem a fájlt." }, finish_reason: "stop" }] };
    const out = await synthesizeWithFallback(
      [synth(prose), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.demoted[0]!.reason).toMatch(/did not start with/i);
  });

  it("falls back to the template on a rate limit", async () => {
    const out = await synthesizeWithFallback(
      [synth(new Error("HTTP 429 Too Many Requests")), templateSynthesizer()],
      ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.demoted[0]!.reason).toContain("429");
  });

  it("prefers Groq when it works", async () => {
    const out = await synthesizeWithFallback(
      [synth(ok), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("groq");
    expect(out.demoted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/groq.test.ts`
Expected: FAIL — `groqSynthesizer` nem létezik.

- [ ] **Step 3: Write minimal implementation**

Hozd létre a `src/core/synthesis/groq.ts` fájlt:

```typescript
import { readFile } from "node:fs/promises";
import type { Synthesizer, BriefContext } from "./synthesizer.ts";
import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";
import { groqComplete } from "../../infra/groq.ts";
import { buildPrompt, assertContract } from "./prompt.ts";

export interface GroqSynthOptions {
  fetcher: Fetcher;
  /** A production model id — verified against GET /openai/v1/models. */
  model: string;
  /** Path to jarvis.md: the persona and the output contract. */
  systemPromptFile: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logger: Logger;
  /** Resolved lazily so the key can live in the Keychain, not the environment. */
  apiKey: () => Promise<string | undefined>;
}

/**
 * Synthesis on Groq's free tier.
 *
 * Two properties earned it the slot: its Services Agreement forbids training on
 * inputs unless explicitly permitted, and the models it serves are an order of
 * magnitude larger than anything that fits in this Mac's 16 GB. The cost is a
 * 6,000 token/minute ceiling, which is why the prompt carries pre-computed
 * facts rather than raw history.
 */
export function groqSynthesizer(opts: GroqSynthOptions): Synthesizer {
  return {
    name: "groq",

    async available() {
      // Free and instant: no key means the chain should skip straight to the
      // template rather than spend a round trip discovering it.
      return Boolean(await opts.apiKey());
    },

    async synthesize(ctx: BriefContext, signal: AbortSignal): Promise<string> {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error("GROQ_API_KEY is not set");

      // Read per call rather than at construction: editing jarvis.md should
      // take effect on the next brief, not the next restart.
      const system = await readFile(opts.systemPromptFile, "utf8");

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

      try {
        const markdown = await groqComplete(opts.fetcher, {
          apiKey,
          model: opts.model,
          system,
          user: buildPrompt(ctx),
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          signal: controller.signal,
        });

        opts.logger.debug({ chars: markdown.length, model: opts.model }, "groq synthesis complete");
        return assertContract(markdown);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
```

> **Egy tudatos döntés a rate limitről.** A `createFetcher` a 429-et kétszer
> újrapróbálja, 250–750 ms várakozással. Egy token/perc limitnél ez kevés, tehát
> a hívás elbukik és a lánc template-re fokoz le. Ez helyes: egy manuális
> eszköznek gyorsan kell válaszolnia, nem egy percig blokkolnia. A brief attól
> még elkészül.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 5: Commit**

```bash
git add src/core/synthesis/groq.ts test/core/groq.test.ts
git commit -m "feat: Groq synthesizer behind the existing chain"
```

---

## Task 5: Groq chat

**Files:**
- Modify: `src/core/chat.ts`
- Test: `test/core/groq.test.ts` (bővítés)

**Interfaces:**
- Consumes: `groqComplete` (Task 2)
- Produces: `groqChat(opts: GroqChatOptions): ChatService` — ugyanaz a `ChatService` interfész, amit a `claudeChat` is teljesít.

- [ ] **Step 1: Write the failing test**

Told hozzá a `test/core/groq.test.ts` fájlhoz:

```typescript
import { groqChat } from "../../src/core/chat.ts";

describe("groqChat", () => {
  const answer = {
    choices: [{ message: { content: "Két előfizetés újul meg a héten." }, finish_reason: "stop" }],
  };

  function chat(response: unknown, seen?: { url?: string; init?: RequestInit }) {
    return groqChat({
      fetcher: stub(response, seen ?? {}),
      model: "llama-3.3-70b-versatile",
      systemPromptFile: "./jarvis.md",
      maxTokens: 800,
      temperature: 0.4,
      timeoutMs: 5_000,
      logger: silentLogger(),
      apiKey: async () => "gsk-test",
    });
  }

  it("answers a follow-up", async () => {
    const out = await chat(answer).ask("részletezd a pénzügyi részt", "# nap\n\n## 💰\n\nvalami", signal);
    expect(out).toBe("Két előfizetés újul meg a héten.");
  });

  it("gives the model today's brief as context", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await chat(answer, seen).ask("mi ez?", "# nap\n\n## 💰 Pénzügy\n\n5 előfizetés", signal);

    const body = JSON.parse(String(seen.init?.body)) as { messages: { content: string }[] };
    expect(body.messages[1]!.content).toContain("5 előfizetés");
    expect(body.messages[1]!.content).toContain("mi ez?");
  });

  it("does not apply the brief's output contract to a chat answer", async () => {
    // A chat reply is prose. Requiring it to start with '#' would reject every
    // useful answer.
    const prose = { choices: [{ message: { content: "Nem, csak kettő." }, finish_reason: "stop" }] };
    await expect(chat(prose).ask("három?", "# nap", signal)).resolves.toBe("Nem, csak kettő.");
  });

  it("is unavailable without a key", async () => {
    const noKey = groqChat({
      fetcher: stub(answer), model: "llama-3.3-70b-versatile",
      systemPromptFile: "./jarvis.md", maxTokens: 800, temperature: 0.4,
      timeoutMs: 5_000, logger: silentLogger(), apiKey: async () => undefined,
    });
    expect(await noKey.available()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/groq.test.ts -t "groqChat"`
Expected: FAIL — `groqChat` nincs exportálva.

- [ ] **Step 3: Write minimal implementation**

`src/core/chat.ts` — az importokhoz:

```typescript
import { readFile } from "node:fs/promises";
import type { Fetcher } from "../infra/http-client.ts";
import { groqComplete } from "../infra/groq.ts";
```

és a fájl végére:

```typescript
export interface GroqChatOptions {
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
 * Follow-up questions on the same provider that writes the brief.
 *
 * Deliberately no output contract here: a chat answer is prose, and demanding
 * a '#' heading would reject every useful reply. The brief's shape check
 * protects the brief; a bad chat answer costs you a re-ask.
 */
export function groqChat(opts: GroqChatOptions): ChatService {
  return {
    async available() {
      return Boolean(await opts.apiKey());
    },

    async ask(question, briefMarkdown, signal) {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error("GROQ_API_KEY is not set");

      const system = await readFile(opts.systemPromptFile, "utf8");
      const user = [
        "A mai briefing:",
        "",
        briefMarkdown,
        "",
        "---",
        "",
        "A felhasználó kérdése ehhez kapcsolódóan:",
        question,
        "",
        "Válaszolj tömören, magyarul, a persona szerint. Ha a kérdés nem a briefingről szól,",
        "attól még válaszolj — de ne találj ki tényeket a fenti adatokon túl.",
      ].join("\n");

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

      try {
        const answer = await groqComplete(opts.fetcher, {
          apiKey, model: opts.model, system, user,
          maxTokens: opts.maxTokens, temperature: opts.temperature,
          signal: controller.signal,
        });
        opts.logger.debug({ chars: answer.length, model: opts.model }, "groq chat complete");
        return answer;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 5: Commit**

```bash
git add src/core/chat.ts test/core/groq.test.ts
git commit -m "feat: Groq chat provider"
```

---

## Task 6: Bekötés — lánc, titok, konfiguráció

**Files:**
- Modify: `config/config.ts`
- Modify: `src/app.ts`
- Modify: `deploy/README.md`
- Test: `test/core/cost-guard.test.ts` (bővítés)

**Interfaces:**
- Consumes: `groqSynthesizer` (Task 4), `groqChat` (Task 5)
- Produces: `config.groq = { model, chatModel, maxTokens, chatMaxTokens, temperature, timeoutMs }`; a `buildSynthesisChain` ismeri a `"groq"` nevet; az `App.chat` a Groq-ot használja.

- [ ] **Step 1: Write the failing test**

Told hozzá a `test/core/cost-guard.test.ts` fájlhoz:

```typescript
  it("puts groq in front of the template by default", () => {
    const chain = buildSynthesisChain(loadEnv(base), silentLogger());
    expect(chain.map((s) => s.name)).toEqual(["groq", "template"]);
  });

  it("still ends with the template whatever the chain says", () => {
    const chain = buildSynthesisChain(loadEnv({ ...base, SYNTHESIS_CHAIN: "groq" }), silentLogger());
    expect(chain.at(-1)!.name).toBe("template");
  });

  it("keeps claude-code selectable for comparison", () => {
    const chain = buildSynthesisChain(
      loadEnv({ ...base, SYNTHESIS_CHAIN: "claude-code,template" }), silentLogger(),
    );
    expect(chain.map((s) => s.name)).toEqual(["claude-code", "template"]);
  });
```

> A meglévő „uses no paid synthesizer by default" teszt `["claude-code", "template"]`-et
> vár. Írd át `["groq", "template"]`-re — a szerződés változott, szándékosan.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/cost-guard.test.ts`
Expected: FAIL — a lánc még `claude-code`-dal kezd, és a `"groq"` ismeretlen név.

- [ ] **Step 3: Add the config block**

`config/config.ts` — a `synthesis` blokk `chain` mezőjét:

```typescript
    /**
     * `groq` first, `template` last. The template can never fail, which is what
     * makes every other entry optional rather than load-bearing.
     */
    chain: ["groq", "template"] as const,
```

és egy új blokk a `synthesis` mellé:

```typescript
  groq: {
    /**
     * Production model ids, verified against GET /openai/v1/models.
     * Compare candidates with: npm run eval-models
     */
    model: "llama-3.3-70b-versatile",
    chatModel: "llama-3.3-70b-versatile",
    /**
     * The free tier allows 6,000 tokens per minute across prompt and
     * completion. jarvis.md plus the payload is roughly 4,200, so the answer
     * has to stay well under two thousand.
     */
    maxTokens: 1_500,
    chatMaxTokens: 800,
    /** Low: the output contract is strict, and invention is the failure mode. */
    temperature: 0.3,
    timeoutMs: 60_000,
  },
```

- [ ] **Step 4: Wire it into the composition root**

`src/app.ts` — importáld a `groqSynthesizer`-t és a `groqChat`-et, és vedd fel a
`buildSynthesisChain` `switch`-ébe, a `case "claude-code"` mellé:

```typescript
      case "groq":
        chain.push(groqSynthesizer({
          fetcher: createFetcher({ logger }),
          model: config.groq.model,
          systemPromptFile: fromRoot("jarvis.md"),
          maxTokens: config.groq.maxTokens,
          temperature: config.groq.temperature,
          timeoutMs: config.groq.timeoutMs,
          logger,
          apiKey: async () => secrets?.get(GROQ_KEY_VAR),
        }));
        break;
```

A `GROQ_KEY_VAR` konstanst told a `src/infra/groq.ts`-be és importáld:

```typescript
/** The Groq API key, from the login Keychain. */
export const GROQ_KEY_VAR = "GROQ_API_KEY";
```

A `createApp`-ban a `chat` felépítését cseréld:

```typescript
  // Same provider that writes the brief. `claudeChat` stays in the codebase and
  // is a one-line swap, but nothing routine should touch the work account.
  const chat = groqChat({
    fetcher: runner.http,
    model: config.groq.chatModel,
    systemPromptFile: fromRoot("jarvis.md"),
    maxTokens: config.groq.chatMaxTokens,
    temperature: config.groq.temperature,
    timeoutMs: config.groq.timeoutMs,
    logger,
    apiKey: () => secrets.get(GROQ_KEY_VAR),
  });
```

- [ ] **Step 5: Store the key**

```bash
./scripts/set-secret.sh GROQ_API_KEY
```

A kulcsot a [console.groq.com](https://console.groq.com) → API Keys oldalon
készíted. Ellenőrzés kulcs kiírása nélkül:

```bash
security find-generic-password -s jarvis -a GROQ_API_KEY >/dev/null && echo "✓ tárolva"
```

- [ ] **Step 6: Document the secret**

`deploy/README.md` — az 1. lépés titok-listájába:

```bash
./scripts/set-secret.sh GROQ_API_KEY            # console.groq.com → API Keys
```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 8: Commit**

```bash
git add config/config.ts src/app.ts src/infra/groq.ts deploy/README.md test/core/cost-guard.test.ts
git commit -m "feat: route synthesis and chat through Groq"
```

---

## Task 7: A költség-őr szétválasztása

A `npm run smoke` ma egyetlen ellenőrzésbe mos össze két különböző állítást:
„nincs fizetős szintetizáló" és „nincs API kulcs egyáltalán". A Groq kulcs az
utóbbit elbuktatná, pedig a brief továbbra is ingyenes.

**Files:**
- Modify: `scripts/smoke.ts`

**Interfaces:**
- Consumes: `GROQ_KEY_VAR` (Task 6)
- Produces: a `smoke` két külön költség-sort ír ki, és jelenti a Groq elérhetőségét.

- [ ] **Step 1: Rewrite the cost section**

`scripts/smoke.ts` — a két meglévő `cost:` sort cseréld erre:

```typescript
  // Two different questions that used to be one check. The daily brief must
  // never cost money — that stays a hard rule. Which provider serves it is a
  // reporting matter.
  add(
    "cost: brief never metered",
    paid.length === 0,
    paid.length === 0
      ? `a lánc végig ingyenes: ${chain.join(" → ")}`
      : `FIZETŐS SZINTETIZÁLÓ A LÁNCBAN: ${paid.join(", ")}`,
  );
  add(
    "cost: ANTHROPIC_API_KEY unset",
    !process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY ? "beállítva — mért hívás lehetséges" : "unset",
  );
```

- [ ] **Step 2: Report the Groq key and provider**

A `--- Local prerequisites ---` szakaszba, a `JARVIS_TOKEN` sor mellé:

```typescript
  const groqKey = await app.runner.secrets.get(GROQ_KEY_VAR);
  add(
    `config: ${GROQ_KEY_VAR}`,
    Boolean(groqKey),
    groqKey
      ? `${groqKey.length} karakter — a szintézis és a chat a Groq ingyenes tierjén megy`
      : `hiányzik — a brief a template renderelővel készül. Tárold: ./scripts/set-secret.sh ${GROQ_KEY_VAR}`,
  );
```

Importáld hozzá: `import { GROQ_KEY_VAR } from "../src/infra/groq.ts";`

> A hiányzó kulcs **nem hiba**, csak minőségromlás — de látszódnia kell, mert
> különben a template-re fokozás észrevétlen marad.

- [ ] **Step 3: Run it**

Run: `npm run smoke`
Expected: a `cost: brief never metered` sor a `groq → template` láncot mutatja,
a `config: GROQ_API_KEY` pedig a karakterszámot. Kulcs értéke sehol nem jelenik meg.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.ts
git commit -m "feat: report the LLM provider separately from the cost guard"
```

---

## Task 8: Modell-kiértékelés

A spec szerint a modellt **mérés dönti el, nem tipp.** Ez a script futtatja
ugyanazt a valódi briefet több modellen, és egymás mellé teszi őket.

**Files:**
- Create: `scripts/eval-models.ts`
- Modify: `package.json` (`eval-models` script)

**Interfaces:**
- Consumes: `groqSynthesizer` (Task 4), `GROQ_MODELS_URL`, `GROQ_KEY_VAR` (Task 2, 6)
- Produces: `npm run eval-models` (lista) és `npm run eval-models -- <modell...>` (összehasonlítás).

- [ ] **Step 1: Write the script**

Hozd létre a `scripts/eval-models.ts` fájlt:

```typescript
/**
 * Runs today's real brief through several models and prints them side by side.
 *
 * The model choice is a measurement, not a guess: what matters is whether the
 * output holds the contract in jarvis.md — one `#` heading, `## ` titles taken
 * verbatim from the modules, `- [ ] ` todos — because the renderer splits on
 * exactly that.
 *
 *   npm run eval-models                       # what models are available
 *   npm run eval-models -- llama-3.3-70b-versatile openai/gpt-oss-120b
 */
import { createApp } from "../src/app.ts";
import { createBriefService } from "../src/core/brief-service.ts";
import { createBriefRepo } from "../src/infra/db/repositories/briefs.ts";
import { createActionRepo } from "../src/infra/db/repositories/actions.ts";
import { nullSeenStore } from "../src/infra/db/repositories/seen.ts";
import { openDb } from "../src/infra/db/index.ts";
import { silentLogger } from "../src/infra/logger.ts";
import { groqSynthesizer } from "../src/core/synthesis/groq.ts";
import { GROQ_MODELS_URL, GROQ_KEY_VAR } from "../src/infra/groq.ts";
import type { Synthesizer, BriefContext } from "../src/core/synthesis/synthesizer.ts";
import { config } from "../config/config.ts";
import { TZ } from "../src/shared/dates.ts";
import { fromRoot } from "../src/shared/paths.ts";

process.env.LOG_LEVEL ??= "error";
const app = createApp();
const models = process.argv.slice(2);

const apiKey = await app.runner.secrets.get(GROQ_KEY_VAR);
if (!apiKey) {
  console.error(`Nincs ${GROQ_KEY_VAR}. Tárold: ./scripts/set-secret.sh ${GROQ_KEY_VAR}`);
  app.close();
  process.exit(1);
}

if (models.length === 0) {
  const list = await app.runner.http.json<{ data?: { id: string; context_window?: number }[] }>(
    GROQ_MODELS_URL, { headers: { authorization: `Bearer ${apiKey}` } },
  );
  console.log("Elérhető modellek:\n");
  for (const m of (list.data ?? []).sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${m.id}${m.context_window ? `  (${m.context_window} token)` : ""}`);
  }
  console.log("\nÖsszehasonlítás:  npm run eval-models -- <modell> <modell>");
  app.close();
  process.exit(0);
}

// A scratch database for the brief and action rows this run produces, and a
// null seen-store: an evaluation must not consume today's dedupe budget or
// leave rows behind in the real one.
const scratch = openDb(":memory:", silentLogger());

let captured: BriefContext | undefined;
const capture: Synthesizer = {
  name: "capture",
  available: async () => true,
  synthesize: async (ctx) => { captured = ctx; return "# captured\n\n## x\n\ny"; },
};

const briefs = createBriefService({
  modules: app.modules,
  synthesizers: [capture],
  runner: { ...app.runner, seen: nullSeenStore() },
  briefs: createBriefRepo(scratch),
  actions: createActionRepo(scratch),
  logger: silentLogger(),
  tz: TZ,
  freshnessMinutes: 0,
  maxWaitSeconds: 60,
});

await briefs.generate(app.clock.now());
if (!captured) throw new Error("no context captured");

const signal = new AbortController().signal;

for (const model of models) {
  const synth = groqSynthesizer({
    fetcher: app.runner.http,
    model,
    systemPromptFile: fromRoot("jarvis.md"),
    maxTokens: config.groq.maxTokens,
    temperature: config.groq.temperature,
    timeoutMs: config.groq.timeoutMs,
    logger: silentLogger(),
    apiKey: async () => apiKey,
  });

  console.log(`\n${"═".repeat(64)}\n  ${model}\n${"═".repeat(64)}\n`);
  const started = Date.now();
  try {
    const markdown = await synth.synthesize(captured, signal);
    console.log(markdown);
    console.log(`\n— ${Date.now() - started} ms · ${markdown.length} karakter`);
  } catch (err) {
    console.log(`✗ ${err instanceof Error ? err.message : String(err)}`);
    console.log(`— ${Date.now() - started} ms`);
  }

  // The free tier is 6,000 tokens a minute and each run spends most of it.
  if (model !== models.at(-1)) {
    console.log("\n  …60 másodperc szünet a token/perc limit miatt\n");
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

scratch.close();
app.close();
```

- [ ] **Step 2: Add the npm script**

`package.json` — a `scripts` blokkba:

```json
    "eval-models": "node --env-file-if-exists=.env scripts/eval-models.ts",
```

- [ ] **Step 3: List what is actually available**

Run: `npm run eval-models`
Expected: a Groq-nál elérhető modellek listája. **Innen vedd az id-ket** —
ne abból, amit ez a terv említ.

- [ ] **Step 4: Compare the candidates**

```bash
npm run eval-models -- llama-3.3-70b-versatile openai/gpt-oss-120b
```

Ha a lista tartalmaz Kimi K2-t vagy más nagy modellt, vedd be harmadiknak.
Referenciának mellé:

```bash
npm run brief -- --synthesizer=claude-code
npm run brief -- --synthesizer=template
```

- [ ] **Step 5: Judge them in this order**

1. **Formátum-hűség** — pontosan egy `#` cím; a `## ` címek **szó szerint** a modul
   `title` mezői (emojival együtt); minden teendő `- [ ] ` prefixszel. Ezen bukik
   a legtöbb kisebb modell, és a renderer erre bontja szét a kimenetet.
2. **Ténypontosság** — nincs kitalált szám, nem hagy el javasolt időpontot.
   *(A `claude-code` egy korábbi mérésben elhagyta a naptár-javaslat idősávját —
   a referencia sem hibátlan.)*
3. **Magyar minőség** — tömör, sallangmentes, a persona szerint.
4. **Késleltetés.**

- [ ] **Step 6: Record the decision and set it**

Írd be a győztes id-t a `config/config.ts` `groq.model` és `groq.chatModel`
mezőibe, és a fölötte lévő kommentbe **egy sorban, hogy miért** — melyik
szempont döntött.

- [ ] **Step 7: Commit**

```bash
git add scripts/eval-models.ts package.json config/config.ts
git commit -m "feat: model evaluation script; pick the synthesis model by measurement"
```

---

## Task 9: Dokumentáció és éles ellenőrzés

**Files:**
- Modify: `README.md`, `deploy/README.md`, `shortcuts/README.md`

- [ ] **Step 1: Rewrite how it stays free**

`README.md` — a „Hogyan marad ingyenes" szakasz teljes tartalmát cseréld:

```markdown
## Hogyan marad ingyenes

A szintézis és a chat a **Groq ingyenes tierjén** fut. A szolgáltatási szerződése
tiltja, hogy a bemeneteden tanítson, hacsak kifejezetten nem engedélyezed — ezért
esett rá a választás egy egészség- és pénzügyi adatokat hordozó rendszerben.

Ha a Groq nem elérhető, rate limitel, vagy a szerződésen kívüli kimenetet ad, a
**template** renderelő veszi át — teljes tartalommal, LLM nélkül.

```
groq  →  template
 ingyenes   ingyenes, sosem bukik el
```

A fizetős `api` szintetizáló megvan, de **alapból ki van kapcsolva**, és a
`npm run smoke` ellenőrzi, hogy az is marad.

Az ingyenes tier 6 000 token/percet ad. Ezért megy a promptba előre kiszámolt,
tömör tény a nyers történet helyett — és ez amúgy is pontosabb, mert egy modell
nem számol megbízhatóan átlagot.
```

- [ ] **Step 2: Remove the wake schedule from the deploy guide**

`deploy/README.md` — töröld az egész **„5. Ébresztés 07:15-re"** szakaszt, és a
„Napi működés" táblázatot cseréld erre:

```markdown
## Napi működés

Nincs ütemezett brief. Te indítod, amikor kell:

| Ahogy kéred | Mi történik |
|---|---|
| `npm run brief` | A brief a terminálon, 15–25 másodperc alatt |
| Telegram `/brief` | Ugyanaz, gombokkal |
| `GET /api/morning-brief` | Ugyanaz, a telefonról vagy scriptből |

| Idő | Mi történik magától |
|---|---|
| 04:00 | Takarítás: lejárt cache és 21 napnál régebbi `seen_items` |

A launchd agent továbbra is fut, amíg a Mac be van kapcsolva — ettől elérhető a
Telegram bot és a HTTP API. **Nem ébreszti fel a gépet, és nem gyárt magától
briefet.**
```

Ha korábban beállítottad az ébresztést, vond vissza:

```bash
sudo pmset repeat cancel
```

- [ ] **Step 3: Narrow the Shortcut's job**

`shortcuts/README.md` — a fájl elejére, a cím alá:

```markdown
> **A Shortcut dolga leszűkült: csak adatot küld.** Nincs briefing-lekérés és
> nincs iOS értesítés — a briefet a Macen kéred, amikor kell. Az Apple Health
> adatoknak viszont nincs más forrása, ezért a 2. lépés (POST az
> `/api/ingest/health`-re) marad.
```

Töröld a **3. Briefing lekérése** és **4. Megjelenítés** lépéseket, valamint az
**Automation** szakaszt.

- [ ] **Step 4: Verify it live**

```bash
npm test && npm run typecheck && npm run smoke

launchctl kickstart -k gui/$(id -u)/local.jarvis.agent
sleep 6
tail -3 data/jarvis.log

# A brief most a Groq-on megy
npm run brief
```

Expected:
- a logban `scheduler started {cleanup: "0 4 * * *"}` — pre-warm és contactCheck nélkül
- a `brief ready` sorban `synthesizer: "groq"`, `demoted: []`
- `pmset -g sched` nem mutat ismétlődő eseményt

- [ ] **Step 5: Verify the fallback actually catches**

Ideiglenesen rontsd el a kulcsot, és nézd meg, hogy a brief attól még elkészül:

```bash
SYNTHESIS_CHAIN=groq,template GROQ_API_KEY=gsk-invalid npm run brief 2>&1 | tail -20
```

Expected: `synthesizer: "template"`, a `demoted` mezőben a Groq hibája. A brief
**tartalma teljes**.

- [ ] **Step 6: Verify the chat over Telegram**

Írj a botnak egy szabadszavas kérdést (nem parancsot), pl. *„részletezd a
pénzügyi részt"*. Expected: válasz érkezik, és a logban nincs hiba.

- [ ] **Step 7: Commit**

```bash
git add README.md deploy/README.md shortcuts/README.md
git commit -m "docs: no scheduled brief, Groq synthesis, Shortcut sends data only"
```

---

## Self-review

**Spec coverage**

| Spec szakasz | Task |
|---|---|
| `pmset` ébresztés visszavonása | 1 (8. lépés), 9 |
| Pre-warm cron eltávolítása | 1 |
| Kapcsolat-ellenőrzés, riasztás, `contacts` repo eltávolítása | 1 |
| `client_contact` tábla és 003 migráció megtartása | 1 (nincs `DROP`) |
| Kérés-log megtartása, a `contacts.record` kivétele a hookból | 1 |
| LaunchAgent `RunAtLoad`-dal marad | 1 (9. lépés ellenőrzi) |
| Éjszakai takarítás marad | 1 |
| Tailscale, ingest végpont, Telegram, napi brief marad | érintetlen — egyik task sem nyúl hozzájuk |
| Shortcut leszűkítése adatküldésre | 9 |
| `groq → template` lánc | 6 |
| Nincs új futásidejű függőség | 2 (a `Fetcher`-t használja) |
| `GROQ_API_KEY` a Kulcskarikában | 6 |
| `claude-code` kódja marad, env-vel előhívható | 6 (teszt rögzíti) |
| `api` tiltva marad | 7 |
| Chat ugyanazon a szolgáltatón | 5, 6 |
| Modell mérésre, négy szempont sorrendben | 8 |
| Lefokozás: hiba, 429, szerződésszegés | 2, 4 |
| Költség-őr szétválasztása | 7 |
| Tesztek hálózat nélkül | 2, 4, 5 (stub `Fetcher`) |

**Placeholder-ellenőrzés.** Minden lépés tényleges kódot vagy parancsot
tartalmaz. Ahol a terv nem tud döntést hozni — a nyerő modell id-je —, ott a
lépés **megmondja, honnan szerezd** (`npm run eval-models`), nem hagy üres helyet.

**Típus-konzisztencia.** `GROQ_CHAT_URL` · `GROQ_MODELS_URL` · `GROQ_KEY_VAR` ·
`groqComplete(fetcher, req)` · `GroqRequest` · `buildPrompt(ctx)` ·
`assertContract(markdown)` · `groqSynthesizer(opts)` · `groqChat(opts)` ·
`config.groq.{model,chatModel,maxTokens,chatMaxTokens,temperature,timeoutMs}`.
Mindegyik ugyanazzal a névvel szerepel a definíciójánál és a használatánál.

**Egy függőség, amit a végrehajtó lásson előre.** A Task 1 első lépése
`recordingLogger`-t és a `buildTestApp` `logger` opcióját használja. Ezeket az
**előző terv** (weboldal, Task 1) vezette volna be, ami nem futott le. Ha
hiányoznak, a Task 1 első lépése tartalmazza, mit kell pótolni — de ne lepődj
meg, hogy egy „teszt-megőrzés" lépés `test/helpers.ts`-t is módosít.

**Egy kockázat.** A Task 6 megváltoztatja az alapértelmezett láncot, tehát
`npm run brief` onnantól **valódi Groq-hívást** csinál. Amíg a kulcs nincs
eltárolva (Task 6, 5. lépés), a lánc template-re fokoz — ez nem hiba, de a
tesztelésnél tudni kell róla.
