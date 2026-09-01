import { describe, it, expect } from "vitest";
import { groqChat } from "../../src/core/chat.ts";
import { createConversationRepo } from "../../src/infra/db/repositories/conversations.ts";
import { GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import { memoryDb, recordingLogger } from "../helpers.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";
import type { AskContext } from "../../src/core/ask/context.ts";

const CONTEXT: AskContext = {
  today: "2026-09-01",
  briefMarkdown: "# Ma",
  analyses: [],
  metrics: {} as AskContext["metrics"],
  history: [],
};

function fetcherThat(answer: string | Error): Fetcher & { bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      if (!url.startsWith(GROQ_CHAT_URL)) throw new Error(`unexpected url ${url}`);
      bodies.push(String(init?.body ?? ""));
      if (answer instanceof Error) throw answer;
      return { choices: [{ message: { content: answer }, finish_reason: "stop" }] } as T;
    },
    async text(): Promise<string> { throw new Error("not used"); },
  };
}

function chatWith(fetcher: Fetcher, conversations = createConversationRepo(memoryDb())) {
  return {
    conversations,
    service: groqChat({
      fetcher,
      model: "test-model",
      systemPromptFile: "jarvis.md",
      maxTokens: 800,
      temperature: 0.4,
      timeoutMs: 5_000,
      logger: recordingLogger(),
      apiKey: async () => "key",
      clock: { now: () => new Date("2026-09-01T08:00:00.000Z") },
      conversations,
      context: async () => CONTEXT,
    }),
  };
}

const signal = () => new AbortController().signal;

describe("ask", () => {
  it("answers and stores both turns", async () => {
    const { service, conversations } = chatWith(fetcherThat("Ez a válasz."));

    const answer = await service.ask("web", "Ez a kérdés?", signal());

    expect(answer).toBe("Ez a válasz.");
    expect(conversations.recent("web", 10).map((t) => [t.role, t.content])).toEqual([
      ["user", "Ez a kérdés?"],
      ["assistant", "Ez a válasz."],
    ]);
  });

  it("stores nothing when the call fails", async () => {
    // A question stored without its answer would read as a refusal next turn.
    const { service, conversations } = chatWith(fetcherThat(new Error("groq exploded")));

    await expect(service.ask("web", "Ez a kérdés?", signal())).rejects.toThrow(/groq exploded/);
    expect(conversations.recent("web", 10)).toEqual([]);
  });

  it("sends the assembled context, not the raw question alone", async () => {
    const fetcher = fetcherThat("ok");
    await chatWith(fetcher).service.ask("web", "KERDES", signal());

    expect(fetcher.bodies[0]).toContain("KERDES");
    expect(fetcher.bodies[0]).toContain("2026-09-01");
  });

  it("keeps threads apart", async () => {
    const conversations = createConversationRepo(memoryDb());
    const { service } = chatWith(fetcherThat("válasz"), conversations);

    await service.ask("web", "gépnél", signal());
    await service.ask("123456", "telefonon", signal());

    expect(conversations.recent("web", 10).map((t) => t.content)).toEqual(["gépnél", "válasz"]);
    expect(conversations.recent("123456", 10).map((t) => t.content)).toEqual(["telefonon", "válasz"]);
  });

  it("fails without an API key and stores nothing", async () => {
    const fetcher = fetcherThat("nem hívódik");
    const conversations = createConversationRepo(memoryDb());
    const service = groqChat({
      fetcher, model: "m", systemPromptFile: "jarvis.md", maxTokens: 800,
      temperature: 0.4, timeoutMs: 5_000, logger: recordingLogger(),
      apiKey: async () => undefined,
      clock: { now: () => new Date("2026-09-01T08:00:00.000Z") },
      conversations, context: async () => CONTEXT,
    });

    await expect(service.ask("web", "k", signal())).rejects.toThrow(/GROQ_API_KEY/);
    expect(fetcher.bodies).toHaveLength(0);
    expect(conversations.recent("web", 10)).toEqual([]);
  });
});
