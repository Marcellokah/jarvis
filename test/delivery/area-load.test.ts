import { describe, it, expect } from "vitest";
import { loadBody } from "../../src/delivery/http/view/area/load.ts";

const empty = {
  loadRatio: null, strengthPerWeek28d: null,
  byMonth: [], byType: [], recent: [], tiles: [], analysis: undefined, earlier: [],
};

const w = (date: string, type: string, min: number, kcal: number | null) => ({
  date, type, startedAt: `${date}T06:00:00.000Z`,
  durationMin: min, energyKcal: kcal, source: "teszt",
});

describe("Terhelés oldal", () => {
  it("a terhelési arányt mutatja vezető számként", () => {
    const html = loadBody({ ...empty, loadRatio: 1.41 });
    expect(html).toContain("Terhelési arány");
    expect(html).toContain("1,41×");
  });

  it("alap nélkül nem 1,00×-et mutat", () => {
    // A loadRatio null, ha 28 előzmény-edzésnapnál kevesebb van. Egy 1,00×
    // azt állítaná, hogy pont az átlagon vagyunk — ami mérés, nem hiány.
    const html = loadBody({ ...empty });
    expect(html).toContain("nincs elég előzmény");
    expect(html).not.toContain("1,00×");
  });

  it("a havi edzésórát oszlopdiagramként rajzolja", () => {
    // Az óra, a munkavégzés és az erősítés mind más szám — a teszt azt
    // biztosítja, hogy az óra (nem a munkavégzés) kerül a diagramra.
    const html = loadBody({
      ...empty,
      byMonth: [
        { month: "2026-07", hours: 12.5, sessions: 400, strength: 900 },
        { month: "2026-08", hours: 9, sessions: 350, strength: 850 },
      ],
    });
    expect(html).toContain('class="oszlopok"');
    expect(html).toContain("2026-07");
    expect(html).toContain("12,5 óra");
    // Sessions and strength must not appear as plotted values
    expect(html).not.toContain("400,0 óra");
    expect(html).not.toContain("900,0 óra");
  });

  it("a kalóriát nem hordozó típusnál nincs mérést ír, nem 0 kcal-t", () => {
    // Az energy_kcal nullázható, és a séta gyakran nem hoz kalóriát. A 0
    // kcal azt állítaná, hogy megmértük.
    const html = loadBody({
      ...empty,
      byType: [
        { type: "Cooldown", sessions: 68, minutes: 527, kcal: null, kcalFrom: 0, lastDate: "2026-08-30" },
      ],
    });
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("0 kcal");
  });

  it("részleges kalóriánál megmondja, hány alkalomból jön", () => {
    const html = loadBody({
      ...empty,
      byType: [
        { type: "Hiking", sessions: 19, minutes: 3760, kcal: 8400, kcalFrom: 4, lastDate: "2026-07-11" },
      ],
    });
    expect(html).toContain("8 400 kcal");
    expect(html).toContain("4 alkalomból");
    // G1: 3760 perc órává alakítva 62,7 óra — nem 3 760,0 óra. Ez a sor
    // szándékosan nem kerek percösszeget hordoz, hogy az órává osztás
    // (`minutes / 60`) elmaradása bukjon, ne csak a formázás.
    expect(html).toContain("62,7 óra");
    expect(html).not.toContain("3 760,0 óra");
  });

  it("az utolsó edzések listája alatt link visz a teljes naplóra", () => {
    const html = loadBody({ ...empty, recent: [w("2026-09-01", "Walking", 32, 140)] });
    expect(html).toContain("Walking");
    expect(html).toContain('href="/terulet/terheles/naplo"');
  });

  it("edzés nélkül nem üres táblát mutat, hanem kimondja a hiányt", () => {
    const html = loadBody({ ...empty });
    expect(html).toContain("Nincs rögzített edzés");
  });

  it("escape-eli az edzés típusát", () => {
    // A típus az Apple exportjából jön, nem ebből a kódból.
    const html = loadBody({ ...empty, recent: [w("2026-09-01", "<script>x</script>", 10, null)] });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("elemzés nélkül is teljes oldalt ad", () => {
    const html = loadBody({ ...empty, loadRatio: 1.2 });
    expect(html).toContain("Még nem futott");
  });

  it("az erősítési arányt a havi diagrammal jeleníti meg", () => {
    // A strengthPerWeek28d a havi óra sáv mellett jelenik meg, nem
    // önálló diagramként.
    const html = loadBody({
      ...empty,
      strengthPerWeek28d: 2.5,
      byMonth: [{ month: "2026-08", hours: 10, sessions: 20, strength: 5 }],
    });
    expect(html).toContain("Erősítés");
    expect(html).toContain("2,5");
    expect(html).toContain("alkalom hetente");
  });

  it("erősítés nélkül nem mutatja az erősítési sort", () => {
    // Null strengthPerWeek28d azt jelenti, hogy nincs elég előzmény az
    // erősítés kiszámításához.
    const html = loadBody({
      ...empty,
      byMonth: [{ month: "2026-08", hours: 10, sessions: 20, strength: 5 }],
    });
    expect(html).not.toContain("Erősítés");
  });

  it("elemzést mutatja, ha van", () => {
    // Az analysisBand(d.analysis, d.earlier) vezérlést tesztelni kell, hogy
    // tényleg továbbítva van az adat, nem csak hardcoded undefined.
    const html = loadBody({
      ...empty,
      analysis: { markdown: "**Fontos** megállapítás", createdAt: "2026-09-01T07:08:45.487Z" },
    });
    expect(html).toContain("<strong>Fontos</strong>");
    expect(html).toContain("2026-09-01");
  });

  it("a típusneveket escape-eli", () => {
    // A típus az Apple exportjából jön, és lehet HTML-szerű szöveg, így
    // a típusbontás táblázatban is escape-elni kell.
    const html = loadBody({
      ...empty,
      byType: [
        { type: "<b>Malicious</b>", sessions: 10, minutes: 600, kcal: 5000, kcalFrom: 10, lastDate: "2026-09-01" },
      ],
    });
    expect(html).not.toContain("<b>Malicious</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});
