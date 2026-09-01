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
 */
export function toAppleDate(iso: string): string | null {
  const m = ISO.exec(iso.trim());
  if (!m) return null;
  const [, day, time, zone] = m;
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
