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
      earlierSynthesis: [],
      cards: [],
    });
    // Exact heading format to verify .slice(0, 10) truncation
    expect(html).toContain("<h2>Összegzés · 2026-09-01</h2>");
    // Verify full timestamp is NOT rendered (would be if slice was removed)
    expect(html).not.toContain("T07:11:50");
    expect(html).toContain("<strong>Összkép</strong>");
  });

  it("Összegzés nélkül nem ad üres címet", () => {
    // Egy "Összegzés" fejléc semmivel alatta hiányzó adat, ami nem látszik
    // hiányzónak.
    const html = hubBody({ synthesis: undefined, earlierSynthesis: [], cards: [card()] });
    expect(html).not.toContain("Összegzés");
  });

  it("minden kártya a saját területére visz", () => {
    const html = hubBody({ synthesis: undefined, earlierSynthesis: [], cards: [card()] });
    // Extract the card to verify its content (scoped to prevent false positives from other cards)
    const cardMatch = html.match(/<a class="kartya"[^>]*>.*?<\/a>/);
    expect(cardMatch).toBeTruthy();
    expect(cardMatch![0]).toContain('href="/terulet/terheles"');
    expect(cardMatch![0]).toContain("1,41×");
    expect(cardMatch![0]).toContain("A terhelés magas.");
  });

  it("a kártyán ott a forrás kora", () => {
    // Egy két hete készült elemzés összefoglalója akkor is két hetes, ha
    // magabiztosan hangzik.
    const html = hubBody({ synthesis: undefined, earlierSynthesis: [], cards: [card({ noteDate: "2026-08-20" })] });
    // Extract the card to verify date is wrapped in .kor span, not bare text
    const cardMatch = html.match(/<a class="kartya"[^>]*>.*?<\/a>/);
    expect(cardMatch).toBeTruthy();
    expect(cardMatch![0]).toContain('<span class="kor">2026-08-20</span>');
  });

  it("vezető szám nélküli kártya nem nullát mutat", () => {
    const html = hubBody({
      synthesis: undefined,
      earlierSynthesis: [],
      cards: [card({ figure: null, note: "Nincs elég előzmény.", noteDate: null })],
    });
    // Extract the card to verify missing-figure handling (scoped to prevent ambiguity with multiple cards)
    const cardMatch = html.match(/<a class="kartya[^>]*>.*?<\/a>/);
    expect(cardMatch).toBeTruthy();
    const cardHtml = cardMatch![0];
    expect(cardHtml).toContain("nincs adat");
    expect(cardHtml).not.toMatch(/class="szam">0/);
  });

  it("escape-eli a kártya szövegét", () => {
    const html = hubBody({
      synthesis: undefined,
      earlierSynthesis: [],
      cards: [card({
        title: "<b>T</b>",
        note: "<i>n</i>",
        figure: "<u>f</u>",
        noteDate: "<script>d</script>",
      })],
    });
    // Extract the card to verify escaping (scoped to prevent false positives from other cards)
    const cardMatch = html.match(/<a class="kartya"[^>]*>.*?<\/a>/);
    expect(cardMatch).toBeTruthy();
    const cardHtml2 = cardMatch![0];
    expect(cardHtml2).not.toContain("<b>T</b>");
    expect(cardHtml2).not.toContain("<i>n</i>");
    expect(cardHtml2).not.toContain("<u>f</u>");
    // Verify noteDate is also escaped
    expect(cardHtml2).not.toContain("<script>d</script>");
    expect(cardHtml2).toContain("&lt;script&gt;d&lt;/script&gt;");
  });
});
