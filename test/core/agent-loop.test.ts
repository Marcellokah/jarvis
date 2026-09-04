import { describe, it, expect } from "vitest";
import { memoryDb, snapshot } from "../helpers.ts";
import { investigate, MAX_STEPS, type InvestigatorModel, type Step } from "../../src/core/agent/loop.ts";
import { createHealthRepo } from "../../src/infra/db/repositories/health.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";
import { unavailableCalendar } from "../../src/infra/calendar/service.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { QuestionContext } from "../../src/core/agent/questions.ts";

function ctx(): QuestionContext {
  const db = memoryDb();
  const health = createHealthRepo(db);
  health.upsert(snapshot({ date: "2026-09-04", sleepH: 6.6 }), {}, new Date("2026-09-04T05:00:00Z"));
  return {
    health, workouts: createWorkoutRepo(db),
    calendar: unavailableCalendar("test"), today: "2026-09-04",
  };
}

/** Replays a fixed list of steps — no network, fully deterministic. */
function scripted(steps: Step[]): InvestigatorModel {
  let i = 0;
  return { async nextStep() { return steps[i++] ?? { name: "kifutott", args: {}, why: "" }; } };
}

const run = (steps: Step[]) => investigate({
  goal: "teszt", model: scripted(steps), ctx: ctx(),
  logger: silentLogger(), signal: new AbortController().signal,
});

describe("investigate", () => {
  it("runs each chosen question and records the observation", async () => {
    const result = await run([
      { name: "nap", args: { datum: "2026-09-04" }, why: "a mai nap" },
      { name: "kerdezz", args: { szoveg: "Aludtál rosszul?" }, why: "nem elég az adat" },
    ]);
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0]!.observation).toContain("2026-09-04");
    expect(result.outcome).toEqual({ kind: "kerdezz", question: "Aludtál rosszul?" });
  });

  it("stops after MAX_STEPS and keeps what it collected", async () => {
    const many = Array.from({ length: MAX_STEPS + 5 }, () =>
      ({ name: "nap", args: { datum: "2026-09-04" }, why: "újra" }));
    const result = await run(many);
    expect(result.transcript).toHaveLength(MAX_STEPS);
    expect(result.outcome.kind).toBe("kifutott");
  });

  it("feeds an unknown question back as an observation instead of failing", async () => {
    const result = await run([
      { name: "nincsilyen", args: {}, why: "elgépelés" },
      { name: "kerdezz", args: { szoveg: "?" }, why: "" },
    ]);
    expect(result.transcript[0]!.observation).toContain("ismeretlen kérdés");
    expect(result.outcome.kind).toBe("kerdezz");
  });

  it("gives the model the transcript so far on every call", async () => {
    const seen: number[] = [];
    const model: InvestigatorModel = {
      async nextStep(_goal, transcript) {
        seen.push(transcript.length);
        return transcript.length >= 2
          ? { name: "kerdezz", args: { szoveg: "elég" }, why: "" }
          : { name: "nap", args: { datum: "2026-09-04" }, why: "" };
      },
    };
    await investigate({
      goal: "teszt", model, ctx: ctx(),
      logger: silentLogger(), signal: new AbortController().signal,
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it("surfaces a model failure as an outcome, never as a silent empty run", async () => {
    const model: InvestigatorModel = {
      async nextStep() { throw new Error("HTTP 529 overloaded"); },
    };
    const result = await investigate({
      goal: "teszt", model, ctx: ctx(),
      logger: silentLogger(), signal: new AbortController().signal,
    });
    expect(result.outcome).toEqual({ kind: "hiba", reason: "HTTP 529 overloaded" });
  });
});
