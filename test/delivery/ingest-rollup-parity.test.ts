import { describe, it, expect } from "vitest";
import { readSamples } from "../../src/delivery/http/routes/ingest.ts";
import { rollup } from "../../src/infra/health-export/rollup.ts";
import type { ExportEntry } from "../../src/infra/health-export/reader.ts";

/**
 * The branch's central claim, under test: the phone route and the import route
 * are the same logic, so one night fed to both must come out identical.
 *
 * This was proved once by a scratchpad script that was then deleted, which left
 * the claim resting on nothing — the two paths could drift apart and the suite
 * would stay green. Every other sleep test exercises one path only.
 *
 * The fixture is deliberately adversarial: two sources with overlapping core
 * segments. That is what makes the union do real work — the three stage totals
 * (190 + 90 + 180 = 460) sum to more than `asleep_min` (430), and the 30-minute
 * difference is exactly the overlap being collapsed. An implementation that
 * merely added the stages up would pass a single-source fixture and fail here.
 */

/** One night, source-attributed, as the watch and a second app recorded it. */
const WATCH = "Marcell's Apple Watch";
const APP = "AutoSleep";

const NIGHT: { stage: string; label: string; from: string; to: string; source: string }[] = [
  { stage: "InBed", label: "In Bed", from: "2026-09-01 23:00:00", to: "2026-09-02 07:00:00", source: WATCH },
  { stage: "AsleepCore", label: "Core", from: "2026-09-01 23:20:00", to: "2026-09-02 02:00:00", source: WATCH },
  // The overlap: the second app's core segment starts inside the watch's and
  // runs past its end, straight into the watch's deep segment.
  { stage: "AsleepCore", label: "Core", from: "2026-09-02 01:30:00", to: "2026-09-02 02:30:00", source: APP },
  { stage: "AsleepDeep", label: "Deep", from: "2026-09-02 02:00:00", to: "2026-09-02 03:30:00", source: WATCH },
  { stage: "Awake", label: "Awake", from: "2026-09-02 03:30:00", to: "2026-09-02 03:40:00", source: WATCH },
  { stage: "AsleepREM", label: "REM", from: "2026-09-02 03:40:00", to: "2026-09-02 06:40:00", source: WATCH },
];

/** The import's shape: Apple's export format and Apple's own constants. */
const asExport: ExportEntry[] = NIGHT.map((s) => ({
  kind: "record",
  type: "SleepAnalysis",
  value: `HKCategoryValueSleepAnalysis${s.stage}`,
  unit: null,
  startDate: `${s.from} +0200`,
  endDate: `${s.to} +0200`,
  source: s.source,
}));

/** The phone's shape: ISO timestamps and the labels the Shortcuts app shows. */
const asPhone = NIGHT.map((s) => ({
  type: "SleepAnalysis",
  value: s.label,
  startDate: `${s.from.replace(" ", "T")}+02:00`,
  endDate: `${s.to.replace(" ", "T")}+02:00`,
  source: s.source,
}));

async function* stream(entries: ExportEntry[]): AsyncIterable<ExportEntry> {
  for (const e of entries) yield e;
}

describe("one night, both routes", () => {
  it("produces identical days through rollup and through readSamples", async () => {
    const viaImport = await rollup(stream(asExport));
    const viaPhone = await readSamples(asPhone);

    // Every key, not a chosen few — a column that only one route produces is
    // exactly the drift this test exists to catch.
    expect(viaPhone.days).toEqual(viaImport.days);
    expect(viaPhone.ignored).toEqual([]);
  });

  it("collapses the overlap rather than adding the stages up", async () => {
    const viaImport = await rollup(stream(asExport));
    const viaPhone = await readSamples(asPhone);

    for (const [route, days] of [["import", viaImport.days], ["phone", viaPhone.days]] as const) {
      expect(days, route).toHaveLength(1);
      const day = days[0]!;
      expect(day.date, route).toBe("2026-09-02"); // the day you woke up on

      expect(day.values.core_min, route).toBe(190); // 23:20 -> 02:30, both sources
      expect(day.values.deep_min, route).toBe(90);
      expect(day.values.rem_min, route).toBe(180);

      // The point of the fixture: the stages sum to 460, the union is 430.
      const stageSum = day.values.core_min! + day.values.deep_min! + day.values.rem_min!;
      expect(stageSum, route).toBe(460);
      expect(day.values.asleep_min, route).toBe(430);
      expect(stageSum - day.values.asleep_min!, route).toBe(30);

      expect(day.values.in_bed_min, route).toBe(480);
      expect(day.values.awakenings, route).toBe(1);
      expect(day.values.sleep_h, route).toBeCloseTo(7.2, 6);
    }
  });

  it("marks the contested columns the same way on both routes", async () => {
    // Two sources touched core (and therefore asleep, and therefore sleep_h);
    // the phone route must inherit that mark, not flatten it.
    const viaImport = await rollup(stream(asExport));
    const viaPhone = await readSamples(asPhone);

    // readSamples narrows its return type to what fillGaps needs, but it hands
    // back the rollup's own day objects, marks included.
    const contestedOf = (day: unknown) => (day as { contested: Record<string, unknown> }).contested;

    const contested = contestedOf(viaImport.days[0]);
    expect(Object.keys(contested).sort()).toEqual(["asleep_min", "core_min", "sleep_h"]);
    expect(contestedOf(viaPhone.days[0])).toEqual(contested);
  });
});
