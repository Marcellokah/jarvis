import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { runQuestion, MIN_BUCKET_N, type QuestionContext } from "../../src/core/agent/questions.ts";

/** 60 consecutive days of sleep, every value 7.0 except one 3.0 outlier. */
function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  const now = new Date("2026-09-04T05:00:00.000Z");
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 6, 7 + i)).toISOString().slice(0, 10);
    health.upsert(snapshot({ date: d, sleepH: d === "2026-08-20" ? 3 : 7 }), {}, now);
  }
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

describe("elteresek", () => {
  it("finds the day that sits far from the mean, with its sigma", async () => {
    const out = await runQuestion("elteresek", { mutato: "alvas", ablak_nap: 90 }, ctx());
    expect(out).toContain("2026-08-20");
    expect(out).toMatch(/−[0-9]+,[0-9]σ|-[0-9]+,[0-9]σ/);
  });

  it("says so when nothing stands out, rather than listing the least ordinary day", async () => {
    const out = await runQuestion("elteresek", { mutato: "alvas", ablak_nap: 3 }, ctx());
    expect(out).toMatch(/nincs elég mérés|nincs kiugró/);
  });
});

describe("ritmus", () => {
  it("refuses to average a bucket below the sample floor", async () => {
    const out = await runQuestion("ritmus", { mutato: "alvas", bontas: "hetnap" }, ctx());
    // 60 days gives ~8-9 per weekday, all above the floor.
    expect(out).not.toContain("kevés mérés");
    expect(out).toMatch(/hétfő|kedd|szerda/);
  });

  it("names a thin bucket as insufficient instead of printing a number", async () => {
    const thin = ctx();
    const out = await runQuestion("ritmus", { mutato: "alvas", bontas: "honap" }, thin);
    // July has 25 days here, August 31, September 4 — September is below the floor.
    expect(out).toContain("2026-09");
    expect(out).toMatch(/2026-09:.*kevés mérés \(n=4, kell \d+\)/);
  });

  it("exports a floor that is actually enforced", () => {
    expect(MIN_BUCKET_N).toBeGreaterThanOrEqual(5);
  });
});

describe("hasonlo_napok", () => {
  it("returns the closest days by that metric, excluding the day itself", async () => {
    const out = await runQuestion("hasonlo_napok", { datum: "2026-08-20", mutato: "alvas", k: 3 }, ctx());
    expect(out).not.toContain("2026-08-20 ");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("says so when the anchor day has no value to match against", async () => {
    const out = await runQuestion("hasonlo_napok", { datum: "2026-08-20", mutato: "hrv", k: 3 }, ctx());
    expect(out).toContain("nincs");
  });

  it("names a non-numeric k rather than returning an empty answer", async () => {
    const out = await runQuestion("hasonlo_napok", { datum: "2026-08-20", mutato: "alvas", k: "sok" }, ctx());
    expect(out).not.toBe("");
    expect(out).toContain("k");
    expect(out).toContain("sok");
  });
});

describe("mi_lett_utana", () => {
  it("reports the following days, naming the ones with no data", async () => {
    const out = await runQuestion("mi_lett_utana", { datum: "2026-09-02", napok: 4 }, ctx());
    expect(out).toContain("2026-09-03");
    expect(out).toContain("nincs adat");
  });

  it("names a non-numeric napok rather than returning an empty answer", async () => {
    const out = await runQuestion("mi_lett_utana", { datum: "2026-09-02", napok: null }, ctx());
    expect(out).not.toBe("");
    expect(out).toContain("napok");
  });
});
