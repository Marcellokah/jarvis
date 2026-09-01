import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import {
  createHealthRepo, ACCUMULATES_OVER_DAY, HISTORY_COLUMNS, SNAPSHOT_FIELDS,
  type HealthSnapshot,
} from "../../src/infra/db/repositories/health.ts";

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
        dietCarbsG: null, dietFatG: null,
        distanceKm: null, standMin: null, walkingSpeed: null, stepLengthCm: null,
        doubleSupportPct: null, asymmetryPct: null, steadinessPct: null,
        sixMinWalkM: null, stairUpMs: null, stairDownMs: null },
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
        dietCarbsG: null, dietFatG: null,
        distanceKm: null, standMin: null, walkingSpeed: null, stepLengthCm: null,
        doubleSupportPct: null, asymmetryPct: null, steadinessPct: null,
        sixMinWalkM: null, stairUpMs: null, stairDownMs: null },
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

  it("re-importing the same export changes nothing", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52, steps: 8400 }, NOW);
    repo.fillGaps("2026-03-02", { rhr: 52, steps: 8400 }, NOW);

    const row = repo.forDate("2026-03-02")!;
    expect(row.rhr).toBe(52);
    expect(row.steps).toBe(8400);
    db.close();
  });

  /**
   * The qualified half of the claim above, which used to be stated flatly as
   * idempotence and is no longer true in that form.
   *
   * Two imports disagreeing about the same day means the second export saw
   * more of it — an export made at 10:00 and one made at 23:00 do not hold the
   * same step count. For a counter that makes the later run the better one, so
   * running the import twice is a no-op only when the two runs agree. A
   * reading that was final when taken has no such story: a second export
   * cannot have measured this morning's RHR any better, so the first value
   * stands.
   */
  it("takes the newer figure when a re-import disagrees about a day total", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52, steps: 8400 }, NOW);
    repo.fillGaps("2026-03-02", { rhr: 99, steps: 8700 }, NOW);

    const row = repo.forDate("2026-03-02")!;
    expect(row.rhr).toBe(52);     // final when taken — the first import's stands
    expect(row.steps).toBe(8700); // a counter — the later writer saw more of the day
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
 * The one rule, pinned from both sides.
 *
 * The winner is decided by the KIND of measurement, and the two kinds behave
 * differently under ordering — which is the point, not an inconsistency. A
 * reading that is final when taken belongs to whoever took it, so the phone
 * keeps it however often the export is replayed over that day, in either
 * order. A counter belongs to whoever wrote last, because writing last is what
 * it means to have seen more of the day; so for a day total the order IS the
 * verdict. What keeps that safe is that the import never writes a day it saw
 * only part of — see `health-partial-day.test.ts`.
 */
describe("precedence between the phone and the import", () => {
  it("lets the import correct a day total the phone sent at 23:55", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(phone("2026-08-31", { steps: 9000 }), { steps: 9000 }, NOW);
    repo.fillGaps("2026-08-31", { steps: 12_400 }, NOW);

    // The export saw the whole day; the evening run could not have.
    expect(repo.forDate("2026-08-31")!.steps).toBe(12_400);
    db.close();
  });

  /**
   * The 23:55 run failed and the user re-ran it at 23:59.
   *
   * This is the case the old rule got backwards: it froze the first value and
   * left only the monthly import able to correct it. Two posts about the same
   * counter cannot both be right, and the later one is four minutes less wrong
   * — a counter only ever goes up as the day runs.
   */
  it("takes the later of two phone posts for the same day total", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(phone("2026-08-31", { steps: 11_800 }), { steps: 11_800 }, NOW);
    repo.upsert(phone("2026-08-31", { steps: 12_050 }), { steps: 12_050 }, NOW);

    expect(repo.forDate("2026-08-31")!.steps).toBe(12_050);
    db.close();
  });

  /**
   * The same rule seen from the other side, and the reason it is safe.
   *
   * A phone post landing after the import wins the day total too — last writer,
   * fullest view, no exception carved out for who the writer is. It takes an
   * explicit `date` in the request to even reach this situation, because the
   * import no longer writes totals for the day it stopped mid-way through; and
   * when it does happen, the post is a person deliberately re-sending that day.
   */
  it("lets a later phone post correct a day total the import wrote", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-08-31", { steps: 12_400 }, NOW);
    repo.upsert(phone("2026-08-31", { steps: 12_900 }), { steps: 12_900 }, NOW);

    expect(repo.forDate("2026-08-31")!.steps).toBe(12_900);
    db.close();
  });

  /**
   * A day average is not an accumulation, and must not be treated as one.
   *
   * `walking_hr` is a single figure Apple has already computed for the day, and
   * `walking_speed` and the gait percentages come out of the rollup's plain
   * mean — the same path as `hrv` and `rhr`. The export having more samples of
   * a mean does not make its number more complete, only different, so the
   * phone's own reading stands.
   */
  it("keeps the phone's gait and walking figures against the export's means", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(
      phone("2026-08-31", { walkingHr: 112, walkingSpeed: 5.1, stepLengthCm: 74,
        doubleSupportPct: 27.5, asymmetryPct: 1.2, stairUpMs: 0.42, stairDownMs: 0.55 }),
      {}, NOW,
    );
    repo.fillGaps("2026-08-31", {
      walking_hr: 98, walking_speed: 4.2, step_length_cm: 68,
      double_support_pct: 31.0, asymmetry_pct: 3.4, stair_up_ms: 0.31, stair_down_ms: 0.40,
    }, NOW);

    const row = repo.forDate("2026-08-31")!;
    expect(row.walkingHr).toBe(112);
    expect(row.walkingSpeed).toBe(5.1);
    expect(row.stepLengthCm).toBe(74);
    expect(row.doubleSupportPct).toBe(27.5);
    expect(row.asymmetryPct).toBe(1.2);
    expect(row.stairUpMs).toBe(0.42);
    expect(row.stairDownMs).toBe(0.55);
    db.close();
  });

  it("keeps the phone's morning HRV against the export's whole-day average", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(phone("2026-08-31", { hrv: 87 }), { hrv: 87 }, NOW);
    repo.fillGaps("2026-08-31", { hrv: 61 }, NOW);

    // 61 is not a worse copy of 87 — it is a different number, and not the one
    // the brief asks about.
    expect(repo.forDate("2026-08-31")!.hrv).toBe(87);
    db.close();
  });

  it("still prefers the phone's HRV when the import got there first", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-08-31", { hrv: 61 }, NOW);
    repo.upsert(phone("2026-08-31", { hrv: 87 }), { hrv: 87 }, NOW);

    expect(repo.forDate("2026-08-31")!.hrv).toBe(87);
    db.close();
  });
});

/**
 * The three lists that decide what gets written, and how.
 *
 * They are three hand-maintained lists of the same columns, and nothing in the
 * type system connects them. Dropping a row from `SNAPSHOT_FIELDS` typechecks
 * cleanly and does not throw at runtime either: the column simply stops being
 * named in the upsert, which silently turns "the phone's post wins this" into
 * "a phone post cannot change this at all". A misspelling in
 * `ACCUMULATES_OVER_DAY` is quieter still — it classifies a column that does
 * not exist, and the real one keeps the wrong precedence forever.
 */
describe("the column lists that have to agree", () => {
  it("has the phone's upsert write exactly the columns the import may write", () => {
    const upsertColumns = SNAPSHOT_FIELDS.map(([column]) => column);

    // Sorted arrays rather than sets, so a duplicated row fails too.
    expect(upsertColumns.slice().sort()).toEqual([...HISTORY_COLUMNS].sort());
  });

  it("only classifies columns that exist", () => {
    const unknown = [...ACCUMULATES_OVER_DAY].filter((c) => !HISTORY_COLUMNS.has(c));
    expect(unknown).toEqual([]);
  });
});
