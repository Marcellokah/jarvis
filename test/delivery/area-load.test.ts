import { describe, it, expect } from "vitest";
import { loadBody } from "../../src/delivery/http/view/area/load.ts";

const empty = {
  loadRatio: null, strengthPerWeek28d: null,
  byMonth: [], byType: [], recent: [], tiles: [], analysis: undefined,
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
    const html = loadBody({
      ...empty,
      byMonth: [
        { month: "2026-07", hours: 12.5, sessions: 20, strength: 8 },
        { month: "2026-08", hours: 9, sessions: 15, strength: 6 },
      ],
    });
    expect(html).toContain('class="oszlopok"');
    expect(html).toContain("2026-07");
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

  it("escape-eli az edzés típusát és forrását", () => {
    // A típus az Apple exportjából jön, nem ebből a kódból.
    const html = loadBody({ ...empty, recent: [w("2026-09-01", "<script>x</script>", 10, null)] });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("elemzés nélkül is teljes oldalt ad", () => {
    const html = loadBody({ ...empty, loadRatio: 1.2 });
    expect(html).toContain("Még nem futott");
  });
});
