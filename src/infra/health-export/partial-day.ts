import { ACCUMULATES_OVER_DAY } from "../db/repositories/health.ts";

/** The part of the rollup's output this rule looks at. */
export interface DayValues {
  date: string;
  values: Record<string, number>;
}

export interface TrimmedDays<D extends DayValues> {
  /** What the import may actually write. */
  days: D[];
  /** The day whose counters were withheld, or null if there was nothing to withhold. */
  partialDay: string | null;
  /** The columns withheld from it, sorted — empty when nothing was. */
  withheld: string[];
  /** True when withholding left that day with nothing to write at all. */
  dayDropped: boolean;
}

/**
 * Withholds the counters of the one day the export only saw part of.
 *
 * An export is a snapshot taken at a moment, not at midnight. Whatever day it
 * was dumped on, that day's counters had only run as far as the dump: a zip
 * written at 10:00 holds ten hours of steps. Every earlier day in it is whole.
 *
 * Writing that fraction is what this prevents, and the damage would be
 * permanent: `fillGaps` only fills holes, so once 2,100 steps sit in the row no
 * later import can replace them with the day's real total. Worse, the number
 * does not look like the fraction it is — nothing downstream could tell a
 * ten-hour total from a lived one. Withheld, the column simply stays NULL: the
 * day looks as incomplete as it is, and the next import, for which that day is
 * no longer the last, fills it.
 *
 * The day's other columns are unaffected. An HRV or a VO2max in that zip was
 * final the moment it was taken, and being taken at 08:00 on a day that had
 * not finished takes nothing away from it.
 *
 * The partial day is the export's own last day, not today: a zip found in
 * Downloads may be weeks old, and then the day it stops at is the partial one —
 * today is simply a day it says nothing about.
 */
export function withoutPartialDayTotals<D extends DayValues>(
  days: readonly D[],
): TrimmedDays<D> {
  // The anchor is the last date present in `days`, and deliberately not the
  // rollup's `range.to`. That range is computed over every entry it read,
  // workouts included, so an export whose last day holds nothing but a workout
  // has a range end that appears in no `days` entry at all — anchored there,
  // this function would match nothing and hand the genuinely partial day
  // straight through. `days` is exactly what the import writes, so its last
  // date is the last day this guard can act on. Scanned rather than taken off
  // the end, because nothing in the type says the rollup's output is sorted.
  const lastDay = days.reduce<string | null>(
    (latest, day) => (latest === null || day.date > latest ? day.date : latest),
    null,
  );
  if (lastDay === null) {
    return { days: [], partialDay: null, withheld: [], dayDropped: false };
  }

  const withheld: string[] = [];
  let dayDropped = false;

  const kept = days.flatMap((day) => {
    if (day.date !== lastDay) return [day];

    const values: Record<string, number> = {};
    for (const [column, value] of Object.entries(day.values)) {
      if (ACCUMULATES_OVER_DAY.has(column)) withheld.push(column);
      else values[column] = value;
    }

    // A day with nothing left to write is removed rather than passed on empty,
    // so that what the import counts as written stays the truth.
    if (Object.keys(values).length === 0) { dayDropped = true; return []; }
    return [{ ...day, values }];
  });

  withheld.sort();
  return {
    days: kept,
    partialDay: withheld.length > 0 ? lastDay : null,
    withheld,
    dayDropped,
  };
}
