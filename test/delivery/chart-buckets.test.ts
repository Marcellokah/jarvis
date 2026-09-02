import { describe, it, expect } from "vitest";
import { buildSeries } from "../../src/delivery/http/view/chart/series.ts";
import { bucketise } from "../../src/delivery/http/view/chart/buckets.ts";

const days = (first: string, ...vals: (number | null)[]) =>
  vals.map((value, i) => ({
    date: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("sűrítés", () => {
  it("az üres oszlop üres marad, nem örökli a szomszédját", () => {
    // Ez a sűrítés egyetlen tilalma: ahol nem mértünk, ott nem lehet érték.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-04", days("2026-01-01", 10, null, null, 20));
    const b = bucketise(s, 4);
    expect(b).toHaveLength(4);
    expect(b[0]).toMatchObject({ min: 10, max: 10, n: 1 });
    expect(b[1]).toBeNull();
    expect(b[2]).toBeNull();
    expect(b[3]).toMatchObject({ min: 20, max: 20, n: 1 });
  });

  it("a kiugrás nem tűnik el a sűrítésben", () => {
    // Ezért min-max sáv és nem átlag: egy évnyi adatban egyetlen 200-as nap
    // átlagolva nyomtalanul eltűnne.
    const vals = new Array(40).fill(50);
    vals[17] = 200;
    const s = buildSeries("hrv", "2026-01-01", "2026-02-09", days("2026-01-01", ...vals));
    const b = bucketise(s, 4);
    expect(b.some((x) => x !== null && x.max === 200)).toBe(true);
  });

  it("egy oszlop min-maxa a benne lévő valódi pontokból jön", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-04", days("2026-01-01", 10, 30, 20, 40));
    const b = bucketise(s, 2);
    expect(b[0]).toMatchObject({ min: 10, max: 30, median: 10, n: 2 });
    expect(b[1]).toMatchObject({ min: 20, max: 40, median: 20, n: 2 });
  });

  it("nulla pontnál minden oszlop üres", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-03", days("2026-01-01", null, null, null));
    expect(bucketise(s, 3)).toEqual([null, null, null]);
  });

  it("egyetlen napos ablakot sem oszt el nullával", () => {
    const s = buildSeries("hrv", "2026-01-01", "2026-01-01", days("2026-01-01", 42));
    const b = bucketise(s, 5);
    expect(b.filter((x) => x !== null)).toHaveLength(1);
  });

  it("az oszlop a saját napjait viszi, nem a kerekített oszlophatárokat", () => {
    // A felirat dátumtartománya innen jön. Ha az oszlopindexből számolnánk
    // vissza, az i. oszlop vége és az i+1. kezdete ugyanaz a nap lenne, és
    // minden olvasó egy szomszédjához tartozó napot is magának állítana.
    const s = buildSeries("hrv", "2026-01-01", "2026-01-04", days("2026-01-01", 10, 30, 20, 40));
    const b = bucketise(s, 2);
    expect(b[0]).toMatchObject({ from: "2026-01-01", to: "2026-01-02" });
    expect(b[1]).toMatchObject({ from: "2026-01-03", to: "2026-01-04" });
  });
});
