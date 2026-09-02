import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { plot } from "../../src/delivery/http/view/chart/plot.ts";
import { SOROZATOK } from "../../src/delivery/http/view/chart/registry.ts";

const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

const hrv = SOROZATOK.get("hrv")!;

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
    // Ez a teszt csak azt tudja bizonyítani, hogy plot() sosem ír ki egy
    // "riado" alstringet — mert a kimenet kizárólag osztálynevekre hivatkozik
    // (pl. "hezag", "sav"), a színeket a theme.ts CSS-e adja hozzájuk. Ha
    // valaki a .hezag vagy .sav szabályt itt, ebben a fájlban átírná
    // var(--riado)-ra, ez a teszt azt NEM venné észre — placeholder,
    // dokumentálja a szándékot, de nem őrzi. A tényleges garancia kézi
    // ellenőrzés: theme.ts-ben `.plot .hezag { fill: var(--racs); }` és
    // `.plot .sav { fill: var(--jel); ... }`, egyik sem var(--riado).
    const s = buildSeries("hrv", "2026-01-01", "2026-01-09", days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5));
    expect(plot(s, hrv)).not.toContain("riado");
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
});
