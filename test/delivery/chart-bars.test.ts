import { describe, it, expect } from "vitest";
import { bars } from "../../src/delivery/http/view/chart/bars.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";

const spec = { label: "Edzésóra", format: (v: number) => `${v} óra` };

/** Egy szabály minden CSS-blokkja, a téma-teszt mintájára. */
const rules = (selector: string): string[] =>
  STYLE.split("\n").filter((line) => line.trimStart().startsWith(selector));

describe("havi oszlopdiagram", () => {
  it("a nincs-adat és a mért nulla a kimenetből megkülönböztethető", () => {
    // Ez a primitív egyetlen igazi állítása. Ha a kettő egyformán néz ki, a
    // diagram azt mondja egy nem rögzített hónapról, hogy nulla volt — pont
    // az a magabiztosan rossz szám, ami ellen ez a rendszer épül.
    const html = bars([
      { label: "2026-07", value: null },
      { label: "2026-08", value: 0 },
      { label: "2026-09", value: 12 },
    ], spec);
    expect((html.match(/class="hezag"/g) ?? [])).toHaveLength(1);
    expect((html.match(/class="oszlop nulla"/g) ?? [])).toHaveLength(1);
    expect((html.match(/class="oszlop"/g) ?? [])).toHaveLength(1);
  });

  it("a mért nulla látható magasságot kap, nem nullát", () => {
    // Egy 0 magas téglalap érvényes SVG, és pontosan nulla képpontot fest: a
    // mért nulla nyomtalanul eltűnne, és megkülönböztethetetlen lenne attól,
    // hogy oda semmit nem rajzoltunk.
    const html = bars([{ label: "2026-08", value: 0 }, { label: "2026-09", value: 40 }], spec);
    const zero = /class="oszlop nulla"[^>]*height="([\d.]+)"/.exec(html);
    expect(zero).not.toBeNull();
    expect(Number(zero![1])).toBeGreaterThan(0);
  });

  it("az olvasó a nincs-adat hónapra nem értéket mond", () => {
    const html = bars([{ label: "2025-01", value: null }, { label: "2025-02", value: 3 }], spec);
    expect(html).toContain("2025-01 · nincs adat");
    expect(html).toContain("2025-02 · 3 óra");
  });

  it("csupa hiány esetén kimondja a hiányt, nem üres keretet ad", () => {
    // Egy üres keret úgy olvasódik, hogy a diagram elromlott. Egy mondat úgy,
    // hogy még nincs mit mutatni.
    const html = bars([{ label: "2026-08", value: null }, { label: "2026-09", value: null }], spec);
    expect(html).toContain("nincs adat");
    expect(html).not.toContain('class="hezag"');
    expect(html).not.toContain('class="oszlop"');
  });

  it("üres bemenetre sem esik szét", () => {
    const html = bars([], spec);
    expect(html).toContain("nincs adat");
    expect(html).not.toContain("NaN");
  });

  it("egyetlen hónapból álló bemenetre sem oszt nullával", () => {
    const html = bars([{ label: "2026-09", value: 7 }], spec);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).toContain('class="oszlop"');
  });

  it("a tengely ritkít, de a két végét mindig kiírja", () => {
    // 56 oszlop alá 56 felirat nem fér: egyetlen olvashatatlan maszattá
    // folyna. A két szélső viszont az, ami megmondja, milyen tartományt
    // nézünk — az sosem eshet ki.
    const rows = Array.from({ length: 56 }, (_, i) => ({
      label: `H${i}`, value: i,
    }));
    const html = bars(rows, spec);
    const labels = [...html.matchAll(/class="tengely"[^>]*>(H\d+)</g)].map((m) => m[1]);
    expect(labels.length).toBeLessThan(20);
    expect(labels).toContain("H0");
    expect(labels).toContain("H55");
  });

  it("minden hónap elérhető olvasóval, a ritkítottak is", () => {
    // A ritkítás nem vehet el információt: amit a tengely nem ír ki, azt az
    // olvasójának akkor is meg kell mondania.
    const rows = Array.from({ length: 56 }, (_, i) => ({ label: `H${i}`, value: i }));
    const html = bars(rows, spec);
    expect((html.match(/class="celpont"/g) ?? [])).toHaveLength(56);
    expect(html).toContain("H23 · 23 óra");
  });

  it("a riasztás színe egyetlen szabályában sem szerepel", () => {
    // --riado kizárólag az állapotsáv elmaradt-csatorna sora. Egy diagram,
    // ami magentát használ, elveszi a magenta egyetlen jelentését.
    const own = rules(".oszlopok");
    expect(own.length).toBeGreaterThan(0);
    expect(own.join("")).not.toContain("riado");
  });

  it("a nem mért hónap nem animálódik", () => {
    // A hiányt az teszi láthatóvá, hogy ott nem történik semmi.
    const style = rules(".oszlopok").join("");
    expect(/\.oszlopok \.oszlop \{[^}]*animation/.test(STYLE)).toBe(true);
    expect(style).not.toMatch(/\.oszlopok \.hezag \{[^}]*animation/);
  });

  it("a csökkentett mozgás leállítja az oszlopok beúszását", () => {
    expect(STYLE).toMatch(/prefers-reduced-motion[\s\S]*\.oszlopok \.oszlop \{ animation: none/);
  });
});
