import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { runQuestion, MAX_RANGE_DAYS, type QuestionContext } from "../../src/core/agent/questions.ts";
import { shiftDay } from "../../src/core/analysis/stats.ts";

/**
 * The observation text alone. `runQuestion` also reports whether the answer
 * is evidence; that flag has its own tests in agent-questions-read.test.ts.
 */
const ask = (name: string, args: Record<string, unknown>, c: QuestionContext): Promise<string> =>
  runQuestion(name, args, c).then((r) => r.observation);


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
    const out = await ask("nap", { datum: "2026-09-04" }, ctx());
    expect(out).toContain("2026-09-04");
    expect(out).toMatch(/hrv=203,6 \(\+[0-9]+,[0-9]σ.*minden idők maximuma\)/);
  });

  it("says the row is missing rather than returning nothing", async () => {
    expect(await ask("nap", { datum: "2020-01-01" }, ctx())).toContain("nincs sor");
  });
});

describe("napok", () => {
  it("returns a whole range in one step", async () => {
    const out = await ask("napok", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out).toContain("2026-09-04");
  });

  it("caps the range so one step cannot flood the context", async () => {
    const out = await ask("napok", { tol: "2019-01-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("legfeljebb 60 nap");
  });

  it("formats decimal values with a Hungarian comma, not a period", async () => {
    const out = await ask("napok", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out).toContain("hrv=203,6");
    expect(out).not.toContain("hrv=203.6");
  });

  it("allows a range of exactly MAX_RANGE_DAYS days", async () => {
    const ig = "2026-09-04";
    const tol = shiftDay(ig, -MAX_RANGE_DAYS);
    const out = await ask("napok", { tol, ig }, ctx());
    expect(out).not.toContain("legfeljebb 60 nap");
  });

  it("rejects a range one day past MAX_RANGE_DAYS", async () => {
    const ig = "2026-09-04";
    const tol = shiftDay(ig, -(MAX_RANGE_DAYS + 1));
    const out = await ask("napok", { tol, ig }, ctx());
    expect(out).toContain("legfeljebb 60 nap");
  });
});

describe("lefedettseg", () => {
  it("names the current unbroken run and the gap before it", async () => {
    const out = await ask("lefedettseg", { mutato: "hrv" }, ctx());
    expect(out).toMatch(/megszakítatlan sorozat/);
    expect(out).toMatch(/mérés/);
  });

  it("says plainly when a metric was never measured", async () => {
    expect(await ask("lefedettseg", { mutato: "vo2max" }, ctx())).toContain("soha nem mért");
  });
});

describe("unknown questions", () => {
  it("returns a correctable error instead of throwing", async () => {
    const out = await ask("nincsilyen", {}, ctx());
    expect(out).toContain("ismeretlen kérdés");
    expect(out).toContain("nap");
  });
});

/**
 * A name from the menu is not a result.
 *
 * The falsification gate reads this flag off the transcript to decide whether
 * a cited step could have refuted anything, so where the line falls is a
 * safety property, not a formatting detail. The rule: did this observation
 * constrain the world? Absence of data, an unusable argument and a missing
 * instrument do not; measurements do — including measurements that found
 * nothing unusual.
 */
describe("the evidence flag", () => {
  it.each<[string, Record<string, unknown>]>([
    ["nap", { datum: "1999-01-01" }],
    ["napok", { tol: "2019-01-01", ig: "2026-09-04" }],
    ["napok", { tol: "1999-01-01", ig: "1999-02-01" }],
    ["lefedettseg", { mutato: "nincs_ilyen" }],
    ["lefedettseg", { mutato: "vo2max" }],
    ["elteresek", { mutato: "nincs_ilyen" }],
    ["ritmus", { mutato: "hrv", bontas: "nincsilyen" }],
    ["hasonlo_napok", { datum: "2026-09-04", mutato: "hrv", k: "sok" }],
    ["mi_lett_utana", { datum: "2026-09-04", napok: null }],
    ["mi_lett_utana", { datum: "1999-01-01", napok: 3 }],
    ["naptar", { tol: "2026-09-04", ig: "2026-09-04" }],
    ["nincsilyen", {}],
  ])("does not call %s with %o evidence", async (name, args) => {
    const result = await runQuestion(name, args, ctx());
    expect(result.evidence).toBe(false);
    expect(result.observation).not.toBe("");
  });

  it.each<[string, Record<string, unknown>]>([
    ["nap", { datum: "2026-09-04" }],
    ["napok", { tol: "2026-09-01", ig: "2026-09-04" }],
    ["lefedettseg", { mutato: "hrv" }],
    ["elteresek", { mutato: "hrv", ablak_nap: 90 }],
    ["ritmus", { mutato: "hrv", bontas: "hetnap" }],
    ["hasonlo_napok", { datum: "2026-09-04", mutato: "hrv", k: 3 }],
    ["mi_lett_utana", { datum: "2026-09-01", napok: 3 }],
  ])("calls %s with %o evidence", async (name, args) => {
    expect((await runQuestion(name, args, ctx())).evidence).toBe(true);
  });

  it("refuses a name that only exists on the prototype chain", async () => {
    // "constructor" in QUESTIONS is true for a plain object literal, and used
    // to reach bracket access and come back as Object's own constructor.
    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      const result = await runQuestion(name, {}, ctx());
      expect(result.evidence).toBe(false);
      expect(result.observation).toContain("ismeretlen kérdés");
    }
  });
});

/**
 * Defence 2 was optional, and the prompt claimed otherwise.
 *
 * `napok` is the question the ten-step budget nudges the model towards, and
 * it used to print the +9,7σ all-time maximum as a bare "hrv=203,6" — the
 * exact shape of the measured failure, where a 9B model read that number and
 * called it normal. The system prompt meanwhile told the model that values
 * arrive labelled. Now they do.
 */
describe("range questions annotate too, not just nap", () => {
  it("labels every day in a napok range against the owner's own baseline", async () => {
    const out = await ask("napok", { tol: "2026-09-01", ig: "2026-09-04" }, ctx());
    expect(out).toMatch(/hrv=203,6 \(\+[0-9]+,[0-9]σ.*minden idők maximuma\)/);
    expect(out).not.toMatch(/hrv=203,6 {2}/);
  });

  it("labels the days mi_lett_utana reports", async () => {
    const out = await ask("mi_lett_utana", { datum: "2026-09-03", napok: 1 }, ctx());
    expect(out).toMatch(/hrv=203,6 \(\+[0-9]+,[0-9]σ/);
  });
});
