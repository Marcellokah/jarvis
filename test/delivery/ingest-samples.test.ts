import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, TEST_TOKEN, stubModule, type TestApp } from "../helpers.ts";

let app: TestApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function boot() {
  app = await buildTestApp({ modules: [stubModule({ name: "Teszt" })], now: "2026-09-02T05:00:00.000Z" });
  return app;
}

const post = (a: TestApp, payload: unknown) => a.server.inject({
  method: "POST", url: "/api/ingest/health",
  headers: { authorization: `Bearer ${TEST_TOKEN}` },
  payload: payload as Record<string, unknown>,
});

/** One night: in bed, then core, deep and a brief wake, ending on the 2nd. */
const NIGHT = [
  { type: "SleepAnalysis", value: "In Bed", startDate: "2026-09-01T23:00:00+02:00", endDate: "2026-09-02T07:00:00+02:00" },
  { type: "SleepAnalysis", value: "Core",   startDate: "2026-09-01T23:20:00+02:00", endDate: "2026-09-02T02:00:00+02:00" },
  { type: "SleepAnalysis", value: "Deep",   startDate: "2026-09-02T02:00:00+02:00", endDate: "2026-09-02T03:30:00+02:00" },
  { type: "SleepAnalysis", value: "Awake",  startDate: "2026-09-02T03:30:00+02:00", endDate: "2026-09-02T03:40:00+02:00" },
  { type: "SleepAnalysis", value: "REM",    startDate: "2026-09-02T03:40:00+02:00", endDate: "2026-09-02T06:40:00+02:00" },
];

describe("ingest — raw samples", () => {
  it("computes the night the same way the import would", async () => {
    const a = await boot();
    const res = await post(a, { samples: NIGHT });
    expect(res.statusCode).toBe(202);

    // Attributed to the day the night ENDS on, as the rollup already does.
    const row = a.health.forDate("2026-09-02")!;
    expect(row.coreMin).toBeCloseTo(160, 3);   // 23:20 -> 02:00
    expect(row.deepMin).toBeCloseTo(90, 3);    // 02:00 -> 03:30
    expect(row.remMin).toBeCloseTo(180, 3);    // 03:40 -> 06:40
    expect(row.awakenings).toBe(1);
    expect(row.asleepMin).toBeCloseTo(430, 3); // 160 + 90 + 180
    expect(row.inBedMin).toBeCloseTo(480, 3);  // 23:00 -> 07:00
  });

  it("reports a sleep stage it does not recognise instead of losing it", async () => {
    const a = await boot();
    const res = await post(a, {
      samples: [{ type: "SleepAnalysis", value: "Szendergés",
                  startDate: "2026-09-01T23:00:00+02:00", endDate: "2026-09-02T07:00:00+02:00" }],
    });
    const body = res.json() as { ignored: { field: string; reason: string }[] };
    expect(JSON.stringify(body.ignored)).toContain("Szendergés");
  });

  it("reports a date it cannot parse instead of filing it on the wrong day", async () => {
    const a = await boot();
    const res = await post(a, {
      samples: [{ type: "SleepAnalysis", value: "Core", startDate: "tegnap este", endDate: "ma reggel" }],
    });
    expect(JSON.stringify(res.json())).toMatch(/tegnap este|dátum/i);
    expect(a.health.forDate("2026-09-02")?.coreMin ?? null).toBeNull();
  });

  it("does not overwrite a value that is already there", async () => {
    // fillGaps only fills holes, which is what lets the monthly import run
    // without thought. A second post of the same night must not rewrite it.
    const a = await boot();
    await post(a, { samples: NIGHT });
    await post(a, { samples: [{ type: "SleepAnalysis", value: "Deep",
      startDate: "2026-09-02T02:00:00+02:00", endDate: "2026-09-02T02:05:00+02:00" }] });
    expect(a.health.forDate("2026-09-02")!.deepMin).toBeCloseTo(90, 3);
  });

  it("accepts samples and direct fields in one request", async () => {
    const a = await boot();
    await post(a, { hrv: 68, samples: NIGHT });
    const row = a.health.forDate("2026-09-02")!;
    expect(row.hrv).toBe(68);
    expect(row.asleepMin).toBeCloseTo(430, 3);
  });

  it("prefers the samples over the phone's own sleepH, and says so", async () => {
    // The branch's whole point. `upsert` is incoming-wins and `fillGaps` is
    // existing-wins, and sleep lands on the wake-up day — the same date the
    // upsert just wrote. Without this precedence the phone's number freezes,
    // the rollup's is dropped silently, and the import can never correct it.
    const a = await boot();
    const res = await post(a, { sleepH: 0.3, samples: NIGHT });
    const body = res.json() as { accepted: string[]; ignored: { field: string }[] };

    const row = a.health.forDate("2026-09-02")!;
    expect(row.asleepMin).toBeCloseTo(430, 3);
    expect(row.sleepH).toBeCloseTo(430 / 60, 1); // 7.2, not 0.3

    expect(body.ignored.map((i) => i.field)).toContain("sleepH");
    expect(body.accepted).not.toContain("sleepH");
  });

  it("accepts sleepH exactly as before when no samples came", async () => {
    // Until the Shortcut is rebuilt this is the only sleep the system gets, and
    // with iPhone-only tracking one sample covers the night, so it is correct.
    const a = await boot();
    const res = await post(a, { sleepH: 7.4 });
    const body = res.json() as { accepted: string[]; ignored: { field: string }[] };

    expect(a.health.forDate("2026-09-02")!.sleepH).toBeCloseTo(7.4, 6);
    expect(body.accepted).toContain("sleepH");
    expect(body.ignored.map((i) => i.field)).not.toContain("sleepH");
  });

  it("keeps sleepH when the samples are all unusable", async () => {
    // "Samples were sent" is not the test — "samples produced a sleep value for
    // this date" is. An unreadable batch must not blank the only sleep there is.
    const a = await boot();
    await post(a, {
      sleepH: 7.4,
      samples: [{ type: "SleepAnalysis", value: "Szendergés",
                  startDate: "2026-09-01T23:00:00+02:00", endDate: "2026-09-02T07:00:00+02:00" }],
    });
    expect(a.health.forDate("2026-09-02")!.sleepH).toBeCloseTo(7.4, 6);
  });

  it("refuses a non-sleep sample type and names it", async () => {
    // The rollup separates accumulating types BY source so it can pick one
    // instead of adding them. This path has no real source to report, so
    // accepting steps here would collapse every source into one fabricated
    // name — the 81,272-step day all over again.
    const a = await boot();
    const res = await post(a, {
      samples: [
        { type: "StepCount", value: "500", unit: "count",
          startDate: "2026-09-02T07:00:00+02:00", endDate: "2026-09-02T07:10:00+02:00" },
        { type: "StepCount", value: "500", unit: "count",
          startDate: "2026-09-02T07:10:00+02:00", endDate: "2026-09-02T07:20:00+02:00" },
      ],
    });
    const body = res.json() as { ignored: { field: string; reason: string }[] };
    expect(JSON.stringify(body.ignored)).toContain("StepCount (2)");
    expect(a.health.forDate("2026-09-02")?.steps ?? null).toBeNull();
  });

  it("still works with no samples at all", async () => {
    const a = await boot();
    const res = await post(a, { hrv: 68 });
    expect(res.statusCode).toBe(202);
    expect(a.health.forDate("2026-09-02")!.hrv).toBe(68);
  });
});
