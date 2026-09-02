import { describe, it, expect } from "vitest";
import { layout, SCRUB_SCRIPT, type ShellData } from "../../src/delivery/http/view/shell.ts";

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

  it("minden oldal kitörli a tokent a címsorból", () => {
    // A dokumentált belépő URL a `/?token=<TOKEN>` (deploy/README.md), és az
    // bármelyik oldalra mutathat — nem csak a kérdés-dobozéra, ahová a script
    // korábban került. A szerver már sütire cserélte a tokent, mire ez lefut;
    // ami marad, az a címsor (és vele az előzmény meg a könyvjelző) takarítása.
    for (const section of ["ma", "elemzes", "szamok", "kerdes"] as const) {
      const html = layout({ ...base, section });
      expect(html, section).toContain(SCRUB_SCRIPT);
    }
    expect(SCRUB_SCRIPT).toContain(`searchParams.delete("token")`);
    expect(SCRUB_SCRIPT).toContain("history.replaceState");
  });

  it("a takarítás csak a tokent viszi el, más paramétert nem", () => {
    // Egy `?token=…&valami=x` URL-ből a `valami` maradjon meg: csak a token
    // titok. A régi egysoros a teljes query stringet dobta.
    expect(SCRUB_SCRIPT).not.toContain("location.pathname)");
    expect(SCRUB_SCRIPT).toContain("u.pathname + u.search + u.hash");
  });

  it("escape-eli a beleadott szöveget", () => {
    const html = layout({ ...base, dateLabel: "<script>x()</script>" });
    expect(html).not.toContain("<script>x()</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
