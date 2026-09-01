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
 * That single partial day is the exception to the import's ownership of
 * `ACCUMULATES_OVER_DAY`. The import wins those columns because it is the last
 * writer with the fullest view — which is exactly what it is not here, where
 * the phone's own 23:55 total is the complete one. Writing the half-day figure
 * would replace a true number with a smaller true-looking one, and a plausible
 * wrong total is worse than no total: nothing downstream could ever tell it
 * was only half a day.
 *
 * The day's other columns are unaffected. An HRV or a VO2max in that zip was
 * final the moment it was taken, and being taken at 08:00 on a day that had
 * not finished takes nothing away from it.
 *
 * `lastDay` is the export's own last day, not today: a zip found in Downloads
 * may be weeks old, and then the day it stops at is the partial one — today is
 * simply a day it says nothing about.
 */
export function withoutPartialDayTotals<D extends DayValues>(
  days: readonly D[], lastDay: string,
): TrimmedDays<D> {
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
