# F4 — Írás a felületen: implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rendszer négy meglévő írási művelete — kipipálás, naptár-javaslat
elfogadása és elutasítása, naptár-írás visszavonása — elérhetővé válik a
weboldalról, JavaScript nélkül.

**Architecture:** HTML-űrlap POST → a `ProposalService` elvégzi a műveletet →
`303 See Other` vissza a Ma oldalra (POST/Redirect/GET), a hiba a query
stringben utazik. A `view/*` modulok továbbra is már lekérdezett adatot kapnak
és sztringet adnak vissza.

**Tech Stack:** Node 24 futtatja a `.ts`-t közvetlenül (nincs build), Fastify 5,
`node:sqlite`, vitest.

## Global Constraints

- **Nincs új futásidejű függőség.** Nem `@fastify/formbody` — a form-parser
  négy sor beépített `URLSearchParams`.
- **Nincs kliensoldali JavaScript.** Két örökölt kivétel van (a token-takarító
  a fejlécben, a kérdés-űrlap küldője), és ez a szám nem nő.
- **A felület magyar.** Felhasználónak szánt szöveg és CSS-osztálynév magyarul,
  kódkomment angolul, a környező fájlok mintájára.
- **Színszabály:** `--jel` KIZÁRÓLAG mért adat; `--vaz` keret, soha nem adat;
  `--riado` eddig kizárólag az állapotsáv elmaradt-csatorna sora volt, és
  ebben a tervben **egyetlen** új használatot kap: a `calendar_failed` sávja.
  Semmi más új szabályban nem jelenhet meg.
- **A hiányzó adat hiányzónak látsszon.** Soha nem nulla, soha nem üres keret,
  soha nem üres cím tartalom nélkül.
- **A tesztek offline futnak**, nem írnak a `./data/jarvis.db`-be, nem
  indítanak szervert a 8787-es porton; az adatbázis mindig `memoryDb()`.
- **Mutációs fegyelem:** minden új teszt bukjon el a javítatlan implementáció
  ellen — ellenőrizd, ne feltételezd. Az F3-on tizenkét feladatból tizenegy
  igényelt plusz javítási kört, szinte mindig azért, mert egy teszt nem látta
  a hibát, amit őrizni hivatott; leggyakrabban úgy, hogy egy állítást a lap
  egy másik szakasza is kielégített. **Minden állítást szűkíts a saját
  sávjára** egy lusta, jobbról lehorgonyzott kivonattal.
- Minden HTML-be kerülő szöveg `escapeHtml`-en megy át; markdown csak
  `renderMarkdown`-on.
- Teszt: `npx vitest run <fájl>`. Teljes suite: `npm test` (jelenleg 818 zöld).
  Típusellenőrzés: `npx tsc --noEmit` (jelenleg néma).

---

## Fájlszerkezet

```
ÚJ
  src/delivery/http/routes/writes.ts     a négy űrlap-útvonal (Task 2)
  src/delivery/http/view/actions.ts      a Teendők és a Visszavonás sáv (Task 3)

MÓDOSUL
  src/infra/db/repositories/actions.ts   listAllOpen()                (Task 1)
  src/delivery/http/server.ts            form-parser + registerWriteRoutes (Task 2)
  src/delivery/http/view/theme.ts        űrlapgomb, hibasáv, teendő-sor (Task 3)
  src/delivery/http/routes/page-shell.ts PageDeps.modules, a hibakód   (Task 4)
  src/delivery/http/routes/page.ts       a Ma oldal két új sávja       (Task 4)
  src/delivery/http/view/today.ts        a hibasáv és a két új sáv     (Task 4)
  test/helpers.ts                        a bővült deps                 (Task 4)
```

---

### Task 1: `listAllOpen()` az ActionRepo-ban

A `listOpen(date)` egyetlen napra kérdez, és **ma üres listát adna**: 2026-09-03
van, a kilenc nyitott teendő dátuma 2026-08-30, 08-31 és 09-04. A Ma oldal
tehát azt állítaná, hogy nincs teendő, miközben kilenc nyitva áll.

**Files:**
- Modify: `src/infra/db/repositories/actions.ts`
- Test: `test/infra/actions-repo.test.ts`

**Interfaces:**
- Consumes: `Db`, a fájlban már meglévő `Row` interfész és `toStored(row)`
  leképező, valamint a `StoredAction` típus — ezeket ne definiáld újra.
- Produces az `ActionRepo` interfészen:
  ```ts
  /** Every open action, whatever day it belongs to, newest day first. */
  listAllOpen(): StoredAction[];
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/infra/actions-repo.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createActionRepo } from "../../src/infra/db/repositories/actions.ts";

const NOW = new Date("2026-09-03T08:00:00.000Z");

/** One checkbox action for a given day, through the repo's own writer. */
const seed = (repo: ReturnType<typeof createActionRepo>, date: string, text: string) =>
  repo.replaceForDate(date, [{
    module: "Teszt",
    action: { id: `${date}-${text}`, kind: "checkbox", text },
  }], NOW);

describe("ActionRepo.listAllOpen", () => {
  it("a más napra szóló nyitott teendőt is visszaadja", () => {
    // Ez a feladat egyetlen oka. A listOpen(ma) a valódi adatbázison ma üres
    // listát ad: a kilenc nyitott teendő egyike sem a mai napra szól, mert a
    // modulok naponta a SAJÁT napjuk teendőit cserélik le, a többi napé pedig
    // nyitva marad, amíg valaki le nem zárja.
    const db = memoryDb();
    const repo = createActionRepo(db);
    seed(repo, "2026-08-30", "régi");
    seed(repo, "2026-09-04", "jövőbeli");

    expect(repo.listOpen("2026-09-03")).toHaveLength(0);
    expect(repo.listAllOpen().map((a) => a.text).sort()).toEqual(["jövőbeli", "régi"]);
    db.close();
  });

  it("a legfrissebb napot adja elöl", () => {
    const db = memoryDb();
    const repo = createActionRepo(db);
    seed(repo, "2026-08-30", "régi");
    seed(repo, "2026-09-04", "jövőbeli");
    expect(repo.listAllOpen().map((a) => a.date)).toEqual(["2026-09-04", "2026-08-30"]);
    db.close();
  });

  it("a lezárt teendőt nem adja vissza", () => {
    // A `declined` is válasz, nem eltüntetés — de a nyitottak közé nem való.
    const db = memoryDb();
    const repo = createActionRepo(db);
    const [nyitott] = seed(repo, "2026-09-03", "nyitott");
    seed(repo, "2026-09-02", "lezart");
    const lezart = repo.listAllOpen().find((a) => a.text === "lezart")!;
    repo.setStatus(lezart.id, "declined", NOW);
    expect(repo.listAllOpen().map((a) => a.id)).toEqual([nyitott!.id]);
    db.close();
  });

  it("üres táblára üres listát ad", () => {
    const db = memoryDb();
    expect(createActionRepo(db).listAllOpen()).toEqual([]);
    db.close();
  });

  it("a naptár-javaslatot a saját javaslatával adja vissza", () => {
    // A proposal_json a modulokból jön; ha nem parse-olódik vissza, a Ma
    // oldal egy naptárba író gombot mutatna a javaslat részletei nélkül.
    const db = memoryDb();
    const repo = createActionRepo(db);
    repo.replaceForDate("2026-09-05", [{
      module: "WeekendPlanner",
      action: {
        id: "p1", kind: "proposal", text: "Kirándulás",
        proposal: {
          title: "Kirándulás", start: "2026-09-05T09:00:00+02:00",
          end: "2026-09-05T12:00:00+02:00", location: "Szentendre",
        },
      },
    }], NOW);
    const only = repo.listAllOpen()[0]!;
    expect(only.kind).toBe("proposal");
    expect(only.proposal?.location).toBe("Szentendre");
    db.close();
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/infra/actions-repo.test.ts`
Expected: FAIL — `repo.listAllOpen is not a function`

- [ ] **Step 3: Bővítsd a repository-t**

Az `interface ActionRepo` blokkba, a `listOpen` után:

```ts
  /**
   * Every open action, whatever day it belongs to, newest day first.
   *
   * `listOpen(date)` asks about one day, and that is the wrong question for
   * the page: `replaceForDate` only ever replaces the actions of the day it
   * runs for, so an action from any other day stays open until someone closes
   * it. On the real database `listOpen(today)` currently answers with nothing
   * while nine actions sit open — a page built on it would claim there is
   * nothing to do.
   */
  listAllOpen(): StoredAction[];
```

A `createActionRepo` visszatérő objektumába, a `listOpen` után:

```ts
    listAllOpen() {
      return db
        .all<Row>(
          "SELECT * FROM action_items WHERE status = 'open' ORDER BY date DESC, created_at DESC, id",
          )
        .map(toStored);
    },
```

Az `id` a rendezés végén nem díszítés: a `(date, created_at)` pár nem
egyedi — egy futás minden teendője ugyanabban a másodpercben születik —, és
egy nem teljes rendezés fölött az SQLite szabadon adhat más sorrendet
hívásonként.

- [ ] **Step 4: Futtasd a teszteket**

Run: `npx vitest run test/infra/actions-repo.test.ts`
Expected: PASS mind az 5

- [ ] **Step 5: Mutációs ellenőrzés**

Cseréld a `WHERE status = 'open'` feltételt `WHERE 1=1`-re, és futtasd újra.
Expected: FAIL — „a lezárt teendőt nem adja vissza". Állítsd vissza.

Cseréld az `ORDER BY date DESC`-et `ORDER BY date`-re (növekvő), és futtasd
újra. Expected: FAIL — „a legfrissebb napot adja elöl". Állítsd vissza,
futtasd újra: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/infra/db/repositories/actions.ts test/infra/actions-repo.test.ts
git commit -m "feat: minden nyitott teendő, nem csak a mai napé"
```

---

### Task 2: A form-parser és a négy írási útvonal

**Files:**
- Create: `src/delivery/http/routes/writes.ts`
- Modify: `src/delivery/http/server.ts`
- Test: `test/delivery/write-routes.test.ts`

**Interfaces:**
- Consumes: `ProposalService` és `ProposalError` a
  `../../../core/proposals.ts`-ből (metódusai: `accept(id, now)`,
  `decline(id, now)`, `complete(id, now)`, `undo(eventUid, now)`; a
  `ProposalError.code` értékei `"not_found" | "wrong_kind" |
  "already_resolved" | "calendar_failed"`), `Clock`, `Logger`.
- Produces:
  ```ts
  export function registerWriteRoutes(
    app: FastifyInstance,
    deps: { proposals: ProposalService; clock: Clock; logger: Logger },
  ): void;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/write-routes.test.ts` fájlt:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, TEST_TOKEN, stubModule } from "../helpers.ts";
import type { TestApp } from "../helpers.ts";

const UTAK = [
  "/teendo/x1/kesz",
  "/teendo/x1/elfogad",
  "/teendo/x1/elutasit",
  "/naptar/u1/visszavon",
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

/** A form POST the way a browser sends one: urlencoded, empty body. */
const post = (a: TestApp, url: string) => a.server.inject({
  method: "POST", url,
  headers: {
    authorization: `Bearer ${TEST_TOKEN}`,
    "content-type": "application/x-www-form-urlencoded",
  },
  payload: "",
});

/** Seeds one open checkbox action and returns its id. */
const seedCheckbox = (a: TestApp): string => {
  const rows = a.actions.replaceForDate("2026-09-03", [{
    module: "Teszt",
    action: { id: "c1", kind: "checkbox", text: "Kipipálandó" },
  }], new Date("2026-09-03T08:00:00.000Z"));
  return rows[0]!.id;
};

describe("írási útvonalak", () => {
  it("token nélkül mind a négy 401", async () => {
    const a = await boot();
    for (const url of UTAK) {
      const res = await a.server.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "",
      });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("a százalék-kódolt alak sem csúszik át", async () => {
    // Az F1 záró reviewjának valódi lelete: a hook a nyers URL-t hasonlította,
    // a router viszont dekódolva irányított.
    const a = await boot();
    for (const url of ["/%74eendo/x1/kesz", "/%6Eaptar/u1/visszavon"]) {
      const res = await a.server.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "",
      });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("GET-tel egyik írási útvonal sem érhető el", async () => {
    // Egy állapotot változtató GET-et egy előtöltő böngésző vagy egy
    // link-ellenőrző magától elsütne.
    const a = await boot();
    for (const url of UTAK) {
      const res = await a.server.inject({
        method: "GET", url, headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect([404, 405], url).toContain(res.statusCode);
    }
  });

  it("a kipipálás 303-mal a Ma oldalra küld vissza", async () => {
    const a = await boot();
    const id = seedCheckbox(a);
    const res = await post(a, `/teendo/${id}/kesz`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/");
    expect(a.actions.find(id)!.status).toBe("done");
  });

  it("az űrlapos POST nem kap 415-öt", async () => {
    // A Fastify alapból csak JSON-t olvas; parser nélkül minden
    // application/x-www-form-urlencoded kérés 415-öt kapna, akkor is, ha
    // üres a törzse. Ez a teszt azt a regressziót fogja meg, nem a parser
    // létezését állítja.
    const a = await boot();
    const id = seedCheckbox(a);
    const res = await post(a, `/teendo/${id}/kesz`);
    expect(res.statusCode).not.toBe(415);
  });

  it("kétszer elküldött kipipálás nem hibázik és nem jelez hibát", async () => {
    // A kívánt állapot már fennáll. Egy piros sáv arról, hogy „ezt már
    // elintézted", mindig szólna és semmit nem jelentene.
    const a = await boot();
    const id = seedCheckbox(a);
    await post(a, `/teendo/${id}/kesz`);
    const masodik = await post(a, `/teendo/${id}/kesz`);
    expect(masodik.statusCode).toBe(303);
    expect(masodik.headers.location).toBe("/");
  });

  it("ismeretlen teendő hibakóddal irányít vissza, nem 404-gyel", async () => {
    // A lap létezik; csak ez a kérés volt értelmetlen. A 404 azt állítaná,
    // hogy az útvonal nincs.
    const a = await boot();
    const res = await post(a, "/teendo/nincs-ilyen/kesz");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/?hiba=not_found");
  });

  it("a rossz fajtára küldött művelet hibakódot ad", async () => {
    const a = await boot();
    const id = seedCheckbox(a);
    const res = await post(a, `/teendo/${id}/elfogad`);
    expect(res.headers.location).toBe("/?hiba=wrong_kind");
  });

  it("a naptár-hiba a saját kódjával jön vissza, és a teendő nyitva marad", async () => {
    // A test harness naptára mindig elérhetetlen, tehát az accept ezen az
    // ágon fut: ez a valódi calendar_failed, nem szimuláció.
    const a = await boot();
    const rows = a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: {
        id: "p1", kind: "proposal", text: "Kirándulás",
        proposal: {
          title: "Kirándulás", start: "2026-09-05T09:00:00+02:00",
          end: "2026-09-05T12:00:00+02:00",
        },
      },
    }], new Date("2026-09-03T08:00:00.000Z"));
    const id = rows[0]!.id;
    const res = await post(a, `/teendo/${id}/elfogad`);
    expect(res.headers.location).toBe("/?hiba=calendar_failed");
    expect(a.actions.find(id)!.status).toBe("open");
  });

  it("az elutasítás lezárja a teendőt", async () => {
    const a = await boot();
    const rows = a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: {
        id: "p2", kind: "proposal", text: "Kirándulás",
        proposal: { title: "K", start: "2026-09-05T09:00:00+02:00", end: "2026-09-05T12:00:00+02:00" },
      },
    }], new Date("2026-09-03T08:00:00.000Z"));
    const id = rows[0]!.id;
    const res = await post(a, `/teendo/${id}/elutasit`);
    expect(res.statusCode).toBe(303);
    expect(a.actions.find(id)!.status).toBe("declined");
  });

  it("ismeretlen naptár-írás visszavonása hibakóddal tér vissza", async () => {
    const a = await boot();
    const res = await post(a, "/naptar/nincs-ilyen/visszavon");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/\?hiba=/);
  });

  it("a JSON API változatlanul működik", async () => {
    // A Telegram és a Shortcut azt használja; ez a négy útvonal a böngésző
    // saját bejárata ugyanahhoz a szolgáltatáshoz, nem a helyettesítője.
    const a = await boot();
    const id = seedCheckbox(a);
    const res = await a.server.inject({
      method: "POST", url: `/api/actions/${id}/done`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
```

A teszt `a.actions`-t használ. Ha a `TestApp` nem teszi közzé az
`ActionRepo`-t, vedd fel a `test/helpers.ts`-be ugyanúgy, ahogy a
`workouts`/`meals`/`subscriptions` szerepel: mező az `interface TestApp`-en és
a `buildTestApp` visszatérő objektumában. A `createActionRepo(db)` példány már
létezik a `buildTestApp` törzsében `actions` néven.

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/write-routes.test.ts`
Expected: FAIL — az útvonalak 404-et adnak

- [ ] **Step 3: Írd meg a writes.ts-t**

Hozd létre a `src/delivery/http/routes/writes.ts` fájlt:

```ts
import type { FastifyInstance, FastifyReply } from "fastify";
import { ProposalError, type ProposalService } from "../../../core/proposals.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";

/**
 * The page's own way in to the four writes the system already knows how to do.
 *
 * `/api/actions/*` and `/api/calendar/writes/*` already expose the same
 * service as JSON, and they stay: Telegram and the Shortcut speak to those.
 * These four are for a browser with no JavaScript, which means an HTML form —
 * and a form gets POST/Redirect/GET, because without the redirect a refresh
 * re-submits the POST and writes a second calendar event.
 *
 * No CSRF token: the page's cookie is `SameSite=Strict` (see `auth.ts`), so a
 * cross-site POST never carries it, and these routes accept nothing else.
 */
export function registerWriteRoutes(
  app: FastifyInstance,
  deps: { proposals: ProposalService; clock: Clock; logger: Logger },
): void {
  /**
   * Back to the page, carrying the error code when there is one.
   *
   * `303 See Other` rather than 302: it is the status that means "the result
   * of your POST is at this other address, fetch it with GET", which is
   * exactly the promise being made.
   *
   * `already_resolved` deliberately redirects clean. It is what a double tap
   * or a back-then-resubmit produces, and the state the reader wanted already
   * holds — an alarm that fires whenever nothing is wrong is the same kind of
   * indicator this project refuses everywhere else.
   */
  const back = (reply: FastifyReply, err?: unknown): FastifyReply => {
    if (err === undefined) return reply.code(303).header("location", "/").send();
    if (!(err instanceof ProposalError)) throw err;
    if (err.code === "already_resolved") {
      return reply.code(303).header("location", "/").send();
    }
    deps.logger.warn({ code: err.code, err: String(err) }, "write from the page failed");
    return reply.code(303)
      .header("location", `/?hiba=${encodeURIComponent(err.code)}`).send();
  };

  const run = async (reply: FastifyReply, work: () => Promise<unknown>) => {
    try {
      await work();
      return back(reply);
    } catch (err) {
      return back(reply, err);
    }
  };

  app.post<{ Params: { id: string } }>("/teendo/:id/kesz", (request, reply) =>
    run(reply, () => deps.proposals.complete(request.params.id, deps.clock.now())));

  app.post<{ Params: { id: string } }>("/teendo/:id/elfogad", (request, reply) =>
    run(reply, () => deps.proposals.accept(request.params.id, deps.clock.now())));

  app.post<{ Params: { id: string } }>("/teendo/:id/elutasit", (request, reply) =>
    run(reply, () => deps.proposals.decline(request.params.id, deps.clock.now())));

  app.post<{ Params: { uid: string } }>("/naptar/:uid/visszavon", (request, reply) =>
    run(reply, () => deps.proposals.undo(request.params.uid, deps.clock.now())));
}
```

- [ ] **Step 4: Kösd be a szerverbe**

A `src/delivery/http/server.ts`-ben, a `Fastify({...})` létrehozása után és a
route-regisztrációk előtt illeszd be:

```ts
  /**
   * Form bodies, without a dependency.
   *
   * Fastify parses JSON and nothing else out of the box: an
   * `application/x-www-form-urlencoded` POST answers 415 even with an empty
   * body, which is exactly what a browser sends for a button-only form. This
   * is `@fastify/formbody`'s whole job, in four lines of built-in
   * `URLSearchParams` — and this project takes no new runtime dependency.
   */
  app.addContentTypeParser(
    "application/x-www-form-urlencoded", { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );
```

A `registerActionRoutes(...)` hívás mellé:

```ts
  registerWriteRoutes(app, {
    proposals: deps.proposals, clock: deps.clock, logger: deps.logger,
  });
```

és az importok közé:

```ts
import { registerWriteRoutes } from "./routes/writes.ts";
```

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/write-routes.test.ts test/delivery/server-auth.test.ts`
Expected: PASS mind

Majd: `npm test && npx tsc --noEmit` — a teljes suite maradjon zöld.

- [ ] **Step 6: Mutációs ellenőrzés**

Kommentezd ki az `addContentTypeParser` blokkot, és futtasd újra.
Expected: FAIL — „az űrlapos POST nem kap 415-öt". Állítsd vissza.

A `back()`-ben töröld az `already_resolved` külön ágát (hadd essen a
hibakódos ágra), és futtasd újra.
Expected: FAIL — „kétszer elküldött kipipálás nem hibázik és nem jelez
hibát". Állítsd vissza.

Cseréld a `reply.code(303)`-at `reply.code(302)`-re, és futtasd újra.
Expected: FAIL. Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: űrlapos írási útvonalak POST/Redirect/GET mintával"
```

---

### Task 3: A Teendők és a Visszavonás sáv

Tiszta view-modul: már lekérdezett adatot kap, sztringet ad vissza,
repository-hoz nem ér.

**Files:**
- Create: `src/delivery/http/view/actions.ts`
- Modify: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/view-actions.test.ts`

**FIGYELEM — CSS-csapda.** A `theme.ts`-ben már van egy **elem-szintű**
szabály: `form { display: flex; gap: .5rem; margin-top: 1.4rem; position: relative; }`,
amit a kérdés-űrlaphoz írtunk. Az új gomb-űrlapok ugyanúgy `<form>`-ok, tehát
ezt **öröklik**, és 1,4rem-es felső margóval, flex-konténerként rendeződnének
egy teendő-sorban. Ne írd át a meglévő `form` szabályt (F1-kód, saját
tesztekkel) — adj az új űrlapoknak `class="muvelet"`-et, és írd felül benne
explicit `display`, `margin-top` és `gap` értékekkel.

**Interfaces:**
- Consumes: `escapeHtml` a `../markdown.ts`-ből.
- Produces:
  ```ts
  export interface ActionRow {
    id: string;
    kind: "checkbox" | "proposal";
    text: string;
    /** The module's own title, or its raw name when no module matches. */
    modul: string;
    /** Already-worded proposal detail lines — empty for a checkbox. */
    reszletek: readonly string[];
  }
  export interface ActionsData {
    /** Open actions grouped by day, newest day first. */
    napok: readonly { date: string; items: readonly ActionRow[] }[];
    undoable: readonly { eventUid: string; title: string; startsAt: string; calendar: string }[];
  }
  export function actionsBody(d: ActionsData): string;
  export function errorBand(code: string | undefined): string;
  ```

- [ ] **Step 1: Írd meg a bukó tesztet**

Hozd létre a `test/delivery/view-actions.test.ts` fájlt:

```ts
import { describe, it, expect } from "vitest";
import { actionsBody, errorBand } from "../../src/delivery/http/view/actions.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";

const empty = { napok: [], undoable: [] };

const row = (over: Partial<Parameters<typeof actionsBody>[0]["napok"][number]["items"][number]> = {}) => ({
  id: "a1", kind: "checkbox" as const, text: "Kipipálandó",
  modul: "🧪 Teszt", reszletek: [], ...over,
});

/** Only the Teendők band — the undo band below it also renders forms. */
const teendokSav = (html: string): string =>
  /<h2>Teendők<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

/** Only the undo band. */
const visszavonSav = (html: string): string =>
  /<h2>Visszavonható<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

describe("teendő-sáv", () => {
  it("nyitott teendő nélkül nem ad üres címet", () => {
    // Egy "Teendők" fejléc semmivel alatta hiányzó adat, ami nem látszik
    // hiányzónak.
    expect(actionsBody(empty)).toBe("");
  });

  it("a checkbox egyetlen Kész gombot kap", () => {
    const sav = teendokSav(actionsBody({
      ...empty, napok: [{ date: "2026-09-03", items: [row()] }],
    }));
    expect(sav).toContain('action="/teendo/a1/kesz"');
    expect(sav).not.toContain("/elfogad");
    expect(sav).not.toContain("/elutasit");
  });

  it("a naptár-javaslat elfogadást és elutasítást kap, kipipálást nem", () => {
    const sav = teendokSav(actionsBody({
      ...empty,
      napok: [{ date: "2026-09-05", items: [row({ id: "p1", kind: "proposal", text: "Kirándulás" })] }],
    }));
    expect(sav).toContain('action="/teendo/p1/elfogad"');
    expect(sav).toContain('action="/teendo/p1/elutasit"');
    expect(sav).not.toContain("/kesz");
  });

  it("minden űrlap POST-ol", () => {
    // Egy állapotot változtató GET-et egy előtöltő böngésző elsütne.
    const sav = teendokSav(actionsBody({
      ...empty, napok: [{ date: "2026-09-03", items: [row()] }],
    }));
    const urlapok = [...sav.matchAll(/<form[^>]*>/g)].map((m) => m[0]);
    expect(urlapok.length).toBeGreaterThan(0);
    for (const u of urlapok) expect(u).toContain('method="post"');
  });

  it("a napokat a saját dátumukkal csoportosítja", () => {
    // A nyitott teendők nem a mai naphoz tartoznak; a dátum az a tény, ami
    // elhelyezi őket.
    const sav = teendokSav(actionsBody({
      ...empty,
      napok: [
        { date: "2026-09-04", items: [row({ id: "u1", text: "újabb" })] },
        { date: "2026-08-30", items: [row({ id: "r1", text: "régebbi" })] },
      ],
    }));
    expect(sav.indexOf("2026-09-04")).toBeLessThan(sav.indexOf("2026-08-30"));
    expect(sav).toContain("2026-08-30");
  });

  it("a javaslat részleteit kiírja a gomb mellé", () => {
    // Egy naptárba író gombhoz kevés a puszta cím.
    const sav = teendokSav(actionsBody({
      ...empty,
      napok: [{ date: "2026-09-05", items: [row({
        kind: "proposal", reszletek: ["2026-09-05 09:00", "Szentendre", "Esőben is működik"],
      })] }],
    }));
    expect(sav).toContain("Szentendre");
    expect(sav).toContain("Esőben is működik");
  });

  it("a modul címkéjét kiírja", () => {
    const sav = teendokSav(actionsBody({
      ...empty, napok: [{ date: "2026-09-03", items: [row({ modul: "🥾 Hétvége" })] }],
    }));
    expect(sav).toContain("🥾 Hétvége");
  });

  it("escape-eli a szöveget, a modult és a részleteket", () => {
    // Mind a három a modulokból jön, nem ebből a kódból.
    const sav = teendokSav(actionsBody({
      ...empty,
      napok: [{ date: "2026-09-03", items: [row({
        kind: "proposal", text: "<b>t</b>", modul: "<i>m</i>", reszletek: ["<u>r</u>"],
      })] }],
    }));
    expect(sav).not.toContain("<b>t</b>");
    expect(sav).not.toContain("<i>m</i>");
    expect(sav).not.toContain("<u>r</u>");
    expect(sav).toContain("&lt;b&gt;");
  });
});

describe("visszavonás-sáv", () => {
  it("visszavonható írás nélkül nincs ott", () => {
    const html = actionsBody({ ...empty, napok: [{ date: "2026-09-03", items: [row()] }] });
    expect(html).not.toContain("Visszavonható");
  });

  it("minden írás a saját visszavonó gombját kapja", () => {
    const sav = visszavonSav(actionsBody({
      ...empty,
      undoable: [{ eventUid: "u1", title: "Kirándulás", startsAt: "2026-09-05T09:00:00+02:00", calendar: "Jarvis" }],
    }));
    expect(sav).toContain('action="/naptar/u1/visszavon"');
    expect(sav).toContain("Kirándulás");
    expect(sav).toContain("Jarvis");
  });

  it("escape-eli a naptár-írás címét", () => {
    const sav = visszavonSav(actionsBody({
      ...empty,
      undoable: [{ eventUid: "u1", title: "<b>x</b>", startsAt: "2026-09-05T09:00:00+02:00", calendar: "J" }],
    }));
    expect(sav).not.toContain("<b>x</b>");
    expect(sav).toContain("&lt;b&gt;");
  });
});

describe("hibasáv", () => {
  it("hibakód nélkül nincs sáv", () => {
    expect(errorBand(undefined)).toBe("");
  });

  it("az already_resolved semmit nem mutat", () => {
    // A kívánt állapot fennáll. Ez nem hiba, csak egy kétszer megnyomott gomb.
    expect(errorBand("already_resolved")).toBe("");
  });

  it("a naptár-hiba riasztást kap, és megmondja, hogy nyitva maradt", () => {
    const sav = errorBand("calendar_failed");
    expect(sav).toContain("riado");
    expect(sav).toContain("nyitva");
  });

  it("a not_found és a wrong_kind nem riaszt", () => {
    // Nem történt semmi, és nem is a szerver hibája.
    for (const kod of ["not_found", "wrong_kind"]) {
      const sav = errorBand(kod);
      expect(sav, kod).not.toBe("");
      expect(sav, kod).not.toContain("riado");
    }
  });

  it("ismeretlen kódot nem visszhangoz a lapra", () => {
    // A query string bárkitől jöhet; egy ismeretlen kód kiírása tükrözött
    // tartalom lenne.
    expect(errorBand("<script>alert(1)</script>")).toBe("");
    expect(errorBand("akarmi")).toBe("");
  });

  it("a riasztás színe csak a naptár-hibánál jelenik meg", () => {
    const rules = STYLE.split("\n").filter((l) => l.trimStart().startsWith(".hibasav"));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((l) => l.includes("riado")).every((l) => l.includes("riado"))).toBe(true);
  });

  it("az űrlapgomb nem örökli a kérdés-űrlap flex elrendezését", () => {
    // A theme.ts-ben van egy elem-szintű `form { display: flex; margin-top:
    // 1.4rem; }` szabály a kérdés-űrlaphoz. Felülírás nélkül minden
    // teendő-gomb 1,4rem-mel lejjebb csúszna a saját sorában.
    expect(/\.muvelet \{[^}]*margin-top:\s*0/.test(STYLE)).toBe(true);
    expect(/\.muvelet \{[^}]*display:\s*inline/.test(STYLE)).toBe(true);
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/view-actions.test.ts`
Expected: FAIL — `Cannot find module '.../view/actions.ts'`

- [ ] **Step 3: Írd meg a modult**

Hozd létre a `src/delivery/http/view/actions.ts` fájlt:

```ts
import { escapeHtml } from "../markdown.ts";

export interface ActionRow {
  id: string;
  kind: "checkbox" | "proposal";
  text: string;
  /** The module's own title, or its raw name when no module matches. */
  modul: string;
  /**
   * Already-worded detail lines for a proposal — when it starts, where, and
   * its note. Empty for a checkbox.
   *
   * A button that writes to the calendar needs more beside it than a title:
   * these are the lines a person reads BEFORE accepting.
   */
  reszletek: readonly string[];
}

export interface UndoableWrite {
  eventUid: string;
  title: string;
  startsAt: string;
  calendar: string;
}

export interface ActionsData {
  /** Open actions grouped by day, newest day first. */
  napok: readonly { date: string; items: readonly ActionRow[] }[];
  undoable: readonly UndoableWrite[];
}

/**
 * One button, as its own form.
 *
 * A form rather than a link because this changes state, and a prefetching
 * browser or a link checker fires GETs on its own. The action id travels in
 * the path, so the form carries no fields at all.
 */
function gomb(action: string, label: string): string {
  return `<form class="muvelet" method="post" action="${action}">`
    + `<button type="submit">${escapeHtml(label)}</button></form>`;
}

function sor(r: ActionRow): string {
  const muveletek = r.kind === "checkbox"
    ? gomb(`/teendo/${encodeURIComponent(r.id)}/kesz`, "Kész")
    : gomb(`/teendo/${encodeURIComponent(r.id)}/elfogad`, "Elfogadom")
      + gomb(`/teendo/${encodeURIComponent(r.id)}/elutasit`, "Elutasítom");

  const reszletek = r.reszletek.length === 0
    ? ""
    : `<p class="halk">${r.reszletek.map((d) => escapeHtml(d)).join(" · ")}</p>`;

  return [
    `<div class="teendo">`,
    `<div class="mit"><span class="cimke">${escapeHtml(r.modul)}</span>`,
    `<span class="szoveg">${escapeHtml(r.text)}</span>${reszletek}</div>`,
    `<div class="muveletek">${muveletek}</div>`,
    "</div>",
  ].join("");
}

/**
 * The two write bands: what is still open, and what can still be undone.
 *
 * Each is absent rather than empty when it has nothing to say — an "Teendők"
 * heading with a void beneath it is missing data that does not look missing.
 */
export function actionsBody(d: ActionsData): string {
  const teendok = d.napok.length === 0 ? "" : [
    "<section><h2>Teendők</h2>",
    d.napok.map((nap) =>
      `<h3>${escapeHtml(nap.date)}</h3><div class="teendok">`
      + `${nap.items.map(sor).join("")}</div>`).join(""),
    "</section>",
  ].join("");

  const vissza = d.undoable.length === 0 ? "" : [
    "<section><h2>Visszavonható</h2><div class=\"teendok\">",
    d.undoable.map((w) => [
      `<div class="teendo">`,
      `<div class="mit"><span class="cimke">${escapeHtml(w.calendar)}</span>`,
      `<span class="szoveg">${escapeHtml(w.title)}</span>`,
      `<p class="halk">${escapeHtml(w.startsAt)}</p></div>`,
      `<div class="muveletek">`,
      gomb(`/naptar/${encodeURIComponent(w.eventUid)}/visszavon`, "Visszavonom"),
      "</div></div>",
    ].join("")).join(""),
    "</div></section>",
  ].join("");

  return `${teendok}${vissza}`;
}

/**
 * What each write error says to the reader, and how loudly.
 *
 * The list is closed on purpose: the code arrives in the query string, which
 * anybody can write, so anything not on this list renders nothing rather than
 * being echoed back onto the page.
 *
 * `already_resolved` is absent from the list deliberately, not by oversight.
 * It is what a double tap produces, and the state the reader wanted already
 * holds — an alarm that fires when nothing is wrong is exactly the kind of
 * indicator this project refuses everywhere else.
 */
const HIBAK: Record<string, { szoveg: string; riaszt: boolean }> = {
  calendar_failed: {
    szoveg: "Nem sikerült a naptárba írni. A teendő nyitva maradt, újra megpróbálhatod.",
    riaszt: true,
  },
  not_found: { szoveg: "Ez a teendő már nincs meg.", riaszt: false },
  wrong_kind: { szoveg: "Ezt a műveletet nem erre a fajta teendőre lehet.", riaszt: false },
};

export function errorBand(code: string | undefined): string {
  const hiba = code === undefined ? undefined : HIBAK[code];
  if (hiba === undefined) return "";
  return `<p class="hibasav${hiba.riaszt ? " riaszt" : ""}">${escapeHtml(hiba.szoveg)}</p>`;
}
```

- [ ] **Step 4: Add hozzá a CSS-t**

A `theme.ts`-ben a `/* ---- területi oldalak ---- */` blokk ELŐTT illeszd be:

```css

/* ---- teendők és írási műveletek ---- */
.teendok { display: grid; gap: 1px; background: var(--racs);
  border: 1px solid var(--racs); }
.teendo { display: flex; justify-content: space-between; align-items: center;
  gap: .8rem; padding: .7rem .8rem; background: var(--lap); }
.teendo .cimke { display: block; font: .64rem/1.4 var(--mono); letter-spacing: .1em;
  text-transform: uppercase; color: var(--halvany); }
.teendo .szoveg { display: block; }
.teendo p.halk { margin: .25rem 0 0; font: .74rem/1.5 var(--mono); }
.muveletek { display: flex; gap: .4rem; flex: 0 0 auto; }
/* A kérdés-űrlapé egy elem-szintű `form` szabály flex elrendezéssel és 1,4rem
   felső margóval; enélkül minden gomb lecsúszna a saját sorában. */
.muvelet { display: inline; margin-top: 0; gap: 0; }
.muvelet button { padding: .45rem .8rem; border: 1px solid var(--vaz);
  border-radius: .3rem; background: transparent; color: var(--vaz); cursor: pointer;
  font: 600 .66rem/1.4 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
.muvelet button:hover { border-color: var(--jel); color: var(--jel); }
.muvelet button:focus-visible { outline: 2px solid var(--jel); outline-offset: 2px; }
.hibasav { margin: 0 0 1rem; padding: .6rem .8rem; border: 1px solid var(--racs);
  border-radius: .3rem; color: var(--halvany);
  font: .76rem/1.5 var(--mono); }
.hibasav.riaszt { border-color: var(--riado); color: var(--riado); }
```

Figyeld meg: a `--riado` **egyetlen** új szabályban szerepel, a
`.hibasav.riaszt`-ban. Sehol máshol.

- [ ] **Step 5: Futtasd a teszteket**

Run: `npx vitest run test/delivery/view-actions.test.ts test/delivery/view-theme.test.ts`
Expected: PASS mind

- [ ] **Step 6: Mutációs ellenőrzés**

A `sor()`-ban add mindkét fajtának mind a három gombot (töröld a `kind`
szerinti elágazást), és futtasd újra.
Expected: FAIL — „a checkbox egyetlen Kész gombot kap". Állítsd vissza.

Az `errorBand`-ben cseréld a `HIBAK[code]` keresést arra, hogy minden kódra
visszaad egy sávot a kód szövegével, és futtasd újra.
Expected: FAIL — „ismeretlen kódot nem visszhangoz a lapra". Állítsd vissza.

Az `actionsBody`-ban cseréld a `d.napok.length === 0 ? "" :` őrt `false ? "" :`-re,
és futtasd újra. Expected: FAIL — „nyitott teendő nélkül nem ad üres címet".
Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/delivery/http/view/actions.ts src/delivery/http/view/theme.ts test/delivery/view-actions.test.ts
git commit -m "feat: teendő- és visszavonás-sáv, JS nélküli gombokkal"
```

---

### Task 4: Bekötés a Ma oldalra

**Files:**
- Modify: `src/delivery/http/routes/page-shell.ts` (`PageDeps` két új mezővel)
- Modify: `src/delivery/http/routes/page.ts` (a `/` útvonal)
- Modify: `src/delivery/http/view/today.ts`
- Modify: `src/delivery/http/server.ts` (az új deps átadása)
- Modify: `test/helpers.ts` (a bővült deps)
- Test: `test/delivery/page.test.ts` (bővül)

**Interfaces:**
- `PageDeps` két új mezőt kap:
  ```ts
  actions: ActionRepo;                    // ../../../infra/db/repositories/actions.ts
  proposals: ProposalService;             // ../../../core/proposals.ts
  modules: readonly JarvisModule[];       // ../../../core/module.ts — `name` és `title` mezőkkel
  ```
- A `todayBody` adatobjektuma két új mezőt kap: `hibaKod: string | undefined`
  és `actions: ActionsData`.

- [ ] **Step 1: Írd meg a bukó tesztet**

Illeszd a `test/delivery/page.test.ts` végére (az importokat egészítsd ki
azzal, ami hiányzik):

```ts
describe("Ma oldal — teendők", () => {
  const boot = () => buildTestApp({
    modules: [stubModule({ name: "Teszt", title: "🧪 Teszt" })],
    now: "2026-09-03T08:00:00.000Z",
  });
  const get = (a: Awaited<ReturnType<typeof boot>>, url: string) =>
    a.server.inject({ method: "GET", url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });

  /** Only the Teendők band — the rest of the page also renders text. */
  const teendokSav = (html: string): string =>
    /<h2>Teendők<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

  it("a nem mai nyitott teendőt is mutatja", async () => {
    // Ez a bekötés egyetlen valódi kockázata: a listOpen(ma) a valódi
    // adatbázison üres listát ad, és a lap azt állítaná, hogy nincs teendő.
    const a = await boot();
    a.actions.replaceForDate("2026-08-30", [{
      module: "Teszt",
      action: { id: "r1", kind: "checkbox", text: "RÉGI-JELÖLŐ" },
    }], new Date("2026-08-30T08:00:00.000Z"));

    const res = await get(a, "/");
    const sav = teendokSav(res.body);
    expect(sav).toContain("RÉGI-JELÖLŐ");
    expect(sav).toContain("2026-08-30");
    await a.close();
  });

  it("a modul saját címét használja címkének", async () => {
    const a = await boot();
    a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: { id: "c1", kind: "checkbox", text: "x" },
    }], new Date("2026-09-03T08:00:00.000Z"));
    expect(teendokSav((await get(a, "/")).body)).toContain("🧪 Teszt");
    await a.close();
  });

  it("ismeretlen modulnál a nyers nevet mutatja", async () => {
    // Egy eltűnt modulhoz kitalálni egy szép nevet hazugság volna.
    const a = await boot();
    a.actions.replaceForDate("2026-09-03", [{
      module: "MarNincsIlyen",
      action: { id: "c2", kind: "checkbox", text: "x" },
    }], new Date("2026-09-03T08:00:00.000Z"));
    expect(teendokSav((await get(a, "/")).body)).toContain("MarNincsIlyen");
    await a.close();
  });

  it("teendő nélkül nincs Teendők sáv", async () => {
    const a = await boot();
    expect((await get(a, "/")).body).not.toContain("<h2>Teendők</h2>");
    await a.close();
  });

  it("a hibakódot a query stringből veszi", async () => {
    const a = await boot();
    const res = await get(a, "/?hiba=calendar_failed");
    expect(res.body).toContain("Nem sikerült a naptárba írni");
    await a.close();
  });

  it("ismeretlen hibakódot nem visszhangoz", async () => {
    const a = await boot();
    const res = await get(a, "/?hiba=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).not.toContain("hibasav");
    await a.close();
  });

  it("a hibázó teendő-lekérdezés nem viszi el a briefinget", async () => {
    // Az F1 óta érvényes minta: minden darab magában bukik.
    const a = await boot();
    (a.actions as unknown as { listAllOpen: () => never }).listAllOpen = () => {
      throw new Error("szándékos hiba");
    };
    const res = await get(a, "/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("A mai nap");
    await a.close();
  });
});
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `npx vitest run test/delivery/page.test.ts`
Expected: FAIL — nincs Teendők sáv, és `a.actions` esetleg nem létezik

- [ ] **Step 3: Bővítsd a PageDeps-et**

A `src/delivery/http/routes/page-shell.ts`-ben a `PageDeps` interfészbe:

```ts
  actions: ActionRepo;
  proposals: ProposalService;
  /** For turning a stored module NAME into that module's own title. */
  modules: readonly JarvisModule[];
```

és az importok közé a három típus (`ActionRepo` a
`../../../infra/db/repositories/actions.ts`-ből, `ProposalService` a
`../../../core/proposals.ts`-ből, `JarvisModule` a `../../../core/module.ts`-ből
— ellenőrizd a pontos export-neveket a fájlokban).

- [ ] **Step 4: Írd meg a `/` útvonal új részét**

A `src/delivery/http/routes/page.ts`-ben cseréld a `/` útvonalat:

```ts
  app.get<{ Querystring: { hiba?: string } }>("/", async (request, reply) => {
    const now = deps.clock.now();
    const inputs = await shellInputs(deps, now);

    // A module's own title, or its raw name when the module is gone. Inventing
    // a nicer label for a module that no longer exists would be a lie about
    // where the action came from.
    const cim = (name: string) =>
      deps.modules.find((m) => m.name === name)?.title ?? name;

    // Its own try/catch, like every other input this page assembles: a failing
    // action repo must drop the todo band, never the briefing.
    let napok: ActionsData["napok"] = [];
    try {
      const byDate = new Map<string, ActionRow[]>();
      for (const a of deps.actions.listAllOpen()) {
        const items = byDate.get(a.date) ?? [];
        items.push({
          id: a.id,
          kind: a.kind,
          text: a.text,
          modul: cim(a.module),
          reszletek: a.proposal === null ? [] : [
            a.proposal.start,
            ...(a.proposal.location ? [a.proposal.location] : []),
            ...(a.proposal.notes ? [a.proposal.notes] : []),
          ],
        });
        byDate.set(a.date, items);
      }
      napok = [...byDate.entries()].map(([date, items]) => ({ date, items }));
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its actions");
    }

    // Separately guarded: a failing calendar-write repo must not take the
    // todo band with it.
    let undoable: ActionsData["undoable"] = [];
    try {
      undoable = deps.proposals.listUndoable(20);
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "page rendered without its undoable writes");
    }

    return reply.type("text/html; charset=utf-8").send(render("ma", inputs, todayBody({
      briefMarkdown: inputs.briefMarkdown,
      readings: inputs.readings,
      lastSeen: inputs.lastSeen,
      writtenAge: inputs.writtenAge,
      hibaKod: request.query.hiba,
      actions: { napok, undoable },
    })));
  });
```

`listAllOpen()` már `date DESC` szerint rendez, tehát a `Map` beszúrási
sorrendje a helyes napsorrendet őrzi — a `Map` a JS-ben megőrzi a beszúrás
sorrendjét, és ezen múlik, hogy a legfrissebb nap kerül elöl.

Vedd fel az importokat: `type ActionRow, type ActionsData` a
`../view/actions.ts`-ből.

- [ ] **Step 5: Bővítsd a today.ts-t**

A `TodayData` interfészbe:

```ts
  /** The write error carried back through the redirect, if any. */
  hibaKod: string | undefined;
  actions: ActionsData;
```

és a `todayBody` visszatérésébe — a hibasáv **legelöl**, a két új sáv a mérések
után:

```ts
  return [
    errorBand(data.hibaKod),
    `<section><h2>Briefing</h2>${brief}</section>`,
    `<section><h2>A mai nap</h2>${stale}${written}`,
    `<div class="csatornak">${data.readings.map(channelRow).join("")}</div></section>`,
    actionsBody(data.actions),
  ].join("");
```

Vedd fel az importot: `actionsBody, errorBand, type ActionsData` a
`./actions.ts`-ből.

- [ ] **Step 6: Add át az új függőségeket**

A `src/delivery/http/server.ts`-ben a `pageDeps` objektumba:

```ts
    actions: deps.actions, proposals: deps.proposals, modules: deps.modules,
```

Ha a `ServerDeps`-en nincs `actions` mező, vedd fel (`ActionRepo` típussal), és
add át a `src/main.ts`-ből (`app.actions`) meg a `test/helpers.ts`-ből (a
`buildTestApp` törzsében már létezik `actions` néven). A `proposals` és a
`modules` már ott van a `ServerDeps`-en.

A `test/helpers.ts` `TestApp` interfészébe vedd fel az `actions: ActionRepo`
mezőt és add hozzá a visszatérő objektumhoz — a fenti tesztek ezen keresztül
vetnek teendőt.

- [ ] **Step 7: Futtasd a teljes suite-ot**

Run: `npm test && npx tsc --noEmit`
Expected: minden zöld, `tsc` néma. A meglévő Ma-oldal tesztek nem változhatnak
— ha valamelyik elbukik, a bekötés vitt el valamit, amit nem kellett volna.

- [ ] **Step 8: Mutációs ellenőrzés**

Cseréld a `deps.actions.listAllOpen()`-t `deps.actions.listOpen(isoDate(now, TZ))`-re,
és futtasd újra. Expected: FAIL — „a nem mai nyitott teendőt is mutatja".
Állítsd vissza.

Cseréld a `cim()` visszatérését `name`-re (mindig a nyers név), és futtasd
újra. Expected: FAIL — „a modul saját címét használja címkének". Állítsd
vissza.

Vedd ki a két külön `try/catch` közül a másodikat úgy, hogy egy közösbe
kerüljön mindkét olvasás, és dobasd el az elsőt — futtasd újra.
Expected: FAIL — „a hibázó teendő-lekérdezés nem viszi el a briefinget" vagy
egy 500. Állítsd vissza, futtasd újra: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: a teendők és a visszavonás a Ma oldalon"
```

---

## Önátnézés

**Spec-lefedettség.**

| Spec-szakasz | Feladat |
|---|---|
| `listAllOpen()`, az összes nyitott teendő | Task 1 |
| Form content-type parser, nulla függőséggel | Task 2 |
| Négy írási útvonal, 303-mal | Task 2 |
| CSRF: nincs új felület (SameSite=Strict) | Task 2 (komment + auth-tesztek) |
| A hibakódok megjelenése és az `already_resolved` némasága | Task 2 (útvonal) + Task 3 (sáv) |
| Teendők sáv, dátum szerint csoportosítva | Task 3 + Task 4 |
| A modul saját címe címkeként | Task 4 |
| A javaslat részletei a gomb mellett | Task 3 + Task 4 |
| Visszavonható naptár-írások sávja | Task 3 + Task 4 |
| Hibatűrés: darabonkénti try/catch | Task 4 |
| Ellenőrzés: 401, százalék-kódolás, GET tiltva, 415-regresszió | Task 2 |

Nincs lefedetlen spec-követelmény.

**Két csapda, amit a terv szándékosan előre kimond.**

1. A `theme.ts` elem-szintű `form` szabálya elrontaná az új gombokat; a Task 3
   ezért ad nekik `class="muvelet"`-et explicit felülírásokkal, és tesztet is
   ír rá. A meglévő `form` szabályhoz nem nyúlunk — F1-kód, saját tesztekkel.
2. A `listOpen(ma)` **ma üres listát ad**. A Task 1 és a Task 4 tesztje is
   pontosan azt a fixtúrát használja, ami ezt a változatot elbuktatja.

**Sorrendfüggőség.** A Task 1 és a Task 3 független egymástól; a Task 2 a
Task 1-től nem függ; a Task 4 mindháromra épül. A teljes suite végig zöld
marad — ebben a tervben nincs szándékos piros állapot.
