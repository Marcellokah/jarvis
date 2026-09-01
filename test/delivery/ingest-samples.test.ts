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

  it("refuses a sourceless day total and names it", async () => {
    // The rollup separates accumulating types BY source so it can pick one
    // instead of adding them. An entry with no source to report would collapse
    // every source into one fabricated name — the 81,272-step day all over
    // again, and the sourceless total is exactly what sent 21,401 steps.
    const a = await boot();
    const res = await post(a, {
      samples: [
        { type: "StepCount", value: "500", unit: "count",
          startDate: "2026-09-02T07:00:00+02:00", endDate: "2026-09-02T07:00:00+02:00" },
        { type: "StepCount", value: "500", unit: "count", source: "   ",
          startDate: "2026-09-02T07:10:00+02:00", endDate: "2026-09-02T07:10:00+02:00" },
      ],
    });
    const body = res.json() as { ignored: { field: string; reason: string }[] };

    // Both refused, each by its own index — a whitespace-only source is no
    // source, because it would be its own grouping key in the rollup.
    expect(body.ignored.filter((i) => i.reason.includes("forrás nélküli"))).toHaveLength(2);
    expect(body.ignored.map((i) => i.field)).toEqual(
      expect.arrayContaining(["samples[0]", "samples[1]"]),
    );
    expect(JSON.stringify(body.ignored)).toContain("StepCount");
    expect(a.health.forDate("2026-09-02")?.steps ?? null).toBeNull();
  });

  it("still works with no samples at all", async () => {
    const a = await boot();
    const res = await post(a, { hrv: 68 });
    expect(res.statusCode).toBe(202);
    expect(a.health.forDate("2026-09-02")!.hrv).toBe(68);
  });
});

/**
 * The counters, one aggregate per (type, source) pair.
 *
 * The phone can filter `Find Health Samples` by Source, so it sums within a
 * source and sends the totals separately. Everything below is about the server
 * doing nothing clever with them: it hands them to the rollup, which already
 * keeps `agg: "sum"` types separated by source and picks the largest single one
 * rather than adding them. That rule is the entire fix — the 21,401-step day
 * came from the phone adding the Watch's and the iPhone's raw samples together.
 */
describe("ingest — per-source day counters", () => {
  const counter = (p: {
    type: string; source?: string; unit: string; value: number; at?: string;
  }) => ({
    type: p.type, unit: p.unit, value: p.value,
    ...(p.source === undefined ? {} : { source: p.source }),
    // One instant: the moment of the evening run. Only the local day matters.
    startDate: p.at ?? "2026-09-01T23:55:00+02:00",
    endDate: p.at ?? "2026-09-01T23:55:00+02:00",
  });

  const WATCH = "Marcell’s Apple Watch";
  const PHONE = "Marcell’s iPhone";

  it("keeps the largest single source and does not add the other to it", async () => {
    // The measured bug, in miniature: 6645 real steps and a 4213-step partial
    // view of the same walk. The answer is 6645 — never 10858.
    const { days, ignored } = await readSamples([
      counter({ type: "StepCount", source: WATCH, unit: "count", value: 6645 }),
      counter({ type: "StepCount", source: PHONE, unit: "count", value: 4213 }),
    ]);

    expect(ignored).toEqual([]);
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-09-01");
    expect(days[0]!.values.steps).toBe(6645);
    expect(days[0]!.values.steps).not.toBe(6645 + 4213);
  });

  it("picks per type, not once for the whole payload", async () => {
    // Steps and calories can be won by different devices on the same day, so a
    // single global "best source" would be wrong for one of them.
    const { days } = await readSamples([
      counter({ type: "StepCount", source: WATCH, unit: "count", value: 6645 }),
      counter({ type: "StepCount", source: PHONE, unit: "count", value: 4213 }),
      counter({ type: "ActiveEnergyBurned", source: WATCH, unit: "kcal", value: 300 }),
      counter({ type: "ActiveEnergyBurned", source: PHONE, unit: "kcal", value: 856 }),
    ]);

    expect(days[0]!.values.steps).toBe(6645);       // the watch won steps
    expect(days[0]!.values.move_kcal).toBe(856);    // the phone won calories
  });

  it("refuses a declared unit that is not ours, and names both units", async () => {
    // The rollup refuses a record whose unit is not its own because a silently
    // rescaled number that still looks plausible is the worst thing this import
    // can produce. This path must not be the hole in that rule — and it must
    // not convert either, only refuse.
    const { days, ignored } = await readSamples([
      counter({ type: "DistanceWalkingRunning", source: WATCH, unit: "mi", value: 4.1 }),
    ]);

    expect(days).toEqual([]);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.field).toBe("samples[0]");
    expect(ignored[0]!.reason).toContain("DistanceWalkingRunning");
    expect(ignored[0]!.reason).toContain("mi");   // what arrived
    expect(ignored[0]!.reason).toContain("km");   // what was expected
  });

  it("names a missing unit rather than assuming ours", async () => {
    const { days, ignored } = await readSamples([
      { type: "StepCount", source: WATCH, value: 6645,
        startDate: "2026-09-01T23:55:00+02:00", endDate: "2026-09-01T23:55:00+02:00" },
    ]);

    expect(days).toEqual([]);
    expect(JSON.stringify(ignored)).toContain("hiányzik");
  });

  it("refuses a sourceless total by name and stores nothing", async () => {
    const { days, ignored } = await readSamples([
      counter({ type: "StepCount", unit: "count", value: 21401 }),
    ]);

    expect(days).toEqual([]);
    expect(ignored).toEqual([
      { field: "samples[0]", reason: "StepCount: forrás nélküli napi összeg nem fogadható el" },
    ]);
  });

  it("still refuses an avg type, source and unit notwithstanding", async () => {
    // Not because it is dangerous, but because `rhr` already arrives as a
    // direct READING field. Two routes to one column buys nothing.
    const { days, ignored } = await readSamples([
      counter({ type: "RestingHeartRate", source: WATCH, unit: "count/min", value: 54 }),
    ]);

    expect(days).toEqual([]);
    expect(JSON.stringify(ignored)).toContain("RestingHeartRate (1)");
  });

  it("reads a counter's local day exactly as it reads a sleep sample's", async () => {
    // Both timestamps are the same instant, in an offset where the local day
    // and the UTC day disagree: 23:55 on the 1st at -05:00 is 04:55 UTC on the
    // 2nd. The rollup takes the local day the owner actually lived, and the
    // counter must not be filed by any other rule than the one sleep uses —
    // otherwise the evening run's steps land on tomorrow.
    const { days, ignored } = await readSamples([
      counter({ type: "StepCount", source: WATCH, unit: "count", value: 6645,
                at: "2026-09-01T23:55:00-05:00" }),
      { type: "SleepAnalysis", value: "In Bed",
        startDate: "2026-09-01T22:55:00-05:00", endDate: "2026-09-01T23:55:00-05:00",
        source: WATCH },
    ]);

    expect(ignored).toEqual([]);
    // One day, not two: the counter did not drift onto the UTC date.
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-09-01");
    expect(days[0]!.values.steps).toBe(6645);
    expect(days[0]!.values.in_bed_min).toBe(60);
  });

  it("handles sleep and counters in one request, end to end", async () => {
    const a = await boot();
    const res = await post(a, {
      hrv: 68,
      samples: [
        ...NIGHT,
        counter({ type: "StepCount", source: WATCH, unit: "count", value: 6645 }),
        counter({ type: "StepCount", source: PHONE, unit: "count", value: 4213 }),
        counter({ type: "ActiveEnergyBurned", source: WATCH, unit: "kcal", value: 856 }),
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ignored).toEqual([]);

    // The night lands on the day it ended, the counters on the day they were
    // counted — two different rows out of one request.
    const night = a.health.forDate("2026-09-02")!;
    expect(night.asleepMin).toBeCloseTo(430, 3);
    expect(night.hrv).toBe(68);

    const counted = a.health.forDate("2026-09-01")!;
    expect(counted.steps).toBe(6645);
    expect(counted.moveKcal).toBe(856);
  });

  it("keeps the first evening run's counter when the run repeats", async () => {
    // fillGaps is existing-wins and the counters get no precedence rule of
    // their own, so a 23:59 re-run of the 23:55 run keeps the first total —
    // at most those four minutes short. Deliberate: neither run's number is
    // Health's merged daily total, so neither may overwrite the other.
    const a = await boot();
    await post(a, { samples: [counter({ type: "StepCount", source: WATCH, unit: "count", value: 6645 })] });
    await post(a, {
      samples: [counter({ type: "StepCount", source: WATCH, unit: "count", value: 6700,
                          at: "2026-09-01T23:59:00+02:00" })],
    });

    expect(a.health.forDate("2026-09-01")!.steps).toBe(6645);
  });

  it("refuses one bad counter without losing the good ones beside it", async () => {
    // Same rule as the direct fields: the phone gets one attempt, and a wrong
    // unit on distance must not cost the steps.
    const { days, ignored } = await readSamples([
      counter({ type: "StepCount", source: WATCH, unit: "count", value: 6645 }),
      counter({ type: "DistanceWalkingRunning", source: WATCH, unit: "mi", value: 4.1 }),
      counter({ type: "FlightsClimbed", source: WATCH, unit: "count", value: 12 }),
    ]);

    expect(days[0]!.values.steps).toBe(6645);
    expect(days[0]!.values.flights).toBe(12);
    expect(days[0]!.values.distance_km).toBeUndefined();
    expect(ignored).toHaveLength(1);
  });
});

/**
 * The first live run of the counter path, and the two defects it exposed.
 *
 * `LIVE_COUNTERS` is the payload verbatim out of the database — not a
 * reconstruction. That is the whole point: the decimal comma and the empty
 * aggregates are things a real phone did, and a hand-written approximation
 * would only prove the parser agrees with my idea of what Shortcuts sends.
 *
 * What it produced before the fix: steps 12727 and flights landed (integers
 * are unaffected), `distance_km` vanished entirely (Number("8,717…") is NaN,
 * and the rollup drops a non-finite value), and `move_kcal` was stored as 0 —
 * the Watch's 1198,36 was lost the same way, leaving the iPhone's `""` as the
 * only candidate, which Number() reads as a real zero.
 */
const LIVE_COUNTERS = [
  '{"startDate":"2026-09-01T23:08:34+02:00","value":"12727","endDate":"2026-09-01T23:08:34+02:00","source":"Marcell’s Apple Watch","type":"StepCount","unit":"count"}\n'
  + '{"startDate":"2026-09-01T23:08:34+02:00","value":"8674","endDate":"2026-09-01T23:08:34+02:00","source":"Marcell’s iPhone","type":"StepCount","unit":"count"}\n'
  + '{"startDate":"2026-09-01T23:08:34+02:00","value":"8,71793477021344","endDate":"2026-09-01T23:08:34+02:00","source":"Marcell’s Apple Watch","type":"DistanceWalkingRunning","unit":"km"}\n'
  + '{"startDate":"2026-09-01T23:08:34+02:00","value":"1198,36299999997","endDate":"2026-09-01T23:08:34+02:00","source":"Marcell’s Apple Watch","type":"ActiveEnergyBurned","unit":"kcal"}\n'
  + '{"startDate":"2026-09-01T23:08:34+02:00","value":"","endDate":"2026-09-01T23:08:34+02:00","source":"Marcell’s iPhone","type":"ActiveEnergyBurned","unit":"kcal"}',
];

describe("ingest — the phone's own number format", () => {
  const WATCH = "Marcell’s Apple Watch";
  const PHONE = "Marcell’s iPhone";

  const counter = (p: { type: string; source: string; unit: string; value: unknown }) => ({
    type: p.type, unit: p.unit, value: p.value, source: p.source,
    startDate: "2026-09-01T23:08:34+02:00", endDate: "2026-09-01T23:08:34+02:00",
  });

  it("stores every column of the real payload, comma decimals included", async () => {
    const { days, ignored } = await readSamples(LIVE_COUNTERS);

    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-09-01");
    // The integers that always worked, still picked per source rather than added.
    expect(days[0]!.values.steps).toBe(12727);
    // The column that vanished: 8,71793477021344 km, rounded as the rollup rounds.
    expect(days[0]!.values.distance_km).toBe(8.718);
    // The column that was stored as 0: the Watch's real 1198,36 kcal.
    expect(days[0]!.values.move_kcal).toBe(1198.363);

    // The iPhone's empty ActiveEnergyBurned no longer becomes a zero: the strict
    // parser refuses it. Noisily for now, one line per entry — turning that into
    // one aggregate line is the next commit's job. The point here is only that
    // nothing was invented.
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.reason).toContain("értelmezhetetlen szám");
  });



  it("keeps a genuine zero, which is a measurement and not an absence", async () => {
    // A source that has samples and sums to zero said something. Only the empty
    // string means it said nothing.
    const { days, ignored } = await readSamples([
      counter({ type: "FlightsClimbed", source: WATCH, unit: "count", value: "0" }),
    ]);

    expect(ignored).toEqual([]);
    expect(days[0]!.values.flights).toBe(0);
  });

  it("refuses a numeric shape it cannot read, by name, without guessing", async () => {
    // A grouped number is the one case where the decimal comma stops being the
    // only reading. Refusing names it in the reply; guessing would store a
    // plausible-looking number that is wrong by a factor of a thousand.
    const { days, ignored } = await readSamples([
      counter({ type: "StepCount", source: WATCH, unit: "count", value: "12727" }),
      counter({ type: "ActiveEnergyBurned", source: WATCH, unit: "kcal", value: "1.198,363" }),
      counter({ type: "DistanceWalkingRunning", source: WATCH, unit: "km", value: "8,7 km" }),
    ]);

    // The good counter beside them survives, as with a wrong unit.
    expect(days[0]!.values.steps).toBe(12727);
    expect(days[0]!.values.move_kcal).toBeUndefined();
    expect(days[0]!.values.distance_km).toBeUndefined();

    expect(ignored).toHaveLength(2);
    expect(ignored[0]).toEqual({
      field: "samples[1]",
      reason: "ActiveEnergyBurned: értelmezhetetlen szám (1.198,363)",
    });
    expect(ignored[1]!.reason).toContain("8,7 km");
  });


  it("writes the real payload's columns to the row, end to end", async () => {
    const a = await boot();
    const res = await post(a, { samples: LIVE_COUNTERS });
    expect(res.statusCode).toBe(202);

    const row = a.health.forDate("2026-09-01")!;
    expect(row.steps).toBe(12727);
    expect(row.distanceKm).toBeCloseTo(8.718, 3);
    expect(row.moveKcal).toBeCloseTo(1198.363, 3);
  });
});
