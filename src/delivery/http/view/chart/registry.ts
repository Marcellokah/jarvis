import {
  SNAPSHOT_FIELDS, type HealthSnapshot,
} from "../../../../infra/db/repositories/health.ts";
import { hu } from "../format.ts";

export interface SeriesSpec {
  column: string;
  label: string;
  unit: string;
  /**
   * Whether the y axis starts at zero.
   *
   * Not a matter of taste. A COUNTER — steps, calories, minutes, distance —
   * starts at zero because zero is a real value there and the proportions are
   * the story. A MEASUREMENT — HRV, resting heart rate, VO2max, walking speed
   * — uses the data's own range, because zero is physically meaningless for it
   * and a zero-based axis would flatten the entire variation into a hairline.
   */
  zeroBased: boolean;
  format: (v: number) => string;
}


const spec = (
  column: string, label: string, unit: string, zeroBased: boolean, digits = 0,
): [string, SeriesSpec] => [
  column,
  { column, label, unit, zeroBased, format: (v) => `${hu(v, digits)}${unit ? ` ${unit}` : ""}` },
];

/** Only a column with a real daily history can carry a chart. */
export const SOROZATOK: ReadonlyMap<string, SeriesSpec> = new Map([
  spec("hrv", "HRV", "ms", false, 1),
  spec("rhr", "Nyugalmi pulzus", "bpm", false),
  spec("vo2max", "VO2max", "", false, 1),
  spec("hr_recovery", "Pulzus-visszatérés", "bpm", false),
  spec("asleep_min", "Alvás", "perc", true),
  spec("sleep_h", "Alvás", "óra", true, 1),
  spec("awakenings", "Ébredés", "", true),
  spec("steps", "Lépés", "lépés", true),
  spec("distance_km", "Táv", "km", true, 2),
  spec("move_kcal", "Aktív kalória", "kcal", true),
  spec("basal_kcal", "Alapanyagcsere", "kcal", true),
  spec("exercise_min", "Mozgás", "perc", true),
  spec("diet_kcal", "Bevitt kalória", "kcal", true),
  spec("diet_protein_g", "Fehérje", "g", true),
  spec("walking_speed", "Járássebesség", "km/h", false, 2),
  spec("step_length_cm", "Lépéshossz", "cm", false),
  spec("six_min_walk_m", "Hatperces séta", "m", false),
  spec("steadiness_pct", "Járásstabilitás", "%", false),
]);

const FIELD = new Map(SNAPSHOT_FIELDS.map(([column, field]) => [column, field]));

/** The snapshot rows for one column, keeping a measured zero as a measurement. */
export function valuesFrom(
  snapshots: readonly HealthSnapshot[], column: string,
): { date: string; value: number | null }[] {
  const field = FIELD.get(column);
  if (field === undefined) return [];
  return snapshots.map((s) => {
    const raw = s[field];
    return { date: s.date, value: typeof raw === "number" ? raw : null };
  });
}
