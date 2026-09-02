import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { sparkline } from "../../src/delivery/http/view/chart/sparkline.ts";
import { SOROZATOK } from "../../src/delivery/http/view/chart/registry.ts";

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
    const s = buildSeries("hrv", "2026-01-01", "2026-01-02", days("2026-01-01", 1, 2));
    expect(sparkline(s, hrv)).not.toContain("--riado");
  });
});
