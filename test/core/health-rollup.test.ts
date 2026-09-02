import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readExport, FOOD_CORRELATION_DUPLICATE } from "../../src/infra/health-export/reader.ts";
import { rollup } from "../../src/infra/health-export/rollup.ts";

const FIXTURE = resolve("test/fixtures/health/export.xml");
const run = () => rollup(readExport(FIXTURE));
const day = async (d: string) => (await run()).days.find((x) => x.date === d);

describe("rollup", () => {
  it("sums what accumulates through the day, within one source", async () => {
    // The Watch's own two records, 1500 + 900 on 2026-03-01.
    expect((await day("2026-03-01"))!.values.steps).toBe(2400);
  });

  /**
   * The export is raw: every source's samples are in it, covering the same
   * real minutes. Health de-duplicates for display, so summing them here
   * produced days of 81,272 steps on the real export.
   */
  it("picks one source for a day rather than adding the sources together", async () => {
    const d = (await day("2026-03-01"))!;
    // Phone 1200 + 800 = 2000, Watch 1500 + 900 = 2400, over the same hours.
    expect(d.values.steps).toBe(2400);
    expect(d.values.steps).not.toBe(4400); // what summing both sources gives
    expect(d.contested.steps).toEqual({
      resolution: "pick",
      chosen: "Watch",
      sources: ["Phone", "Watch"],
    });
  });

  it("leaves a single-source column unmarked, so a mark means a real conflict", async () => {
    const d = (await day("2026-03-01"))!;
    expect(d.contested.rhr).toBeUndefined();
    expect(d.contested.diet_protein_g).toBeUndefined();
    expect((await day("2026-03-02"))!.contested.deep_min).toBeUndefined();
  });

  /**
   * The unit decides, not the number. 1000 kJ is 239 kcal — believable enough
   * to never be questioned, and wrong. Nothing converts; the record is skipped
   * and named, so a locale change shows up in the import's own report.
   */
  it("skips a record whose unit is not the one the column stores", async () => {
    const { skipped } = await run();
    expect((await day("2026-03-01"))!.values.move_kcal).toBe(420); // the kcal one
    expect(skipped["ActiveEnergyBurned: nem várt egység (kJ)"]).toBe(1);
  });

  it("counts a record it could not read at all, instead of dropping it silently", async () => {
    const { skipped } = await run();
    expect(skipped["Record: hiányzó type vagy startDate"]).toBe(1);
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
    // 23:10-03:10 (240) + 03:20-06:50 (210); the AutoSleep block below adds
    // nothing because it falls inside the first of those.
    expect(second!.values.asleep_min).toBe(450);
  });

  /**
   * Two devices recording the same night is two records of one night's sleep,
   * not two nights. Summing them is how the real export produced ten days
   * claiming more than fifteen hours asleep, and 19.9 hours at the worst.
   */
  it("unions overlapping intervals from two sources instead of adding them", async () => {
    const d = (await day("2026-03-02"))!;

    // AutoSleep's core block (00:00-02:00) lies inside the Watch's
    // (23:10-02:40), so the union is still the Watch's 210 minutes.
    expect(d.values.core_min).toBe(210);
    expect(d.values.core_min).not.toBe(330); // 210 + 120, if the two were summed

    // AutoSleep's in-bed block (06:00-08:00) runs past the Watch's
    // (23:00-07:00): the union is 23:00-08:00.
    expect(d.values.in_bed_min).toBe(540);
    expect(d.values.in_bed_min).not.toBe(600); // 480 + 120, if the two were summed

    expect(d.values.asleep_min).toBe(450);
    expect(d.values.asleep_min).not.toBe(570); // 450 + 120, if the two were summed
  });

  it("marks the columns two sources competed for, so the number can be explained", async () => {
    const d = (await day("2026-03-02"))!;
    expect(d.contested.asleep_min).toEqual({
      resolution: "union",
      sources: ["AutoSleep", "Watch"],
    });
    expect(d.contested.in_bed_min).toEqual({
      resolution: "union",
      sources: ["AutoSleep", "Watch"],
    });
    // sleep_h is what the brief reads out loud, so it carries the same mark.
    expect(d.contested.sleep_h).toEqual(d.contested.asleep_min);
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
    expect(d.in_bed_min).toBe(540);
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

  /**
   * The end-to-end shape of the bug: the reader yielded both copies of every
   * food entry, the rollup added them together (same source, so the
   * pick-one-source rule never applied), and every dietary column came out
   * exactly double.
   */
  describe("food entries Apple writes twice", () => {
    const food = () => rollup(readExport(resolve("test/fixtures/health/food-correlation.xml")));

    it("does not double a dietary column when the entry is also inside a Correlation", async () => {
      const d = (await food()).days.find((x) => x.date === "2026-03-01")!;
      // 124 + 38, the two entries — what the phone's own Shortcut reports.
      expect(d.values.diet_kcal).toBe(162);
      expect(d.values.diet_kcal).not.toBe(324); // both copies summed
      expect(d.values.diet_protein_g).toBe(4.4);
      expect(d.values.diet_carbs_g).toBe(16.8);
      expect(d.values.diet_fat_g).toBe(3.2);
    });

    it("counts the collapsed copies so the import can report them", async () => {
      const { skipped } = await food();
      expect(skipped[FOOD_CORRELATION_DUPLICATE]).toBe(5);
    });
  });

  it("reports the range it covered", async () => {
    expect((await run()).range).toEqual({ from: "2026-03-01", to: "2026-03-02" });
  });

  it("returns days in date order, so an import writes them predictably", async () => {
    const dates = (await run()).days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});
