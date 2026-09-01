import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { withoutPartialDayTotals } from "../../src/infra/health-export/partial-day.ts";
import {
  createHealthRepo, ACCUMULATES_OVER_DAY, type HealthSnapshot,
} from "../../src/infra/db/repositories/health.ts";

const NOW = new Date("2026-08-31T10:00:00Z");

/** What the route posts: the readings Health had, and null for all the rest. */
const phone = (
  date: string, values: Partial<Omit<HealthSnapshot, "date" | "ingestedAt">>,
): Omit<HealthSnapshot, "ingestedAt"> => ({
  date,
  sleepH: null, hrv: null, rhr: null, moveKcal: null, exerciseMin: null, steps: null,
  asleepMin: null, inBedMin: null, coreMin: null, remMin: null, deepMin: null,
  awakenings: null, vo2max: null, hrRecovery: null, walkingHr: null, basalKcal: null,
  flights: null, dietKcal: null, dietProteinG: null, dietCarbsG: null, dietFatG: null,
  distanceKm: null, standMin: null, walkingSpeed: null, stepLengthCm: null,
  doubleSupportPct: null, asymmetryPct: null, steadinessPct: null, sixMinWalkM: null,
  stairUpMs: null, stairDownMs: null,
  ...values,
});

/**
 * The import owns the day totals because it writes last and saw most — and the
 * one day where that is false is the day the export itself stopped on.
 */
describe("the export's own last day", () => {
  it("withholds its counters and keeps everything else", () => {
    const days = [
      { date: "2026-08-30", values: { steps: 11_200, hrv: 64, vo2max: 41.2 } },
      { date: "2026-08-31", values: { steps: 2100, hrv: 71, vo2max: 41.4 } },
    ];

    const trimmed = withoutPartialDayTotals(days, "2026-08-31");

    expect(trimmed.partialDay).toBe("2026-08-31");
    expect(trimmed.withheld).toEqual(["steps"]);
    // An HRV taken at 08:00 is finished being measured, whatever the clock says.
    expect(trimmed.days).toEqual([
      { date: "2026-08-30", values: { steps: 11_200, hrv: 64, vo2max: 41.2 } },
      { date: "2026-08-31", values: { hrv: 71, vo2max: 41.4 } },
    ]);
  });

  it("leaves an export that ends on a complete day alone", () => {
    const days = [{ date: "2026-08-30", values: { steps: 11_200, hrv: 64 } }];

    // Nothing is withheld from a day that is not the last one, and the report
    // stays silent — a skip line on every import would stop being read.
    const trimmed = withoutPartialDayTotals(days, "2026-08-31");

    expect(trimmed.partialDay).toBeNull();
    expect(trimmed.withheld).toEqual([]);
    expect(trimmed.days).toEqual(days);
  });

  /**
   * The zip may be weeks old, and then "the day it stops at" is not today.
   * Anchoring on today instead would withhold nothing at all from a stale
   * export — and withhold a whole good day from a fresh one every time the
   * import ran just after midnight.
   */
  it("is the export's last day, not today", () => {
    const days = [
      { date: "2026-07-04", values: { steps: 900, rhr: 52 } },
      { date: "2026-08-31", values: { steps: 11_200, rhr: 55 } },
    ];

    const trimmed = withoutPartialDayTotals(days, "2026-07-04");

    expect(trimmed.partialDay).toBe("2026-07-04");
    expect(trimmed.days.find((d) => d.date === "2026-07-04")!.values).toEqual({ rhr: 52 });
    expect(trimmed.days.find((d) => d.date === "2026-08-31")!.values).toEqual(
      { steps: 11_200, rhr: 55 },
    );
  });

  it("drops the day entirely when it held nothing but counters", () => {
    // The import counts what it handed to fillGaps to decide whether the write
    // survived; a day passed on with an empty value set would never be inserted
    // and would read as a lost day.
    const trimmed = withoutPartialDayTotals(
      [{ date: "2026-08-31", values: { steps: 2100, move_kcal: 180 } }], "2026-08-31",
    );

    expect(trimmed.days).toEqual([]);
    expect(trimmed.dayDropped).toBe(true);
    expect(trimmed.withheld).toEqual(["move_kcal", "steps"]);
  });

  it("withholds every counter and only the counters", () => {
    // Pinned against the set itself: a column added to ACCUMULATES_OVER_DAY
    // must be withheld here too, or the day it is added the import starts
    // writing half a day of it.
    const values = Object.fromEntries([...ACCUMULATES_OVER_DAY].map((c, i) => [c, i + 1]));
    const trimmed = withoutPartialDayTotals(
      [{ date: "2026-08-31", values: { ...values, hrv: 64 } }], "2026-08-31",
    );

    expect(trimmed.withheld).toEqual([...ACCUMULATES_OVER_DAY].sort());
    expect(trimmed.days[0]!.values).toEqual({ hrv: 64 });
  });

  /**
   * End to end, and the actual reason any of this exists.
   *
   * The phone posted its complete total at 23:55. An export dumped the next
   * morning holds a fraction of that same day. Without the filter the import
   * would win the column — it writes last — and replace 12,400 steps with
   * 2,100: not missing data, but confidently wrong data, and nothing
   * downstream could tell.
   */
  it("cannot overwrite the phone's complete total with half a day", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(phone("2026-08-31", { steps: 12_400, hrv: 87 }), {}, NOW);

    const trimmed = withoutPartialDayTotals(
      [{ date: "2026-08-31", values: { steps: 2100, vo2max: 41.4 } }], "2026-08-31",
    );
    for (const day of trimmed.days) repo.fillGaps(day.date, day.values, NOW);

    const row = repo.forDate("2026-08-31")!;
    expect(row.steps).toBe(12_400);
    expect(row.hrv).toBe(87);
    expect(row.vo2max).toBe(41.4); // final when taken, and the row had a hole
    db.close();
  });

  /**
   * And the day after: the same export's earlier days are whole, so there the
   * import is the last writer with the fullest view and does correct the
   * phone's five-minutes-short total.
   */
  it("still lets the import correct the days it saw whole", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(phone("2026-08-30", { steps: 12_400 }), {}, NOW);

    const trimmed = withoutPartialDayTotals([
      { date: "2026-08-30", values: { steps: 12_610 } },
      { date: "2026-08-31", values: { steps: 2100 } },
    ], "2026-08-31");
    for (const day of trimmed.days) repo.fillGaps(day.date, day.values, NOW);

    expect(repo.forDate("2026-08-30")!.steps).toBe(12_610);
    db.close();
  });
});
