import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import type { WorkoutRow } from "../../src/infra/health-export/rollup.ts";

const strength = (startedAt: string, date: string): WorkoutRow => ({
  date, type: "TraditionalStrengthTraining", startedAt,
  durationMin: 47.5, energyKcal: 312.4, source: "Watch",
});

describe("workout store", () => {
  it("saves and reports how many were new", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    expect(repo.save([strength("2026-03-01T16:00:00.000Z", "2026-03-01")])).toBe(1);
    db.close();
  });

  it("is idempotent — a re-import adds nothing", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    const rows = [strength("2026-03-01T16:00:00.000Z", "2026-03-01")];

    repo.save(rows);
    expect(repo.save(rows)).toBe(0);
    expect(repo.forDate("2026-03-01")).toHaveLength(1);
    db.close();
  });

  it("keeps two different workouts that started at the same moment", () => {
    // Rare but real: the key is (started_at, type), not started_at alone.
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      strength("2026-03-01T16:00:00.000Z", "2026-03-01"),
      { ...strength("2026-03-01T16:00:00.000Z", "2026-03-01"), type: "Cooldown" },
    ]);
    expect(repo.forDate("2026-03-01")).toHaveLength(2);
    db.close();
  });

  it("returns a range in date order, for trend queries", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      strength("2026-03-03T16:00:00.000Z", "2026-03-03"),
      strength("2026-03-01T16:00:00.000Z", "2026-03-01"),
      strength("2026-03-05T16:00:00.000Z", "2026-03-05"),
    ]);

    const range = repo.between("2026-03-01", "2026-03-03");
    expect(range.map((w) => w.date)).toEqual(["2026-03-01", "2026-03-03"]);
    db.close();
  });

  it("keeps a workout with no energy reading", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([{ ...strength("2026-03-02T11:00:00.000Z", "2026-03-02"), energyKcal: null }]);
    expect(repo.forDate("2026-03-02")[0]!.energyKcal).toBeNull();
    db.close();
  });
});
