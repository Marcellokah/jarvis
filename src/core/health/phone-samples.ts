/**
 * The boundary between what the phone can say and what the rollup expects.
 *
 * The rollup is the import's code and stays untouched: its correctness cannot
 * depend on the phone's path growing. These two functions translate at the
 * edge, and return null rather than guess — a guess here would file a sample
 * on the wrong day or under the wrong sleep stage, silently.
 */

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * ISO 8601 -> the export's own format, e.g. '2026-09-01 23:10:00 +0200'.
 *
 * The offset is preserved rather than normalised, because the rollup reads the
 * local day from the first ten characters with no conversion — that is the day
 * the owner actually lived, which is the honest answer when travelling.
 *
 * Validates date components by round-tripping through the Date constructor:
 * invalid values like month 13 or hour 99 will be rolled over and won't survive
 * the round-trip, ensuring we catch malformed timestamps that would be silently
 * filed on the wrong day.
 */
export function toAppleDate(iso: string): string | null {
  const m = ISO.exec(iso.trim());
  if (!m) return null;
  const [, day, time, zone] = m;

  // Extract and validate date/time components by round-tripping.
  const [yearStr, monthStr, dayStr] = day!.split("-");
  const [hourStr, minuteStr, secondStr] = time!.split(":");

  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10);
  const dayOfMonth = parseInt(dayStr!, 10);
  const hour = parseInt(hourStr!, 10);
  const minute = parseInt(minuteStr!, 10);
  const second = parseInt(secondStr!, 10);

  // Create a Date in UTC and extract the components back. Invalid values like
  // month 13 or day 45 will be rolled over, and the extracted values will not
  // match what we put in.
  const d = new Date(Date.UTC(year, month - 1, dayOfMonth, hour, minute, second));

  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== dayOfMonth ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second
  ) {
    return null;
  }

  const offset = zone === "Z" ? "+0000" : zone!.replace(":", "");
  return `${day} ${time} ${offset}`;
}

/** Apple's constants, and the labels the Shortcuts app shows for them. */
export const SLEEP_VALUES: Record<string, string> = {
  inbed: "HKCategoryValueSleepAnalysisInBed",
  awake: "HKCategoryValueSleepAnalysisAwake",
  core: "HKCategoryValueSleepAnalysisAsleepCore",
  light: "HKCategoryValueSleepAnalysisAsleepCore",
  rem: "HKCategoryValueSleepAnalysisAsleepREM",
  deep: "HKCategoryValueSleepAnalysisAsleepDeep",
  deepsleep: "HKCategoryValueSleepAnalysisAsleepDeep",
  asleep: "HKCategoryValueSleepAnalysisAsleepUnspecified",
  unspecified: "HKCategoryValueSleepAnalysisAsleepUnspecified",
};

/**
 * A sleep sample's value, as either Apple's constant or the app's own label.
 *
 * Deliberately liberal: the exact labels could not be measured, because there
 * is no staged sleep data yet to read them from. Deliberately loud too — an
 * unrecognised name returns null so the route can report it by name, and the
 * first real night tells us what we got wrong instead of losing it.
 */
export function normaliseSleepValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("HKCategoryValueSleepAnalysis")) return trimmed;
  return SLEEP_VALUES[trimmed.toLowerCase().replace(/[\s_-]/g, "")] ?? null;
}
