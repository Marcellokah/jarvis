import { describe, it, expect } from "vitest";
import { nutritionBody } from "../../src/delivery/http/view/area/nutrition.ts";

const empty = {
  measuredDays: 0, measuredProteinDays: 0, lastDate: null,
  actual: { kcal: null, proteinG: null },
  plan: [], tiles: [],
  analysis: undefined, earlier: [],
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

  it("elemzés-sávot kap, mert az S8 óta van nutrition domain", () => {
    // Az F3 ezt a sávot szándékosan hagyta el — akkor nem volt mögötte
    // domain, és egy üres sáv vagy egy „hamarosan" felirat hiányzó adat lett
    // volna, ami nem látszik hiányzónak. Az S8 megcsinálta a domaint.
    const html = nutritionBody({
      ...empty, measuredDays: 74,
      analysis: { markdown: "**Fontos**", createdAt: "2026-09-04T07:00:00.000Z" },
      earlier: [],
    });
    expect(html).toContain("Elemzés");
    expect(html).toContain("<strong>Fontos</strong>");
    expect(html).toContain("2026-09-04");
  });

  it("elemzés nélkül megmondja, hogyan lehet elindítani — nem hamarosant ír", () => {
    const html = nutritionBody({ ...empty, analysis: undefined, earlier: [] });
    expect(html).toContain("Még nem futott");
    expect(html).toContain("npm run analyze");
    expect(html).not.toContain("hamarosan");
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

  it("az étkezések fejlécét mutatja az étrendtáblában", () => {
    const html = nutritionBody({
      ...empty,
      plan: [m(1, "reggeli", "Kenyér", { kcal: 100, proteinG: 5 })],
    });
    expect(html).toContain("Reggeli");
    expect(html).toContain("Ebéd");
    expect(html).toContain("Vacsora");
  });

  it("a hét különböző napjait helyes napnéven mutatja", () => {
    // Teszteljük, hogy a hétfő (weekday=1) az "hétfő" sor alatt jelenik meg,
    // és a vasárnap (weekday=0) a "vasárnap" sor alatt.
    const html = nutritionBody({
      ...empty,
      plan: [
        m(1, "reggeli", "Hétfői reggeli", { kcal: 100, proteinG: 5 }),
        m(0, "reggeli", "Vasárnapi reggeli", { kcal: 100, proteinG: 5 }),
      ],
    });
    // Kell a "Hétfői reggeli" az "hétfő" napon belül
    const hétfőiIndex = html.indexOf("hétfő");
    const hétfőiReggelijeIndex = html.indexOf("Hétfői reggeli");
    expect(hétfőiIndex).toBeGreaterThan(-1);
    expect(hétfőiReggelijeIndex).toBeGreaterThan(-1);
    expect(hétfőiReggelijeIndex).toBeGreaterThan(hétfőiIndex);

    // Kell a "Vasárnapi reggeli" a "vasárnap" napon belül
    const vasárnapi = html.indexOf("vasárnap");
    const vasarnapiReggelijeIndex = html.indexOf("Vasárnapi reggeli");
    expect(vasárnapi).toBeGreaterThan(-1);
    expect(vasarnapiReggelijeIndex).toBeGreaterThan(-1);
    // A vasárnap utolsó héten van (utolsó sor), úgyhogy a vasárnapi reggeli után az index
    expect(vasarnapiReggelijeIndex).toBeGreaterThan(vasárnapi);
  });

  it("a heti étrend táblája hétfővel kezdődik, nem a tárolási sorrenddel", () => {
    // D3: az előző teszt csak a címke↔hétköznap PÁROSÍTÁST őrzi (indexOf-
    // pozíciókkal), a SOROK SORRENDJÉT nem — az `order` tömb tárolási
    // sorrendre ([0..6], vasárnap elöl) cserélése minden névcímkét helyesen
    // hagyna, csak a táblát vasárnappal indítaná. Ez a teszt a ténylegesen
    // renderelt sorsorrendet nézi, nem a szöveg pozícióját.
    const plan = [0, 1, 2, 3, 4, 5, 6].map((w) =>
      m(w, "reggeli", `Nap-${w}`, { kcal: 100, proteinG: 5 }));
    const html = nutritionBody({ ...empty, plan });
    const table = html.substring(html.indexOf("Heti étrend"));
    const days = [...table.matchAll(/<tr class="live"[^>]*><td>([^<]+)<\/td>/g)].map((mm) => mm[1]);
    expect(days).toEqual(["hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat", "vasárnap"]);
  });

  it("a terv és valóság sávban mutatja a tervezett napi kalóriát", () => {
    const html = nutritionBody({
      ...empty,
      plan: [m(1, "reggeli", "Zabkása", { kcal: 550, proteinG: 25 })],
    });
    const comparison = html.substring(html.indexOf("Terv és valóság"));
    expect(comparison).toContain("Tervezett napi kalória");
    expect(comparison).toContain("550 kcal");
    expect(comparison).toContain("a heti étrend 1 teljes napjából");
  });

  it("a terv és valóság sávban mutatja a mért napi kalóriát és fehérjét", () => {
    const html = nutritionBody({
      ...empty,
      measuredDays: 10,
      measuredProteinDays: 10,
      actual: { kcal: 2000, proteinG: 75 },
      plan: [],
    });
    const comparison = html.substring(html.indexOf("Terv és valóság"));
    expect(comparison).toContain("Mért napi kalória");
    expect(comparison).toContain("2 000 kcal");
    expect(comparison).toContain("Mért napi fehérje");
    expect(comparison).toContain("75 g");
    expect(comparison).toContain("10 mért nap átlaga");
  });

  it("a fehérje sora a saját napszámát mutatja, nem a kalóriáét", () => {
    // B1: a fehérje átlagát `withProtein.length` napon számoljuk, ami
    // kevesebb lehet, mint a kalóriát hordozó napok száma — egy nap
    // rögzíthet kalóriát fehérje nélkül. A két szám itt szándékosan eltér,
    // hogy egy olyan hiba is bukjon, ahol a fehérje sor a kalória
    // napszámát írná ki.
    const html = nutritionBody({
      ...empty,
      measuredDays: 3,
      measuredProteinDays: 2,
      actual: { kcal: 2100, proteinG: 100 },
      plan: [],
    });
    const comparison = html.substring(html.indexOf("Terv és valóság"));
    const kcalRow = /<tr[^>]*><td>Mért napi kalória<\/td>[\s\S]*?<\/tr>/.exec(comparison)?.[0] ?? "";
    const proteinRow = /<tr[^>]*><td>Mért napi fehérje<\/td>[\s\S]*?<\/tr>/.exec(comparison)?.[0] ?? "";
    expect(kcalRow).toContain("3 mért nap átlaga");
    expect(proteinRow).toContain("2 mért nap átlaga");
    expect(proteinRow).not.toContain("3 mért nap átlaga");
  });

  it("mért érték nélkül halott sornak jelöli a mért kalóriát", () => {
    const html = nutritionBody({
      ...empty,
      measuredDays: 0,
      actual: { kcal: null, proteinG: null },
      plan: [],
    });
    const comparison = html.substring(html.indexOf("Terv és valóság"));
    expect(comparison).toContain('class="dead"');
    expect(comparison).toContain("Mért napi kalória");
  });

  it("mért érték nélkül nincs adatot mutat", () => {
    const html = nutritionBody({
      ...empty,
      measuredDays: 0,
      actual: { kcal: null, proteinG: null },
      plan: [],
    });
    const comparison = html.substring(html.indexOf("Terv és valóság"));
    expect(comparison).toContain("nincs adat");
  });

  it("hiányos terv esetén nincs teljes tervet mutat", () => {
    // Egy teljes nap és egy részleges nap — csak az egyik számít
    const html = nutritionBody({
      ...empty,
      plan: [
        m(1, "reggeli", "Zabkása", { kcal: 550, proteinG: 25 }),
        m(2, "reggeli", "Kávé", { kcal: null, proteinG: null }),
        m(2, "ebed", "Rizs", { kcal: 600, proteinG: 12 }),
      ],
    });
    const comparison = html.substring(html.indexOf("Terv és valóság"));
    expect(comparison).toContain("a heti étrend 1 teljes napjából");
    expect(comparison).not.toContain("a heti étrend 2");
  });

  it("üres terv esetén nincs teljes tervet mutat", () => {
    const html = nutritionBody({
      ...empty,
      plan: [],
      actual: { kcal: null, proteinG: null },
    });
    const comparison = html.substring(html.indexOf("Terv és valóság"));
    expect(comparison).toContain("nincs teljes terv");
  });
});
