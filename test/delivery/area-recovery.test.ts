import { describe, it, expect } from "vitest";
import { recoveryBody } from "../../src/delivery/http/view/area/recovery.ts";
import type { Metric } from "../../src/core/analysis/stats.ts";

const NINCS: Metric = { value: null, n: 0, coverage: 0, window: "90d" };
const empty = {
  deviation: null,
  sleepByYear: [],
  stages: { core: NINCS, rem: NINCS, deep: NINCS },
  awakenings: NINCS,
  tiles: [],
  analysis: undefined,
  earlier: [],
};

/** Csak az „Alvás lefedettsége" sáv törzse — a fázistábla dead sávjai nem
 *  számítanak bele. Enélkül az állítást a lap egy másik része is kielégíti,
 *  és a teszt akkor is zöld, ha az alvássáv rosszul rajzol. */
const alvasSav = (html: string): string =>
  /Alvás lefedettsége<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

/** Csak a vezető sáv — a bare "6"/"84" szám máshol is előfordulhat az
 *  oldalon, és egy szűretlen `toContain` akkor is zöld maradna, ha az n7/n90
 *  fel lenne cserélve valahol a sávon KÍVÜL. */
const vezetoSav = (html: string): string =>
  /<section class="vezeto[^"]*">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

describe("Regeneráció oldal", () => {
  it("a HRV-eltérést mutatja vezető számként, a mintaszámokkal", () => {
    // Egy nyers ms-érték semmihez nem viszonyítható. A szórás annyit ér,
    // amennyi mérésből számoltuk — ezért van ott az n7 és az n90.
    //
    // D1: a bare "6" és "84" bárhol egyeznének az oldalon (pl. egy másik sáv
    // számjegyeiben is), így az n7/n90 felcserélése a `recoveryBody`-ban
    // zölden futott volna át. A sávra szűkített, teljes mondat pontosan
    // rögzíti, melyik szám melyik ablaké.
    const html = recoveryBody({ ...empty, deviation: { sigma: 1.42, n7: 6, n90: 84 } });
    const sav = vezetoSav(html);
    expect(sav).toContain("1,42");
    expect(sav).toContain("7 nap 6 mérése a 90 nap 84 méréséhez mérve");
  });

  it("eltérés nélkül nem nullát mutat", () => {
    const html = recoveryBody({ ...empty });
    expect(html).toContain("nincs elég mérés");
    expect(html).not.toMatch(/class="szam">0/);
  });

  it("az alvás lefedettségét évenként mutatja, sávval", () => {
    const sav = alvasSav(recoveryBody({
      ...empty,
      sleepByYear: [
        { year: "2022", days: 365, withSleep: 217 },
        { year: "2026", days: 245, withSleep: 43 },
      ],
    }));
    expect(sav).toContain("2022");
    expect(sav).toContain("217");
    expect(sav).toContain('class="rail"');
    expect(sav).toContain("59%");
  });

  it("a nulla lefedettségű évet kihaltnak jelöli, a mértet nem", () => {
    // Egy 0%-ra kitöltött sáv úgy néz ki, mint egy mérés, ami rosszul sült el.
    // A nulla mérés nem rossz mérés — nincs mérés. A két irányt egyszerre kell
    // állítani: egyetlen sorból nem derül ki, hogy a sáv mindig kihalt-e.
    const sav = alvasSav(recoveryBody({
      ...empty,
      sleepByYear: [
        { year: "2021", days: 365, withSleep: 0 },
        { year: "2022", days: 365, withSleep: 217 },
      ],
    }));
    expect((sav.match(/class="rail dead"/g) ?? [])).toHaveLength(1);
    expect((sav.match(/class="rail"/g) ?? [])).toHaveLength(1);
  });

  it("a nem mért alvásfázist hiányként írja, nem 0 percként", () => {
    const html = recoveryBody({ ...empty });
    expect(html).toContain("nincs mérés");
    expect(html).not.toContain("0 perc");
  });

  it("a mért fázist az értékével és a mintaszámával adja", () => {
    const html = recoveryBody({
      ...empty,
      stages: {
        core: { value: 215, n: 300, coverage: .3, window: "365d" },
        rem: NINCS, deep: NINCS,
      },
    });
    expect(html).toContain("215 perc");
    expect(html).toContain("300 nap");
  });

  it("a Mély alvás és az Alap alvás sora a saját fázisát hordozza, nem a másikét", () => {
    // G2: egy deep↔core csere a metricRow hívások adatoldalán (a "Mély
    // alvás" / "Alap alvás" feliratok megtartása mellett) minden korábbi
    // tesztet zölden hagyna, mert azok csak az egyik oldalt állítják be
    // egyszerre. Itt mindkét fázis saját, megkülönböztethető értéket kap, és
    // mindkét irányban ellenőrizzük — a saját sorára szűkítve —, hogy a
    // helyes érték landol benne.
    const html = recoveryBody({
      ...empty,
      stages: {
        deep: { value: 71, n: 40, coverage: .4, window: "90d" },
        core: { value: 215, n: 300, coverage: .3, window: "365d" },
        rem: NINCS,
      },
    });
    const deepRow = /<tr[^>]*><td>Mély alvás<\/td>[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    const coreRow = /<tr[^>]*><td>Alap alvás<\/td>[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(deepRow).toContain("71 perc");
    expect(deepRow).not.toContain("215 perc");
    expect(coreRow).toContain("215 perc");
    expect(coreRow).not.toContain("71 perc");
  });

  it("alvás-előzmény nélkül kimondja a hiányt", () => {
    expect(recoveryBody({ ...empty })).toContain("Nincs alvás-előzmény");
  });
});
