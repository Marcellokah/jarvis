import { describe, it, expect, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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
    // 17 records, 2 workouts, and one record it could not read.
    expect(all.length).toBe(20);
    expect(all.filter((e) => e.kind === "record")).toHaveLength(17);
    expect(all.filter((e) => e.kind === "workout")).toHaveLength(2);
  });

  /**
   * A <Record> with no type or no startDate cannot be filed under a day, so it
   * cannot be stored — but it used to vanish without a trace, which looks
   * exactly like data that was never recorded. It is yielded as a counted
   * casualty instead, and the import reports it.
   */
  it("reports a record it cannot use rather than dropping it silently", async () => {
    const dropped = (await collect(FIXTURE)).filter((e) => e.kind === "dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toMatch(/startDate/);
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

  /**
   * The owner's export writes minutes and kcal today. Nothing converts, because
   * a duration read as hours instead of minutes, or kJ read as kcal, is a
   * confident number that is simply wrong — and the export's units follow the
   * phone's locale, so this can change without anything else changing.
   */
  describe("units it will not reinterpret", () => {
    const dirs: string[] = [];

    function xml(body: string): string {
      const dir = mkdtempSync(join(tmpdir(), "health-units-"));
      dirs.push(dir);
      const path = join(dir, "export.xml");
      writeFileSync(path, `<HealthData>\n${body}\n</HealthData>\n`);
      return path;
    }

    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("drops a workout whose duration is not in minutes, and names the unit", async () => {
      const all = await collect(xml(
        '<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="1.5"'
        + ' durationUnit="h" sourceName="Watch" startDate="2026-03-01 17:00:00 +0100"'
        + ' endDate="2026-03-01 18:30:00 +0100"/>',
      ));

      expect(all.filter((e) => e.kind === "workout")).toHaveLength(0);
      expect(all.filter((e) => e.kind === "dropped")).toHaveLength(1);
      expect((all[0] as { reason: string }).reason).toMatch(/h/);
    });

    it("keeps a workout whose energy is in kJ, but without the energy", async () => {
      const all = await collect(xml(
        '<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="18.2"'
        + ' durationUnit="min" sourceName="Watch" startDate="2026-03-01 17:00:00 +0100"'
        + ' endDate="2026-03-01 17:18:12 +0100">\n'
        + '  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="1000" unit="kJ"/>\n'
        + '</Workout>',
      ));

      const workouts = all.filter((e) => e.kind === "workout");
      expect(workouts).toHaveLength(1);
      // 1000 kJ is 239 kcal. Storing 1000 would have been the worse outcome.
      expect(workouts[0]!.energyKcal).toBeNull();
      expect(all.filter((e) => e.kind === "dropped")).toHaveLength(1);
    });
  });

  describe("zip failure modes", () => {
    // Each test builds its own throwaway archive in a temp dir — no network, and
    // never the real export. `zip` (like `unzip`) ships with macOS; it is only
    // ever invoked here, to construct a fixture, never by the reader itself.
    const dirs: string[] = [];

    function tmpDir(): string {
      const dir = mkdtempSync(join(tmpdir(), "health-export-"));
      dirs.push(dir);
      return dir;
    }

    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("fails loudly, naming the file and unzip's stderr, when the zip archive is corrupt", async () => {
      const dir = tmpDir();
      const badZip = join(dir, "export.zip");
      // Not a zip at all — unzip exits non-zero and writes nothing to stdout, which
      // is exactly the shape that used to look like "zero entries, no error".
      writeFileSync(badZip, "not actually a zip file\n");

      let message = "";
      try {
        await collect(badZip);
        expect.unreachable("expected readExport to throw on a corrupt archive");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(badZip);
      // Info-ZIP's own diagnostic; asserting on it proves stderr is actually
      // surfaced, not just the bare exit code.
      expect(message).toMatch(/zipfile/i);
    });

    it("fails loudly, naming the expected member, when unzip exits 0 but the export member is empty", async () => {
      const dir = tmpDir();
      mkdirSync(join(dir, "apple_health_export"));
      // A present-but-zero-byte member: unzip -p exits 0 and writes nothing — the
      // silent-zero case a non-zero exit code can't catch.
      writeFileSync(join(dir, "apple_health_export", "export.xml"), "");
      const zipPath = join(dir, "export.zip");
      execFileSync("zip", ["-q", zipPath, "apple_health_export/export.xml"], { cwd: dir });

      await expect(collect(zipPath)).rejects.toThrow(/apple_health_export\/export\.xml/);
    });

    it("still fails loudly when the archive is valid but the member name doesn't match", async () => {
      // A locale/export-version drift scenario: the archive is fine, but the path
      // the reader looks for isn't in it. Info-ZIP exits non-zero for this too, so
      // it goes through the same exit-code check as a corrupt archive.
      const dir = tmpDir();
      mkdirSync(join(dir, "apple_health_export"));
      writeFileSync(join(dir, "apple_health_export", "other.xml"), "<HealthData></HealthData>\n");
      const zipPath = join(dir, "export.zip");
      execFileSync("zip", ["-q", zipPath, "apple_health_export/other.xml"], { cwd: dir });

      await expect(collect(zipPath)).rejects.toThrow(/unzip failed/);
    });
  });
});
