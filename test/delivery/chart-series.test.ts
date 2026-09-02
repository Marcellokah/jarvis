import { describe, it, expect } from "vitest";
import { buildSeries, dayNumber } from "../../src/delivery/http/view/chart/series.ts";

/** Napok listája dátum→érték párokká, `null` = nem mért nap. */
const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("sorozat", () => {
  it("a törésküszöb a mediánból jön, nem az átlagból", () => {
    // Napi ritmus egyetlen nagy lyukkal. Az átlagos hézag ~4 nap lenne, a
    // medián 1 — és a küszöbnek a tipikus ritmust kell leírnia, különben egy
    // szakadás elhitetné, hogy a szakadás maga normális.
    const v = days("2026-01-01", 1, 2, 3, 4, 5, ...new Array(20).fill(null), 6, 7, 8);
    const s = buildSeries("steps", "2026-01-01", "2026-01-28", v);
    expect(s.medianGapDays).toBe(1);
    expect(s.breakThreshold).toBe(3);
  });

  it("a küszöbnél nagyobb hézag megtöri a vonalat", () => {
    // A pár első fele.
    const v = days("2026-01-01", 1, 2, 3, null, null, null, null, 4, 5);
    const s = buildSeries("steps", "2026-01-01", "2026-01-09", v);
    expect(s.segments).toHaveLength(2);
    expect(s.segments[0]!.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(s.segments[1]!.map((p) => p.value)).toEqual([4, 5]);
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]).toMatchObject({ fromDate: "2026-01-03", toDate: "2026-01-08", days: 5 });
  });

  it("a küszöbnél kisebb hézag nem töri meg", () => {
    // A pár másik fele. Külön-külön mindkettő átmegy egy olyan
    // implementáción, ami a küszöböt figyelmen kívül hagyja — együtt nem.
    const v = days("2026-01-01", 1, 2, null, 3, 4);
    const s = buildSeries("steps", "2026-01-01", "2026-01-05", v);
    expect(s.segments).toHaveLength(1);
    expect(s.gaps).toEqual([]);
  });

  it("kétnapos ritmusnál a hatnapos lyuk a hír", () => {
    // A valódi HRV-alak: minden második nap mérés, a mért legnagyobb hézag 6.
    const v = days("2026-01-01", 1, null, 2, null, 3, null, null, null, null, null, 4);
    const s = buildSeries("hrv", "2026-01-01", "2026-01-11", v);
    expect(s.medianGapDays).toBe(2);
    expect(s.breakThreshold).toBe(6);
    expect(s.segments).toHaveLength(2);
  });

  it("nulla pontnál nincs se vonal, se kivétel", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", null, null, null, null, null));
    expect(s.points).toEqual([]);
    expect(s.segments).toEqual([]);
    expect(s.coverage).toBe(0);
  });

  it("egyetlen pontnál pont van, vonal nincs", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-05", days("2026-01-01", null, 42, null, null, null));
    expect(s.points).toHaveLength(1);
    expect(s.segments).toEqual([[expect.objectContaining({ value: 42 })]]);
    expect(s.medianGapDays).toBe(0);
  });

  it("a lefedettséget a kért ablakhoz méri, nem a pontokhoz", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-10", days("2026-01-01", 1, 2, null, null, null, null, null, null, null, null));
    expect(s.totalDays).toBe(10);
    expect(s.coverage).toBeCloseTo(0.2, 5);
  });

  it("páros számú hézagnál az alsó mediánt választja, nem a felsőt", () => {
    // Négy hézag: 1, 2, 5, 12 nap. A két középső (2 és 5) különbözik, tehát ez
    // az egyetlen eset, ahol az alsó és a felső medián ténylegesen eltérő
    // eredményt ad — a többi teszt hézagszáma páratlan, vagy a két középső
    // érték véletlenül egyenlő, így azok önmagukban nem bizonyítják, hogy a
    // kód valóban az alsó mediánt (index 1, nem 2) választja. Kisebb küszöb =
    // kevesebb kitalált vonal, ezért az alsó a helyes választás.
    const v = days(
      "2026-01-01",
      1, 2, null, 3, null, null, null, null, 4,
      null, null, null, null, null, null, null, null, null, null, null,
      5,
    );
    const s = buildSeries("hrv", "2026-01-01", "2026-01-21", v);
    expect(s.medianGapDays).toBe(2);
    expect(s.breakThreshold).toBe(6);
    expect(s.segments).toHaveLength(2);
    expect(s.gaps).toEqual([{ fromDate: "2026-01-09", toDate: "2026-01-21", days: 12 }]);
  });
});
