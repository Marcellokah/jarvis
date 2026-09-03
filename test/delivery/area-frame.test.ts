import { describe, it, expect } from "vitest";
import { hu, huFt, duration } from "../../src/delivery/http/view/format.ts";
import {
  leadBand, seriesBand, analysisBand, historyBlock,
} from "../../src/delivery/http/view/area/frame.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";

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
    const html = analysisBand(
      { markdown: "**Fontos** megállapítás", createdAt: "2026-09-01T07:08:45.487Z" },
      [],
    );
    expect(html).toContain("2026-09-01");
    expect(html).toContain("<strong>Fontos</strong>");
  });

  it("elemzés nélkül megmondja, hogyan lehet elindítani", () => {
    const html = analysisBand(undefined, []);
    expect(html).toContain("Még nem futott");
    expect(html).toContain("npm run analyze");
    expect(html).not.toContain("hamarosan");
  });
});

describe("elemzés-előzmény", () => {
  const earlier = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      createdAt: `2026-08-${String(20 - i).padStart(2, "0")}T07:00:00.000Z`,
      summary: `összefoglaló ${i}`,
    }));

  /** Csak az előzmény-blokk — a sáv fölötte szintén rendel markdownt. */
  const elozmeny = (html: string): string =>
    /<details class="elozmeny">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";

  it("korábbi elemzés nélkül nincs details", () => {
    // Egy üres, kinyitható doboz azt ígérné, hogy van benne valami.
    expect(historyBlock([])).toBe("");
    expect(analysisBand({ markdown: "x", createdAt: "2026-09-01T07:00:00.000Z" }, []))
      .not.toContain("<details");
  });

  it("a felirat a valódi darabszámot mondja", () => {
    // Egy „Korábbiak" felirat nem árulja el, érdemes-e kinyitni.
    expect(historyBlock(earlier(1))).toContain("1 korábbi elemzés");
    expect(historyBlock(earlier(3))).toContain("3 korábbi elemzés");
  });

  it("legfeljebb ötöt mutat", () => {
    // A hatodiktól már archívum, és annak külön hely kell.
    const sav = elozmeny(historyBlock(earlier(9)));
    expect((sav.match(/class="tetel"/g) ?? [])).toHaveLength(5);
  });

  it("hatnál is azt mondja, hányat MUTAT, nem hányan vannak", () => {
    // Egy „9 korábbi elemzés" felirat öt tétel fölött hazudik.
    expect(historyBlock(earlier(9))).toContain("5 korábbi elemzés");
    expect(historyBlock(earlier(9))).not.toContain("9 korábbi elemzés");
  });

  it("minden tételt a saját dátumával és összefoglalójával mutat", () => {
    const sav = elozmeny(historyBlock(earlier(2)));
    expect(sav).toContain("2026-08-20");
    expect(sav).toContain("összefoglaló 0");
    expect(sav).toContain("2026-08-19");
    expect(sav).toContain("összefoglaló 1");
  });

  it("a dátumot napra csonkítja, nem a teljes időbélyeget írja ki", () => {
    const sav = elozmeny(historyBlock(earlier(1)));
    expect(sav).not.toContain("T07:00:00");
  });

  it("escape-eli az összefoglalót", () => {
    // A summary-t a modell írja, nem ez a kód.
    const sav = elozmeny(historyBlock([
      { createdAt: "2026-08-20T07:00:00.000Z", summary: "<script>alert(1)</script>" },
    ]));
    expect(sav).not.toContain("<script>alert(1)</script>");
    expect(sav).toContain("&lt;script&gt;");
  });

  it("a sáv alá kerül, nem a helyére", () => {
    const html = analysisBand(
      { markdown: "**mai**", createdAt: "2026-09-01T07:00:00.000Z" },
      earlier(2),
    );
    expect(html).toContain("<strong>mai</strong>");
    expect(html.indexOf("<strong>mai</strong>")).toBeLessThan(html.indexOf("<details"));
  });

  it("elemzés nélkül is megjelenik, ha van korábbi", () => {
    // Furcsa állapot, de lehetséges: a legfrissebb futás elszállt ezen a
    // domainen, a korábbiak viszont megvannak. A hiány kimondva marad, és
    // az előzmény attól még elérhető.
    const html = analysisBand(undefined, earlier(2));
    expect(html).toContain("Még nem futott");
    expect(html).toContain("<details");
  });

  it("a details alapból csukva van", () => {
    // Nyitva ugyanaz a hosszú lista lenne, csak összecsukható kerettel.
    expect(historyBlock(earlier(3))).not.toContain("<details class=\"elozmeny\" open");
  });

  it("a stíluslap kezeli az elozmeny osztályt", () => {
    const rules = STYLE.split("\n").filter((l) => l.trimStart().startsWith(".elozmeny"));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join("")).not.toContain("riado");
  });
});
