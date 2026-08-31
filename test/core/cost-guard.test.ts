import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSynthesisChain } from "../../src/app.ts";
import { loadEnv } from "../../src/env.ts";
import { silentLogger } from "../../src/infra/logger.ts";

const base = { NODE_ENV: "test" as const };

const originalKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

/**
 * The whole premise of this project is $0/month. These guards are what stop a
 * stray config edit turning the morning brief into a metered API call.
 */
describe("cost guards", () => {
  it("uses no paid synthesizer by default", () => {
    const chain = buildSynthesisChain(loadEnv(base), silentLogger());
    expect(chain.map((s) => s.name)).toEqual(["claude-code", "template"]);
    expect(chain.map((s) => s.name)).not.toContain("api");
  });

  it("always ends with the template, whatever the chain says", () => {
    // Dropping the free fallback would make the 07:30 notification conditional
    // on a subprocess and a network.
    const chain = buildSynthesisChain(
      loadEnv({ ...base, SYNTHESIS_CHAIN: "claude-code" }), silentLogger(),
    );
    expect(chain.at(-1)!.name).toBe("template");
  });

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

  it("reports the paid path unavailable without an API key, rather than failing at 07:30", async () => {
    const chain = buildSynthesisChain(
      loadEnv({ ...base, SYNTHESIS_CHAIN: "api,template" }), silentLogger(),
    );
    expect(await chain[0]!.available()).toBe(false);
    expect(await chain[1]!.available()).toBe(true);
  });
});
