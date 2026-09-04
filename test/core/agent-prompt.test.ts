import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserTurn, parseStep } from "../../src/core/agent/prompt.ts";

describe("buildSystemPrompt", () => {
  it("carries the whole menu, so the model cannot invent a question", () => {
    const prompt = buildSystemPrompt("2026-09-04");
    for (const name of ["nap", "napok", "lefedettseg", "elteresek", "ritmus", "hipotezis", "kesz"]) {
      expect(prompt).toContain(name);
    }
  });

  it("states today, and that the finding must be Hungarian", () => {
    const prompt = buildSystemPrompt("2026-09-04");
    expect(prompt).toContain("2026-09-04");
    expect(prompt.toLowerCase()).toContain("hungarian");
  });

  it("is byte-stable for the same day, so it caches", () => {
    expect(buildSystemPrompt("2026-09-04")).toBe(buildSystemPrompt("2026-09-04"));
  });
});

describe("buildUserTurn", () => {
  it("numbers the steps from 1, matching what cafolat refers to", () => {
    const turn = buildUserTurn("cél", [
      { step: { name: "nap", args: { datum: "2026-09-04" }, why: "" }, observation: "alvas=6,6" },
      { step: { name: "hipotezis", args: { allitas: "X" }, why: "" }, observation: "rögzítve" },
    ]);
    expect(turn).toContain("1. nap");
    expect(turn).toContain("2. hipotezis");
    expect(turn).toContain("alvas=6,6");
  });

  it("asks for the first step when the transcript is empty", () => {
    expect(buildUserTurn("cél", [])).toContain("cél");
  });
});

describe("parseStep", () => {
  it("reads a well-formed step", () => {
    const step = parseStep('{"lepes":"nap","parameterek":{"datum":"2026-09-04"},"miert":"a mai nap"}');
    expect(step).toEqual({ name: "nap", args: { datum: "2026-09-04" }, why: "a mai nap" });
  });

  it("tolerates a missing parameterek object", () => {
    expect(parseStep('{"lepes":"kifutott","miert":"kész"}').args).toEqual({});
  });

  it("throws on unparseable output rather than inventing a step", () => {
    expect(() => parseStep("nem json")).toThrow(/nem értelmezhető/);
  });
});
