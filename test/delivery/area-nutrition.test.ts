import { describe, it, expect } from "vitest";
import { nutritionBody } from "../../src/delivery/http/view/area/nutrition.ts";

const empty = {
  measuredDays: 0, lastDate: null,
  actual: { kcal: null, proteinG: null },
  plan: [], tiles: [],
};

const m = (weekday: number, meal: "reggeli" | "ebed" | "vacsora", item: string,
  extra: Partial<{ needsDefrost: boolean; defrostLeadH: number; proteinG: number | null; kcal: number | null }> = {}) => ({
  weekday, meal, item,
  needsDefrost: false, defrostLeadH: 0, proteinG: null, kcal: null, ...extra,
});

describe("Táplálkozás oldal", () => {
  it("a mért napok számát mutatja vezető számként, nem napi átlagot", () => {
    // Ez a terület még alig mért. Egy magabiztos napi átlag 74 nap
    // mintájából többet állítana, mint amennyit tudunk.
    const html = nutritionBody({ ...empty, measuredDays: 74, lastDate: "2026-09-01" });
    expect(html).toContain("74");
    expect(html).toContain("2026-09-01");
  });

  it("egyetlen mért nap nélkül nem nullát mutat", () => {
    const html = nutritionBody({ ...empty });
    expect(html).toContain("nincs mérés");
  });

  it("nincs elemzés-sávja, és nincs hamarosan felirata sem", () => {
    // Nincs nutrition domain. A sáv nem üresen áll ott — nincs ott.
    const html = nutritionBody({ ...empty, measuredDays: 74 });
    expect(html).not.toContain("Elemzés");
    expect(html).not.toContain("hamarosan");
    expect(html).not.toContain("npm run analyze");
  });

  it("a heti étrendet naponta összegzi", () => {
    const html = nutritionBody({
      ...empty,
      plan: [
        m(1, "reggeli", "Zabkása", { proteinG: 25, kcal: 550 }),
        m(1, "ebed", "Csirkemell", { proteinG: 55, kcal: 700, needsDefrost: true, defrostLeadH: 12 }),
      ],
    });
    expect(html).toContain("Zabkása");
    expect(html).toContain("1 250 kcal");
    expect(html).toContain("80 g");
  });

  it("a kiolvasztást igénylő tételt megjelöli az előkészítési idejével", () => {
    const html = nutritionBody({
      ...empty,
      plan: [m(2, "ebed", "Marhapörkölt", { needsDefrost: true, defrostLeadH: 12 })],
    });
    expect(html).toContain("12 óra");
  });

  it("hiányos tervezett értéknél nem részösszeget ad", () => {
    // A protein_g és a kcal nullázható. Egy két tételből egyet ismerő nap
    // összege nem a nap terve.
    const html = nutritionBody({
      ...empty,
      plan: [
        m(3, "reggeli", "Kávé", { kcal: null, proteinG: null }),
        m(3, "ebed", "Rizs", { kcal: 600, proteinG: 12 }),
      ],
    });
    expect(html).toContain("nincs adat");
    expect(html).not.toContain("600 kcal");
  });

  it("étrend nélkül kimondja a hiányt", () => {
    expect(nutritionBody({ ...empty })).toContain("Nincs heti étrend");
  });

  it("escape-eli az étel nevét", () => {
    const html = nutritionBody({ ...empty, plan: [m(1, "reggeli", "<img src=x>")] });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img");
  });
});
