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
    // A complete() nem őriz státuszt (proposals.ts), tehát ez a kétszeri
    // POST nem az already_resolved ágat futtatja — az a kesz-en elérhetetlen.
    // Ez a teszt azt rögzíti, hogy egy dupla tap ezen az útvonalon is
    // ártalmatlan marad, nem pedig azt, hogy a hibakód-ág kimarad.
    const a = await boot();
    const id = seedCheckbox(a);
    await post(a, `/teendo/${id}/kesz`);
    const masodik = await post(a, `/teendo/${id}/kesz`);
    expect(masodik.statusCode).toBe(303);
    expect(masodik.headers.location).toBe("/");
  });

  it("kétszer elfogadott javaslat másodszorra is tisztán tér vissza", async () => {
    // Az already_resolved ágat a kesz nem tudja elérni (complete() nem őriz
    // státuszt) — csak accept() és undo() dobja. A harness naptára mindig
    // elérhetetlen, ezért az első elfogadás nem tud sikerrel lezárulni; a már
    // elfogadott állapotot közvetlenül a repón keresztül állítjuk be, hogy az
    // accept() a saját already_resolved ágába fusson, naptár-hívás nélkül.
    const a = await boot();
    const rows = a.actions.replaceForDate("2026-09-03", [{
      module: "Teszt",
      action: {
        id: "p3", kind: "proposal", text: "Kirándulás",
        proposal: { title: "K", start: "2026-09-05T09:00:00+02:00", end: "2026-09-05T12:00:00+02:00" },
      },
    }], new Date("2026-09-03T08:00:00.000Z"));
    const id = rows[0]!.id;
    a.actions.setStatus(id, "accepted", new Date("2026-09-03T08:00:00.000Z"));
    const res = await post(a, `/teendo/${id}/elfogad`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/");
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
    expect(res.statusCode).toBe(303);
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
    expect(res.statusCode).toBe(303);
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
    expect(res.headers.location).toBe("/?hiba=not_found");
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
