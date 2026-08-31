import { describe, it, expect } from "vitest";
import { synthesizeWithFallback, type Synthesizer, type BriefContext } from "../../src/core/synthesis/synthesizer.ts";
import { templateSynthesizer } from "../../src/core/synthesis/template.ts";
import { silentLogger } from "../../src/infra/logger.ts";

const ctx: BriefContext = {
  date: "2026-08-31",
  dateLabel: "2026. augusztus 31., hétfő",
  time: "06:20",
  outcomes: [{
    name: "Demo", title: "🥦 Demó", priority: "normal", status: "ok",
    result: { data: {}, actions: [], priority: "normal" },
    plain: "Egy sor tartalom.",
    actions: [{ id: "a1", kind: "checkbox", text: "Csinálj valamit" }],
    durationMs: 1,
  }],
};

const failing = (name: string, reason: string): Synthesizer => ({
  name,
  available: async () => true,
  synthesize: async () => { throw new Error(reason); },
});

const signal = new AbortController().signal;

describe("synthesis fallback chain", () => {
  it("falls through to the template when the preferred synthesizer fails", async () => {
    const out = await synthesizeWithFallback(
      [failing("claude-code", "ENOENT: claude not found"), templateSynthesizer()],
      ctx, silentLogger(), signal,
    );

    expect(out.synthesizer).toBe("template");
    expect(out.demoted).toEqual([{ name: "claude-code", reason: "ENOENT: claude not found" }]);
    expect(out.markdown).toContain("🥦 Demó");
  });

  it("skips a synthesizer that reports itself unavailable", async () => {
    const unavailable: Synthesizer = {
      name: "claude-code", available: async () => false,
      synthesize: async () => "never reached",
    };
    const out = await synthesizeWithFallback([unavailable, templateSynthesizer()], ctx, silentLogger(), signal);

    expect(out.synthesizer).toBe("template");
    expect(out.demoted[0]!.reason).toBe("not available");
  });

  it("treats empty output as a failure rather than a valid brief", async () => {
    const blank: Synthesizer = {
      name: "blank", available: async () => true, synthesize: async () => "   ",
    };
    const out = await synthesizeWithFallback([blank, templateSynthesizer()], ctx, silentLogger(), signal);
    expect(out.synthesizer).toBe("template");
  });

  it("throws only when every synthesizer in the chain fails", async () => {
    await expect(
      synthesizeWithFallback([failing("a", "x"), failing("b", "y")], ctx, silentLogger(), signal),
    ).rejects.toThrow(/Every synthesizer failed/);
  });
});

describe("template synthesizer", () => {
  it("renders headings, body and actions using the shared contract", async () => {
    const md = await templateSynthesizer().synthesize(ctx, signal);

    expect(md).toContain("# 2026. augusztus 31., hétfő");
    expect(md).toContain("## 🥦 Demó");
    expect(md).toContain("Egy sor tartalom.");
    expect(md).toContain("- [ ] Csinálj valamit");
  });

  it("omits empty modules but names the failed ones", async () => {
    const md = await templateSynthesizer().synthesize({
      ...ctx,
      outcomes: [
        { ...ctx.outcomes[0]!, name: "Empty", title: "Üres", status: "empty", plain: "", actions: [] },
        { ...ctx.outcomes[0]!, name: "Broken", title: "Hibás", status: "failed", plain: "⚠️ Nem elérhető", actions: [] },
      ],
    }, signal);

    expect(md).not.toContain("Üres");
    expect(md).toContain("Nem futott le: Broken");
  });

  it("never needs network or credentials — that is the whole point", async () => {
    expect(await templateSynthesizer().available()).toBe(true);
  });
});
