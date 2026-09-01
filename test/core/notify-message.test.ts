import { describe, it, expect } from "vitest";
import {
  renderNotifyTemplate, buildNotifyPrompt, composeNotification,
} from "../../src/core/notify/message.ts";
import { GROQ_CHAT_URL } from "../../src/infra/groq.ts";
import { recordingLogger } from "../helpers.ts";
import type { Fetcher } from "../../src/infra/http-client.ts";
import type { Candidate } from "../../src/core/notify/candidates.ts";

const CS: Candidate[] = [
  { key: "deadline:csirke:2026-09-01", kind: "deadline", urgency: "now", text: "csirkemell — a határidő már lejárt." },
  { key: "health:rhr-rising", kind: "health", urgency: "soon", text: "A nyugalmi pulzusod emelkedik (200 nap)." },
];

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

const opts = (fetcher: Fetcher) => ({
  fetcher, model: "m", systemPromptFile: "jarvis.md",
  maxTokens: 300, temperature: 0.4, timeoutMs: 5_000,
  logger: recordingLogger(), apiKey: async () => "key",
});

const signal = () => new AbortController().signal;

describe("renderNotifyTemplate", () => {
  it("lists every candidate", () => {
    const text = renderNotifyTemplate(CS);
    expect(text).toContain("csirkemell");
    expect(text).toContain("nyugalmi pulzusod");
  });

  it("returns an empty string for no candidates", () => {
    // Nothing to say means no message, not an empty announcement.
    expect(renderNotifyTemplate([])).toBe("");
  });
});

describe("buildNotifyPrompt", () => {
  it("hands over the candidates and forbids adding to them", () => {
    const { system, user } = buildNotifyPrompt(CS);
    expect(user).toContain("csirkemell");
    expect(system).toMatch(/ne tegy|ne találj|csak a megadott/i);
  });
});

describe("composeNotification", () => {
  it("uses the model's wording when it answers", async () => {
    const result = await composeNotification(CS, opts(fetcherThat("Vedd ki a csirkét.")), signal());
    expect(result).toEqual({ text: "Vedd ki a csirkét.", source: "groq" });
  });

  it("falls back to the template when the model fails", async () => {
    // A missed defrost deadline is worse than an ugly sentence.
    const result = await composeNotification(CS, opts(fetcherThat(new Error("429"))), signal());
    expect(result.source).toBe("template");
    expect(result.text).toContain("csirkemell");
  });

  it("falls back to the template with no API key, without calling out", async () => {
    const fetcher = fetcherThat("nem hívódik");
    const result = await composeNotification(
      CS, { ...opts(fetcher), apiKey: async () => undefined }, signal(),
    );
    expect(fetcher.bodies).toHaveLength(0);
    expect(result.source).toBe("template");
  });

  it("never returns an empty text for a non-empty candidate list", async () => {
    // An empty answer from the model must not become a silent notification.
    const result = await composeNotification(CS, opts(fetcherThat("   ")), signal());
    expect(result.source).toBe("template");
    expect(result.text.trim()).not.toBe("");
  });
});
