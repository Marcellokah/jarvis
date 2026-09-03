import { describe, it, expect } from "vitest";
import { hubBody } from "../../src/delivery/http/view/area/hub.ts";

const card = (over: Partial<Parameters<typeof hubBody>[0]["cards"][number]> = {}) => ({
  href: "/terulet/terheles", title: "Terhelés",
  figure: "1,41×", note: "A terhelés magas.", noteDate: "2026-09-01", ...over,
});

describe("terület-hub", () => {
  it("az Összegzés elemzést a dátumával mutatja", () => {
    const html = hubBody({
      synthesis: { markdown: "**Összkép**", createdAt: "2026-09-01T07:11:50.124Z" },
      cards: [],
    });
    expect(html).toContain("Összegzés");
    expect(html).toContain("2026-09-01");
    expect(html).toContain("<strong>Összkép</strong>");
  });

  it("Összegzés nélkül nem ad üres címet", () => {
    // Egy "Összegzés" fejléc semmivel alatta hiányzó adat, ami nem látszik
    // hiányzónak.
    const html = hubBody({ synthesis: undefined, cards: [card()] });
    expect(html).not.toContain("Összegzés");
  });

  it("minden kártya a saját területére visz", () => {
    const html = hubBody({ synthesis: undefined, cards: [card()] });
    expect(html).toContain('href="/terulet/terheles"');
    expect(html).toContain("1,41×");
    expect(html).toContain("A terhelés magas.");
  });

  it("a kártyán ott a forrás kora", () => {
    // Egy két hete készült elemzés összefoglalója akkor is két hetes, ha
    // magabiztosan hangzik.
    const html = hubBody({ synthesis: undefined, cards: [card({ noteDate: "2026-08-20" })] });
    expect(html).toContain("2026-08-20");
  });

  it("vezető szám nélküli kártya nem nullát mutat", () => {
    const html = hubBody({
      synthesis: undefined,
      cards: [card({ figure: null, note: "Nincs elég előzmény.", noteDate: null })],
    });
    expect(html).toContain("nincs adat");
    expect(html).not.toMatch(/class="szam">0/);
  });

  it("escape-eli a kártya szövegét", () => {
    const html = hubBody({
      synthesis: undefined,
      cards: [card({ title: "<b>T</b>", note: "<i>n</i>", figure: "<u>f</u>" })],
    });
    expect(html).not.toContain("<b>T</b>");
    expect(html).not.toContain("<i>n</i>");
    expect(html).not.toContain("<u>f</u>");
  });
});
