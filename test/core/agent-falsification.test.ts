import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { investigate, type InvestigatorModel, type Step } from "../../src/core/agent/loop.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { QuestionContext } from "../../src/core/agent/questions.ts";

function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  const now = new Date("2026-09-04T05:00:00.000Z");
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 6, 26 + i)).toISOString().slice(0, 10);
    // Sleep cycles 6,8 / 7,0 / 7,2 so that no night reaches 1,5σ: it gives the
    // gate a question that genuinely measured something and genuinely found
    // nothing unusual -- the one "empty-looking" answer that IS evidence.
    health.upsert(snapshot({ date: d, hrv: 55, sleepH: [6.8, 7, 7.2][i % 3] }), {}, now);
  }
  health.upsert(snapshot({ date: "2026-09-04", hrv: 203.6, sleepH: 7 }), {}, now);
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

function scripted(steps: Step[]): InvestigatorModel {
  let i = 0;
  return { async nextStep() { return steps[i++] ?? { name: "kifutott", args: {}, why: "" }; } };
}

const run = (steps: Step[]) => investigate({
  goal: "Miért 203,6 a HRV?", model: scripted(steps), ctx: ctx(),
  logger: silentLogger(), signal: new AbortController().signal,
});

describe("the falsification gate", () => {
  it("rejects a finding with no hypothesis behind it", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "" },
      { name: "kesz", args: { megallapitas: "Kiváló regeneráció.", tamaszkodik: [1], cafolat: 1 }, why: "" },
      { name: "kerdezz", args: { szoveg: "Mi történt?" }, why: "" },
    ]);
    // The kesz was pushed back into the loop, so the run ends on the kerdezz.
    expect(result.outcome.kind).toBe("kerdezz");
    expect(result.transcript.at(-1)!.observation).toContain("hipotezis");
  });

  it("rejects a falsification step that came before the hypothesis", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "" },
      { name: "hipotezis", args: { allitas: "Az edzés utáni regeneráció okozta." }, why: "" },
      { name: "kesz", args: { megallapitas: "Az edzés okozta.", tamaszkodik: [1], cafolat: 1 }, why: "" },
      { name: "kerdezz", args: { szoveg: "Mi történt?" }, why: "" },
    ]);
    expect(result.outcome.kind).toBe("kerdezz");
    expect(result.transcript.at(-1)!.observation).toMatch(/a cáfolatnak a hipotézis UTÁN/);
  });

  it("accepts a finding whose falsification step followed the hypothesis", async () => {
    const result = await run([
      { name: "hipotezis", args: { allitas: "Az edzés utáni regeneráció okozta." }, why: "" },
      { name: "hasonlo_napok", args: { datum: "2026-09-04", mutato: "hrv", k: 5 }, why: "cáfolat" },
      { name: "kesz", args: { megallapitas: "Nem az edzés.", tamaszkodik: [1, 2], cafolat: 2 }, why: "" },
    ]);
    expect(result.outcome).toMatchObject({ kind: "kesz", finding: "Nem az edzés.", falsifiedBy: 2 });
  });

  it("records the hypothesis in the transcript as a step of its own", async () => {
    const result = await run([
      { name: "hipotezis", args: { allitas: "A mérési mód változott." }, why: "" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.transcript[0]!.step.name).toBe("hipotezis");
    expect(result.transcript[0]!.observation).toContain("A mérési mód változott.");
  });

  it("rejects a cafolat that is in range but invalid, even with a hypothesis on record", async () => {
    // Distinguishes the gate's middle branch (bad cafolat value) from its
    // first branch (no hipotezis at all) and its third branch (cafolat
    // points at-or-before the hypothesis) -- none of the other cases here
    // exercise a hypothesis that IS present with a cafolat that is simply
    // malformed.
    const result = await run([
      { name: "hipotezis", args: { allitas: "A mérési mód változott." }, why: "" },
      { name: "nap", args: { datum: "2026-09-04" }, why: "" },
      { name: "kesz", args: { megallapitas: "Teszt.", tamaszkodik: [1], cafolat: "kettő" }, why: "" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "?" });
    expect(result.transcript.at(-1)!.observation).toMatch(/a "cafolat" mezőben nevezd meg/);
  });

  it("rejects a cafolat that names a rejected kesz, not a real question step -- the two-turn bypass", async () => {
    // The bug this closes: a rejected "kesz" is pushed onto the transcript
    // like any other step, which makes IT a nameable index. Without a check
    // on what the cited entry actually is, a model could state a
    // hypothesis, get a "kesz" rejected as out-of-range (which pushes that
    // rejection onto the transcript and grows it by one), then resubmit
    // citing that very rejection -- now in range, now after the hypothesis,
    // and accepted on zero real evidence. The rejection text even tells the
    // model to "name a step number", so this path is actively signposted.
    const result = await run([
      { name: "hipotezis", args: { allitas: "gyanús cáfolat-újrahasznosítás" }, why: "" },
      { name: "kesz", args: { megallapitas: "próbálkozás 1", tamaszkodik: [1], cafolat: 2 }, why: "" },
      { name: "kesz", args: { megallapitas: "próbálkozás 2", tamaszkodik: [1], cafolat: 2 }, why: "" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "?" });
    expect(result.transcript.at(-1)!.observation).toMatch(/valódi adatlekérdező lépésre/);
  });

  it("rejects a citation from before an abandoned hypothesis was replaced -- the stale-hypothesis pin", async () => {
    // Guards findLastIndex over findIndex in gateFinding. A model states
    // hypothesis A, gathers evidence for it, then abandons A for a
    // different hypothesis B. A finding about B must be checked against B,
    // not against the discarded A -- otherwise evidence gathered before the
    // claim even existed could "falsify" it. Under findLastIndex the live
    // hypothesis is B (index 2) and the cited step (index 1) precedes it, so
    // this is rejected. Under the old findIndex the gate would still be
    // bound to A (index 0), the same citation would land after A, and the
    // fabricated finding would be accepted.
    const result = await run([
      { name: "hipotezis", args: { allitas: "A: Az edzés okozta." }, why: "" },
      { name: "nap", args: { datum: "2026-09-04" }, why: "" },
      { name: "hipotezis", args: { allitas: "B: A mérési mód változott." }, why: "" },
      { name: "kesz", args: { megallapitas: "B igaz.", tamaszkodik: [1, 2], cafolat: 2 }, why: "" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "?" });
    expect(result.transcript.at(-1)!.observation).toMatch(/a cáfolatnak a hipotézis UTÁN/);
  });
});

/**
 * The regression that this whole plan exists for.
 *
 * These are the exact steps qwen3.5:9b took on 2026-09-04 before concluding
 * that a 203.6 ms HRV reflected "kiváló regeneráció" after a strength
 * training session three days earlier. The reading was real; the cause was a
 * change of measurement, not of physiology. Every step it cited was really
 * run, and every number it quoted was true -- which is why citations alone
 * were never going to catch this.
 *
 * Replayed here, the gate must refuse the conclusion.
 */
describe("T3 regression: the fabricated workout explanation", () => {
  it("does not let the recorded fabrication through as a finding", async () => {
    const recorded: Step[] = [
      { name: "nap", args: { datum: "2026-09-04" }, why: "megerősítem az értéket" },
      { name: "lefedettseg", args: { mutato: "hrv" }, why: "milyen mélyre nyúlik a történet" },
      { name: "ritmus", args: { mutato: "hrv", bontas: "honap" }, why: "fokozatos növekedés?" },
      { name: "edzesek", args: { tol: "2026-08-31", ig: "2026-09-04" }, why: "volt-e edzés" },
      { name: "elteresek", args: { mutato: "hrv", ablak_nap: 365 }, why: "kiugró-e" },
      {
        name: "kesz",
        args: {
          megallapitas: "A 2026-09-04-i HRV kiugróan magas, ami a 2026-09-01-i "
            + "erősítő edzés utáni kiváló regenerációt jelzi.",
          tamaszkodik: [1, 2, 3, 4, 5],
        },
        why: "az edzés magyarázza",
      },
      { name: "kerdezz", args: { szoveg: "Változott valami a mérésben?" }, why: "nem tudom bizonyítani" },
    ];
    const result = await run(recorded);
    expect(result.outcome.kind).not.toBe("kesz");
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "Változott valami a mérésben?" });
  });
});

/**
 * The gate reads a step's NAME. `QUESTIONS` is a plain object literal, so
 * `"constructor" in QUESTIONS` is true, and so is `"toString"`, `"valueOf"`
 * and `"__proto__"`. None of them is a question; every one of them produces
 * an observation that lands on the transcript as a nameable index.
 */
describe("the falsification gate: inherited names are not questions", () => {
  it.each(["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"])(
    "rejects a cafolat naming the inherited property %s",
    async (name) => {
      const result = await run([
        { name: "hipotezis", args: { allitas: "Az edzés okozta." }, why: "" },
        { name, args: {}, why: "prototípus-lánc" },
        { name: "kesz", args: { megallapitas: "Az edzés okozta.", tamaszkodik: [1], cafolat: 2 }, why: "" },
        { name: "kerdezz", args: { szoveg: "?" }, why: "" },
      ]);
      expect(result.outcome).toEqual({ kind: "kerdezz", question: "?" });
      expect(result.transcript[1]!.observation).toContain("ismeretlen kérdés");
    },
  );
});

/**
 * A name is not a result.
 *
 * Every case below names a real question from the closed menu, and every one
 * of them comes back having measured nothing: an unknown metric, a date with
 * no row, a range refused before it was read, an argument that never parsed.
 * A claim cannot be tested against an answer that never touched the data.
 */
describe("the falsification gate: a cited step must have produced evidence", () => {
  it.each([
    ["elteresek", { mutato: "nincs_ilyen" }],
    ["nap", { datum: "1999-01-01" }],
    ["napok", { tol: "2019-01-01", ig: "2026-09-04" }],
    ["napok", { tol: "1999-01-01", ig: "1999-02-01" }],
    ["hasonlo_napok", { datum: "2026-09-04", mutato: "alvas", k: "sok" }],
    ["lefedettseg", { mutato: "vo2max" }],
    ["ritmus", { mutato: "hrv", bontas: "nincsilyen" }],
    ["naptar", { tol: "2026-09-01", ig: "2026-09-04" }],
  ])("rejects a cafolat naming %s, which returned no data", async (name, args) => {
    const result = await run([
      { name: "hipotezis", args: { allitas: "Az edzés okozta." }, why: "" },
      { name, args, why: "látszatlépés" },
      { name: "kesz", args: { megallapitas: "Az edzés okozta.", tamaszkodik: [1], cafolat: 2 }, why: "" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "?" });
    expect(result.transcript.at(-1)!.observation).toMatch(/nem hozott adatot/);
  });

  it("accepts a genuine \"nothing stands out\" answer -- absence that was measured", async () => {
    // The distinction this whole flag exists for. "nincs kiugró nap 1,5
    // szóráson túl, n=41" looks as empty as "nincs sor az adatbázisban", but
    // it is the opposite: 41 nights were read and every one of them was
    // ordinary. That constrains the world, so it may falsify a claim.
    const result = await run([
      { name: "hipotezis", args: { allitas: "Az alvásom is kiugrott aznap." }, why: "" },
      { name: "elteresek", args: { mutato: "alvas", ablak_nap: 90 }, why: "cáfolat" },
      { name: "kesz", args: { megallapitas: "Az alvás nem kiugró.", tamaszkodik: [2], cafolat: 2 }, why: "" },
    ]);
    expect(result.transcript[1]!.observation).toContain("nincs kiugró nap");
    expect(result.outcome).toMatchObject({ kind: "kesz", falsifiedBy: 2 });
  });
});

/**
 * T3, re-run with the hypothesis step the recorded transcript never had.
 *
 * The original replay above passes for a reason that is weaker than it
 * looks: the 2026-09-04 transcript contains no `hipotezis`, so the gate
 * refuses it at its very first branch and never reaches the interesting
 * question. These two cases put a hypothesis on the record and then vary
 * only ONE thing -- whether the step cited as the falsification actually
 * measured anything.
 */
describe("T3 regression: the fabrication, with a hypothesis on the record", () => {
  const FABRICATION = "A 2026-09-04-i HRV kiugróan magas, ami a 2026-09-01-i "
    + "erősítő edzés utáni kiváló regenerációt jelzi.";

  it("still refuses the fabrication when the cited step measured nothing", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "megerősítem az értéket" },
      { name: "edzesek", args: { tol: "2026-08-31", ig: "2026-09-04" }, why: "volt-e edzés" },
      { name: "hipotezis", args: { allitas: "Az edzés utáni regeneráció okozta." }, why: "" },
      { name: "elteresek", args: { mutato: "regeneracio" }, why: "úgy teszek, mintha cáfolnék" },
      { name: "kesz", args: { megallapitas: FABRICATION, tamaszkodik: [1, 2, 4], cafolat: 4 }, why: "" },
      { name: "kerdezz", args: { szoveg: "Változott valami a mérésben?" }, why: "" },
    ]);
    expect(result.outcome.kind).not.toBe("kesz");
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "Változott valami a mérésben?" });
    expect(result.transcript.at(-1)!.observation).toMatch(/nem hozott adatot/);
  });

  /**
   * The boundary, stated rather than hidden.
   *
   * With a hypothesis on the record and a genuine, data-returning step run
   * after it, the same fabricated sentence IS accepted. The gate is
   * procedural: it can prove the model committed to a claim before looking,
   * and that what it looked at was real data. It cannot prove the sentence
   * follows from the data -- doing that would require exactly the inference
   * whose unreliability is the reason this gate exists.
   *
   * This test is here so the limit is pinned and visible. If a later change
   * makes this case refusable, this test failing is the announcement.
   */
  it("cannot refuse the fabrication once a real data step follows the hypothesis", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "megerősítem az értéket" },
      { name: "hipotezis", args: { allitas: "Az edzés utáni regeneráció okozta." }, why: "" },
      { name: "lefedettseg", args: { mutato: "hrv" }, why: "valódi lekérdezés" },
      { name: "kesz", args: { megallapitas: FABRICATION, tamaszkodik: [1, 3], cafolat: 3 }, why: "" },
    ]);
    expect(result.outcome).toMatchObject({ kind: "kesz", finding: FABRICATION });
  });
});
