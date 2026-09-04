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
    health.upsert(snapshot({ date: d, hrv: 55 }), {}, now);
  }
  health.upsert(snapshot({ date: "2026-09-04", hrv: 203.6 }), {}, now);
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
