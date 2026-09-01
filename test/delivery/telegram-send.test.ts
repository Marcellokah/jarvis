import { describe, it, expect } from "vitest";
import type { Bot } from "grammy";
import { sendTo, chunkText } from "../../src/delivery/telegram/bot.ts";

interface Sent { chatId: string; text: string; parseMode?: string }

/**
 * Only `api.sendMessage` is exercised, so the stub is exactly that. Building a
 * real `Bot` would need a token and would reach the network on the first call,
 * which the offline test rule forbids.
 */
function fakeBot(): { bot: Bot; sent: Sent[] } {
  const sent: Sent[] = [];
  const bot = {
    api: {
      sendMessage: async (chatId: string, text: string, opts?: { parse_mode?: string }) => {
        sent.push({ chatId, text, parseMode: opts?.parse_mode });
      },
    },
  };
  return { bot: bot as unknown as Bot, sent };
}

describe("sendTo", () => {
  it("escapes the characters that would make Telegram reject the message", async () => {
    const { bot, sent } = fakeBot();
    // A meal item, a subscription name and a sentence the model wrote — the
    // three things a notification is actually made of, each carrying a
    // character that is markup to Telegram's HTML parser.
    await sendTo(bot, "42", "• Marhahús <csont & velő> — 30 perc múlva jár le.");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("• Marhahús &lt;csont &amp; velő&gt; — 30 perc múlva jár le.");
    expect(sent[0]!.parseMode).toBe("HTML");
  });

  it("lets no raw angle bracket or ampersand reach the API", async () => {
    const { bot, sent } = fakeBot();
    // The 400 this prevents is silent in production: `send` throws, the tick
    // returns "failed", nothing is recorded, and the same candidates come back
    // fifteen minutes later to fail again — one Groq call each, forever.
    await sendTo(bot, "42", "AT&T <b>előfizetés</b> megújul — ma.");

    expect(sent[0]!.text).not.toMatch(/[<>]/);
    expect(sent[0]!.text).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(sent[0]!.text).toBe("AT&amp;T &lt;b&gt;előfizetés&lt;/b&gt; megújul — ma.");
  });

  it("escapes before chunking, so no entity is split across two messages", async () => {
    const { bot, sent } = fakeBot();
    // Each paragraph is under the limit; together they are over it, so the
    // text is split on a paragraph boundary.
    const paragraph = `${"a".repeat(3900)} & <x>`;
    await sendTo(bot, "42", `${paragraph}\n\n${paragraph}`);

    expect(sent).toHaveLength(2);
    for (const message of sent) {
      expect(message.text.endsWith(" &amp; &lt;x&gt;")).toBe(true);
      expect(message.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("sends plain text through untouched", async () => {
    const { bot, sent } = fakeBot();
    await sendTo(bot, "42", "A HRV-d 2.1 szórással az alapvonalad alatt van.");
    expect(sent[0]!.text).toBe("A HRV-d 2.1 szórással az alapvonalad alatt van.");
  });
});

describe("chunkText", () => {
  it("keeps a short text in one piece", () => {
    expect(chunkText("rövid", 4000)).toEqual(["rövid"]);
  });
});
