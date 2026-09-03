import type { Db } from "../index.ts";
import type { WorkoutRow } from "../../health-export/rollup.ts";

export interface WorkoutTypeTotal {
  type: string;
  sessions: number;
  minutes: number;
  /**
   * Total kcal across the sessions of this type that carry one — `null` when
   * not one of them does.
   *
   * `0` would be a claim that the sessions were measured and burned nothing.
   * `energy_kcal` is nullable and plenty of walks arrive without it, so the
   * distinction is real: SQLite's `SUM` over an all-NULL column answers NULL,
   * which is exactly the honest answer, and it is passed through rather than
   * coalesced to zero.
   */
  kcal: number | null;
  /** How many sessions the sum is built from — 400 kcal from one session of ten is a different claim than from ten. */
  kcalFrom: number;
  lastDate: string;
}

export interface WorkoutRepo {
  /** Inserts what is new. Returns how many rows were actually added. */
  save(rows: readonly WorkoutRow[]): number;
  forDate(date: string): WorkoutRow[];
  /** Inclusive on both ends, oldest first. */
  between(from: string, to: string): WorkoutRow[];
  /** Per-type totals over the whole history, busiest type first. */
  byType(): WorkoutTypeTotal[];
  /** One page of workouts, newest first, plus how many there are in total. */
  page(offset: number, limit: number): { rows: WorkoutRow[]; total: number };
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

    byType() {
      return db.all<{
        type: string; sessions: number; minutes: number;
        kcal: number | null; kcal_from: number; last_date: string;
      }>(
        `SELECT type,
                COUNT(*)           AS sessions,
                SUM(duration_min)  AS minutes,
                SUM(energy_kcal)   AS kcal,
                COUNT(energy_kcal) AS kcal_from,
                MAX(date)          AS last_date
           FROM workouts
          GROUP BY type
          ORDER BY sessions DESC, type`,
      ).map((r) => ({
        type: r.type, sessions: r.sessions, minutes: r.minutes,
        kcal: r.kcal, kcalFrom: r.kcal_from, lastDate: r.last_date,
      }));
    },

    page(offset, limit) {
      // Clamped here rather than trusted: a negative OFFSET is not an error in
      // SQLite, it quietly behaves as something the caller did not ask for,
      // and a zero LIMIT returns nothing at all — both would look like "there
      // are no workouts" to a page that has 2392 of them.
      const from = Math.max(0, Math.floor(offset));
      const size = Math.max(1, Math.floor(limit));
      const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workouts")?.n ?? 0;
      const rows = db.all<Row>(
        "SELECT * FROM workouts ORDER BY date DESC, started_at DESC LIMIT ? OFFSET ?",
        size, from,
      ).map(toWorkout);
      return { rows, total };
    },
  };
}
