import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, TEST_TOKEN, stubModule, type TestApp } from "../helpers.ts";
import { readSamples } from "../../src/delivery/http/routes/ingest.ts";

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

/**
 * Exactly what the first live run put in the database, trimmed to three stages.
 *
 * Kept verbatim rather than reconstructed: the point of this test is that the
 * shape came off a real phone, and a hand-written approximation would only
 * prove the parser agrees with my idea of what Shortcuts does.
 */
const SHORTCUT_NDJSON = [
  '{"value":"Core","startDate":"2026-09-01T00:03:42+02:00","type":"SleepAnalysis",'
  + '"endDate":"2026-09-01T00:24:12+02:00"}\n'
  + '{"value":"Deep","startDate":"2026-09-01T00:24:12+02:00","type":"SleepAnalysis",'
  + '"endDate":"2026-09-01T01:04:42+02:00"}\n'
  + '{"value":"In Bed","startDate":"2026-09-01T00:03:42+02:00","type":"SleepAnalysis",'
  + '"endDate":"2026-09-01T01:04:42+02:00"}',
];

describe("ingest — a Shortcut's own sample encoding", () => {
  it("reads the night out of the one string Shortcuts sends", async () => {
    const { days, ignored } = await readSamples(SHORTCUT_NDJSON);

    // 61 minutes in bed, all of it asleep — the two stages abut, so the union
    // is one span and not the sum of two overlapping ones.
    expect(ignored).toEqual([]);
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-09-01");
    expect(days[0]!.values.asleep_min).toBe(61);
    // 40m30s of deep sleep, rounded — the rollup stores whole minutes.
    expect(days[0]!.values.deep_min).toBe(41);
    expect(days[0]!.values.in_bed_min).toBe(61);
  });

  it("reads a real JSON array the same way", async () => {
    // The unpacking must not become the only accepted shape: anything that can
    // post proper JSON still should.
    const asArray = SHORTCUT_NDJSON[0]!.split("\n").map((l) => JSON.parse(l) as unknown);
    const { days, ignored } = await readSamples(asArray);

    expect(ignored).toEqual([]);
    expect(days[0]!.values.asleep_min).toBe(61);
  });

  it("drops an unreadable line by name instead of guessing at it", async () => {
    const { days, ignored } = await readSamples([
      SHORTCUT_NDJSON[0]! + "\n{ ez nem JSON",
    ]);

    // The night still lands; only the broken line is lost, and it is named.
    expect(ignored).toEqual([{ field: "samples[0].3", reason: "értelmezhetetlen JSON sor" }]);
    expect(days[0]!.values.asleep_min).toBe(61);
  });
});

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

  it("does not overwrite a night that is already there", async () => {
    // fillGaps only fills holes, which is what lets the monthly import run
    // without thought. A second post of the same night must not rewrite it —
    // and `sleep_h` goes the same way as the stage minutes here, even though
    // the route writes it through the upsert: a row that already has
    // `asleep_min` holds a night one rollup run resolved, and replacing only
    // its hours would leave the pair disagreeing.
    const a = await boot();
    await post(a, { samples: NIGHT });
    await post(a, { samples: [{ type: "SleepAnalysis", value: "Deep",
      startDate: "2026-09-02T02:00:00+02:00", endDate: "2026-09-02T02:05:00+02:00" }] });

    const row = a.health.forDate("2026-09-02")!;
    expect(row.deepMin).toBeCloseTo(90, 3);
    expect(row.sleepH).toBeCloseTo(430 / 60, 1);
  });

  it("accepts samples and direct fields in one request", async () => {
    const a = await boot();
    await post(a, { hrv: 68, samples: NIGHT });
    const row = a.health.forDate("2026-09-02")!;
    expect(row.hrv).toBe(68);
    expect(row.asleepMin).toBeCloseTo(430, 3);
  });

  it("prefers the samples over the phone's own sleepH, and says so", async () => {
    // Both arrive in one request and both are about the same date, so one of
    // them has to give way. A Shortcut cannot sum sleep stages, so its `sleepH`
    // is at best one sample of the night — 0.3 hours for a seven-hour one. The
    // reply names the field it dropped, so a Shortcut that keeps sending a
    // useless number is visible rather than silently ignored.
    const a = await boot();
    const res = await post(a, { sleepH: 0.3, samples: NIGHT });
    const body = res.json() as { accepted: string[]; ignored: { field: string }[] };

    const row = a.health.forDate("2026-09-02")!;
    expect(row.asleepMin).toBeCloseTo(430, 3);
    expect(row.sleepH).toBeCloseTo(430 / 60, 1); // 7.2, not 0.3

    expect(body.ignored.map((i) => i.field)).toContain("sleepH");
    expect(body.accepted).not.toContain("sleepH");
  });

  it("keeps the rollup's sleep when a later post sends sleepH alone", async () => {
    // The guard has to ask about the stored day, not about the request in
    // hand: this post carries no samples at all. `sleep_h` is the one sleep
    // column the upsert does not force to null and the upsert is incoming-wins,
    // so without that the second post would overwrite 7.2 with 0.3 and leave it
    // sitting beside an asleep_min of 430.
    const a = await boot();
    await post(a, { samples: NIGHT });
    const res = await post(a, { sleepH: 0.3 });
    const body = res.json() as { accepted: string[]; ignored: { field: string }[] };

    const row = a.health.forDate("2026-09-02")!;
    expect(row.sleepH).toBeCloseTo(430 / 60, 1); // still 7.2
    expect(row.asleepMin).toBeCloseTo(430, 3);
    expect(body.ignored.map((i) => i.field)).toContain("sleepH");
    expect(body.accepted).not.toContain("sleepH");
  });

  it("replaces a sleepH the direct field left behind when the samples arrive", async () => {
    // The hole this closes. The 07:30 post's samples step failed, so the row
    // took the direct field's 0.3. The 07:35 re-run has good samples, so its
    // own `sleepH` is dropped as above — and the samples reach the row through
    // fillGaps, which is existing-wins for `sleep_h` and would keep the 0.3
    // beside an asleep_min of 430. The route writes the samples' own hours
    // through the upsert for exactly this: a night the phone's samples resolved
    // replaces a number the direct field guessed.
    const a = await boot();
    await post(a, {
      sleepH: 0.3,
      samples: [{ type: "SleepAnalysis", value: "Szendergés",
                  startDate: "2026-09-01T23:00:00+02:00", endDate: "2026-09-02T07:00:00+02:00" }],
    });
    expect(a.health.forDate("2026-09-02")!.sleepH).toBeCloseTo(0.3, 6);

    await post(a, { sleepH: 0.3, samples: NIGHT });

    const row = a.health.forDate("2026-09-02")!;
    expect(row.sleepH).toBeCloseTo(430 / 60, 1); // 7.2, not the 0.3 left behind
    expect(row.asleepMin).toBeCloseTo(430, 3);
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
