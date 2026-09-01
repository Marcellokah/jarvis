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
   * Two imports disagreeing about the same day, which the test above cannot
   * distinguish from two agreeing ones.
   *
   * The first value stands, for a day total exactly as for a reading that was
   * final when taken. A newer export is not a better witness to a step count:
   * the rollup keeps one source's raw sum rather than merging them, so a second
   * run's larger figure may be a different device rather than a fuller day (see
   * `ACCUMULATES_OVER_DAY`). Overwriting on that basis would trade a true value
   * for a plausible one at random.
   */
  it("keeps the first import's figure when a re-import disagrees", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-03-02", { rhr: 52, steps: 8400 }, NOW);
    repo.fillGaps("2026-03-02", { rhr: 99, steps: 8700 }, NOW);

    const row = repo.forDate("2026-03-02")!;
    expect(row.rhr).toBe(52);
    expect(row.steps).toBe(8400);
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
 * Which writer wins a column both of them have something to say about.
 *
 * There is one rule and it does not look at the column: the import fills holes
 * and never overwrites, and a phone post writes whatever it carries. The tests
 * below pin both directions, including for the day counters — where an earlier
 * branch had the import overwrite, on the reasoning that a monthly export saw
 * the whole day. It does not: for a counter the rollup keeps one source's raw
 * sum, so neither writer holds Health's merged total and neither can correct
 * the other. `ACCUMULATES_OVER_DAY` survived that retreat because the partial
 * day still needs naming — see `health-partial-day.test.ts` — but nothing here
 * consults it any more.
 */
describe("precedence between the phone and the import", () => {
  /**
   * The one that changed, and the reason the branch was cut back.
   *
   * The phone posted its own total at 23:55; the export's figure for that day
   * is a single source's raw sum, which on any day two devices were worn is
   * deliberately short. 12,400 is not known to be worse than 9,000, so it is
   * not replaced by it.
   */
  it("does not let the import overwrite a day total the phone already sent", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(phone("2026-08-31", { steps: 9000 }), { steps: 9000 }, NOW);
    repo.fillGaps("2026-08-31", { steps: 12_400 }, NOW);

    expect(repo.forDate("2026-08-31")!.steps).toBe(9000);
    db.close();
  });

  /**
   * A pin, not a regression guard: `upsert` has always been incoming-wins.
   *
   * Worth holding because the two are easy to reason about separately and get
   * opposite by accident. The 23:55 run failed and the user re-ran it at 23:59
   * — the same source saying the same thing again, so there is nothing to weigh
   * and the second post simply lands.
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
   * The same pin across the two writers, which is the asymmetry of the rule.
   *
   * The import cannot overwrite the phone, but a phone post lands on top of an
   * imported value. That is not "later wins" — it is that a post is a person
   * deliberately sending that day's readings, which takes an explicit `date` in
   * the request for any day but today.
   */
  it("lets a phone post write over a day total the import wrote", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.fillGaps("2026-08-31", { steps: 12_400 }, NOW);
    repo.upsert(phone("2026-08-31", { steps: 12_900 }), { steps: 12_900 }, NOW);

    expect(repo.forDate("2026-08-31")!.steps).toBe(12_900);
    db.close();
  });

  /**
   * The same existing-wins rule, held across a wide sample of columns.
   *
   * These are the ones somebody re-reading the rule is most likely to want an
   * exception for: `walking_hr` and the gait figures because the export has
   * more samples of them, and `steps` because the export "saw more of the day".
   * The export's mean is a different number rather than a fuller one, and its
   * step count is one source's sum — neither is grounds for replacing what the
   * phone measured.
   */
  it("keeps every column the phone wrote, whatever kind it is", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    repo.upsert(
      phone("2026-08-31", { steps: 12_400, walkingHr: 112, walkingSpeed: 5.1,
        stepLengthCm: 74, doubleSupportPct: 27.5, asymmetryPct: 1.2,
        stairUpMs: 0.42, stairDownMs: 0.55 }),
      {}, NOW,
    );
    repo.fillGaps("2026-08-31", {
      steps: 9000, walking_hr: 98, walking_speed: 4.2, step_length_cm: 68,
      double_support_pct: 31.0, asymmetry_pct: 3.4, stair_up_ms: 0.31, stair_down_ms: 0.40,
      vo2max: 41.4,
    }, NOW);

    const row = repo.forDate("2026-08-31")!;
    expect(row.steps).toBe(12_400);
    expect(row.walkingHr).toBe(112);
    expect(row.walkingSpeed).toBe(5.1);
    expect(row.stepLengthCm).toBe(74);
    expect(row.doubleSupportPct).toBe(27.5);
    expect(row.asymmetryPct).toBe(1.2);
    expect(row.stairUpMs).toBe(0.42);
    expect(row.stairDownMs).toBe(0.55);
    expect(row.vo2max).toBe(41.4); // the phone had nothing to say, so the hole is filled
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
 * `ACCUMULATES_OVER_DAY` is quieter still — it names a column that does not
 * exist, and the real one is never withheld from a partial day again.
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
