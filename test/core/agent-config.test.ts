import { describe, it, expect } from "vitest";
import { config } from "../../config/config.ts";
import { MAX_STEPS } from "../../src/core/agent/loop.ts";

describe("agent config", () => {
  it("carries a per-run cost ceiling, because the $0 rule no longer covers this path", () => {
    expect(config.agent.maxUsdPerRun).toBeGreaterThan(0);
    expect(config.agent.maxUsdPerRun).toBeLessThanOrEqual(2);
  });

  it("names the measured model", () => {
    expect(config.agent.model).toBe("claude-opus-5");
  });

  it("agrees with the loop's own step ceiling", () => {
    expect(config.agent.maxSteps).toBe(MAX_STEPS);
  });
});
