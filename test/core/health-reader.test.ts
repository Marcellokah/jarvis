import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readExport, type ExportEntry } from "../../src/infra/health-export/reader.ts";

const FIXTURE = resolve("test/fixtures/health/export.xml");

async function collect(path: string): Promise<ExportEntry[]> {
  const out: ExportEntry[] = [];
  for await (const e of readExport(path)) out.push(e);
  return out;
}

describe("readExport", () => {
  it("reads a plain xml file, so tests never need a zip", async () => {
    const all = await collect(FIXTURE);
    expect(all.length).toBe(13);
  });

  it("strips the Apple identifier prefix from the type", async () => {
    const all = await collect(FIXTURE);
    const types = all.filter((e) => e.kind === "record").map((e) => e.type);
    expect(types).toContain("RestingHeartRate");
    expect(types).toContain("SleepAnalysis");
    expect(types.some((t) => t.startsWith("HK"))).toBe(false);
  });

  it("keeps the raw value and unit — parsing belongs to the rollup", async () => {
    const rhr = (await collect(FIXTURE)).find(
      (e) => e.kind === "record" && e.type === "RestingHeartRate",
    );
    expect(rhr).toMatchObject({ kind: "record", value: "52", unit: "count/min" });
  });

  it("reads a record whose opening tag is followed by child elements", async () => {
    // DietaryProtein is not self-closing: <MetadataEntry> children follow and a
    // </Record> closes it. Only the opening line carries the attributes.
    const protein = (await collect(FIXTURE)).filter(
      (e) => e.kind === "record" && e.type === "DietaryProtein",
    );
    expect(protein).toHaveLength(1);
    expect(protein[0]).toMatchObject({ value: "4.4" });
  });

  it("reads workouts, with duration and the energy from WorkoutStatistics", async () => {
    const workouts = (await collect(FIXTURE)).filter((e) => e.kind === "workout");
    expect(workouts).toHaveLength(2);
    expect(workouts[0]).toMatchObject({
      type: "TraditionalStrengthTraining",
      durationMin: 47.5,
      energyKcal: 312.4,
    });
    // The second workout has no statistics block at all.
    expect(workouts[1]).toMatchObject({ type: "Walking", energyKcal: null });
  });

  it("carries dates through verbatim — the rollup decides what a day is", async () => {
    const sleep = (await collect(FIXTURE)).filter(
      (e) => e.kind === "record" && e.type === "SleepAnalysis",
    );
    expect(sleep[0]).toMatchObject({
      startDate: "2026-03-01 23:10:00 +0100",
      endDate: "2026-03-02 02:40:00 +0100",
    });
  });

  it("reports a missing file rather than yielding nothing", async () => {
    await expect(collect("./does-not-exist.xml")).rejects.toThrow(/does-not-exist/);
  });
});
