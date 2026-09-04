import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSynthesisChain } from "../../src/app.ts";
import { loadEnv } from "../../src/env.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { config } from "../../config/config.ts";

const base = { NODE_ENV: "test" as const };

const originalKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

/**
 * The brief is free, and these guards are what stop a stray config edit
 * turning it into a metered API call.
 *
 * Not "the whole premise of this project is $0/month" any more — that rule
 * ended with the agent, and the block below pins what replaced it. What
 * survives of it is exactly this: the daily brief, the path that runs
 * unattended every morning, still costs nothing.
 */
describe("cost guards", () => {
  it("uses groq before template by default, with no paid synthesizer", () => {
    const chain = buildSynthesisChain(loadEnv(base), silentLogger());
    expect(chain.map((s) => s.name)).toEqual(["groq", "template"]);
    expect(chain.map((s) => s.name)).not.toContain("api");
  });

  /**
   * claude-code was removed deliberately, not by accident: the only Claude Code
   * subscription reachable from this machine is not a personal one, and this
   * project must not spend someone else's quota. Naming it in SYNTHESIS_CHAIN
   * has to be inert, not merely undocumented — an env var is the one place a
   * removed provider could come back without a code change.
   */
  it("no longer builds claude-code, even when the chain names it", () => {
    const chain = buildSynthesisChain(
      loadEnv({ ...base, SYNTHESIS_CHAIN: "claude-code,template" }), silentLogger(),
    );
    expect(chain.map((s) => s.name)).toEqual(["template"]);
  });

  // Dropping the free fallback would make the brief conditional on a network —
  // checked against both remaining providers so neither the default one nor
  // the paid one can skip it.
  it.each(["groq", "api"])(
    "always appends the template, even when the chain is just \"%s\"",
    (name) => {
      const chain = buildSynthesisChain(loadEnv({ ...base, SYNTHESIS_CHAIN: name }), silentLogger());
      expect(chain.at(-1)!.name).toBe("template");
    },
  );

  it("appends the template even when the chain is nonsense", () => {
    const chain = buildSynthesisChain(
      loadEnv({ ...base, SYNTHESIS_CHAIN: "nope,alsonope" }), silentLogger(),
    );
    expect(chain.map((s) => s.name)).toEqual(["template"]);
  });

  it("includes the paid path only when explicitly named", () => {
    const chain = buildSynthesisChain(
      loadEnv({ ...base, SYNTHESIS_CHAIN: "api,template" }), silentLogger(),
    );
    expect(chain.map((s) => s.name)).toEqual(["api", "template"]);
  });

  it("reports the paid path unavailable without an API key, rather than failing mid-generation", async () => {
    const chain = buildSynthesisChain(
      loadEnv({ ...base, SYNTHESIS_CHAIN: "api,template" }), silentLogger(),
    );
    expect(await chain[0]!.available()).toBe(false);
    expect(await chain[1]!.available()).toBe(true);
  });
});

/**
 * The $0/month rule is gone, and that has to be stated rather than implied.
 *
 * It is replaced by two narrower rules, and both need to be pinned: the daily
 * brief stays free, and the one metered path has a ceiling. The danger a
 * dropped rule leaves behind is not the agent's cost — it is that a later
 * edit quietly makes the brief metered too, under cover of "we pay for the
 * API now anyway".
 */
describe("the metered path", () => {
  it("keeps the brief free even though the agent is not", () => {
    const chain = buildSynthesisChain(loadEnv(base), silentLogger());
    expect(chain.map((s) => s.name)).toEqual(["groq", "template"]);
    expect(chain.map((s) => s.name)).not.toContain("api");
  });

  it("caps what one investigation may spend", () => {
    expect(config.agent.maxUsdPerRun).toBeGreaterThan(0);
    expect(config.agent.maxUsdPerRun).toBeLessThanOrEqual(2);
  });
});
