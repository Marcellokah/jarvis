import { describe, it, expect } from "vitest";
import { hu, huFt, duration } from "../../src/delivery/http/view/format.ts";
import { leadBand, seriesBand, analysisBand } from "../../src/delivery/http/view/area/frame.ts";

describe("magyar számformázás", () => {
  it("ezres csoportot sima szóközzel ad, nem nem-törő szóközzel", () => {
    // A hu-HU alapból U+00A0-t tesz be, és a felület többi része sima
    // szóközre hajtja (lásd chart/registry.ts) — a kettő keveredve két
    // hangon írná ugyanazt a számot ugyanazon az oldalon.
    expect(hu(64860)).toBe("64 860");
    expect(hu(64860)).not.toContain(" ");
  });
  it("tizedesvesszőt használ", () => {
    expect(hu(1.41, 2)).toBe("1,41");
    expect(hu(1.4, 2)).toBe("1,40");
    expect(hu(1.456, 2)).toBe("1,46");
  });
  it("négy jegyű számot is csoportosít", () => {
    // A hu-HU „auto" csoportosítása pont a négyjegyűeknél hallgat el, és a
    // három korábbi másolat közül csak a numbers.ts hagyta rá — ugyanaz a
    // 6753 lépés a Számok oldalon „6753", a Ma oldal csatornasorában
    // „6 753" volt. A közös formázó mindig csoportosít, és ez a teszt az,
    // ami ezt megtartja.
    expect(hu(6753)).toBe("6 753");
  });
  it("a forintot mértékegységgel adja", () => {
    expect(huFt(64860)).toBe("64 860 Ft");
  });
  it("0 percet csak percként adja", () => {
    expect(duration(0)).toBe("0 perc");
  });
  it("32 percet csak percként adja", () => {
    expect(duration(32)).toBe("32 perc");
  });
  it("60 percet 1 óra 0 percként adja", () => {
    expect(duration(60)).toBe("1 óra 0 perc");
  });
  it("59.5 percet kerekítve 1 óra 0 percként adja", () => {
    // Apple exportja tört perceket hoz — ha a kerekítés előtt hasítunk, 59.5
    // az 59 perc marad; ha utána, akkor 60 perc kerekít, és a szállító 1 óra.
    // Ez a teszt őrzi a helyes sorrend: kerekítés előbb.
    expect(duration(59.5)).toBe("1 óra 0 perc");
  });
  it("119.5 percet kerekítve 2 óra 0 percként adja", () => {
    // Még kritikusabb a szállítási eset: 119.5 perc kerekít 120-ra, az 2 óra.
    // Rossz sorrend (hasítás előbb) ezt "1 óra 60 percként" adná.
    expect(duration(119.5)).toBe("2 óra 0 perc");
  });
  it("3760 percet 62 óra 40 percként adja", () => {
    expect(duration(3760)).toBe("62 óra 40 perc");
  });
});

describe("vezető szám", () => {
  it("mért értéknél a számot mutatja", () => {
    const html = leadBand({
      label: "Terhelési arány", value: "1,41×",
      against: "28 napos napi átlag a 365 naposhoz mérve", missing: "nincs elég előzmény",
    });
    expect(html).toContain("1,41×");
    expect(html).toContain("28 napos napi átlag");
    expect(html).not.toContain("hianyzik");
  });

  it("hiánynál nem nullát mutat, és jelöli, hogy hiányzik", () => {
    // Ez a szabály, amiért ez a rendszer épült: a hiányzó adat hiányzónak
    // látsszon. Egy 0,00× ugyanúgy néz ki, mint egy mért érték.
    const html = leadBand({
      label: "Terhelési arány", value: null,
      against: "28 napos napi átlag a 365 naposhoz mérve", missing: "nincs elég előzmény",
    });
    expect(html).toContain("nincs elég előzmény");
    expect(html).toContain("hianyzik");
    expect(html).not.toContain("0");
  });

  it("escape-eli a címkét és a szöveget", () => {
    const html = leadBand({
      label: "<b>x</b>", value: "<i>1</i>", against: "&", missing: "-",
    });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&amp;");
  });
});

describe("sorozat-csempék", () => {
  it("minden csempe a saját részletoldalára visz, a saját ablakával", () => {
    const html = seriesBand("Mozgás", [
      { column: "steps", label: "Lépés", days: 90, chart: "<svg/>" },
    ]);
    expect(html).toContain('href="/szamok/steps?tart=90"');
    expect(html).toContain("Lépés");
    expect(html).toContain("<svg/>");
  });

  it("csempe nélkül nem ad üres címet", () => {
    // Egy "Mozgás" fejléc alatta semmivel hiányzó adat, ami nem látszik
    // hiányzónak.
    expect(seriesBand("Mozgás", [])).toBe("");
  });

  it("kódolja az oszlopnevet az URL-ben", () => {
    const html = seriesBand("X", [{ column: "a/b", label: "A", days: 7, chart: "" }]);
    expect(html).toContain("/szamok/a%2Fb?tart=7");
  });

  it("escape-eli a fejléc és a címke szövegét", () => {
    const html = seriesBand("<b>title</b>", [
      { column: "test", label: "<i>label</i>", days: 7, chart: "" },
    ]);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;i&gt;");
  });
});

describe("elemzés-sáv", () => {
  it("a dátumával együtt mutatja az elemzést", () => {
    // Egy két hete készült elemzés akkor is két hetes, ha magabiztosan
    // hangzik — a dátum az egyetlen, ami ezt megmondja.
    const html = analysisBand({ markdown: "**Fontos** megállapítás", createdAt: "2026-09-01T07:08:45.487Z" });
    expect(html).toContain("2026-09-01");
    expect(html).toContain("<strong>Fontos</strong>");
  });

  it("elemzés nélkül megmondja, hogyan lehet elindítani", () => {
    const html = analysisBand(undefined);
    expect(html).toContain("Még nem futott");
    expect(html).toContain("npm run analyze");
    expect(html).not.toContain("hamarosan");
  });
});
