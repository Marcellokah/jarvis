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

/** A machine-formatted number: digits, optionally a dot fraction. */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * The one comma shape the phone was observed to send: digits, one comma,
 * digits, and nothing else anywhere in the string.
 */
const COMMA_DECIMAL = /^-?\d+,\d+$/;

/**
 * A counter aggregate's value as the phone writes it -> a string the rollup can
 * read, or null.
 *
 * Shortcuts renders numbers in the phone's locale, and the owner's phone is
 * Hungarian: measured on 2026-09-01, `8.71793477021344` km arrived as
 * `8,71793477021344` and 1198.363 kcal as `1198,36299999997`. The rollup calls
 * `Number()` on the value, which returns NaN for both — so `distance_km`
 * vanished from that day entirely and the energy columns lost their only real
 * source. Integers were unaffected, which is why steps and flights landed.
 *
 * WHY A DECIMAL COMMA IS UNAMBIGUOUS HERE, when `1,234` is not in general.
 * `1198,36299999997` is the proof: a locale that grouped thousands would have
 * written it `1.198,36299999997`. Shortcuts emits no grouping separator at all,
 * so within this payload a comma can only be the decimal point. Crucially, that
 * reading is not an assumption this function is free to be wrong about — every
 * shape that would REVEAL grouping (a second comma, a dot beside a comma, a
 * space between digit groups) fails both patterns and is refused by name. So if
 * the phone ever starts grouping, this returns null and the reply says so; it
 * cannot quietly turn 1234 into 1.234.
 *
 * What would have to change for the ambiguity to bite: Shortcuts (or another
 * caller) beginning to emit grouped thousands with the group separator omitted
 * for values under 10,000 — the one case that still looks like a bare decimal.
 * Nothing observed does that, and the fix if it appears is not a cleverer
 * heuristic but a locale declared in the payload, the same way `unit` is.
 *
 * Everything outside the two patterns is refused rather than coerced. `Number()`
 * is far too generous for a boundary like this: it reads "", " ", "0x1f", "1e5"
 * and "Infinity" as numbers, and an empty string as zero — which is the other
 * half of the same bug this fix exists for.
 */
export function normalisePhoneNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (PLAIN_NUMBER.test(trimmed)) return trimmed;
  if (COMMA_DECIMAL.test(trimmed)) return trimmed.replace(",", ".");
  return null;
}
