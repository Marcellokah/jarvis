import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { claudeCodeSynthesizer } from "../../src/core/synthesis/claude-code.ts";
import { resetAuthCache } from "../../src/core/synthesis/claude-cli.ts";
import { templateSynthesizer } from "../../src/core/synthesis/template.ts";
import { synthesizeWithFallback, type BriefContext } from "../../src/core/synthesis/synthesizer.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { beforeEach } from "vitest";

const bin = (name: string) => resolve("test/fixtures/bin", name);

const ctx: BriefContext = {
  date: "2026-08-31",
  dateLabel: "2026. augusztus 31., hétfő",
  time: "06:20",
  outcomes: [{
    name: "HealthAndMealPrep", title: "🥦 Egészség & Meal Prep", priority: "critical", status: "ok",
    result: { data: { proteinTargetG: 115 }, actions: [], priority: "critical" },
    plain: "Fallback szöveg.",
    actions: [{ id: "a1", kind: "checkbox", text: "Vedd ki a csirkét" }],
    durationMs: 3,
  }],
};

const signal = new AbortController().signal;

// The probe cache is shared per binary path; clear it between cases.
beforeEach(() => resetAuthCache());

function synth(name: string, over: Partial<Parameters<typeof claudeCodeSynthesizer>[0]> = {}) {
  return claudeCodeSynthesizer({
    bin: bin(name),
    model: "sonnet",
    systemPromptFile: "./jarvis.md",
    webGapFill: false,
    timeoutMs: 5_000,
    logger: silentLogger(),
    authCacheMs: 0,
    ...over,
  });
}

describe("availability probe", () => {
  it("reports available when the CLI is logged in", async () => {
    expect(await synth("claude-ok").available()).toBe(true);
  });

  it("reports unavailable when the CLI is logged out, without spawning a doomed run", async () => {
    expect(await synth("claude-logged-out").available()).toBe(false);
  });

  it("reports unavailable when the binary does not exist", async () => {
    expect(await synth("claude-does-not-exist").available()).toBe(false);
  });

  it("caches the probe so a brief does not re-check on every synthesizer call", async () => {
    const s = synth("claude-ok", { authCacheMs: 60_000 });
    expect(await s.available()).toBe(true);
    expect(await s.available()).toBe(true); // served from cache; no second spawn
  });
});

describe("synthesis", () => {
  it("returns the markdown from the result field", async () => {
    const md = await synth("claude-ok").synthesize(ctx, signal);
    expect(md).toContain("## 🥦 Egészség & Meal Prep");
    expect(md).toContain("- [ ] Csinálj valamit");
  });

  it("treats is_error as failure even though the CLI exits 0", async () => {
    // This is the case that would otherwise publish "Credit balance is too low"
    // as the morning brief.
    await expect(synth("claude-errors").synthesize(ctx, signal))
      .rejects.toThrow(/Credit balance is too low/);
  });

  it("rejects unparseable output rather than passing it through", async () => {
    await expect(synth("claude-garbage").synthesize(ctx, signal))
      .rejects.toThrow(/unparseable CLI output/);
  });

  it("kills a wedged subprocess instead of holding the brief open", async () => {
    const started = Date.now();
    await expect(synth("claude-hangs", { timeoutMs: 300 }).synthesize(ctx, signal))
      .rejects.toThrow(/timed out after 300 ms/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    const promise = synth("claude-hangs", { timeoutMs: 10_000 }).synthesize(ctx, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it("passes the persona file and disables tools for a plain text run", async () => {
    const out = await synth("claude-echoes-args").synthesize(ctx, signal);
    expect(out).toContain("--append-system-prompt-file ./jarvis.md");
    expect(out).toContain("--model sonnet");
    expect(out).toContain("--max-turns 1");
    expect(out).toContain("STDIN_HAS_JSON=1");
  });

  it("enables WebSearch and more turns when gap-fill is on", async () => {
    const out = await synth("claude-echoes-args", { webGapFill: true }).synthesize(ctx, signal);
    expect(out).toContain("--allowedTools WebSearch,WebFetch");
    expect(out).toContain("--max-turns 4");
  });
});

/**
 * Removing the tools changed how a tool-hungry model fails: instead of a hard
 * `error_max_turns`, it now writes the tool call out as prose. That is
 * non-empty, so the fallback chain's only guard would wave it through and it
 * would be delivered as your morning brief.
 */
describe("output shape", () => {
  it("rejects prose that is not a brief, so the template still takes over", async () => {
    await expect(synth("claude-prose-tool-call").synthesize(ctx, signal))
      .rejects.toThrow(/did not start with/i);
  });

  it("falls back to the template rather than delivering it", async () => {
    const out = await synthesizeWithFallback(
      [synth("claude-prose-tool-call"), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.markdown).toContain("Fallback szöveg.");
  });

  it("accepts a brief that opens with the date heading", async () => {
    const out = await synth("claude-ok").synthesize(ctx, signal);
    expect(out.startsWith("#")).toBe(true);
  });
});

/**
 * `claude -p` inherits the logged-in user's entire Claude Code configuration:
 * installed plugins, the MCP servers they bring, and hooks. Those tools stay in
 * the model's schema even with `--allowedTools ""`, which only governs
 * permission for the built-in set — so the model can call one, the call is
 * denied for want of a grant, the denial costs a turn, and the run ends as
 * `error_max_turns` with no text at all.
 *
 * Observed in production: a `claude-mem` plugin put 14 MCP tools into a brief
 * synthesis and cost a morning's prose.
 */
describe("isolation from the user's own Claude Code setup", () => {
  it("removes the built-in tools rather than merely denying them", async () => {
    const out = await synth("claude-echoes-argv").synthesize(ctx, signal);
    // `--allowedTools ""` left the tools in the schema; `--tools ""` removes them.
    expect(out).toContain("[--tools][]");
  });

  it("ignores MCP servers and settings the user happens to have installed", async () => {
    const out = await synth("claude-echoes-argv").synthesize(ctx, signal);
    expect(out).toContain("[--strict-mcp-config]");
    expect(out).toContain("[--setting-sources][]");
  });

  it("keeps the isolation when gap-fill grants the web tools", async () => {
    const out = await synth("claude-echoes-argv", { webGapFill: true }).synthesize(ctx, signal);
    // Available and permitted, but still nothing inherited from the user.
    expect(out).toContain("[--tools][WebSearch,WebFetch]");
    expect(out).toContain("[--strict-mcp-config]");
    expect(out).toContain("[--setting-sources][]");
  });
});

describe("the guarantee", () => {
  it("falls back to the template when the CLI is logged out", async () => {
    const out = await synthesizeWithFallback(
      [synth("claude-logged-out"), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.markdown).toContain("Fallback szöveg.");
  });

  it("falls back to the template when the CLI errors mid-run", async () => {
    const out = await synthesizeWithFallback(
      [synth("claude-errors"), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.demoted[0]!.reason).toContain("Credit balance");
  });

  it("prefers the CLI when it works", async () => {
    const out = await synthesizeWithFallback(
      [synth("claude-ok"), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("claude-code");
    expect(out.demoted).toEqual([]);
  });
});

describe("abort semantics", () => {
  it("honours a signal that was already aborted before the call", async () => {
    // Credentials are resolved before spawning, so the signal can fire during
    // that window — an abort listener attached afterwards would never see it.
    const controller = new AbortController();
    controller.abort();

    await expect(synth("claude-hangs", { timeoutMs: 10_000 }).synthesize(ctx, controller.signal))
      .rejects.toThrow(/aborted/);
  });
});

describe("invalid credentials", () => {
  it("stops recommending itself after the CLI rejects the token", async () => {
    // `auth status` reports loggedIn for any non-empty token, valid or not, so
    // a truncated one probes fine and fails only on use. Without remembering
    // that, every brief — and every Telegram message — pays the round trip.
    const s = synth("claude-401", { authCacheMs: 60_000 });

    expect(await s.available()).toBe(true);
    await expect(s.synthesize(ctx, signal)).rejects.toThrow(/401/);
    expect(await s.available()).toBe(false);
  });

  it("falls back to the template on a rejected token", async () => {
    const out = await synthesizeWithFallback(
      [synth("claude-401"), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.demoted[0]!.reason).toContain("401");
  });

  it("does not treat a transient failure as an auth problem", async () => {
    // A crashed CLI must not disable the path for a minute; it may work next time.
    const s = synth("claude-garbage", { authCacheMs: 60_000 });
    await expect(s.synthesize(ctx, signal)).rejects.toThrow(/unparseable/);
    expect(await s.available()).toBe(true);
  });
});
