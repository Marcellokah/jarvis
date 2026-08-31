import { describe, it, expect } from "vitest";
import { buildPrompt, assertContract } from "../../src/core/synthesis/prompt.ts";
import type { BriefContext } from "../../src/core/synthesis/synthesizer.ts";

const ctx: BriefContext = {
  date: "2026-08-31",
  dateLabel: "2026. augusztus 31., hétfő",
  time: "06:20",
  outcomes: [{
    name: "HealthAndMealPrep", title: "🥦 Egészség & Meal Prep",
    priority: "critical", status: "ok",
    result: { data: { proteinTargetG: 115 }, actions: [], priority: "critical" },
    plain: "Fallback szöveg.",
    actions: [{ id: "a1", kind: "checkbox", text: "Vedd ki a csirkét" }],
    durationMs: 3,
  }],
};

describe("buildPrompt", () => {
  it("carries the module data and the section title verbatim", () => {
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain("HealthAndMealPrep");
    expect(prompt).toContain("🥦 Egészség & Meal Prep");
    expect(prompt).toContain("115");
  });

  it("carries the actions, which become the todo lines", () => {
    expect(buildPrompt(ctx)).toContain("Vedd ki a csirkét");
  });

  it("tells the model not to invent facts", () => {
    expect(buildPrompt(ctx)).toContain("ne találj ki tényeket");
  });
});

describe("assertContract", () => {
  it("passes a brief that opens with the date heading", () => {
    expect(assertContract("# 2026. augusztus 31.\n\n## A\n\nx")).toBe("# 2026. augusztus 31.\n\n## A\n\nx");
  });

  it("rejects prose that is not a brief", () => {
    // A tool-less model that wants a tool writes the call out as text. That is
    // non-empty, so only a shape check keeps it out of your morning.
    expect(() => assertContract("Megkeresem a fájlt.\n\n**Tool: bash**"))
      .toThrow(/did not start with/i);
  });

  it("rejects an empty result", () => {
    expect(() => assertContract("   ")).toThrow(/empty/i);
  });
});
