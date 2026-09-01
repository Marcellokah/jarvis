import { describe, it, expect } from "vitest";
import { groqComplete, GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import { groqSynthesizer } from "../../src/core/synthesis/groq.ts";
import { templateSynthesizer } from "../../src/core/synthesis/template.ts";
import { synthesizeWithFallback, type BriefContext } from "../../src/core/synthesis/synthesizer.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";
import { groqChat } from "../../src/core/chat.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";
import { memoryDb } from "../helpers.ts";
import type { AskContext } from "../../src/core/ask/context.ts";

const signal = new AbortController().signal;

/** A fetcher that records what it was asked and returns what the test dictates. */
function stub(answer: unknown, seen: { url?: string; init?: RequestInit } = {}): Fetcher {
  return {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      seen.url = url;
      seen.init = init;
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
    async text() { throw new Error("unused"); },
  };
}

const ok = {
  choices: [{ message: { role: "assistant", content: "# nap\n\n## A\n\nvalami" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};

const req = {
  apiKey: "gsk-test", model: "llama-3.3-70b-versatile",
  system: "te vagy jarvis", user: "írd meg a briefet",
  maxTokens: 1500, temperature: 0.3, signal,
};

describe("groqComplete", () => {
  it("returns the assistant's text", async () => {
    expect(await groqComplete(stub(ok), req)).toBe("# nap\n\n## A\n\nvalami");
  });

  it("posts to the chat completions endpoint with the key in a header", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await groqComplete(stub(ok, seen), req);

    expect(seen.url).toBe(GROQ_CHAT_URL);
    expect(seen.init?.method).toBe("POST");
    expect((seen.init?.headers as Record<string, string>).authorization).toBe("Bearer gsk-test");

    const body = JSON.parse(String(seen.init?.body)) as {
      model: string; messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.messages[0]).toEqual({ role: "system", content: "te vagy jarvis" });
    expect(body.messages[1]).toEqual({ role: "user", content: "írd meg a briefet" });
  });

  it("rejects a truncated completion — a half-written brief is not a brief", async () => {
    const truncated = { choices: [{ message: { content: "# nap\n\n## A" }, finish_reason: "length" }] };
    await expect(groqComplete(stub(truncated), req)).rejects.toThrow(/truncated/i);
  });

  it("rejects an empty completion", async () => {
    const empty = { choices: [{ message: { content: "   " }, finish_reason: "stop" }] };
    await expect(groqComplete(stub(empty), req)).rejects.toThrow(/empty/i);
  });

  it("rejects a response with no choices at all", async () => {
    await expect(groqComplete(stub({}), req)).rejects.toThrow(/no completion/i);
  });

  it("lets a transport error through so the chain can demote", async () => {
    await expect(groqComplete(stub(new Error("HTTP 429 for groq")), req))
      .rejects.toThrow(/429/);
  });

  it("never puts the key anywhere but the header", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await groqComplete(stub(ok, seen), req);

    expect(seen.url).not.toContain("gsk-test");
    expect(String(seen.init?.body)).not.toContain("gsk-test");
  });
});

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

function synth(answer: unknown, key: string | undefined = "gsk-test") {
  return groqSynthesizer({
    fetcher: stub(answer),
    model: "llama-3.3-70b-versatile",
    systemPromptFile: "./jarvis.md",
    maxTokens: 1500,
    temperature: 0.3,
    timeoutMs: 5_000,
    logger: silentLogger(),
    apiKey: async () => key,
  });
}

describe("groqSynthesizer", () => {
  it("is unavailable without a key, so the chain skips it cheaply", async () => {
    // Passing `undefined` here would silently re-trigger `synth`'s own default
    // parameter ("gsk-test"), defeating the point of this test — JavaScript's
    // default-parameter substitution fires on an explicit `undefined` too, not
    // just on an omitted argument. An empty string is falsy but not `undefined`,
    // so it exercises the "no usable key" path the test name describes.
    expect(await synth(ok, "").available()).toBe(false);
  });

  it("is available with one", async () => {
    expect(await synth(ok).available()).toBe(true);
  });

  it("returns the brief", async () => {
    const out = await synth(ok).synthesize(ctx, signal);
    expect(out).toBe("# nap\n\n## A\n\nvalami");
  });

  it("sends jarvis.md as the system message and the payload as the user message", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await groqSynthesizer({
      fetcher: stub(ok, seen), model: "llama-3.3-70b-versatile",
      systemPromptFile: "./jarvis.md", maxTokens: 1500, temperature: 0.3,
      timeoutMs: 5_000, logger: silentLogger(), apiKey: async () => "gsk-test",
    }).synthesize(ctx, signal);

    const body = JSON.parse(String(seen.init?.body)) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain("OPERATIONAL CONTRACT");
    expect(body.messages[1]!.content).toContain("🥦 Egészség & Meal Prep");
  });

  it("falls back to the template when the model breaks the contract", async () => {
    const prose = { choices: [{ message: { content: "Megkeresem a fájlt." }, finish_reason: "stop" }] };
    const out = await synthesizeWithFallback(
      [synth(prose), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.demoted[0]!.reason).toMatch(/did not start with/i);
  });

  it("falls back to the template on a rate limit", async () => {
    const out = await synthesizeWithFallback(
      [synth(new Error("HTTP 429 Too Many Requests")), templateSynthesizer()],
      ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("template");
    expect(out.demoted[0]!.reason).toContain("429");
  });

  it("prefers Groq when it works", async () => {
    const out = await synthesizeWithFallback(
      [synth(ok), templateSynthesizer()], ctx, silentLogger(), signal,
    );
    expect(out.synthesizer).toBe("groq");
    expect(out.demoted).toEqual([]);
  });

  it("fails fast on an already-aborted signal instead of waiting out the timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    // The budget below sits far under timeoutMs on purpose: a regression (the
    // aborted-check missing, falling back to "wait for the timer") takes the
    // full 2 seconds, while the correct path returns in about a millisecond.
    // The two must not be within scheduler noise of each other — at 20ms
    // against a 20ms timeout this test failed whenever the full suite loaded
    // the machine, which is a flake, not a signal.
    await expect(
      groqSynthesizer({
        fetcher: stub(ok), model: "llama-3.3-70b-versatile",
        systemPromptFile: "./jarvis.md", maxTokens: 1500, temperature: 0.3,
        timeoutMs: 2_000, logger: silentLogger(), apiKey: async () => "gsk-test",
      }).synthesize(ctx, controller.signal),
    ).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("groqChat", () => {
  const answer = {
    choices: [{ message: { content: "Két előfizetés újul meg a héten." }, finish_reason: "stop" }],
  };

  const CONTEXT: AskContext = {
    today: "2026-08-31",
    briefMarkdown: "# nap\n\n## 💰 Pénzügy\n\n5 előfizetés",
    analyses: [],
    metrics: {} as AskContext["metrics"],
    history: [],
  };

  const clock = { now: () => new Date("2026-08-31T08:00:00.000Z") };

  function chat(
    response: unknown,
    seen?: { url?: string; init?: RequestInit },
    conversations = createConversationRepo(memoryDb()),
  ) {
    return groqChat({
      fetcher: stub(response, seen ?? {}),
      model: "llama-3.3-70b-versatile",
      systemPromptFile: "./jarvis.md",
      maxTokens: 800,
      temperature: 0.4,
      timeoutMs: 5_000,
      logger: silentLogger(),
      apiKey: async () => "gsk-test",
      clock,
      conversations,
      context: async () => CONTEXT,
    });
  }

  it("answers a follow-up", async () => {
    const out = await chat(answer).ask("web", "részletezd a pénzügyi részt", signal);
    expect(out).toBe("Két előfizetés újul meg a héten.");
  });

  it("gives the model today's brief as context", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await chat(answer, seen).ask("web", "mi ez?", signal);

    const body = JSON.parse(String(seen.init?.body)) as { messages: { content: string }[] };
    expect(body.messages[1]!.content).toContain("5 előfizetés");
    expect(body.messages[1]!.content).toContain("mi ez?");
  });

  it("does not apply the brief's output contract to a chat answer", async () => {
    // A chat reply is prose. Requiring it to start with '#' would reject every
    // useful answer.
    const prose = { choices: [{ message: { content: "Nem, csak kettő." }, finish_reason: "stop" }] };
    await expect(chat(prose).ask("web", "három?", signal)).resolves.toBe("Nem, csak kettő.");
  });

  it("is unavailable without a key", async () => {
    const noKey = groqChat({
      fetcher: stub(answer), model: "llama-3.3-70b-versatile",
      systemPromptFile: "./jarvis.md", maxTokens: 800, temperature: 0.4,
      timeoutMs: 5_000, logger: silentLogger(), apiKey: async () => undefined,
      clock, conversations: createConversationRepo(memoryDb()), context: async () => CONTEXT,
    });
    expect(await noKey.available()).toBe(false);
  });

  it("fails fast on an already-aborted signal instead of waiting out the timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    // The budget below sits far under timeoutMs on purpose: a regression (the
    // aborted-check missing, falling back to "wait for the timer") takes the
    // full 2 seconds, while the correct path returns in about a millisecond.
    // The two must not be within scheduler noise of each other — at 20ms
    // against a 20ms timeout this test failed whenever the full suite loaded
    // the machine, which is a flake, not a signal.
    await expect(
      groqChat({
        fetcher: stub(answer), model: "llama-3.3-70b-versatile",
        systemPromptFile: "./jarvis.md", maxTokens: 800, temperature: 0.4,
        timeoutMs: 2_000, logger: silentLogger(), apiKey: async () => "gsk-test",
        clock, conversations: createConversationRepo(memoryDb()), context: async () => CONTEXT,
      }).ask("web", "mi ez?", controller.signal),
    ).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(500);
  });
});
