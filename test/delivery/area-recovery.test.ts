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
};

/** Csak az „Alvás lefedettsége" sáv törzse — a fázistábla dead sávjai nem
 *  számítanak bele. Enélkül az állítást a lap egy másik része is kielégíti,
 *  és a teszt akkor is zöld, ha az alvássáv rosszul rajzol. */
const alvasSav = (html: string): string =>
  /Alvás lefedettsége<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

describe("Regeneráció oldal", () => {
  it("a HRV-eltérést mutatja vezető számként, a mintaszámokkal", () => {
    // Egy nyers ms-érték semmihez nem viszonyítható. A szórás annyit ér,
    // amennyi mérésből számoltuk — ezért van ott az n7 és az n90.
    const html = recoveryBody({ ...empty, deviation: { sigma: 1.42, n7: 6, n90: 84 } });
    expect(html).toContain("1,42");
    expect(html).toContain("6");
    expect(html).toContain("84");
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

  it("alvás-előzmény nélkül kimondja a hiányt", () => {
    expect(recoveryBody({ ...empty })).toContain("Nincs alvás-előzmény");
  });
});
