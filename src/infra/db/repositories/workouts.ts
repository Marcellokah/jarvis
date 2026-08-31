import type { Db } from "../index.ts";
import type { WorkoutRow } from "../../health-export/rollup.ts";

export interface WorkoutRepo {
  /** Inserts what is new. Returns how many rows were actually added. */
  save(rows: readonly WorkoutRow[]): number;
  forDate(date: string): WorkoutRow[];
  /** Inclusive on both ends, oldest first. */
  between(from: string, to: string): WorkoutRow[];
}

interface Row {
  started_at: string; type: string; date: string;
  duration_min: number; energy_kcal: number | null; source: string | null;
}

const toWorkout = (r: Row): WorkoutRow => ({
  date: r.date,
  type: r.type,
  startedAt: r.started_at,
  durationMin: r.duration_min,
  energyKcal: r.energy_kcal,
  source: r.source ?? "",
});

/**
 * Workouts, keyed by when they started and what they were.
 *
 * A monthly re-import replays years of the same workouts, so the insert has to
 * be a no-op for anything already stored — `INSERT OR IGNORE` against the
 * natural key, rather than a read-then-write that would be slower and racier.
 */
export function createWorkoutRepo(db: Db): WorkoutRepo {
  return {
    save(rows) {
      if (rows.length === 0) return 0;

      const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workouts")?.n ?? 0;
      db.transaction(() => {
        for (const w of rows) {
          db.run(
            `INSERT OR IGNORE INTO workouts
               (started_at, type, date, duration_min, energy_kcal, source)
             VALUES (?, ?, ?, ?, ?, ?)`,
            w.startedAt, w.type, w.date, w.durationMin, w.energyKcal, w.source,
          );
        }
      });
      const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workouts")?.n ?? 0;
      return after - before;
    },

    forDate(date) {
      return db
        .all<Row>("SELECT * FROM workouts WHERE date = ? ORDER BY started_at", date)
        .map(toWorkout);
    },

    between(from, to) {
      return db
        .all<Row>(
          "SELECT * FROM workouts WHERE date >= ? AND date <= ? ORDER BY date, started_at",
          from, to,
        )
        .map(toWorkout);
    },
  };
}
