import { describe, it, expect } from "vitest";
import { layout, type ShellData } from "../../src/delivery/http/view/shell.ts";

const base: ShellData = {
  section: "ma",
  dateLabel: "2026. szeptember 2., szerda",
  briefAge: "2 órája",
  channels: { arrived: 3, waiting: 3, missing: 0, missingLabels: [], total: 6 },
  nav: { ma: true, elemzes: true, kerdes: false },
  body: "<p>törzs</p>",
};

describe("oldalkeret", () => {
  it("egy teljes dokumentumot ad, a törzzsel benne", () => {
    const html = layout(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<p>törzs</p>");
  });

  it("az aktív menüpontot megjelöli, és csak azt", () => {
    const html = layout({ ...base, section: "szamok" });
    // A CSS a fejlécben szó szerint tartalmazza az `aria-current="page"`
    // szelektort (theme.ts), ezért a keresést a <nav>-ra kell szűkíteni,
    // különben a stíluslap maga is találatnak számítana.
    const navHtml = /<nav[\s\S]*?<\/nav>/.exec(html)![0];
    expect((navHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(/<a[^>]*href="\/szamok"[^>]*aria-current="page"/.test(navHtml)).toBe(true);
  });

  it("a menüpontok jelzője a valódi adatból jön", () => {
    const html = layout(base);
    // A Kérdés jelzője kialszik, mert a modell nem érhető el.
    expect(/href="\/kerdes"[^>]*class="[^"]*holt/.test(html)).toBe(true);
    expect(/href="\/"[^>]*class="[^"]*holt/.test(html)).toBe(false);
  });

  it("a Számok menüpontnak nincs jelzője", () => {
    // Mindig van előzménye, tehát a jelzője soha nem tudna kialudni — egy
    // jelző, ami nem tud kikapcsolni, dekoráció.
    const nav = /<nav[\s\S]*?<\/nav>/.exec(layout(base))![0];
    const szamok = /<a[^>]*href="\/szamok"[\s\S]*?<\/a>/.exec(nav)![0];
    expect(szamok).not.toContain("jelzo");
  });

  it("elmaradt csatornát névvel és riasztó színnel mutat", () => {
    const html = layout({
      ...base,
      channels: { arrived: 3, waiting: 0, missing: 3, missingLabels: ["Lépés", "Aktív kalória", "Mozgás"], total: 6 },
    });
    expect(html).toContain("Lépés");
    expect(/class="[^"]*elmaradt/.test(html)).toBe(true);
  });

  it("nem mutat riasztást, amíg csak várakozás van", () => {
    const html = layout(base);
    expect(/class="[^"]*elmaradt/.test(html)).toBe(false);
  });

  it("escape-eli a beleadott szöveget", () => {
    const html = layout({ ...base, dateLabel: "<script>x()</script>" });
    expect(html).not.toContain("<script>x()</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
