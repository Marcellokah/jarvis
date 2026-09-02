import { describe, it, expect } from "vitest";
import { SOROZATOK, valuesFrom } from "../../src/delivery/http/view/chart/registry.ts";
import { HISTORY_COLUMNS } from "../../src/infra/db/repositories/health.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

describe("sorozat-regiszter", () => {
  it("minden bejegyzés valódi történet-oszlopra mutat", () => {
    // Egy diagram, aminek nincs oszlopa, üres marad örökre — jobb, ha a
    // regiszter maga nem tud ilyet tartalmazni.
    for (const column of SOROZATOK.keys()) {
      expect(HISTORY_COLUMNS.has(column), column).toBe(true);
    }
  });

  it("a számlálók nulláról indulnak, a mérések nem", () => {
    // Nem ízlés: a nulla lépés valódi érték és az arányok számítanak, a nulla
    // HRV viszont fizikailag értelmetlen, és egy nulla-alapú tengely a teljes
    // ingadozást egy hajszálvonalba lapítaná.
    expect(SOROZATOK.get("steps")!.zeroBased).toBe(true);
    expect(SOROZATOK.get("move_kcal")!.zeroBased).toBe(true);
    expect(SOROZATOK.get("hrv")!.zeroBased).toBe(false);
    expect(SOROZATOK.get("rhr")!.zeroBased).toBe(false);
    expect(SOROZATOK.get("vo2max")!.zeroBased).toBe(false);
  });

  it("a pillanatképekből a helyes mezőt olvassa ki", () => {
    const snaps = [
      { date: "2026-01-01", hrv: 61.2, steps: 9000 },
      { date: "2026-01-02", hrv: null, steps: 0 },
    ] as unknown as HealthSnapshot[];

    expect(valuesFrom(snaps, "hrv")).toEqual([
      { date: "2026-01-01", value: 61.2 },
      { date: "2026-01-02", value: null },
    ]);
    // A mért nulla valódi mérés, nem hiány.
    expect(valuesFrom(snaps, "steps")[1]).toEqual({ date: "2026-01-02", value: 0 });
  });

  it("ismeretlen oszlopra üres listát ad, nem hibázik", () => {
    expect(valuesFrom([], "nincs_ilyen")).toEqual([]);
  });
});
