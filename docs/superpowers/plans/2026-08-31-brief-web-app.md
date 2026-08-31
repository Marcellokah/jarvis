# Briefing weboldal — implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reggeli briefing kapjon saját, interaktív weboldalt a tailneten, az iOS értesítés pedig zsugorodjon rövid ébresztő-bökéssé.

**Architecture:** A `BriefService` érintetlen marad. A weboldal ugyanolyan vékony delivery-adapter, mint a Telegram: `GET /brief` szerver-oldalon renderelt HTML-t ad, a gombjai a **már meglévő** `/api/actions/*` végpontokat hívják, a chat mezője pedig egy új `POST /api/chat`-et, ami a meglévő `ChatService`-t szolgálja ki. Hitelesítés süti, ugyanazzal a titokkal, mint a bearer token.

**Tech Stack:** Node 24 (`node:sqlite`, natív TS futtatás), Fastify 5, zod, vitest. Új futásidejű függőség nincs.

## Global Constraints

- **Node `>=24`** (`package.json` engines). A projekt `.ts` fájlokat futtat közvetlenül, build-lépés nincs.
- **Nincs új futásidejű függőség.** A süti-kezelés kézzel írt (egyetlen fejléc, egyetlen név) — ne kerüljön be `@fastify/cookie`.
- **`npm test` induláskor 178 zöld teszt.** Minden task után zöldnek kell maradnia.
- **`npm run typecheck` mindig tiszta** (`tsc --noEmit`).
- **Tesztek hálózat nélkül futnak.** A meglévő `buildTestApp` harnesst és a `test/fixtures/` fájlokat használd.
- **A szintézis lánca soha nem tartalmazhat fizetős elemet.** A `npm run smoke` ezt kényszeríti; a Task 10 finomítja, de nem lazítja.
- **Felhasználónak szóló szöveg magyarul, kódkomment angolul** — ez a meglévő konvenció, tartsd.
- **A kommentek azt magyarázzák, hogy MIÉRT**, nem azt, hogy mit. A meglévő fájlok sűrűsége az irányadó.
- **Titok soha nem kerül logba, HTML-be vagy hibaüzenetbe.**

---

## File Structure

**Új fájlok**

| Fájl | Felelősség |
|---|---|
| `src/infra/db/migrations/004_note_and_conversations.sql` | `health_snapshots.note` oszlop + `conversations` index |
| `src/infra/db/repositories/conversations.ts` | Chat előzmény tárolása és mai napra szűrése |
| `src/delivery/http/routes/chat.ts` | `POST /api/chat` |
| `src/delivery/http/routes/page.ts` | `GET /brief` — süti beállítás, brief lekérés, HTML kiszolgálás |
| `src/delivery/http/page/render.ts` | Brief markdown + actions → HTML fragment |
| `src/delivery/http/page/document.ts` | A teljes HTML dokumentum: fej, CSS, kliens JS |
| `scripts/install-agent.sh` | A launchd plist behelyettesítése és telepítése |
| `deploy/local.jarvis.agent.plist.template` | A plist abszolút útvonalak nélkül |

**Módosított fájlok**

| Fájl | Változás |
|---|---|
| `src/env.ts` | `CLAUDE_BIN` default `homedir()`-ből |
| `src/core/renderer.ts` | `toSummary()` |
| `src/core/chat.ts` | `ask()` előzményt is kap |
| `src/delivery/http/auth.ts` | süti is elfogadható |
| `src/delivery/http/routes/brief.ts` | `format=short` |
| `src/delivery/http/routes/ingest.ts` | `note` mező |
| `src/delivery/http/server.ts` | új route-ok regisztrálása |
| `src/delivery/telegram/bot.ts` | a `chat.ask()` új szignatúrája + közös szál |
| `src/infra/db/repositories/health.ts` | `note` oszlop, külön `setNote()` |
| `src/modules/health-mealprep/index.ts` | a jegyzet megjelenítése |
| `src/infra/scheduler.ts` | `conversations` takarítása |
| `src/app.ts` | `conversations` repo kivezetése |
| `src/main.ts` | új függőségek bekötése |
| `scripts/smoke.ts` | cost guard szétválasztása |
| `.env.example`, `deploy/README.md`, `shortcuts/README.md` | dokumentáció |

**Eltérés a spectől, szándékosan:** a spec a `toHtml()`-t a `core/renderer.ts`-be tette. Az implementációban a HTML a delivery rétegbe kerül (`page/render.ts`), mert az action-azonosítókat és a modul-címeket ismernie kell — az pedig delivery-tudás, nem core. A `core/renderer.ts` marad tiszta markdown→szöveg transzformáció (`toPlainText`, `toTelegramHtml`, az új `toSummary`).

---

## Task 0: Repó-higiénia és git init

A terv minden további taskja commitol, de a projekt **még nem git repó**. Ez a task
teremti meg — és előtte kiszedi a bedrótozott felhasználónevet, hogy az ne
kerüljön bele a history első commitjába. Ugyanez a változtatás kell majd a Linux
migrációhoz is.

**Files:**
- Modify: `src/env.ts:19`
- Modify: `.env.example:40`
- Create: `deploy/local.jarvis.agent.plist.template`
- Create: `scripts/install-agent.sh`
- Delete: `deploy/local.jarvis.agent.plist`
- Test: `test/core/env.test.ts` (új)

**Interfaces:**
- Consumes: semmit
- Produces: `loadEnv()` `CLAUDE_BIN` mezője továbbra is `string`, de a defaultja a futtató felhasználó home-jából származik.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/env.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { loadEnv } from "../../src/env.ts";

/**
 * The default used to be an absolute path containing the developer's username.
 * That leaks into a public repository, and it makes the project unrunnable for
 * anyone else — including the Linux host this is destined for.
 */
describe("environment defaults", () => {
  it("derives the claude binary path from the running user's home", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.CLAUDE_BIN).toBe(`${homedir()}/.local/bin/claude`);
  });

  it("still lets the environment override it", () => {
    const env = loadEnv({ NODE_ENV: "test", CLAUDE_BIN: "/opt/claude/bin/claude" });
    expect(env.CLAUDE_BIN).toBe("/opt/claude/bin/claude");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/env.test.ts`
Expected: FAIL — az első teszt a bedrótozott abszolút útvonalat kapja vissza.

- [ ] **Step 3: Write minimal implementation**

`src/env.ts` — vedd fel az importot a fájl tetejére:

```typescript
import { homedir } from "node:os";
```

és cseréld a `CLAUDE_BIN` sorát erre:

```typescript
  /**
   * Where `claude setup-token` installs the CLI. Derived from the running
   * user's home rather than hardcoded: a literal path bakes one developer's
   * username into the repository and breaks every other machine, this
   * project's future Linux host included.
   */
  CLAUDE_BIN: z.string().default(`${homedir()}/.local/bin/claude`),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/env.test.ts`
Expected: PASS (2 teszt)

- [ ] **Step 5: Template the launchd plist**

Hozd létre a `deploy/local.jarvis.agent.plist.template` fájlt a meglévő
`deploy/local.jarvis.agent.plist` tartalmával, de **minden**
`__JARVIS_HOME__` előfordulást cserélj `__JARVIS_HOME__`-ra, és
a `PATH` értékében a `__USER_HOME__/.local/bin` részt `__USER_HOME__/.local/bin`-re.

Ezután töröld az eredetit:

```bash
rm deploy/local.jarvis.agent.plist
```

- [ ] **Step 6: Write the installer script**

Hozd létre a `scripts/install-agent.sh` fájlt:

```bash
#!/usr/bin/env bash
# Substitutes the machine-specific paths into the launchd plist and installs it.
#
# The plist needs absolute paths — launchd resolves nothing — but a checked-in
# absolute path is one developer's machine baked into the repository. The
# template plus this script keeps the repo portable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="local.jarvis.agent"
TARGET="$HOME/Library/LaunchAgents/${LABEL}.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__JARVIS_HOME__|${HERE}|g" \
    -e "s|__USER_HOME__|${HOME}|g" \
    "${HERE}/deploy/${LABEL}.plist.template" > "$TARGET"

echo "✓ ${TARGET}"

if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/${LABEL}"
fi
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "✓ agent running — tail -f ${HERE}/data/jarvis.log"
```

Tedd futtathatóvá:

```bash
chmod +x scripts/install-agent.sh
```

- [ ] **Step 7: Fix the .env.example comment**

A `.env.example` `# CLAUDE_BIN=__USER_HOME__/.local/bin/claude` sorát cseréld erre:

```
# CLAUDE_BIN=/home/jarvis/.local/bin/claude   # alapból: $HOME/.local/bin/claude
```

- [ ] **Step 8: Verify no personal paths remain**

Run:

```bash
grep -rn "almasimarcell" --include='*.ts' --include='*.md' --include='*.sh' --include='*.plist' --include='*.template' --include='*.example' --include='*.json' . | grep -v node_modules | grep -v package-lock
```

Expected: nincs találat.

- [ ] **Step 9: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: 180 teszt zöld, typecheck tiszta.

- [ ] **Step 10: Initialise the repository and commit**

```bash
git init
git add -A
git commit -m "chore: portable paths, templated launchd plist, initial commit"
```

> A `.gitignore` már kizárja a `.env`-et, a `data/*.db`-t és a `*.log`-ot — ellenőrizd a `git status`-szal, hogy egyik sem került be.

---

## Task 1: Értesítés-méretű összefoglaló (`format=short`)

**Files:**
- Modify: `src/core/renderer.ts`
- Modify: `src/delivery/http/routes/brief.ts`
- Test: `test/core/summary.test.ts` (új)

**Interfaces:**
- Consumes: semmit
- Produces: `toSummary(markdown: string, maxChars?: number): string` a `src/core/renderer.ts`-ből. A `GET /api/morning-brief?format=short` sima szöveget ad vissza.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/summary.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { toSummary } from "../../src/core/renderer.ts";

const BRIEF = [
  "# 2026. augusztus 31., hétfő",
  "",
  "## 🥦 Egészség & Meal Prep",
  "",
  "**Regeneráció:** jó — 7.8 óra alvás",
  "",
  "Mai étkezések:",
  "• Reggeli: Zabkása",
  "",
  "- [ ] Vedd ki a fagyasztóból: Marhapörkölt",
  "",
  "## 💰 Pénzügy & Előfizetések",
  "",
  "5 aktív előfizetés · 41 953 Ft/hó",
  "",
  "- [ ] Gym megújul holnap — 19 900 Ft",
  "",
  "## 🛠️ Fejlesztés & AI",
  "",
  "💡 Napi tipp: valami hasznos.",
].join("\n");

/**
 * An iOS notification shows roughly 200 characters before it truncates, and the
 * body cannot be tapped through to anything. So it carries the two things that
 * survive without a network: what your recovery looks like, and what you have
 * to actually do today.
 */
describe("toSummary", () => {
  it("leads with the first section's opening line", () => {
    expect(toSummary(BRIEF)).toContain("Regeneráció: jó — 7.8 óra alvás");
  });

  it("carries every open todo, because those are the actionable part", () => {
    const out = toSummary(BRIEF);
    expect(out).toContain("☐ Vedd ki a fagyasztóból: Marhapörkölt");
    expect(out).toContain("☐ Gym megújul holnap — 19 900 Ft");
  });

  it("counts the sections it left behind", () => {
    expect(toSummary(BRIEF)).toContain("+2 szekció");
  });

  it("strips markdown emphasis — iOS renders none of it", () => {
    expect(toSummary(BRIEF)).not.toContain("**");
  });

  it("stays inside the notification's budget", () => {
    expect(toSummary(BRIEF).length).toBeLessThanOrEqual(200);
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const long = ["# nap", "", "## A", "", "x".repeat(50) + " " + "y".repeat(400)].join("\n");
    const out = toSummary(long, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles a brief with nothing to do", () => {
    const quiet = ["# nap", "", "## A", "", "Semmi teendő ma."].join("\n");
    const out = toSummary(quiet);
    expect(out).toContain("Semmi teendő ma.");
    expect(out).not.toContain("☐");
    expect(out).not.toContain("szekció");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/summary.test.ts`
Expected: FAIL — `toSummary is not a function`.

- [ ] **Step 3: Write minimal implementation**

Told hozzá a `src/core/renderer.ts` végéhez:

```typescript
/**
 * The notification-sized brief.
 *
 * An iOS notification truncates around 200 characters and its body cannot link
 * anywhere — tapping it opens the Shortcuts app, not a URL. So this is not a
 * shortened brief, it is a different artefact: the recovery line and every open
 * todo, which are the parts that have to survive without a network. The rest
 * lives on the web page, one tap away.
 */
export function toSummary(markdown: string, maxChars = 200): string {
  const lines = markdown.split("\n");

  const sectionCount = lines.filter((l) => l.startsWith("## ")).length;
  const todos = lines
    .filter((l) => l.startsWith("- [ ] "))
    .map((l) => `☐ ${plain(l.slice(6))}`);

  // The first section is the critical one — the runner sorts them that way —
  // so its opening prose line is the most useful thing to lead with.
  const firstHeading = lines.findIndex((l) => l.startsWith("## "));
  const lead = firstHeading === -1
    ? ""
    : plain(
      lines.slice(firstHeading + 1).find((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("#") && !t.startsWith("-") && !t.startsWith("•");
      }) ?? "",
    );

  const parts = [lead, ...todos].filter((p) => p !== "");
  if (sectionCount > 1) parts.push(`+${sectionCount - 1} szekció`);

  return clamp(parts.join("\n"), maxChars);
}

/** Markdown emphasis is noise in a notification: iOS renders none of it. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/[*_`]/g, "").trim();
}

function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > maxChars * 0.5 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/summary.test.ts`
Expected: PASS (7 teszt)

- [ ] **Step 5: Wire the format into the route**

`src/delivery/http/routes/brief.ts` — az importot bővítsd:

```typescript
import { toPlainText, toSummary } from "../../../core/renderer.ts";
```

a `query` sémában a `format` sorát cseréld:

```typescript
  format: z.enum(["text", "md", "json", "short"]).default("text"),
```

és a válasz-összeállítást a `json` ág után:

```typescript
    const body = format === "md"
      ? brief.markdown
      : format === "short"
        ? toSummary(brief.markdown)
        : toPlainText(brief.markdown);
```

- [ ] **Step 6: Test the route end to end**

Told hozzá a `test/core/http.test.ts` `describe("GET /api/morning-brief")` blokkjához:

```typescript
  it("serves a notification-sized summary", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief?format=short", headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body.length).toBeLessThanOrEqual(200);
  });
```

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: 188 teszt zöld, typecheck tiszta.

- [ ] **Step 8: Commit**

```bash
git add src/core/renderer.ts src/delivery/http/routes/brief.ts test/core/summary.test.ts test/core/http.test.ts
git commit -m "feat: notification-sized brief summary (format=short)"
```

---

## Task 2: Süti-hitelesítés a bearer token mellé

Egy böngészőoldal nem tud `Authorization` fejlécet akasztani a saját
navigációjára. Az oldalt egyszer megnyitod `?token=`-nel, onnantól sütit visz.
Ugyanaz a titok, másik boríték.

**Files:**
- Modify: `src/delivery/http/auth.ts`
- Modify: `src/delivery/http/server.ts:39-42`
- Test: `test/core/http.test.ts` (`describe("auth")` blokk bővítése)

**Interfaces:**
- Consumes: semmit
- Produces: `AUTH_COOKIE: string`, `tokenAuth(token: string)` hook-gyár (a `bearerAuth` helyett), `authCookie(token: string): string` Set-Cookie értéket adó függvény. Mind a `src/delivery/http/auth.ts`-ből.

- [ ] **Step 1: Write the failing test**

Told hozzá a `test/core/http.test.ts` `describe("auth")` blokkjához:

```typescript
  it("accepts the session cookie the web page carries", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief",
      headers: { cookie: `jarvis_token=${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong cookie", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief",
      headers: { cookie: "jarvis_token=nope-nope-nope-0123456789" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("ignores unrelated cookies sitting alongside it", async () => {
    const res = await app.server.inject({
      method: "GET", url: "/api/morning-brief",
      headers: { cookie: `theme=dark; jarvis_token=${TEST_TOKEN}; other=1` },
    });
    expect(res.statusCode).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/http.test.ts -t "cookie"`
Expected: FAIL — 401, mert a hook csak a fejlécet nézi.

- [ ] **Step 3: Write minimal implementation**

Cseréld a `src/delivery/http/auth.ts` teljes tartalmát:

```typescript
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

/** The cookie the web page carries once it has been opened with a token once. */
export const AUTH_COOKIE = "jarvis_token";

/** Hash both sides so timingSafeEqual always gets equal-length buffers. */
function matches(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The credential, from wherever this client can carry one.
 *
 * A browser cannot attach an Authorization header to its own navigation, so
 * the page is opened once with `?token=` and thereafter presents a cookie.
 * Same secret either way — the tailnet remains the outer perimeter and this
 * is the inner one.
 */
export function credentialFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();

  const cookie = request.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== AUTH_COOKIE) continue;
    return decodeURIComponent(trimmed.slice(eq + 1)).trim();
  }
  return null;
}

export function tokenAuth(token: string) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const provided = credentialFrom(request);

    if (!provided || !matches(provided, token)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}

/**
 * Long-lived on purpose: the home-screen icon opens a token-less URL, and
 * re-authenticating every morning would defeat the point of the shortcut.
 */
export function authCookie(token: string): string {
  return [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=31536000",
  ].join("; ");
}
```

- [ ] **Step 4: Update the server's import and call site**

`src/delivery/http/server.ts` — az import sorát:

```typescript
import { tokenAuth } from "./auth.ts";
```

és a hook fölötti sort:

```typescript
  const auth = tokenAuth(deps.token);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: 191 teszt zöld, typecheck tiszta.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/auth.ts src/delivery/http/server.ts test/core/http.test.ts
git commit -m "feat: accept a session cookie alongside the bearer token"
```

---

## Task 3: A napi jegyzet (`note`)

Szabad szöveg, amit **te** írsz („ma törve vagyok"), és amit a szintetizáló
ténymezőként lát. Nem írja felül a mért számokat — a chat magyaráz, a
strukturált vezérlők írnak.

**Files:**
- Create: `src/infra/db/migrations/004_health_note.sql`
- Modify: `src/infra/db/repositories/health.ts`
- Modify: `src/delivery/http/routes/ingest.ts`
- Modify: `src/modules/health-mealprep/index.ts`
- Test: `test/core/http.test.ts`, `test/modules/health-mealprep.test.ts`

**Interfaces:**
- Consumes: semmit
- Produces: `HealthSnapshot.note: string | null`; `HealthRepo.setNote(date: string, note: string | null, now: Date): void`. A `POST /api/ingest/health` elfogad egy `note` mezőt.

- [ ] **Step 1: Write the failing test**

Told hozzá a `test/core/http.test.ts` `describe("POST /api/ingest/health")` blokkjához:

```typescript
  it("stores a note and shows it in the brief", async () => {
    const res = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { note: "Ma törve vagyok, húzza a hátam." },
    });
    expect(res.statusCode).toBe(202);

    const brief = await app.server.inject({ method: "GET", url: "/api/morning-brief", headers: auth });
    expect(brief.body).toContain("Ma törve vagyok");
  });

  it("keeps the note when a later measurement POST omits it", async () => {
    // The Shortcut re-runs without a note all the time; that must not erase
    // what you wrote by hand an hour earlier.
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: { note: "megmarad" },
    });
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: { hrv: 70 },
    });

    expect(app.health.forDate("2026-08-31")?.note).toBe("megmarad");
  });

  it("clears the note when an empty one is sent deliberately", async () => {
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: { note: "átmeneti" },
    });
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth, payload: { note: "" },
    });

    expect(app.health.forDate("2026-08-31")?.note).toBeNull();
  });

  it("never lets a note stand in for a measurement", async () => {
    await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: auth,
      payload: { note: "nyolc órát aludtam" },
    });
    expect(app.health.forDate("2026-08-31")?.sleepH).toBeNull();
  });
```

> A `MONDAY` konstans `2026-08-31T06:20:00+02:00`, tehát a helyi dátum `2026-08-31`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/http.test.ts -t "note"`
Expected: FAIL — nincs `note` oszlop, a mező elveszik.

- [ ] **Step 3: Write the migration**

Hozd létre a `src/infra/db/migrations/004_health_note.sql` fájlt:

```sql
-- What you say about your own day, in your own words.
--
-- The measurements answer "what was recorded"; this answers "how are you".
-- They are deliberately separate columns: a sentence you type must never be
-- able to overwrite a number, because baseline() reads those numbers back on
-- later days and a misread sentence would poison tomorrow's starting point too.
ALTER TABLE health_snapshots ADD COLUMN note TEXT;
```

- [ ] **Step 4: Extend the health repository**

`src/infra/db/repositories/health.ts` — bővítsd a típusokat:

```typescript
export interface HealthSnapshot {
  date: string;
  sleepH: number | null;
  hrv: number | null;
  rhr: number | null;
  moveKcal: number | null;
  exerciseMin: number | null;
  steps: number | null;
  /** Free text the user wrote about the day. Never derived, never inferred. */
  note: string | null;
}
```

a `Row` interfészt egészítsd ki `note: string | null;`-lal, a `toSnapshot`-ot
`note: r.note,`-tal, a `HealthRepo` interfészt pedig ezzel:

```typescript
  /**
   * Separate from `upsert` on purpose: a measurement POST must leave the note
   * alone, and writing a note must not require restating the measurements.
   */
  setNote(date: string, note: string | null, now: Date): void;
```

és told hozzá az implementációt az `upsert` után:

```typescript
    setNote(date, note, now) {
      db.run(
        `INSERT INTO health_snapshots (date, note, ingested_at)
         VALUES (?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET note = excluded.note`,
        date, note, now.toISOString(),
      );
    },
```

> Az `upsert` SQL-jéhez **ne** nyúlj: a `note` nincs benne sem a beszúrt oszlopok,
> sem az `ON CONFLICT ... SET` listájában, tehát egy mérés-POST magától békén hagyja.

- [ ] **Step 5: Accept the note in the ingest route**

`src/delivery/http/routes/ingest.ts` — a `readSnapshot` **fölé** vedd fel:

```typescript
/** Long enough for a sentence or three; a wall of text is not a daily note. */
const noteField = z.string().max(500);
```

és a `deps.health.upsert(...)` hívás **után**, a `regenerate` **elé** told be:

```typescript
    // Only when the client actually sent the field. Absent means "leave it as
    // it was" — the Shortcut re-runs without a note all morning. An empty
    // string is the deliberate way to clear one.
    if (fields.note !== undefined) {
      const parsed = noteField.safeParse(fields.note);
      if (!parsed.success) {
        ignored.push({ field: "note", reason: parsed.error.issues[0]?.message ?? "érvénytelen" });
      } else {
        const trimmed = parsed.data.trim();
        deps.health.setNote(date, trimmed === "" ? null : trimmed, now);
        if (trimmed !== "") accepted.push("note" as never);
      }
    }
```

- [ ] **Step 6: Surface it in the module**

`src/modules/health-mealprep/index.ts` — a `renderPlain` `if (health)` blokkjában,
a `readiness` sor **után** told be:

```typescript
        if (health.note) lines.push(`**Jegyzeted:** ${health.note}`);
```

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run typecheck`
Expected: 195 teszt zöld, typecheck tiszta. Ha egy meglévő health-teszt elbukik
azért, mert a `HealthSnapshot` most `note` mezőt is vár, told bele `note: null`-t
a teszt fixtúrába.

- [ ] **Step 8: Commit**

```bash
git add src/infra/db/migrations/004_health_note.sql src/infra/db/repositories/health.ts src/delivery/http/routes/ingest.ts src/modules/health-mealprep/index.ts test/
git commit -m "feat: a daily note that never overwrites a measurement"
```

---

## Task 4: Beszélgetés-előzmény tárolása

A `conversations` tábla a 002-es migráció óta létezik, és **soha senki nem írta
vagy olvasta.** Most kap gazdát — és mindjárt úgy, hogy a weboldal és a Telegram
ugyanazt a szálat használja.

**Files:**
- Create: `src/infra/db/repositories/conversations.ts`
- Modify: `src/core/chat.ts` (csak a `ChatTurn` típus)
- Test: `test/core/conversations.test.ts` (új)

**Interfaces:**
- Consumes: semmit
- Produces: `ChatTurn { role: "user" | "assistant"; content: string }` a `src/core/chat.ts`-ből; `createConversationRepo(db: Db): ConversationRepo` a `src/infra/db/repositories/conversations.ts`-ből, `append(threadId, role, content, at)`, `recent(threadId, on, limit, tz)`, `prune(before)` metódusokkal; `THREAD_ID: string` konstans.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/conversations.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";
import { TZ } from "../../src/shared/dates.ts";

const THREAD = "jarvis";

describe("conversation history", () => {
  it("returns turns oldest first, the order a model expects", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.append(THREAD, "user", "első", new Date("2026-09-04T06:00:00Z"));
    repo.append(THREAD, "assistant", "válasz", new Date("2026-09-04T06:00:05Z"));
    repo.append(THREAD, "user", "második", new Date("2026-09-04T06:01:00Z"));

    const turns = repo.recent(THREAD, "2026-09-04", 10, TZ);
    expect(turns.map((t) => t.content)).toEqual(["első", "válasz", "második"]);
    db.close();
  });

  it("keeps the thread to today — yesterday's brief is not this brief", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.append(THREAD, "user", "tegnapi", new Date("2026-09-03T06:00:00Z"));
    repo.append(THREAD, "user", "mai", new Date("2026-09-04T06:00:00Z"));

    expect(repo.recent(THREAD, "2026-09-04", 10, TZ).map((t) => t.content)).toEqual(["mai"]);
    db.close();
  });

  it("judges the day in Budapest, not UTC", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    // 00:30 on the 4th in Budapest is still 22:30 on the 3rd in UTC.
    repo.append(THREAD, "user", "éjfél után", new Date("2026-09-03T22:30:00Z"));

    expect(repo.recent(THREAD, "2026-09-04", 10, TZ)).toHaveLength(1);
    db.close();
  });

  it("keeps only the last N turns, so the prompt cannot grow without bound", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    for (let i = 0; i < 30; i++) {
      repo.append(THREAD, "user", `q${i}`, new Date(`2026-09-04T06:${String(i).padStart(2, "0")}:00Z`));
    }

    const turns = repo.recent(THREAD, "2026-09-04", 5, TZ);
    expect(turns).toHaveLength(5);
    expect(turns.map((t) => t.content)).toEqual(["q25", "q26", "q27", "q28", "q29"]);
    db.close();
  });

  it("does not mix threads", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.append("a", "user", "enyém", new Date("2026-09-04T06:00:00Z"));
    repo.append("b", "user", "másé", new Date("2026-09-04T06:00:01Z"));

    expect(repo.recent("a", "2026-09-04", 10, TZ).map((t) => t.content)).toEqual(["enyém"]);
    db.close();
  });

  it("prunes what is older than the cutoff", () => {
    const db = memoryDb();
    const repo = createConversationRepo(db);

    repo.append(THREAD, "user", "régi", new Date("2026-08-01T06:00:00Z"));
    repo.append(THREAD, "user", "friss", new Date("2026-09-04T06:00:00Z"));

    expect(repo.prune(new Date("2026-09-01T00:00:00Z"))).toBe(1);
    expect(repo.recent(THREAD, "2026-09-04", 10, TZ)).toHaveLength(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/conversations.test.ts`
Expected: FAIL — `Failed to load url .../conversations.ts`.

- [ ] **Step 3: Add the shared turn type**

`src/core/chat.ts` — told a `ChatService` interfész **fölé**:

```typescript
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * One thread, shared by every surface.
 *
 * This is a single-person system, so there is nothing to key conversations by
 * — and keeping one id means a question asked on the web page in the morning
 * can be followed up in Telegram in the afternoon.
 */
export const THREAD_ID = "jarvis";
```

- [ ] **Step 4: Write the repository**

Hozd létre a `src/infra/db/repositories/conversations.ts` fájlt:

```typescript
import type { Db } from "../index.ts";
import type { ChatTurn } from "../../../core/chat.ts";
import { isoDate } from "../../../shared/dates.ts";

export interface ConversationRepo {
  append(threadId: string, role: ChatTurn["role"], content: string, at: Date): void;
  /** Today's turns, oldest first, capped at `limit`. */
  recent(threadId: string, on: string, limit: number, tz: string): ChatTurn[];
  /** Drops turns older than `before`. Returns how many went. */
  prune(before: Date): number;
}

/**
 * The `conversations` table has existed since migration 002 and nothing ever
 * wrote to it — chat was single-turn, with today's brief as its only context.
 * That answered "explain the finance section" but lost the thread on "and the
 * other one?".
 */
export function createConversationRepo(db: Db): ConversationRepo {
  return {
    append(threadId, role, content, at) {
      db.run(
        "INSERT INTO conversations (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        threadId, role, content, at.toISOString(),
      );
    },

    recent(threadId, on, limit, tz) {
      // Filtering by local day in SQL would mean storing an offset column;
      // reading a bounded window and filtering here keeps the schema as it is.
      // The window is generous because a day's turns are counted in dozens.
      const rows = db.all<{ role: ChatTurn["role"]; content: string; created_at: string }>(
        "SELECT role, content, created_at FROM conversations WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?",
        threadId, Math.max(limit * 4, 100),
      );

      return rows
        .filter((r) => isoDate(new Date(r.created_at), tz) === on)
        .slice(0, limit)
        .reverse()
        .map((r) => ({ role: r.role, content: r.content }));
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

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/core/conversations.test.ts`
Expected: PASS (6 teszt)

- [ ] **Step 6: Commit**

```bash
git add src/core/chat.ts src/infra/db/repositories/conversations.ts test/core/conversations.test.ts
git commit -m "feat: conversation history store, wiring up a table that was never used"
```

---

## Task 5: A chat kapjon előzményt

**Files:**
- Modify: `src/core/chat.ts`
- Modify: `config/config.ts` (`chat.historyTurns`)
- Modify: `src/delivery/telegram/bot.ts`
- Modify: `src/main.ts`, `src/app.ts`
- Test: `test/core/chat-history.test.ts` (új)

**Interfaces:**
- Consumes: `ChatTurn`, `THREAD_ID` (Task 4), `createConversationRepo` (Task 4)
- Produces: `ChatService.ask(question: string, briefMarkdown: string, history: readonly ChatTurn[], signal: AbortSignal): Promise<string>` — **megváltozott szignatúra**. `App.conversations: ConversationRepo`. `config.chat.historyTurns: number`.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/chat-history.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { claudeChat } from "../../src/core/chat.ts";
import { silentLogger } from "../../src/infra/logger.ts";

const bin = (name: string) => resolve("test/fixtures/bin", name);
const signal = new AbortController().signal;

function chat(name: string) {
  return claudeChat({
    bin: bin(name),
    model: "haiku",
    systemPromptFile: "./jarvis.md",
    timeoutMs: 5_000,
    logger: silentLogger(),
  });
}

/**
 * Chat used to be single-turn: today's brief was the only context, so
 * "explain the finance section" worked and "and the other one?" did not.
 */
describe("chat history", () => {
  it("puts earlier turns in the prompt", async () => {
    const out = await chat("claude-echoes-stdin").ask(
      "és a másikat?",
      "# brief\n\n## 💰 Pénzügy\n\nvalami",
      [
        { role: "user", content: "részletezd a pénzügyi részt" },
        { role: "assistant", content: "Két előfizetés újul meg." },
      ],
      signal,
    );

    expect(out).toContain("részletezd a pénzügyi részt");
    expect(out).toContain("Két előfizetés újul meg.");
    expect(out).toContain("és a másikat?");
  });

  it("works with no history at all", async () => {
    const out = await chat("claude-echoes-stdin").ask(
      "mi ez?", "# brief\n\n## A\n\nvalami", [], signal,
    );
    expect(out).toContain("mi ez?");
  });
});
```

- [ ] **Step 2: Add the stdin-echoing fixture**

Hozd létre a `test/fixtures/bin/claude-echoes-stdin` fájlt:

```sh
#!/bin/sh
# Echoes the prompt back so a test can assert what the model was actually told.
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"oauth"}'; exit 0; fi
STDIN=$(cat)
printf '{"is_error":false,"result":%s}' "$(printf '%s' "$STDIN" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
```

Tedd futtathatóvá:

```bash
chmod +x test/fixtures/bin/claude-echoes-stdin
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/chat-history.test.ts`
Expected: FAIL — az `ask` négy helyett három argumentumot vár, a typecheck is panaszkodik.

- [ ] **Step 4: Change the ChatService signature**

`src/core/chat.ts` — az interfészben:

```typescript
export interface ChatService {
  available(): Promise<boolean>;
  /** Answers a follow-up with today's brief and the thread so far as context. */
  ask(
    question: string,
    briefMarkdown: string,
    history: readonly ChatTurn[],
    signal: AbortSignal,
  ): Promise<string>;
}
```

és az implementációban az `ask` prompt-építését:

```typescript
    async ask(question, briefMarkdown, history, signal) {
      const prompt = [
        "A mai briefing:",
        "",
        briefMarkdown,
        ...(history.length > 0
          ? [
            "",
            "---",
            "",
            "Az eddigi beszélgetés:",
            "",
            ...history.map((t) => `${t.role === "user" ? "Kérdés" : "Válasz"}: ${t.content}`),
          ]
          : []),
        "",
        "---",
        "",
        "A felhasználó kérdése ehhez kapcsolódóan:",
        question,
        "",
        "Válaszolj tömören, magyarul, a persona szerint. Ha a kérdés nem a briefingről szól,",
        "attól még válaszolj — de ne találj ki tényeket a fenti adatokon túl.",
      ].join("\n");
```

- [ ] **Step 5: Add the history window to config**

`config/config.ts` — a `chat` blokkba, a `timeoutMs` mellé:

```typescript
    /**
     * How many earlier turns go into the prompt. Enough to hold a morning's
     * back-and-forth, small enough that the prompt cannot grow without bound.
     */
    historyTurns: 20,
```

- [ ] **Step 6: Expose the repository from the composition root**

`src/app.ts`:

```typescript
import { createConversationRepo, type ConversationRepo } from "./infra/db/repositories/conversations.ts";
```

az `App` interfészbe a `health` mellé:

```typescript
  conversations: ConversationRepo;
```

a `createApp` törzsébe a `const contacts = ...` mellé:

```typescript
  const conversations = createConversationRepo(db);
```

és a visszatérési objektumba a `contacts` mellé `conversations`.

- [ ] **Step 7: Update the Telegram call site**

`src/delivery/telegram/bot.ts` — az importokhoz:

```typescript
import { THREAD_ID } from "../../core/chat.ts";
import type { ConversationRepo } from "../../infra/db/repositories/conversations.ts";
import { config } from "../../../config/config.ts";
import { isoDate, TZ } from "../../shared/dates.ts";
```

a `TelegramOptions` interfészbe:

```typescript
  conversations: ConversationRepo;
```

és a `const answer = await opts.chat.ask(...)` sort cseréld erre:

```typescript
      const now = opts.clock.now();
      const history = opts.conversations.recent(
        THREAD_ID, isoDate(now, TZ), config.chat.historyTurns, TZ,
      );
      const answer = await opts.chat.ask(question, brief.markdown, history, controller.signal);
      opts.conversations.append(THREAD_ID, "user", question, now);
      opts.conversations.append(THREAD_ID, "assistant", answer, opts.clock.now());
```

`src/main.ts` — a `buildBot({...})` hívásba told be:

```typescript
      conversations: app.conversations,
```

- [ ] **Step 8: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: minden zöld. Ha egy meglévő Telegram-teszt a régi `ask` szignatúrával
hívja a stubot, igazítsd hozzá (a `history` paraméter a harmadik).

- [ ] **Step 9: Commit**

```bash
git add src/core/chat.ts config/config.ts src/app.ts src/main.ts src/delivery/telegram/bot.ts test/
git commit -m "feat: chat remembers the thread, shared across surfaces"
```

---

## Task 6: `POST /api/chat`

**Files:**
- Create: `src/delivery/http/routes/chat.ts`
- Modify: `src/delivery/http/server.ts`
- Modify: `test/helpers.ts`
- Test: `test/core/chat-route.test.ts` (új)

**Interfaces:**
- Consumes: `ChatService`, `ConversationRepo`, `THREAD_ID`, `config.chat.historyTurns`
- Produces: `registerChatRoutes(app, deps)`. A `POST /api/chat` `{ question }` törzset vár és `{ answer }`-t ad vissza.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/chat-route.test.ts` fájlt:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, stubModule, TEST_TOKEN, type TestApp } from "../helpers.ts";

let app: TestApp | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const boot = () => buildTestApp({
  modules: [stubModule({ name: "M" })],
  now: "2026-08-31T06:20:00+02:00",
  chat: {
    available: async () => true,
    ask: async (question, _brief, history) =>
      `kérdés=${question} előzmény=${history.length}`,
  },
});

describe("POST /api/chat", () => {
  it("answers and records both sides of the exchange", async () => {
    app = await boot();

    const res = await app.server.inject({
      method: "POST", url: "/api/chat", headers: auth, payload: { question: "mi ez?" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ answer: "kérdés=mi ez? előzmény=0" });

    const turns = app.conversations.recent("jarvis", "2026-08-31", 10, "Europe/Budapest");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("feeds the previous turns back on the next question", async () => {
    app = await boot();
    const ask = (question: string) => app!.server.inject({
      method: "POST", url: "/api/chat", headers: auth, payload: { question },
    });

    await ask("első");
    const second = await ask("második");

    expect(second.json()).toMatchObject({ answer: "kérdés=második előzmény=2" });
  });

  it("rejects an empty question rather than spending a model call on it", async () => {
    app = await boot();
    const res = await app.server.inject({
      method: "POST", url: "/api/chat", headers: auth, payload: { question: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("needs a credential like every other /api route", async () => {
    app = await boot();
    const res = await app.server.inject({
      method: "POST", url: "/api/chat", payload: { question: "mi ez?" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("says so plainly when no model is reachable", async () => {
    app = await buildTestApp({
      modules: [stubModule({ name: "M" })],
      now: "2026-08-31T06:20:00+02:00",
      chat: { available: async () => false, ask: async () => "soha" },
    });

    const res = await app.server.inject({
      method: "POST", url: "/api/chat", headers: auth, payload: { question: "mi ez?" },
    });

    expect(res.statusCode).toBe(503);
    expect(String(res.json().message)).toContain("nem érhető el");
  });
});
```

- [ ] **Step 2: Let the harness take a chat stub**

`test/helpers.ts` — az importokhoz:

```typescript
import type { ChatService } from "../src/core/chat.ts";
import { createConversationRepo, type ConversationRepo } from "../src/infra/db/repositories/conversations.ts";
```

a `TestApp` interfészbe:

```typescript
  conversations: ConversationRepo;
```

a `buildTestApp` opciókhoz:

```typescript
  chat?: ChatService;
```

a törzsébe a `contacts` mellé:

```typescript
  const conversations = createConversationRepo(db);
  const chat: ChatService = options.chat ?? {
    available: async () => false,
    ask: async () => { throw new Error("no chat in this test"); },
  };
```

a `buildServer({...})` hívásba `chat, conversations,`, a visszatérési objektumba `conversations,`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/chat-route.test.ts`
Expected: FAIL — 404, nincs ilyen route.

- [ ] **Step 4: Write the route**

Hozd létre a `src/delivery/http/routes/chat.ts` fájlt:

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { ChatService } from "../../../core/chat.ts";
import { THREAD_ID } from "../../../core/chat.ts";
import type { ConversationRepo } from "../../../infra/db/repositories/conversations.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";
import { isoDate, TZ } from "../../../shared/dates.ts";
import { config } from "../../../../config/config.ts";

const body = z.object({
  question: z.string().trim().min(1).max(1_000),
});

export function registerChatRoutes(
  app: FastifyInstance,
  deps: {
    briefs: BriefService;
    chat: ChatService;
    conversations: ConversationRepo;
    clock: Clock;
    logger: Logger;
  },
): void {
  app.post("/api/chat", async (request, reply) => {
    const parsed = body.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", issues: parsed.error.issues });
    }
    const question = parsed.data.question;

    // Checked before spending a subprocess on a doomed run — and before
    // recording a question that will never get an answer.
    if (!(await deps.chat.available())) {
      return reply.code(503).send({
        error: "chat_unavailable",
        message: "A chat most nem érhető el. A briefing és a teendők attól még működnek.",
      });
    }

    const now = deps.clock.now();
    const day = isoDate(now, TZ);

    // wait: false — the page opens against the pre-warmed brief; a chat question
    // must not be what triggers a 25-second generation.
    const brief = await deps.briefs.get(now, { wait: false });
    const history = deps.conversations.recent(THREAD_ID, day, config.chat.historyTurns, TZ);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.chat.timeoutMs);
    try {
      const answer = await deps.chat.ask(question, brief.markdown, history, controller.signal);
      deps.conversations.append(THREAD_ID, "user", question, now);
      deps.conversations.append(THREAD_ID, "assistant", answer, deps.clock.now());
      return reply.send({ answer });
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "chat failed");
      return reply.code(502).send({
        error: "chat_failed",
        message: "Nem sikerült választ kapni. Próbáld újra.",
      });
    } finally {
      clearTimeout(timer);
    }
  });
}
```

- [ ] **Step 5: Register it**

`src/delivery/http/server.ts` — az importokhoz `import { registerChatRoutes } from "./routes/chat.ts";`, a `ServerDeps`-be `chat: ChatService;` és `conversations: ConversationRepo;` (a típusokat is importáld), a route-regisztrációk közé:

```typescript
  registerChatRoutes(app, {
    briefs: deps.briefs, chat: deps.chat, conversations: deps.conversations,
    clock: deps.clock, logger: deps.logger,
  });
```

`src/main.ts` — a `buildServer({...})` hívásba: `chat: app.chat,` és `conversations: app.conversations,`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 7: Commit**

```bash
git add src/delivery/http/routes/chat.ts src/delivery/http/server.ts src/main.ts test/
git commit -m "feat: POST /api/chat"
```

---

## Task 7: Brief markdown → HTML fragment

A teendők **nem** a markdownból jönnek. A markdown csak a szöveget hordozza, az
azonosítót nem — a `- [ ] ` sorokat ezért kihagyjuk, és a vezérlőket a
`brief.actions`-ből építjük, modul-cím alapján a szekciójukhoz rendelve.

**Files:**
- Create: `src/delivery/http/page/render.ts`
- Test: `test/core/page-render.test.ts` (új)

**Interfaces:**
- Consumes: `StoredAction` (`src/infra/db/repositories/actions.ts`), `JarvisModule` (`src/core/module.ts`)
- Produces: `renderBriefHtml(markdown: string, actions: readonly StoredAction[], modules: readonly JarvisModule[]): string`

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/page-render.test.ts` fájlt:

```typescript
import { describe, it, expect } from "vitest";
import { renderBriefHtml } from "../../src/delivery/http/page/render.ts";
import { stubModule } from "../helpers.ts";
import type { StoredAction } from "../../src/infra/db/repositories/actions.ts";

const MODULES = [
  stubModule({ name: "Health", title: "🥦 Egészség" }),
  stubModule({ name: "Finance", title: "💰 Pénzügy" }),
];

const MARKDOWN = [
  "# 2026. augusztus 31., hétfő",
  "",
  "## 🥦 Egészség",
  "",
  "**Regeneráció:** jó",
  "",
  "• Reggeli: Zabkása",
  "• Ebéd: Csirke",
  "",
  "- [ ] Vedd ki a fagyasztóból",
  "",
  "## 💰 Pénzügy",
  "",
  "5 aktív előfizetés",
].join("\n");

const action = (p: Partial<StoredAction> & Pick<StoredAction, "id" | "module" | "kind" | "text">) =>
  ({ date: "2026-08-31", status: "open", ...p }) as StoredAction;

describe("renderBriefHtml", () => {
  it("renders one card per section, titled verbatim", () => {
    const html = renderBriefHtml(MARKDOWN, [], MODULES);
    expect(html).toContain("<h2>🥦 Egészség</h2>");
    expect(html).toContain("<h2>💰 Pénzügy</h2>");
    expect((html.match(/<section class="card">/g) ?? []).length).toBe(2);
  });

  it("turns bullets into a list and emphasis into strong", () => {
    const html = renderBriefHtml(MARKDOWN, [], MODULES);
    expect(html).toContain("<li>Reggeli: Zabkása</li>");
    expect(html).toContain("<strong>Regeneráció:</strong>");
  });

  it("drops the markdown todo lines — the controls replace them", () => {
    const html = renderBriefHtml(MARKDOWN, [], MODULES);
    expect(html).not.toContain("- [ ]");
    expect(html).not.toContain("Vedd ki a fagyasztóból");
  });

  it("renders a checkbox carrying the action id, inside its own section", () => {
    const html = renderBriefHtml(MARKDOWN, [
      action({ id: "a1", module: "Health", kind: "checkbox", text: "Vedd ki a húst" }),
    ], MODULES);

    expect(html).toContain('data-done="a1"');
    const health = html.slice(html.indexOf("🥦 Egészség"), html.indexOf("💰 Pénzügy"));
    expect(health).toContain("Vedd ki a húst");
  });

  it("renders both buttons for a proposal", () => {
    const html = renderBriefHtml(MARKDOWN, [
      action({ id: "p1", module: "Finance", kind: "proposal", text: "Mondd le a Netflixet" }),
    ], MODULES);

    expect(html).toContain('data-accept="p1"');
    expect(html).toContain('data-decline="p1"');
    expect(html).toContain("Elfogadom");
    expect(html).toContain("Elvetem");
  });

  it("escapes anything that could close a tag", () => {
    const nasty = ["# nap", "", "## 🥦 Egészség", "", "<script>alert(1)</script> & \"x\""].join("\n");
    const html = renderBriefHtml(nasty, [], MODULES);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("escapes action text too — it reaches an attribute and a text node", () => {
    const html = renderBriefHtml(MARKDOWN, [
      action({ id: 'x"><img src=x>', module: "Health", kind: "checkbox", text: "<b>nem</b>" }),
    ], MODULES);

    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>nem</b>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/page-render.test.ts`
Expected: FAIL — `Failed to load url .../page/render.ts`.

- [ ] **Step 3: Write minimal implementation**

Hozd létre a `src/delivery/http/page/render.ts` fájlt:

```typescript
import type { StoredAction } from "../../../infra/db/repositories/actions.ts";
import type { JarvisModule } from "../../../core/module.ts";

/**
 * The brief as an HTML fragment.
 *
 * The `- [ ] ` lines in the markdown are deliberately dropped: they carry the
 * text of a todo but not its id, and without the id a checkbox cannot report
 * back. The controls are built from `actions` instead and matched to their
 * section by the module's title — which the output contract guarantees appears
 * verbatim as the `## ` heading.
 */
export function renderBriefHtml(
  markdown: string,
  actions: readonly StoredAction[],
  modules: readonly JarvisModule[],
): string {
  const titleOf = new Map(modules.map((m) => [m.name, m.title]));
  const byTitle = new Map<string, StoredAction[]>();
  for (const a of actions) {
    const title = titleOf.get(a.module);
    if (!title) continue;
    byTitle.set(title, [...(byTitle.get(title) ?? []), a]);
  }

  const out: string[] = [];
  let section: { title: string; body: string[] } | null = null;

  const flush = () => {
    if (!section) return;
    out.push(
      `<section class="card"><h2>${esc(section.title)}</h2>`,
      renderBody(section.body),
      renderControls(byTitle.get(section.title) ?? []),
      "</section>",
    );
    section = null;
  };

  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      section = { title: line.slice(3).trim(), body: [] };
    } else if (line.startsWith("# ")) {
      // The date heading belongs to the page shell, not to a card.
      continue;
    } else if (line.startsWith("- [ ] ") || line.startsWith("- [x] ")) {
      continue;
    } else if (section) {
      section.body.push(line);
    }
  }
  flush();

  return out.join("\n");
}

function renderBody(lines: readonly string[]): string {
  const out: string[] = [];
  let list: string[] = [];

  const closeList = () => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") { closeList(); continue; }
    if (line.startsWith("• ") || line.startsWith("- ")) { list.push(line.slice(2)); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return out.join("");
}

function renderControls(actions: readonly StoredAction[]): string {
  if (actions.length === 0) return "";

  const items = actions.map((a) => {
    if (a.kind === "proposal") {
      return `<div class="proposal" data-action="${esc(a.id)}">`
        + `<p>${esc(a.text)}</p>`
        + `<div class="proposal-buttons">`
        + `<button type="button" class="accept" data-accept="${esc(a.id)}">Elfogadom</button>`
        + `<button type="button" class="decline" data-decline="${esc(a.id)}">Elvetem</button>`
        + `</div></div>`;
    }
    return `<label class="todo" data-action="${esc(a.id)}">`
      + `<input type="checkbox" data-done="${esc(a.id)}">`
      + `<span>${esc(a.text)}</span></label>`;
  });

  return `<div class="actions">${items.join("")}</div>`;
}

/** Only what the output contract actually uses: bold. Everything else is text. */
function inline(text: string): string {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/page-render.test.ts`
Expected: PASS (7 teszt)

- [ ] **Step 5: Commit**

```bash
git add src/delivery/http/page/render.ts test/core/page-render.test.ts
git commit -m "feat: render the brief as an HTML fragment"
```

---

## Task 8: `GET /brief` — az oldal, olvasható állapotban

Ez a task **statikus** oldalt ad: minden látszik, semmi nem kattintható. Az
interaktivitás a Task 9. Így egy hibás JS nem tudja megbuktatni a helyes
renderelést, és külön is elbírálható.

**Files:**
- Create: `src/delivery/http/page/document.ts`
- Create: `src/delivery/http/routes/page.ts`
- Modify: `src/delivery/http/server.ts`
- Test: `test/core/page-route.test.ts` (új)

**Interfaces:**
- Consumes: `renderBriefHtml` (Task 7), `authCookie` / `credentialFrom` (Task 2)
- Produces: `renderDocument(opts): string`, `registerPageRoutes(app, deps)`. A `GET /brief` HTML-t ad; `?token=` esetén sütit állít és átirányít.

- [ ] **Step 1: Write the failing test**

Hozd létre a `test/core/page-route.test.ts` fájlt:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, stubModule, TEST_TOKEN, type TestApp } from "../helpers.ts";

let app: TestApp | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const boot = () => buildTestApp({
  modules: [stubModule({ name: "M", title: "🥦 Egészség" })],
  now: "2026-08-31T06:20:00+02:00",
});

describe("GET /brief", () => {
  it("turns a token in the query into a cookie and gets it out of the URL", async () => {
    app = await boot();

    const res = await app.server.inject({ method: "GET", url: `/brief?token=${TEST_TOKEN}` });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/brief");
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("jarvis_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("serves the page to a request carrying the cookie", async () => {
    app = await boot();

    const res = await app.server.inject({
      method: "GET", url: "/brief", headers: { cookie: `jarvis_token=${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<h2>🥦 Egészség</h2>");
    expect(res.body).toContain("2026. augusztus 31.");
  });

  it("refuses a request with no credential at all", async () => {
    app = await boot();
    const res = await app.server.inject({ method: "GET", url: "/brief" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a wrong token instead of setting a cookie from it", async () => {
    app = await boot();
    const res = await app.server.inject({ method: "GET", url: "/brief?token=nope-nope-nope-01234" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("never puts the token into the page", async () => {
    app = await boot();
    const res = await app.server.inject({
      method: "GET", url: "/brief", headers: { cookie: `jarvis_token=${TEST_TOKEN}` },
    });
    expect(res.body).not.toContain(TEST_TOKEN);
  });

  it("declares itself installable to the home screen", async () => {
    app = await boot();
    const res = await app.server.inject({
      method: "GET", url: "/brief", headers: { cookie: `jarvis_token=${TEST_TOKEN}` },
    });
    expect(res.body).toContain("apple-mobile-web-app-capable");
    expect(res.body).toContain("theme-color");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/page-route.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Write the document shell**

Hozd létre a `src/delivery/http/page/document.ts` fájlt:

```typescript
export interface DocumentOptions {
  dateLabel: string;
  /** The brief, already rendered by renderBriefHtml. */
  body: string;
  /** Today's note, or the empty string. */
  note: string;
  /** Which synthesizer produced the brief — shown small, for trust. */
  synthesizer: string;
  /** Client-side behaviour. Empty in the read-only build. */
  script: string;
}

const STYLE = `
:root {
  color-scheme: dark;
  --ground: #0F1416; --surface: #171E21; --surface-2: #1F282B;
  --ink: #E6EDEB; --ink-soft: #93A5A6; --rule: #273436;
  --accent: #4FC79B; --accent-ink: #06120E; --warn: #DDA842;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 0 4rem;
  background: var(--ground); color: var(--ink);
  font: 17px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 34rem; margin: 0 auto; padding: 0 1rem; }
header { padding: 2rem 0 1.2rem; }
h1 { margin: 0; font-size: 1.5rem; line-height: 1.2; letter-spacing: -.01em; text-wrap: balance; }
.meta { margin: .4rem 0 0; font-size: .78rem; color: var(--ink-soft); }
.card {
  background: var(--surface); border: 1px solid var(--rule); border-radius: 12px;
  padding: 1rem 1.1rem; margin: 0 0 1rem;
}
.card h2 { margin: 0 0 .7rem; font-size: 1.05rem; letter-spacing: -.005em; text-wrap: balance; }
.card p { margin: 0 0 .6rem; }
.card p:last-of-type { margin-bottom: 0; }
.card ul { margin: 0 0 .6rem; padding-left: 1.1rem; }
.card li { margin-bottom: .2rem; }
.actions { margin-top: .9rem; border-top: 1px solid var(--rule); padding-top: .8rem; display: grid; gap: .6rem; }
.todo { display: flex; gap: .65rem; align-items: flex-start; cursor: pointer; }
.todo input { width: 1.35rem; height: 1.35rem; margin: .1rem 0 0; accent-color: var(--accent); flex: none; }
.todo.done span { opacity: .45; text-decoration: line-through; }
.proposal { background: var(--surface-2); border-radius: 9px; padding: .7rem .8rem; }
.proposal p { margin: 0 0 .6rem; }
.proposal-buttons { display: flex; gap: .5rem; }
button {
  font: inherit; font-weight: 600; border-radius: 8px; padding: .5rem .9rem;
  border: 1px solid var(--rule); background: var(--surface); color: var(--ink); cursor: pointer;
}
button.accept { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea {
  width: 100%; font: inherit; color: var(--ink); background: var(--surface-2);
  border: 1px solid var(--rule); border-radius: 9px; padding: .6rem .7rem; resize: vertical;
}
.row { display: flex; gap: .5rem; margin-top: .6rem; }
.row button { flex: none; }
.status { font-size: .82rem; color: var(--ink-soft); margin: .5rem 0 0; min-height: 1.2em; }
.qa { display: grid; gap: .6rem; margin-top: .8rem; }
.qa .q { color: var(--ink-soft); }
.qa .a { white-space: pre-wrap; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/** Rendered server-side, no build step, nothing fetched from anywhere else. */
export function renderDocument(o: DocumentOptions): string {
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Jarvis">
<meta name="theme-color" content="#0F1416">
<meta name="robots" content="noindex">
<title>Jarvis — ${escapeHtml(o.dateLabel)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(o.dateLabel)}</h1>
  <p class="meta">${escapeHtml(o.synthesizer)}</p>
</header>
${o.body}
<section class="card">
  <h2>📝 Jegyzet</h2>
  <p class="meta">Hogy vagy ma? Ez nem írja felül a mért adatokat.</p>
  <textarea id="note" rows="3" placeholder="Ma törve vagyok…">${escapeHtml(o.note)}</textarea>
  <div class="row"><button type="button" id="note-save">Mentés</button></div>
  <p class="status" id="note-status"></p>
</section>
<section class="card">
  <h2>💬 Kérdezz vissza</h2>
  <div class="qa" id="qa"></div>
  <textarea id="q" rows="2" placeholder="Részletezd a pénzügyi részt…"></textarea>
  <div class="row"><button type="button" id="ask">Kérdezem</button></div>
  <p class="status" id="chat-status"></p>
</section>
</div>
<script>${o.script}</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
```

- [ ] **Step 4: Write the route**

Hozd létre a `src/delivery/http/routes/page.ts` fájlt:

```typescript
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { BriefService } from "../../../core/brief-service.ts";
import type { ActionRepo } from "../../../infra/db/repositories/actions.ts";
import type { HealthRepo } from "../../../infra/db/repositories/health.ts";
import type { JarvisModule } from "../../../core/module.ts";
import type { Clock } from "../../../infra/clock.ts";
import { authCookie, credentialFrom } from "../auth.ts";
import { renderBriefHtml } from "../page/render.ts";
import { renderDocument } from "../page/document.ts";
import { isoDate, TZ } from "../../../shared/dates.ts";
import { PAGE_SCRIPT } from "../page/script.ts";

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

export function registerPageRoutes(
  app: FastifyInstance,
  deps: {
    token: string;
    briefs: BriefService;
    actions: ActionRepo;
    health: HealthRepo;
    modules: readonly JarvisModule[];
    clock: Clock;
  },
): void {
  app.get<{ Querystring: { token?: string } }>("/brief", async (request, reply) => {
    // Opened once with ?token=, thereafter with a cookie. The redirect is what
    // gets the secret out of the address bar — and out of history and referrers.
    const fromQuery = request.query.token;
    if (fromQuery) {
      if (!sameSecret(fromQuery, deps.token)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      return reply
        .header("set-cookie", authCookie(deps.token))
        .redirect("/brief", 302);
    }

    const provided = credentialFrom(request);
    if (!provided || !sameSecret(provided, deps.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const now = deps.clock.now();
    // wait: false — the 07:20 pre-warm already built it; the page must open
    // instantly rather than block on a generation.
    const brief = await deps.briefs.get(now, { wait: false });
    const open = deps.actions.listOpen(brief.date);
    const note = deps.health.forDate(isoDate(now, TZ))?.note ?? "";

    return reply.type("text/html; charset=utf-8").send(renderDocument({
      dateLabel: brief.dateLabel ?? brief.date,
      body: renderBriefHtml(brief.markdown, open, deps.modules),
      note,
      synthesizer: `${brief.synthesizer} · ${brief.date}`,
      script: PAGE_SCRIPT,
    }));
  });
}
```

> Ha a `Brief` objektumon nincs `dateLabel`, használd a `brief.date`-et, és
> hagyd el a `??` ágat — a `npm run typecheck` megmondja, melyik eset áll fenn.

- [ ] **Step 5: Add an empty script module for now**

Hozd létre a `src/delivery/http/page/script.ts` fájlt:

```typescript
/** Filled in by the interactivity task; the read-only page needs none. */
export const PAGE_SCRIPT = "";
```

- [ ] **Step 6: Register the route**

`src/delivery/http/server.ts` — importáld a `registerPageRoutes`-t, és a többi
regisztráció mellé:

```typescript
  registerPageRoutes(app, {
    token: deps.token, briefs: deps.briefs, actions: deps.actions,
    health: deps.health, modules: deps.modules, clock: deps.clock,
  });
```

A `ServerDeps`-be vedd fel az `actions: ActionRepo;` mezőt (a típust importáld),
`src/main.ts`-ben pedig a `buildServer({...})` hívásba: `actions: app.actions,`.
A `test/helpers.ts` `buildServer` hívásába szintén: `actions,`.

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 8: Commit**

```bash
git add src/delivery/http/page/ src/delivery/http/routes/page.ts src/delivery/http/server.ts src/main.ts test/
git commit -m "feat: GET /brief serves the brief as a page"
```

---

## Task 9: Az oldal interaktív

**Files:**
- Modify: `src/delivery/http/page/script.ts`
- Test: `test/core/page-route.test.ts` (bővítés)

**Interfaces:**
- Consumes: `POST /api/actions/:id/done|accept|decline`, `POST /api/ingest/health`, `POST /api/chat`
- Produces: `PAGE_SCRIPT: string` — a kliens viselkedése.

- [ ] **Step 1: Write the failing test**

Told hozzá a `test/core/page-route.test.ts` fájlhoz:

```typescript
describe("the page's interactive contract", () => {
  const cookie = { cookie: `jarvis_token=${TEST_TOKEN}` };

  it("ships behaviour, not just markup", async () => {
    app = await boot();
    const res = await app.server.inject({ method: "GET", url: "/brief", headers: cookie });

    expect(res.body).toContain("data-done");
    expect(res.body).toContain("/api/chat");
    expect(res.body).toContain("/api/ingest/health");
    expect(res.body).toContain("same-origin");
  });

  it("lets the cookie authorise the writes the page makes", async () => {
    // The page has no bearer token — every button it renders depends on the
    // cookie being accepted on POST, not just on GET.
    app = await boot();

    const chat = await app.server.inject({
      method: "POST", url: "/api/chat", headers: cookie, payload: { question: "x" },
    });
    expect(chat.statusCode).not.toBe(401);

    const note = await app.server.inject({
      method: "POST", url: "/api/ingest/health", headers: cookie, payload: { note: "kézzel" },
    });
    expect(note.statusCode).toBe(202);
    expect(app.health.forDate("2026-08-31")?.note).toBe("kézzel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/page-route.test.ts -t "interactive"`
Expected: FAIL — a `PAGE_SCRIPT` üres, nincs `data-done` sem a scriptben.

- [ ] **Step 3: Write the client script**

Cseréld a `src/delivery/http/page/script.ts` teljes tartalmát:

```typescript
/**
 * The page's behaviour, inlined.
 *
 * No bundler, no CDN, no framework: this is one screen for one person, read
 * once a morning. Every request goes with `credentials: "same-origin"` so the
 * session cookie authorises it — the page never holds the token itself.
 */
export const PAGE_SCRIPT = `
(function () {
  function post(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; })
        .then(function (e) { throw new Error(e.message || ("HTTP " + r.status)); });
      return r.json();
    });
  }

  function say(el, text) { if (el) el.textContent = text; }

  // --- todos -------------------------------------------------------------
  document.querySelectorAll("input[data-done]").forEach(function (box) {
    box.addEventListener("change", function () {
      if (!box.checked) { box.checked = false; return; }
      box.disabled = true;
      post("/api/actions/" + encodeURIComponent(box.dataset.done) + "/done")
        .then(function () { box.closest(".todo").classList.add("done"); })
        .catch(function (err) { box.checked = false; box.disabled = false; alert(err.message); });
    });
  });

  // --- proposals ---------------------------------------------------------
  function resolve(id, verb, node, label) {
    node.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    post("/api/actions/" + encodeURIComponent(id) + "/" + verb)
      .then(function () {
        var done = document.createElement("p");
        done.className = "status";
        done.textContent = label;
        node.querySelector(".proposal-buttons").replaceWith(done);
      })
      .catch(function (err) {
        node.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
        alert(err.message);
      });
  }

  document.querySelectorAll("[data-accept]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var node = btn.closest(".proposal");
      resolve(btn.dataset.accept, "accept", node, "✓ Naptárba került");
    });
  });

  document.querySelectorAll("[data-decline]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var node = btn.closest(".proposal");
      resolve(btn.dataset.decline, "decline", node, "Elvetve");
    });
  });

  // --- note --------------------------------------------------------------
  var noteBox = document.getElementById("note");
  var noteBtn = document.getElementById("note-save");
  var noteStatus = document.getElementById("note-status");
  if (noteBtn) {
    noteBtn.addEventListener("click", function () {
      noteBtn.disabled = true;
      say(noteStatus, "Mentés…");
      post("/api/ingest/health", { note: noteBox.value })
        .then(function () { say(noteStatus, "Mentve. A következő briefing figyelembe veszi."); })
        .catch(function (err) { say(noteStatus, err.message); })
        .then(function () { noteBtn.disabled = false; });
    });
  }

  // --- chat --------------------------------------------------------------
  var qBox = document.getElementById("q");
  var askBtn = document.getElementById("ask");
  var qa = document.getElementById("qa");
  var chatStatus = document.getElementById("chat-status");

  function bubble(cls, text) {
    var p = document.createElement("p");
    p.className = cls;
    p.textContent = text;
    qa.appendChild(p);
    return p;
  }

  if (askBtn) {
    askBtn.addEventListener("click", function () {
      var question = (qBox.value || "").trim();
      if (question === "") return;

      askBtn.disabled = true;
      qBox.value = "";
      bubble("q", question);
      // Visible on purpose: the model takes seconds, and a silent page reads
      // as a broken one.
      say(chatStatus, "Gondolkodik…");

      post("/api/chat", { question: question })
        .then(function (r) { bubble("a", r.answer); say(chatStatus, ""); })
        .catch(function (err) { say(chatStatus, err.message); })
        .then(function () { askBtn.disabled = false; qBox.focus(); });
    });
  }
})();
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: minden zöld.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/http/page/script.ts test/core/page-route.test.ts
git commit -m "feat: the page's checkboxes, proposals, note and chat actually do something"
```

---

## Task 10: Éjszakai takarítás és a cost guard szétválasztása

**Files:**
- Modify: `src/infra/scheduler.ts`
- Modify: `config/config.ts`
- Modify: `src/main.ts`
- Modify: `scripts/smoke.ts`
- Test: `test/core/contact.test.ts` (bővítés — ott él már a scheduler-teszt)

**Interfaces:**
- Consumes: `ConversationRepo.prune` (Task 4)
- Produces: `runNightlyCleanup(opts): { prunedSeen: number; prunedCache: number; prunedTurns: number }`, `config.schedule.conversationRetentionDays: number`.

- [ ] **Step 1: Write the failing test**

Told hozzá a `test/core/contact.test.ts` fájlhoz:

```typescript
import { runNightlyCleanup } from "../../src/infra/scheduler.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";

describe("nightly cleanup", () => {
  it("drops conversation turns past their retention", () => {
    const db = memoryDb();
    const conversations = createConversationRepo(db);
    conversations.append("jarvis", "user", "régi", new Date("2026-08-01T06:00:00Z"));
    conversations.append("jarvis", "user", "friss", new Date("2026-09-04T06:00:00Z"));

    const result = runNightlyCleanup({
      db, conversations,
      clock: { now: () => new Date("2026-09-05T02:00:00Z") },
      logger: recordingLogger(),
      seenRetentionDays: 21,
      conversationRetentionDays: 14,
    });

    expect(result.prunedTurns).toBe(1);
    expect(conversations.recent("jarvis", "2026-09-04", 10, TZ)).toHaveLength(1);
    db.close();
  });

  it("survives a failure without taking the scheduler down", () => {
    const db = memoryDb();
    db.close(); // every statement will now throw

    const logger = recordingLogger();
    expect(() => runNightlyCleanup({
      db,
      conversations: createConversationRepo(db),
      clock: { now: () => new Date("2026-09-05T02:00:00Z") },
      logger,
      seenRetentionDays: 21,
      conversationRetentionDays: 14,
    })).not.toThrow();
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/contact.test.ts -t "cleanup"`
Expected: FAIL — `runNightlyCleanup` nincs exportálva.

- [ ] **Step 3: Extract and extend the cleanup**

`src/infra/scheduler.ts` — a `SchedulerOptions`-be:

```typescript
  conversations: ConversationRepo;
  /** Chat turns older than this go in the nightly sweep. */
  conversationRetentionDays: number;
```

(és importáld: `import type { ConversationRepo } from "./db/repositories/conversations.ts";`)

a `cleanup` cron törzsét cseréld erre:

```typescript
  const cleanup = new Cron("0 4 * * *", { timezone, protect: true }, () => {
    runNightlyCleanup(opts);
  });
```

és told a fájl végére:

```typescript
export interface CleanupOptions {
  db: Db;
  conversations: ConversationRepo;
  clock: Clock;
  logger: Logger;
  seenRetentionDays: number;
  conversationRetentionDays: number;
}

/**
 * Exported so it can be tested without waiting for 04:00. Never throws: a
 * failed sweep must not take the scheduler — and with it the morning
 * pre-warm — down with it.
 */
export function runNightlyCleanup(opts: CleanupOptions): {
  prunedSeen: number; prunedTurns: number;
} {
  const now = opts.clock.now();
  const result = { prunedSeen: 0, prunedTurns: 0 };

  try {
    result.prunedSeen = createSeenStore(opts.db).prune(opts.seenRetentionDays, now);
    opts.db.run("DELETE FROM module_cache WHERE expires_at < ?", now.toISOString());

    const cutoff = new Date(now.getTime() - opts.conversationRetentionDays * 86_400_000);
    result.prunedTurns = opts.conversations.prune(cutoff);

    opts.logger.info(result, "nightly cleanup complete");
  } catch (err) {
    opts.logger.warn({ err: String(err) }, "nightly cleanup failed");
  }

  return result;
}
```

- [ ] **Step 4: Add the retention to config and wire it**

`config/config.ts` — a `schedule` blokkba:

```typescript
    /** Chat turns are context for today, not an archive. */
    conversationRetentionDays: 14,
```

`src/main.ts` — a `startScheduler({...})` hívásba:

```typescript
  conversations: app.conversations,
  conversationRetentionDays: config.schedule.conversationRetentionDays,
```

- [ ] **Step 5: Split the cost guard**

`scripts/smoke.ts` — a `cost: ANTHROPIC_API_KEY unset` sort cseréld erre:

```typescript
  // Two different questions that used to be one check. The daily brief must
  // never cost money — that stays a hard rule. What serves chat is a reporting
  // matter: it runs on demand, when you ask for it, not on a timer.
  const metered = Boolean(process.env.ANTHROPIC_API_KEY);
  add(
    "cost: brief never metered",
    paid.length === 0,
    paid.length === 0
      ? "a szintézis lánca végig ingyenes"
      : `FIZETŐS SZINTETIZÁLÓ A LÁNCBAN: ${paid.join(", ")}`,
  );
  add(
    "cost: chat provider",
    true,
    metered
      ? "ANTHROPIC_API_KEY beállítva — a chat használat-arányosan fizetős lehet"
      : "claude-code (előfizetés) — nincs mért hívás",
  );
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run smoke`
Expected: minden teszt zöld, a smoke a két új cost-sorral fut le.

- [ ] **Step 7: Commit**

```bash
git add src/infra/scheduler.ts config/config.ts src/main.ts scripts/smoke.ts test/core/contact.test.ts
git commit -m "feat: prune chat history nightly; separate the brief's cost guard from chat's"
```

---

## Task 11: Dokumentáció és éles ellenőrzés

**Files:**
- Modify: `README.md`, `deploy/README.md`, `shortcuts/README.md`

- [ ] **Step 1: Document the page in the deploy guide**

`deploy/README.md` — a „Napi működés" táblázat **elé** told be:

```markdown
## 8. A briefing weboldala

A `tailscale serve` már kiszolgálja; nincs külön teendő. Egyszer nyisd meg a
telefonon a tokennel:

    https://jarvis.<tailnet>.ts.net/brief?token=<JARVIS_TOKEN>

A szerver sütit állít, és átirányít a token nélküli `/brief`-re — a titok így
nem marad a címsorban. Ezután Safariban **Megosztás → Hozzáadás a
kezdőképernyőhöz**: teljes képernyős appként nyílik, egy koppintással.

A süti egy évig él. Ha lejár vagy törlöd, nyisd meg újra a `?token=`-es címmel.
```

- [ ] **Step 2: Point the Shortcut at the short format**

`shortcuts/README.md` — a briefing-lekérő URL-t cseréld mindenhol:

```
https://jarvis.<TAILNET>.ts.net/api/morning-brief?format=short&wait=45
```

és a „Megjelenítés" lépéshez told hozzá:

```markdown
> Az értesítés mostantól **rövid**: a regenerációs sor és a mai teendők. A teljes
> briefing a kezdőképernyőre kitett Jarvis ikon mögött van, egy koppintásra —
> ott pipálhatod ki a teendőket, fogadhatod el a naptár-javaslatokat, és
> kérdezhetsz vissza.
```

- [ ] **Step 3: Update the project README**

`README.md` — a „Mit tud" táblázat után told be:

```markdown
## Felületek

| Felület | Mire jó |
|---|---|
| 📱 iOS értesítés | 07:30, rövid: regeneráció + mai teendők |
| 🌐 `/brief` weboldal | A teljes briefing. Checkboxok, naptár-javaslatok, jegyzet, chat |
| 💬 Telegram | Ugyanaz parancsokkal — és ugyanazt a chat-szálat folytatja |
```

- [ ] **Step 4: Verify it live**

```bash
npm test && npm run typecheck && npm run smoke
launchctl kickstart -k gui/$(id -u)/local.jarvis.agent
sleep 6

TOKEN=$(security find-generic-password -s jarvis -a JARVIS_TOKEN -w)

# A rövid értesítés-forma
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://jarvis.tail5e9d97.ts.net/api/morning-brief?format=short" | tee /dev/stderr | wc -c

# Az oldal: token → süti → átirányítás
curl -si "https://jarvis.tail5e9d97.ts.net/brief?token=$TOKEN" | head -12

# Az oldal sütivel
curl -s -H "Cookie: jarvis_token=$TOKEN" \
  "https://jarvis.tail5e9d97.ts.net/brief" | grep -c "<section class=\"card\">"
```

Expected: a rövid forma 200 karakter alatt; a `?token=` hívás `302` + `set-cookie`;
a sütis hívás annyi kártyát ad, ahány szekció van a mai briefben.

- [ ] **Step 5: Open it on the phone**

Nyisd meg a telefonon a `?token=`-es címet, tedd ki a kezdőképernyőre, és
próbáld ki mind a négyet: egy checkbox, a jegyzet mentése, egy kérdés a chatben,
és — ha épp van javaslat — az `[Elfogadom]`. Ellenőrizd a szerveren:

```bash
tail -20 data/jarvis.log | grep request
```

- [ ] **Step 6: Commit**

```bash
git add README.md deploy/README.md shortcuts/README.md
git commit -m "docs: the brief has a web page now"
```

---

## Self-review

**Spec coverage**

| Spec szakasz | Task |
|---|---|
| Három felület, reggeli folyamat | 1, 8, 11 |
| `format=short` tartalma és mérete | 1 |
| `GET /brief` HTML, kártyák, sorrend | 7, 8 |
| Checkbox → `/done` | 7, 9 |
| Elfogadom / Elvetem → `/accept`, `/decline` | 7, 9 |
| Chat mező, látható várakozó állapot | 9 |
| Jegyzet mező | 3, 8, 9 |
| Frissítés gomb | **kimaradt — lásd lent** |
| Sötét felület, Add to Home Screen | 8 |
| Süti-hitelesítés, egyszeri `?token=` | 2, 8 |
| Chat előzmény, közös szál, 20 forduló | 4, 5, 6 |
| `note` nem írja felül a mérést | 3 |
| `conversations` takarítása 04:00-kor | 10 |
| Cost guard szétválasztása | 10 |
| Host-függetlenség | végig — semmi nem köt macOS-hez |

**Egy szándékos elhagyás.** A spec említett egy „Frissítés" gombot (`force=true`).
Kihagytam: a `force` egy 15–25 másodperces generálást indít, amit az oldalnak
ki kellene várnia — és a `wait=0` mellett az oldal újratöltése (lehúzás) már
most is a legfrissebb briefet adja. YAGNI. Ha kell, később egy gomb és egy
`fetch`, de ne épüljön bele vakon.

**Placeholder-ellenőrzés.** Minden lépés tartalmazza a tényleges kódot vagy
parancsot. Nincs „TBD", „hasonlóan a Task N-hez", vagy „adj hozzá hibakezelést".

**Típus-konzisztencia.** `toSummary` · `AUTH_COOKIE` / `tokenAuth` / `authCookie`
/ `credentialFrom` · `HealthRepo.setNote` · `ChatTurn` / `THREAD_ID` ·
`createConversationRepo` → `append` / `recent` / `prune` · `renderBriefHtml` ·
`renderDocument` · `PAGE_SCRIPT` · `registerChatRoutes` / `registerPageRoutes` ·
`runNightlyCleanup`. Mindegyik ugyanazzal a névvel és szignatúrával szerepel
ott, ahol definiálva lett, és ott is, ahol használják.

**Egy kockázat, amit a végrehajtó lásson előre.** A Task 5 megváltoztatja a
`ChatService.ask` szignatúráját. Minden hívási hely és minden teszt-stub
egyszerre kell hogy kövesse — a `npm run typecheck` megtalálja őket, de ne
lepődj meg, ha a Task 5 több fájlt érint, mint amennyit a fejléce felsorol.
