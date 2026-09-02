import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { sparkline } from "../../src/delivery/http/view/chart/sparkline.ts";
import { SOROZATOK } from "../../src/delivery/http/view/chart/registry.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";

const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

const hrv = SOROZATOK.get("hrv")!;

describe("sparkline", () => {
  it("szakaszonként külön útvonalat rajzol, nem köt át a hézagon", () => {
    // Ez a diagram egyetlen ígérete: a hézag fölött nincs vonal.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-09", days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5));
    const svg = sparkline(s, hrv);
    expect((svg.match(/<path /g) ?? [])).toHaveLength(2);
  });

  it("egyetlen pontból pontot rajzol, útvonalat nem", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", null, 42, null, null, null));
    const svg = sparkline(s, hrv);
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("<path");
  });

  it("mérés nélkül üres, de nem hibázik", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-03", days("2026-01-01", null, null, null));
    const svg = sparkline(s, hrv);
    expect(svg).toContain('class="spark ures"');
    expect(svg).not.toContain("<path");
    expect(svg).not.toContain("NaN");
  });

  it("szavakban is elmondja, amit a kép", () => {
    // Egy diagram, amit nem lehet elolvasni, nem információ.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 40, 50, null, null, 60));
    const svg = sparkline(s, hrv);
    expect(svg).toMatch(/<title>[^<]*3 mérés[^<]*<\/title>/);
    expect(svg).toContain("60%");
  });

  it("nem használ riasztó színt", () => {
    // A színt a stíluslap adja, a sparkline() csak osztályneveket ír ki — a
    // korábbi `not.toContain("--riado")` a kimeneten ezért sosem bukhatott
    // meg. A szabályt magát nézzük, és azt is, hogy megtaláltuk-e.
    // Minden ilyen szabály, nem csak az első: az animációs blokk ugyanezt a
    // szelektort újra megnyitja, és ott is igaznak kell lennie.
    const rules = (selector: string) =>
      [...STYLE.matchAll(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
    expect(rules(".spark path").length).toBeGreaterThan(0);
    expect(rules(".spark circle").length).toBeGreaterThan(0);
    expect(rules(".spark path").join("")).not.toContain("riado");
    expect(rules(".spark circle").join("")).not.toContain("riado");
  });

  it("ugyanazt az összefoglalót mondja, amit a nagy nézet", () => {
    // Egy sor sparkline-ja és a mögötte lévő részletoldal ugyanarról a
    // sorozatról nem mondhat két különböző dolgot: a napszám a kicsiből
    // hiányzott, a trend mindkettőből.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", 40, 50, null, null, 60));
    expect(sparkline(s, hrv)).toMatch(
      /<title>HRV, 5 nap: 3 mérés, 60% lefedettség, [^<]*a trend emelkedő<\/title>/,
    );
  });
});
