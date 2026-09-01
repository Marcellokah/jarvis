import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";

const NOW = new Date("2026-08-31T10:00:00Z");

describe("fillGaps", () => {
  it("writes a day that did not exist", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52, steps: 8400, sleep_h: 7.2 }, NOW);

    const row = repo.forDate("2026-03-02")!;
    expect(row.rhr).toBe(52);
    expect(row.steps).toBe(8400);
    db.close();
  });

  /**
   * The phone posts today's readings each morning. A monthly re-import must
   * not overwrite them with whatever the export happened to contain — the
   * export is a snapshot taken at some point, the POST is what arrived today.
   */
  it("never overwrites a measurement that is already there", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(
      { date: "2026-08-31", sleepH: null, hrv: 87, rhr: 57,
        moveKcal: null, exerciseMin: null, steps: null,
        asleepMin: null, inBedMin: null, coreMin: null, remMin: null, deepMin: null,
        awakenings: null, vo2max: null, hrRecovery: null, walkingHr: null,
        basalKcal: null, flights: null, dietKcal: null, dietProteinG: null,
        dietCarbsG: null, dietFatG: null },
      { hrv: 87, rhr: 57 },
      NOW,
    );
    repo.fillGaps("2026-08-31", { hrv: 12, rhr: 99, steps: 5000 }, NOW);

    const row = repo.forDate("2026-08-31")!;
    expect(row.hrv).toBe(87);   // untouched
    expect(row.rhr).toBe(57);   // untouched
    expect(row.steps).toBe(5000); // was NULL, so filled
    db.close();
  });

  /**
   * The other direction of the same guard. The ingest route accepts an explicit
   * `date`, and it maps every reading the Shortcut did not send to null — so an
   * unconditional upsert blanked whatever the import had put in that row. A
   * post about sleep must not erase yesterday's step count.
   */
  it("a later phone post does not erase what it has nothing to say about", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52, steps: 8400, sleep_h: 7.2, hrv: 64 }, NOW);

    // What the route sends when Health had no HRV and no step sample: nulls.
    repo.upsert(
      { date: "2026-03-02", sleepH: 8.1, hrv: null, rhr: null,
        moveKcal: 300, exerciseMin: null, steps: null,
        asleepMin: null, inBedMin: null, coreMin: null, remMin: null, deepMin: null,
        awakenings: null, vo2max: null, hrRecovery: null, walkingHr: null,
        basalKcal: null, flights: null, dietKcal: null, dietProteinG: null,
        dietCarbsG: null, dietFatG: null },
      { sleepH: 8.1, moveKcal: 300 },
      NOW,
    );

    const row = repo.forDate("2026-03-02")!;
    expect(row.sleepH).toBe(8.1);   // the phone is the fresher source, it wins
    expect(row.moveKcal).toBe(300); // new, from the phone
    expect(row.steps).toBe(8400);   // imported, and the phone said nothing
    expect(row.hrv).toBe(64);       // imported, and the phone said nothing
    expect(row.rhr).toBe(52);       // imported, and the phone said nothing
    db.close();
  });

  it("is idempotent — running it twice changes nothing", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52 }, NOW);
    repo.fillGaps("2026-03-02", { rhr: 99 }, NOW);

    expect(repo.forDate("2026-03-02")!.rhr).toBe(52);
    db.close();
  });

  it("refuses a column that is not in the allowlist", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    // The column names come from the rollup, but they still reach SQL — an
    // allowlist is what keeps that boundary honest.
    expect(() => repo.fillGaps("2026-03-02", { "steps; DROP TABLE briefs": 1 }, NOW))
      .toThrow(/unknown column/i);
    db.close();
  });

  it("does nothing at all when given no values", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);
    repo.fillGaps("2026-03-02", {}, NOW);
    expect(repo.forDate("2026-03-02")).toBeUndefined();
    db.close();
  });

  it("exposes the new history columns on the snapshot", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { asleep_min: 430, deep_min: 30, vo2max: 41.2, diet_protein_g: 118 }, NOW);

    const row = repo.forDate("2026-03-02")!;
    expect(row.asleepMin).toBe(430);
    expect(row.deepMin).toBe(30);
    expect(row.vo2max).toBe(41.2);
    expect(row.dietProteinG).toBe(118);
    db.close();
  });
});
