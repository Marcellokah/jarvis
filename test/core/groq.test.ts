import { describe, it, expect } from "vitest";
import { groqComplete, GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";

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
