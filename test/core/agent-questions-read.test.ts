import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { runQuestion, MAX_RANGE_DAYS, type QuestionContext } from "../../src/core/agent/questions.ts";
import { shiftDay } from "../../src/core/analysis/stats.ts";

function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  const now = new Date("2026-09-04T05:00:00.000Z");
  // 40 ordinary days, then one extreme — enough to clear MIN_BASELINE_N.
  for (let i = 40; i >= 1; i--) {
    const d = new Date(Date.UTC(2026, 6, 26 + (40 - i)));
    health.upsert(snapshot({ date: d.toISOString().slice(0, 10), hrv: 55, sleepH: 7, rhr: 55 }), {}, now);
  }
  health.upsert(snapshot({ date: "2026-09-04", hrv: 203.6, sleepH: 6.6, rhr: 59 }), {}, now);
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

describe("nap", () => {
  it("annotates every value against its own baseline", async () => {
    const out = await runQuestion("nap", { datum: "2026-09-04" }, ctx());
    expect(out).toContain("2026-09-04");
    expect(out).toMatch(/hrv=203,6 \(\+[0-9]+,[0-9]σ.*minden idők maximuma\)/);
  });

  it("says the row is missing rather than returning nothing", async () => {
    expect(await runQuestion("nap", { datum: "2020-01-01" }, ctx())).toContain("nincs sor");
  });
});

describe("napok", () => {
  it("returns a whole range in one step", async () => {
    const out = await runQuestion("napok", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out).toContain("2026-09-04");
  });

  it("caps the range so one step cannot flood the context", async () => {
    const out = await runQuestion("napok", { tol: "2019-01-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("legfeljebb 60 nap");
  });

  it("formats decimal values with a Hungarian comma, not a period", async () => {
    const out = await runQuestion("napok", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("hrv=203,6");
    expect(out).not.toContain("hrv=203.6");
  });

  it("allows a range of exactly MAX_RANGE_DAYS days", async () => {
    const ig = "2026-09-04";
    const tol = shiftDay(ig, -MAX_RANGE_DAYS);
    const out = await runQuestion("napok", { tol, ig }, ctx());
    expect(out).not.toContain("legfeljebb 60 nap");
  });

  it("rejects a range one day past MAX_RANGE_DAYS", async () => {
    const ig = "2026-09-04";
    const tol = shiftDay(ig, -(MAX_RANGE_DAYS + 1));
    const out = await runQuestion("napok", { tol, ig }, ctx());
    expect(out).toContain("legfeljebb 60 nap");
  });
});

describe("lefedettseg", () => {
  it("names the current unbroken run and the gap before it", async () => {
    const out = await runQuestion("lefedettseg", { mutato: "hrv" }, ctx());
    expect(out).toMatch(/megszakítatlan sorozat/);
    expect(out).toMatch(/mérés/);
  });

  it("says plainly when a metric was never measured", async () => {
    expect(await runQuestion("lefedettseg", { mutato: "vo2max" }, ctx())).toContain("soha nem mért");
  });
});

describe("unknown questions", () => {
  it("returns a correctable error instead of throwing", async () => {
    const out = await runQuestion("nincsilyen", {}, ctx());
    expect(out).toContain("ismeretlen kérdés");
    expect(out).toContain("nap");
  });
});
