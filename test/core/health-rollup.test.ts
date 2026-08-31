import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readExport } from "../../src/infra/health-export/reader.ts";
import { rollup } from "../../src/infra/health-export/rollup.ts";

const FIXTURE = resolve("test/fixtures/health/export.xml");
const run = () => rollup(readExport(FIXTURE));
const day = async (d: string) => (await run()).days.find((x) => x.date === d);

describe("rollup", () => {
  it("sums what accumulates through the day", async () => {
    // 1200 + 800 steps on 2026-03-01
    expect((await day("2026-03-01"))!.values.steps).toBe(2000);
  });

  it("averages what is a point measurement", async () => {
    // Two resting heart rates, 52 and 56.
    expect((await day("2026-03-01"))!.values.rhr).toBe(54);
  });

  /**
   * A night crosses midnight, and the brief means "last night" when it says
   * sleep. Attributing a segment to its start date would file most of every
   * night under the previous day.
   */
  it("files a night under the day you woke up on", async () => {
    const first = await day("2026-03-01");
    const second = await day("2026-03-02");

    expect(first?.values.asleep_min).toBeUndefined();
    expect(second!.values.asleep_min).toBe(450); // 210 core + 30 deep + 210 rem
  });

  it("keeps the sleep stages apart", async () => {
    const d = (await day("2026-03-02"))!.values;
    expect(d.core_min).toBe(210);
    expect(d.deep_min).toBe(30);
    expect(d.rem_min).toBe(210);
  });

  it("counts awakenings and keeps time-in-bed separate from time asleep", async () => {
    const d = (await day("2026-03-02"))!.values;
    expect(d.awakenings).toBe(1);
    expect(d.in_bed_min).toBe(480);
    expect(d.in_bed_min).toBeGreaterThan(d.asleep_min!);
  });

  it("derives sleep_h from the minutes, for the existing brief", async () => {
    expect((await day("2026-03-02"))!.values.sleep_h).toBe(7.5);
  });

  it("skips types this product has no use for, and says which", async () => {
    const { skipped, days } = await run();
    expect(skipped.HandwashingEvent).toBe(1);
    for (const d of days) expect(Object.keys(d.values)).not.toContain("HandwashingEvent");
  });

  it("extracts workouts on the day they started", async () => {
    const { workouts } = await run();
    expect(workouts).toHaveLength(2);
    expect(workouts[0]).toMatchObject({
      date: "2026-03-01",
      type: "TraditionalStrengthTraining",
      durationMin: 47.5,
      energyKcal: 312.4,
    });
    expect(workouts[1]).toMatchObject({ date: "2026-03-02", type: "Walking", energyKcal: null });
  });

  it("reports the range it covered", async () => {
    expect((await run()).range).toEqual({ from: "2026-03-01", to: "2026-03-02" });
  });

  it("returns days in date order, so an import writes them predictably", async () => {
    const dates = (await run()).days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});
