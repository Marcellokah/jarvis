import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { plot } from "../../src/delivery/http/view/chart/plot.ts";
import { SOROZATOK } from "../../src/delivery/http/view/chart/registry.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";

const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

const hrv = SOROZATOK.get("hrv")!;

/**
 * Azok a hézagsávok, amelyeken átfut egy kirajzolt vonalszakasz.
 *
 * A kirajzolt SVG-ből olvas — a sávok saját `x`/`width` értékéből és a
 * `vonal` útvonalak saját pontjaiból —, nem a plot belső változóiból: a hiba
 * pontosan a kettő eltérésében élt.
 */
const bandsCrossedBy = (html: string): string[] => {
  const bands = [...html.matchAll(/<rect class="hezag" x="([\d.]+)"[^>]*width="([\d.]+)"/g)]
    .map((m) => ({ x1: Number(m[1]), x2: Number(m[1]) + Number(m[2]) }));
  const links: { xa: number; xb: number }[] = [];
  for (const m of html.matchAll(/<path class="vonal"[^>]*d="([^"]+)"/g)) {
    const xs = [...m[1]!.matchAll(/[ML]([\d.]+) [\d.]+/g)].map((p) => Number(p[1]));
    for (let i = 1; i < xs.length; i++) links.push({ xa: xs[i - 1]!, xb: xs[i]! });
  }
  return bands
    .filter((b) => links.some((l) => l.xa < b.x2 && l.xb > b.x1))
    .map((b) => `${b.x1}–${b.x2}`);
};

/**
 * Azok a szakadások, amelyek alatt nincs hézagsáv.
 *
 * A `bandsCrossedBy` párja, és ugyanannyira szükséges: az első javítás egy
 * oszloppal odébb tette a törést, tehát EGYSZERRE hagyott átvágott sávot és
 * vágott el folytonos szakaszt. Csak a kettő együtt mondja meg, hogy a törés
 * ott van-e, ahol a lyuk.
 */
const unjustifiedBreaks = (html: string): string[] => {
  const bands = [...html.matchAll(/<rect class="hezag" x="([\d.]+)"[^>]*width="([\d.]+)"/g)]
    .map((m) => ({ x1: Number(m[1]), x2: Number(m[1]) + Number(m[2]) }));
  const ends = [...html.matchAll(/<path class="vonal"[^>]*d="([^"]+)"/g)].map((m) => {
    const xs = [...m[1]!.matchAll(/[ML]([\d.]+) [\d.]+/g)].map((p) => Number(p[1]));
    return { first: xs[0]!, last: xs.at(-1)! };
  });
  const out: string[] = [];
  for (let i = 1; i < ends.length; i++) {
    const xa = ends[i - 1]!.last, xb = ends[i]!.first;
    if (!bands.some((b) => xa < b.x2 && xb > b.x1)) out.push(`${xa}→${xb}`);
  }
  return out;
};

describe("nagy diagram", () => {
  it("a szokatlan hézag helyén sávot rajzol", () => {
    // A megszakadt vonal csak azt mondja, volt lyuk; a sáv azt is, meddig tartott.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-09", days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5));
    expect(plot(s, hrv)).toContain('class="hezag"');
  });

  it("hézag nélkül nincs sáv", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 1, 2, 3, 4, 5));
    expect(plot(s, hrv)).not.toContain('class="hezag"');
  });

  it("a hézagsáv nem riasztó színnel rajzolódik", () => {
    // Egy 2021-es lyuk nem hiba, csak hiány. A magenta az állapotsávé.
    //
    // Ez a szabály a stíluslapban él, nem a plot() kimenetében — a kimenet
    // csak osztályneveket ír ki. A korábbi változat ezért azt nézte, hogy a
    // plot() kimenete nem tartalmazza a "riado" alstringet, ami sosem
    // tartalmazhatta: a teszt nem tudott megbukni. Most a szabályt magát
    // nézzük, és azt is, hogy egyáltalán megtaláltuk — különben egy átnevezett
    // osztály üresen, hamis nyugalommal futtatná le.
    // Minden ilyen szabály, nem csak az első: az animációs blokk ugyanezt a
    // szelektort újra megnyitja, és ott is igaznak kell lennie.
    const rules = (selector: string) =>
      [...STYLE.matchAll(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
    expect(rules(".plot .hezag").length).toBeGreaterThan(0);
    expect(rules(".plot .sav").length).toBeGreaterThan(0);
    expect(rules(".plot .hezag").join("")).not.toContain("riado");
    expect(rules(".plot .sav").join("")).not.toContain("riado");
  });

  it("minden oszlophoz tartozik billentyűzettel elérhető olvasó", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 1, 2, 3, 4, 5));
    const html = plot(s, hrv);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="olvaso"');
  });

  it("mérés nélkül azt mondja, hogy nincs mérés", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-03", days("2026-01-01", null, null, null));
    const html = plot(s, hrv);
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("NaN");
  });

  it("szavakban is elmondja, amit a kép", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 40, 50, null, null, 60));
    expect(plot(s, hrv)).toMatch(/<title>[^<]*3 mérés[^<]*<\/title>/);
  });

  it("csoport marad, nem lapított kép — a fókuszálható célpontok egyenként elérhetők", () => {
    // role="img" atomizálná a teljes fát: a benne lévő fókuszálható <rect>-ek
    // eltűnnének a kisegítő fa elemzéséből, egy Tabbal odaérkező felolvasó
    // semmit nem mondana. A role="group" ezt megőrzi, az összefoglalót pedig
    // a csoport saját aria-label/<title> párja viszi tovább — az egyetlen
    // forma, amiben ez az információ egy nem látó olvasóhoz eljut.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 1, 2, 3, 4, 5));
    const html = plot(s, hrv);
    expect(html).not.toContain('role="img"');
    expect(html).toContain('role="group"');
    expect(html).toMatch(/aria-label="[^"]*mérés[^"]*"/);
  });

  it("sűrű sorozatnál oszloponként egy olvasót ad, nem mérésenként egyet", () => {
    // 700 napi mérés a 660 pixeloszlopos rajzterületen sűrű: bucketise()
    // szerint minden oszlop a saját min-max-medián tartományát rajzolja, nem
    // az egyes méréseket. Az olvasónak ugyanezt kell mondania — ha mérésenként
    // adna célpontot, egy 7 éves sorozat több ezer, egymást fedő, Tab-bal
    // végigjárhatatlan fókuszpontot eredményezne, és az olvasott szöveg nem
    // azt írná le, amit a sáv mutat.
    const n = 700;
    const vals = Array.from({ length: n }, (_, i) => 40 + (i % 7));
    const rows = days("2024-01-01", ...vals);
    const s = buildSeries("hrv", "2024-01-01", rows.at(-1)!.date, rows);
    const html = plot(s, hrv);
    const readerCount = (html.match(/tabindex="0"/g) ?? []).length;
    expect(readerCount).toBeLessThan(n);
    expect(readerCount).toBeGreaterThan(0);
    expect(html).not.toContain("NaN");
  });

  it("sűrű sorozatban sem húz vonalat a saját hézagsávján át", () => {
    // Ez az ág bukott meg a valódi adaton. Sűrűnél a törés egyetlen feltétele
    // az volt, hogy egy PIXELOSZLOP üresen maradjon — a tulajdonos
    // előzményén viszont a HRV 37 hézagjából 37, a nyugalmi pulzusé 66-ból 65
    // KESKENYEBB egy oszlopnál, tehát üres oszlop sosem keletkezett, és a
    // mediánvonal átment a saját, kirajzolt hézagsávján: pontosan azokon a
    // napokon, amikről nincs adat.
    //
    // A minta ezt az alakot állítja elő: 2000 napi mérés (sűrű, 660 oszlop),
    // egy oszlop 3,03 nap — a közepén egy 3 napos lyuk, ami így egyetlen
    // oszlopon belül marad, üres oszlopot nem hagy maga után.
    const vals: (number | null)[] = Array.from({ length: 2001 }, (_, i) => 40 + (i % 5));
    vals[1001] = null;
    vals[1002] = null;
    const rows = days("2020-01-01", ...vals);
    const s = buildSeries("hrv", "2020-01-01", rows.at(-1)!.date, rows);
    expect(s.points.length).toBeGreaterThan(660); // tényleg a sűrű ág
    expect(s.gaps).toHaveLength(1);

    const html = plot(s, hrv);
    expect(html).toContain('class="hezag"');
    // NEM az útvonalak SZÁMÁT nézzük. Az első javítás megtörte a vonalat —
    // két útvonal lett belőle —, csak épp egy oszloppal a sáv mellett: a
    // darabszám nőtt, a mértan nem követte, és a sávot továbbra is átvágta
    // egy szakasz. A számlálás ezt nem látja, a mértan igen.
    expect(bandsCrossedBy(html)).toEqual([]);
    // A szakadás valóban ott van, ahol a lyuk: a két oldal nincs összekötve.
    expect((html.match(/class="vonal"/g) ?? []).length).toBeGreaterThan(1);
  });

  it("sűrűnél nem szakítja meg a vonalat ott, ahol nincs hézag", () => {
    // A törés másik iránya, ugyanabból a hibából: az oszlopindexből
    // visszaszámolt töréspont egy folytonos szakaszt vágott el — egy
    // oszloppal a sáv előtt —, miközben a metszőt meghagyta.
    // A 316. és 317. nap hiányzik: 2000 nap 660 oszlopon 3,03 nap
    // oszloponként, és ez a lyuk mindkét végével UGYANABBA az oszlopba esik.
    // Az oszlopindexből számolt törés ilyenkor a lyuk ELÉ került.
    const vals: (number | null)[] = Array.from({ length: 2000 }, (_, i) => 40 + (i % 5));
    vals[316] = null;
    vals[317] = null;
    const rows = days("2020-01-01", ...vals);
    const s = buildSeries("hrv", rows[0]!.date, rows.at(-1)!.date, rows);
    expect(s.points.length).toBeGreaterThan(660);
    expect(s.gaps).toHaveLength(1);
    const html = plot(s, hrv);
    expect(unjustifiedBreaks(html)).toEqual([]);
    expect(bandsCrossedBy(html)).toEqual([]);

    // Hézag nélkül pedig egyáltalán nincs mit megtörni.
    const nincs = days("2020-01-01", ...Array.from({ length: 1500 }, (_, i) => 40 + (i % 5)));
    const s2 = buildSeries("hrv", nincs[0]!.date, nincs.at(-1)!.date, nincs);
    expect(s2.gaps).toHaveLength(0);
    expect((plot(s2, hrv).match(/class="vonal"/g) ?? [])).toHaveLength(1);
  });

  it("sok, eltérő szélességű hézagnál is minden sávot kikerül a vonal", () => {
    // A tulajdonos valódi HRV-előzményének alakja: sok rövid lyuk, néhány
    // hosszú. 37 sávból 34-et vágott át a vonal a javítás után is.
    const vals: (number | null)[] = Array.from({ length: 2400 }, (_, i) => 40 + (i % 9));
    for (const [start, len] of [[120, 2], [400, 3], [401 + 60, 9], [900, 2], [1300, 40], [1700, 2], [2000, 5]]) {
      for (let i = 0; i < len!; i++) vals[start! + i] = null;
    }
    const rows = days("2019-01-01", ...vals);
    const s = buildSeries("hrv", rows[0]!.date, rows.at(-1)!.date, rows);
    expect(s.points.length).toBeGreaterThan(660);
    expect(s.gaps.length).toBeGreaterThan(3);
    const html = plot(s, hrv);
    expect((html.match(/class="hezag"/g) ?? []).length).toBe(s.gaps.length);
    expect(bandsCrossedBy(html)).toEqual([]);
    expect(unjustifiedBreaks(html)).toEqual([]);
  });

  it("sűrűnél a magában álló oszlopot pontnak rajzolja, nem semmit", () => {
    // Egy csak "M"-et tartalmazó útvonal érvényes SVG, és pontosan nulla
    // pixelt fest: a két hézag közé szorult egyetlen oszlop nyomtalanul
    // eltűnt. A ritka ág mindig kört rajzolt oda.
    const vals = [
      ...Array.from({ length: 700 }, (_, i) => 40 + (i % 5)),
      ...new Array(60).fill(null),
      88,
    ];
    const rows = days("2024-01-01", ...vals);
    const s = buildSeries("hrv", "2024-01-01", rows.at(-1)!.date, rows);
    expect(s.points.length).toBeGreaterThan(660);
    const html = plot(s, hrv);
    expect(html).toContain('class="pont"');
    expect(html).not.toMatch(/class="vonal" pathLength="1" d="M[\d.]+ [\d.]+"/);
  });

  it("a szórás nélküli sorozat középen fut, nem a tengelyen ül", () => {
    // Valódi eset: a hatperces séta 49 mérése mind 500 m. A sparkline
    // középre teszi (range === 0 → H/2), a nagy nézet a keret aljára
    // szorította, három egyforma rácsfelirattal — ugyanaz a sor két
    // ellentmondó képet mutatott. A középvonal a becsületes: az alsó él a
    // metrika valaha mért legkisebb értékét jelentené.
    const spec = SOROZATOK.get("six_min_walk_m")!;
    const s = buildSeries("six_min_walk_m", "2026-01-01", "2026-01-05", days("2026-01-01", 500, 500, 500, 500, 500));
    const html = plot(s, spec);
    // T + IH/2 = 10 + 228/2 = 124.
    expect(html).toMatch(/class="vonal"[^>]*d="M[\d.]+ 124/);
    // Egyetlen rácsfelirat, nem három egyforma.
    expect((html.match(/>500 m</g) ?? [])).toHaveLength(1);
  });

  it("ritka sorozatnál sem ad mérésenként egy tabstopot", () => {
    // A ritka ág az alapértelmezett nézet, és ugyanaz a baja volt, amit a
    // sűrűnél a 6. feladat már megoldott: 365 napi lépésmérés 365 célpont,
    // `vo2max?tart=mind` 648 — egyenként pixelnyi csíkok, amiket sem egérrel
    // nem lehet eltalálni, sem Tabbal végigjárni, és mindegyik kétszer viszi a
    // saját feliratát (title + látható olvasó): ~190 KB jelölés egy 30 KB-os
    // képhez.
    const n = 365;
    const rows = days("2025-01-01", ...Array.from({ length: n }, (_, i) => 40 + (i % 9)));
    const s = buildSeries("hrv", "2025-01-01", rows.at(-1)!.date, rows);
    expect(s.points.length).toBeLessThan(660); // tényleg a ritka ág
    const html = plot(s, hrv);
    const readerCount = (html.match(/tabindex="0"/g) ?? []).length;
    expect(readerCount).toBeGreaterThan(0);
    expect(readerCount).toBeLessThanOrEqual(200);
  });

  it("rövid ablakon minden célpont a saját napját és értékét mondja", () => {
    // A célpontrács nem törölheti a napi pontosságot ott, ahol elfér: egy 30
    // napos ablakban minden mérés a saját cellájába esik.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-30", days("2026-01-01", 40, 41, 42));
    expect(plot(s, hrv)).toContain("<title>2026-01-01 · 40,0 ms</title>");
  });

  it("egy cella dátumtartománya nem lóg át a szomszédjára", () => {
    // A feliratot a cella SAJÁT pontjaiból írjuk, nem a helyezési tört
    // visszakerekítéséből: az utóbbinál az i. oszlop vége és az i+1. kezdete
    // ugyanaz a nap lett, tehát minden olvasó egy szomszédjához tartozó napot
    // is magának állított.
    const rows = days("2024-01-01", ...Array.from({ length: 700 }, (_, i) => 40 + (i % 5)));
    const s = buildSeries("hrv", "2024-01-01", rows.at(-1)!.date, rows);
    const html = plot(s, hrv);
    const ranges = [...html.matchAll(/<title>(\d{4}-\d{2}-\d{2})(?:–(\d{4}-\d{2}-\d{2}))?/g)]
      .map((m) => ({ from: m[1]!, to: m[2] ?? m[1]! }));
    expect(ranges.length).toBeGreaterThan(10);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.from > ranges[i - 1]!.to).toBe(true);
    }
  });

  it("az összefoglaló a napszámot és a trendet is elmondja", () => {
    // A spec szerinti alak: „HRV, 365 nap: 1424 mérés, 52% lefedettség,
    // 41–108 ms, a trend enyhén emelkedő." Ugyanez a string kell a sparkline
    // fölé is — egy sor és a mögötte lévő oldal nem mondhat mást ugyanarról.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 40, 50, null, null, 60));
    const html = plot(s, hrv);
    expect(html).toMatch(/<title>HRV, 5 nap: 3 mérés, 60% lefedettség, [^<]*a trend emelkedő<\/title>/);
  });

  it("három mérés alatt nem állít trendet", () => {
    // Két pontra mindig ráilleszthető egy egyenes; attól még nem trend.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-02", days("2026-01-01", 40, 60));
    expect(plot(s, hrv)).not.toContain("a trend");
  });
});
