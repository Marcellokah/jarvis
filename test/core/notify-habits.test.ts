import { describe, it, expect } from "vitest";
import { candidates, HABIT_LAPSE_DAYS, type CandidateInput } from "../../src/core/notify/candidates.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { memoryDb } from "../helpers.ts";
import { TZ } from "../../src/shared/dates.ts";

const NOW = new Date("2026-09-10T10:00:00.000Z");

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    now: NOW, tz: TZ, metrics: null, newAnalyses: [], deadlines: [],
    lastSleepDate: null, lastDietDate: null, ...over,
  };
}

describe("candidates — habits", () => {
  it("says nothing while the habit is being kept", () => {
    const found = candidates(input({ lastSleepDate: "2026-09-10", lastDietDate: "2026-09-09" }));
    expect(found).toEqual([]);
  });

  it("speaks once a habit has lapsed", () => {
    const found = candidates(input({ lastSleepDate: "2026-09-01", lastDietDate: "2026-09-10" }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("habit");
    expect(found[0]!.text).toMatch(/alvás/i);
    expect(found[0]!.text).toContain("9");   // nine days
  });

  it("counts both lapses separately", () => {
    const found = candidates(input({ lastSleepDate: "2026-08-01", lastDietDate: "2026-08-01" }));
    expect(found).toHaveLength(2);
    expect(new Set(found.map((c) => c.key)).size).toBe(2);
  });

  it("does not fire on the day the threshold is reached minus one", () => {
    const justInside = new Date(NOW.getTime() - (HABIT_LAPSE_DAYS - 1) * 86_400_000)
      .toISOString().slice(0, 10);
    expect(candidates(input({ lastSleepDate: justInside, lastDietDate: justInside }))).toEqual([]);
  });

  it("says nothing when a habit was never started", () => {
    // Null is "no data ever", and nagging about a habit that never existed is
    // not the assistant's business.
    expect(candidates(input({ lastSleepDate: null, lastDietDate: null }))).toEqual([]);
  });

  it("keys the lapse without a date, so it is not repeated daily", () => {
    const a = candidates(input({ lastSleepDate: "2026-09-01" }))[0]!.key;
    const b = candidates(input({ now: new Date("2026-09-11T10:00:00.000Z"), lastSleepDate: "2026-09-01" }))[0]!.key;
    expect(b).toBe(a);
  });
});

describe("lastDateWith", () => {
  it("returns the most recent day that has a value in the column", () => {
    const db = memoryDb();
    const repo = createHealthRepo(db);
    const now = new Date("2026-09-10T00:00:00.000Z");
    repo.fillGaps("2026-09-01", { asleep_min: 400 }, now);
    repo.fillGaps("2026-09-05", { steps: 9000 }, now);
    expect(repo.lastDateWith("asleep_min")).toBe("2026-09-01");
    db.close();
  });

  it("returns null when the column was never filled", () => {
    const db = memoryDb();
    expect(createHealthRepo(db).lastDateWith("diet_kcal")).toBeNull();
    db.close();
  });

  it("refuses a column that is not on the allowlist", () => {
    // The same guard fillGaps uses: a column name reaching SQL from anywhere
    // but the allowlist is a bug worth failing loudly on.
    const db = memoryDb();
    expect(() => createHealthRepo(db).lastDateWith("date; DROP TABLE health_snapshots")).toThrow();
    db.close();
  });
});
