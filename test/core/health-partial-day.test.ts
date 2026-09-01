import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import {
  withoutPartialDayTotals, type DayValues,
} from "../../src/infra/health-export/partial-day.ts";
import { rollup } from "../../src/infra/health-export/rollup.ts";
import type { ExportEntry } from "../../src/infra/health-export/reader.ts";
import {
  createHealthRepo, ACCUMULATES_OVER_DAY,
} from "../../src/infra/db/repositories/health.ts";

const NOW = new Date("2026-08-31T10:00:00Z");

const feed = (entries: ExportEntry[]) =>
  rollup((async function* () { for (const e of entries) yield e; })());

/**
 * The export was dumped mid-day, so its last day's counters stopped there.
 *
 * Withholding them is not a precedence rule and does not depend on one. It is
 * that `fillGaps` never overwrites: a half-day total written into an empty row
 * is there for good, and it looks exactly like a real one.
 */
describe("the export's own last day", () => {
  it("withholds its counters and keeps everything else", () => {
    const days = [
      { date: "2026-08-30", values: { steps: 11_200, hrv: 64, vo2max: 41.2 } },
      { date: "2026-08-31", values: { steps: 2100, hrv: 71, vo2max: 41.4 } },
    ];

    const trimmed = withoutPartialDayTotals(days);

    expect(trimmed.partialDay).toBe("2026-08-31");
    expect(trimmed.withheld).toEqual(["steps"]);
    // An HRV taken at 08:00 is finished being measured, whatever the clock says.
    expect(trimmed.days).toEqual([
      { date: "2026-08-30", values: { steps: 11_200, hrv: 64, vo2max: 41.2 } },
      { date: "2026-08-31", values: { hrv: 71, vo2max: 41.4 } },
    ]);
  });

  it("stays silent when the last day carries no counters at all", () => {
    // Nothing to withhold, so nothing is reported: a skip line printed on every
    // import would stop being read, and this one has to be read.
    const days: DayValues[] = [
      { date: "2026-08-30", values: { steps: 11_200, hrv: 64 } },
      { date: "2026-08-31", values: { hrv: 71 } },
    ];

    const trimmed = withoutPartialDayTotals(days);

    expect(trimmed.partialDay).toBeNull();
    expect(trimmed.withheld).toEqual([]);
    expect(trimmed.days).toEqual(days);
  });

  /**
   * The zip may be weeks old, and then "the day it stops at" is not today.
   * Anchoring on today instead would withhold nothing at all from a stale
   * export — and withhold a whole good day from a fresh one every time the
   * import ran just after midnight. Passed out of order on purpose: the anchor
   * is the latest date in the list, not the last element of it, and nothing in
   * the type promises the rollup's output is sorted.
   */
  it("anchors on the export's last day, not on today", () => {
    const days = [
      { date: "2026-07-04", values: { steps: 900, rhr: 52 } },
      { date: "2026-07-03", values: { steps: 11_200, rhr: 55 } },
    ];

    const trimmed = withoutPartialDayTotals(days);

    expect(trimmed.partialDay).toBe("2026-07-04");
    expect(trimmed.days.find((d) => d.date === "2026-07-04")!.values).toEqual({ rhr: 52 });
    expect(trimmed.days.find((d) => d.date === "2026-07-03")!.values).toEqual(
      { steps: 11_200, rhr: 55 },
    );
  });

  /**
   * Why the anchor is the last day in `days` and not the rollup's `range.to`.
   *
   * `range` is computed over every entry the reader produced, workouts
   * included, while `days` holds only the days that have column values. Go for
   * a run on the morning the zip is made and the range ends on a date that
   * appears nowhere in `days` — anchored there, the guard matches no day at
   * all and hands the genuinely partial one straight through to fillGaps.
   */
  it("withholds from the last day it can write, even when a workout ends the export", async () => {
    const steps = (day: string, count: string): ExportEntry => ({
      kind: "record", type: "StepCount", unit: "count", value: count,
      startDate: `${day} 09:00:00 +0200`, endDate: `${day} 09:10:00 +0200`,
      source: "iPhone",
    });
    const result = await feed([
      steps("2026-08-30", "11200"),
      steps("2026-08-31", "2100"),
      { kind: "workout", type: "Running", durationMin: 42, energyKcal: 380,
        startDate: "2026-09-01 07:00:00 +0200", endDate: "2026-09-01 07:42:00 +0200",
        source: "Watch" },
    ]);

    // The export's range runs a day past everything the import can write.
    expect(result.range!.to).toBe("2026-09-01");
    expect(result.days.map((d) => d.date)).toEqual(["2026-08-30", "2026-08-31"]);

    const trimmed = withoutPartialDayTotals(result.days);

    expect(trimmed.partialDay).toBe("2026-08-31");
    expect(trimmed.withheld).toEqual(["steps"]);
    expect(trimmed.days.map((d) => d.date)).toEqual(["2026-08-30"]);
  });

  it("drops the day entirely when it held nothing but counters", () => {
    // The import counts what it handed to fillGaps to decide whether the write
    // survived; a day passed on with an empty value set would never be inserted
    // and would read as a lost day.
    const trimmed = withoutPartialDayTotals(
      [{ date: "2026-08-30", values: { steps: 11_200 } },
       { date: "2026-08-31", values: { steps: 2100, move_kcal: 180 } }],
    );

    expect(trimmed.days.map((d) => d.date)).toEqual(["2026-08-30"]);
    expect(trimmed.dayDropped).toBe(true);
    expect(trimmed.withheld).toEqual(["move_kcal", "steps"]);
  });

  it("withholds every counter and only the counters", () => {
    // Pinned against the set itself: a column added to ACCUMULATES_OVER_DAY
    // must be withheld here too, or the day it is added the import starts
    // writing half a day of it.
    const values = Object.fromEntries([...ACCUMULATES_OVER_DAY].map((c, i) => [c, i + 1]));
    const trimmed = withoutPartialDayTotals(
      [{ date: "2026-08-31", values: { ...values, hrv: 64 } }],
    );

    expect(trimmed.withheld).toEqual([...ACCUMULATES_OVER_DAY].sort());
    expect(trimmed.days[0]!.values).toEqual({ hrv: 64 });
  });

  it("has nothing to say about an export with no days in it", () => {
    // The anchor is derived from `days`, so the empty case has to be an answer
    // rather than a crash — the import calls this before it looks at anything.
    const trimmed = withoutPartialDayTotals([]);

    expect(trimmed).toEqual({ days: [], partialDay: null, withheld: [], dayDropped: false });
  });

  /**
   * End to end, and the actual reason any of this exists.
   *
   * Nobody has written this day's steps yet, so there is nothing to protect it
   * from the import — `fillGaps` fills a NULL without hesitating, and 2,100
   * steps would then be the day's step count forever, because no later import
   * can overwrite a value that is already there. Withheld, the column stays
   * NULL and the next import fills in the whole day.
   */
  it("leaves the column empty rather than half-full, and a later import completes it", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    const morning = withoutPartialDayTotals(
      [{ date: "2026-08-31", values: { steps: 2100, vo2max: 41.4 } }],
    );
    for (const day of morning.days) repo.fillGaps(day.date, day.values, NOW);

    const half = repo.forDate("2026-08-31")!;
    expect(half.steps).toBeNull();      // missing, and it looks missing
    expect(half.vo2max).toBe(41.4);     // final when taken, and the row had a hole

    // The next month's export: 2026-08-31 is no longer the day it stops on.
    const later = withoutPartialDayTotals([
      { date: "2026-08-31", values: { steps: 12_400 } },
      { date: "2026-09-30", values: { steps: 3000 } },
    ]);
    for (const day of later.days) repo.fillGaps(day.date, day.values, NOW);

    expect(repo.forDate("2026-08-31")!.steps).toBe(12_400);
    db.close();
  });

  it("still writes the days it saw whole", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);

    const trimmed = withoutPartialDayTotals([
      { date: "2026-08-30", values: { steps: 12_610 } },
      { date: "2026-08-31", values: { steps: 2100 } },
    ]);
    for (const day of trimmed.days) repo.fillGaps(day.date, day.values, NOW);

    expect(repo.forDate("2026-08-30")!.steps).toBe(12_610);
    expect(repo.forDate("2026-08-31")).toBeUndefined();
    db.close();
  });
});
