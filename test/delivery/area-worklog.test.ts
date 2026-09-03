import { describe, it, expect } from "vitest";
import { OLDAL_MERET, parseOldal, worklogBody } from "../../src/delivery/http/view/area/worklog.ts";

const w = (date: string, type = "Walking", kcal: number | null = 140) => ({
  date, type, startedAt: `${date}T06:12:00.000Z`,
  durationMin: 32, energyKcal: kcal, source: "iPhone",
});

describe("parseOldal", () => {
  it("értelmes lapszámot elfogad", () => {
    expect(parseOldal("3", 500)).toBe(3);
  });

  it("minden értelmetlen bemenet az első oldalra esik", () => {
    // Ezek mind egy régi könyvjelzőből, egy elgépelésből vagy egy kézzel
    // szerkesztett URL-ből jönnek. Egyik sem a szerver hibája, és egyik sem
    // viheti el az oldalt — de 404-et sem kapnak, mert a napló LÉTEZIK.
    for (const raw of ["0", "-3", "9999", "abc", "", " ", "1.5", "1e3", undefined]) {
      expect(parseOldal(raw, 120), `bemenet: ${String(raw)}`).toBe(1);
    }
  });

  it("üres naplónál is az első oldal", () => {
    expect(parseOldal("1", 0)).toBe(1);
    expect(parseOldal("2", 0)).toBe(1);
  });

  it("az utolsó oldalt még elfogadja", () => {
    // 120 edzés, 50-esével: pontosan 3 oldal.
    expect(parseOldal("3", 120)).toBe(3);
    expect(parseOldal("4", 120)).toBe(1);
  });
});

describe("edzésnapló", () => {
  it("kiírja az edzés minden oszlopát", () => {
    // UTC 04:12 becomes 06:12 Budapest time in September (CEST, UTC+2).
    const html = worklogBody([{
      date: "2026-09-01", type: "Walking", startedAt: "2026-09-01T04:12:00.000Z",
      durationMin: 32, energyKcal: 140, source: "iPhone"
    }], 1, 1);
    expect(html).toContain("2026-09-01");  // date
    expect(html).toContain("06:12");       // local time (converted from UTC)
    expect(html).toContain("Walking");     // type
    expect(html).toContain("32 perc");     // duration
    expect(html).toContain("140 kcal");    // energy
    expect(html).toContain("iPhone");      // source
  });

  it("a kalória nélküli edzésnél nincs mérést ír", () => {
    const html = worklogBody([w("2026-09-01", "Walking", null)], 1, 1);
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("0 kcal");
  });

  it("a lapozó sosem mutat a tartományon kívülre", () => {
    // 120 edzés = 3 oldal. Az elsőn nincs "előző", az utolsón nincs
    // "következő" — egy link egy nem létező oldalra üres táblát adna, ami
    // azt állítaná, hogy ott nincs edzés.
    const first = worklogBody([w("2026-09-01")], 1, 120);
    expect(first).not.toContain("oldal=0");
    expect(first).toContain("oldal=2");

    const last = worklogBody([w("2026-01-01")], 3, 120);
    expect(last).toContain("oldal=2");
    expect(last).not.toContain("oldal=4");
  });

  it("megmondja, hányadik oldalon áll és hány edzésből", () => {
    const html = worklogBody([w("2026-09-01")], 2, 120);
    expect(html).toContain("2 / 3");
    expect(html).toContain("120");
  });

  it("egyetlen oldalnál egyáltalán nincs lapozó", () => {
    const html = worklogBody([w("2026-09-01")], 1, 4);
    expect(html).not.toContain("oldal=");
  });

  it("üres naplónál kimondja a hiányt, nem üres táblát ad", () => {
    const html = worklogBody([], 1, 0);
    expect(html).toContain("Nincs rögzített edzés");
    expect(html).not.toContain("<table>");
  });

  it("escape-eli a típust és a forrást", () => {
    const html = worklogBody([{ ...w("2026-09-01"), type: "<b>x</b>", source: "<i>y</i>" }], 1, 1);
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>y</i>");
    // Verify the escaped forms are actually present.
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;y&lt;/i&gt;");
  });

  it("az oldalméret ötven", () => {
    expect(OLDAL_MERET).toBe(50);
  });
});
