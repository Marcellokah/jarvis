import type { Db } from "../index.ts";

export interface HealthSnapshot {
  date: string;
  sleepH: number | null;
  hrv: number | null;
  rhr: number | null;
  moveKcal: number | null;
  exerciseMin: number | null;
  steps: number | null;
}

export interface HealthRepo {
  upsert(snapshot: HealthSnapshot, raw: unknown, now: Date): void;
  latest(onOrBefore: string): HealthSnapshot | undefined;
  forDate(date: string): HealthSnapshot | undefined;
  /** Most recent `days` snapshots strictly before `date`, for baselines. */
  baseline(date: string, days: number): HealthSnapshot[];
}

interface Row {
  date: string;
  sleep_h: number | null;
  hrv: number | null;
  rhr: number | null;
  move_kcal: number | null;
  exercise_min: number | null;
  steps: number | null;
}

const toSnapshot = (r: Row): HealthSnapshot => ({
  date: r.date,
  sleepH: r.sleep_h,
  hrv: r.hrv,
  rhr: r.rhr,
  moveKcal: r.move_kcal,
  exerciseMin: r.exercise_min,
  steps: r.steps,
});

export function createHealthRepo(db: Db): HealthRepo {
  return {
    upsert(s, raw, now) {
      db.run(
        `INSERT INTO health_snapshots
           (date, sleep_h, hrv, rhr, move_kcal, exercise_min, steps, raw_json, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET
           sleep_h = excluded.sleep_h, hrv = excluded.hrv, rhr = excluded.rhr,
           move_kcal = excluded.move_kcal, exercise_min = excluded.exercise_min,
           steps = excluded.steps, raw_json = excluded.raw_json,
           ingested_at = excluded.ingested_at`,
        s.date, s.sleepH, s.hrv, s.rhr, s.moveKcal, s.exerciseMin, s.steps,
        JSON.stringify(raw), now.toISOString(),
      );
    },

    latest(onOrBefore) {
      const row = db.get<Row>(
        "SELECT * FROM health_snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1",
        onOrBefore,
      );
      return row ? toSnapshot(row) : undefined;
    },

    forDate(date) {
      const row = db.get<Row>("SELECT * FROM health_snapshots WHERE date = ?", date);
      return row ? toSnapshot(row) : undefined;
    },

    baseline(date, days) {
      return db
        .all<Row>(
          "SELECT * FROM health_snapshots WHERE date < ? ORDER BY date DESC LIMIT ?",
          date, days,
        )
        .map(toSnapshot);
    },
  };
}
