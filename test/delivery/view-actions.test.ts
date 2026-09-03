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
    // A riasztás a "riaszt" osztálynévben jelenik meg a jelölésben; a
    // "--riado" a hozzá tartozó CSS-változó neve, ami csak a stíluslapban
    // szerepel, ezért itt a class nevet ellenőrizzük.
    const sav = errorBand("calendar_failed");
    expect(sav).toContain("riaszt");
    expect(sav).toContain("nyitva");
  });

  it("a not_found és a wrong_kind nem riaszt", () => {
    // Nem történt semmi, és nem is a szerver hibája.
    for (const kod of ["not_found", "wrong_kind"]) {
      const sav = errorBand(kod);
      expect(sav, kod).not.toBe("");
      expect(sav, kod).not.toContain("riaszt");
    }
  });

  it("ismeretlen kódot nem visszhangoz a lapra", () => {
    // A query string bárkitől jöhet; egy ismeretlen kód kiírása tükrözött
    // tartalom lenne.
    expect(errorBand("<script>alert(1)</script>")).toBe("");
    expect(errorBand("akarmi")).toBe("");
  });

  it("a riasztás színe csak a naptár-hibánál jelenik meg", () => {
    // Soronkénti szűrés hamis biztonságot adna: ez a fájl a szabályokat
    // több sorra töri, és egy folytatósoron lévő `--riado` (pl. a
    // `.hibasav` alapszabály `color:` sorában) nem kezdődik `.hibasav`-val,
    // tehát egy sor-alapú szűrő némán kihagyná — pontosan azt a hibát nem
    // látná, amit ez a teszt hivatott elkapni. Ezért a teljes szabály-
    // blokkokat (a szelektortól a záró `}`-ig) vizsgáljuk, nem sorokat.
    const blocks = [...STYLE.matchAll(/\.hibasav[^{]*\{[^}]*\}/g)].map((m) => m[0]);
    expect(blocks.length).toBeGreaterThan(0);
    const alap = blocks.filter((b) => !b.startsWith(".hibasav.riaszt"));
    const riaszt = blocks.filter((b) => b.startsWith(".hibasav.riaszt"));
    expect(alap.length).toBeGreaterThan(0);
    expect(riaszt.length).toBeGreaterThan(0);
    expect(alap.some((b) => b.includes("riado"))).toBe(false);
    expect(riaszt.some((b) => b.includes("riado"))).toBe(true);
  });

  it("az űrlapgomb nem örökli a kérdés-űrlap flex elrendezését", () => {
    // A theme.ts-ben van egy elem-szintű `form { display: flex; margin-top:
    // 1.4rem; }` szabály a kérdés-űrlaphoz. Felülírás nélkül minden
    // teendő-gomb 1,4rem-mel lejjebb csúszna a saját sorában.
    expect(/\.muvelet \{[^}]*margin-top:\s*0/.test(STYLE)).toBe(true);
    expect(/\.muvelet \{[^}]*display:\s*inline/.test(STYLE)).toBe(true);
  });
});
