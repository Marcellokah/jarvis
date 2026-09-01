import { readFile } from "node:fs/promises";
import type { Logger } from "../infra/logger.ts";
import type { Fetcher } from "../infra/http-client.ts";
import type { Clock } from "../infra/clock.ts";
import { groqComplete } from "../infra/groq.ts";
import { withTimeout } from "../infra/abort.ts";
import type { ConversationRepo } from "../infra/db/repositories/conversations.ts";
import { renderAskPrompt, type AskContext } from "./ask/context.ts";

export interface ChatService {
  available(): Promise<boolean>;
  /**
   * Answers a question in one thread, and remembers the exchange.
   *
   * `chatId` is the thread: a Telegram chat id, or "web" for the local page.
   * The two are deliberately separate threads — a question asked on the phone
   * and one asked at the desk are different situations.
   */
  ask(chatId: string, question: string, signal: AbortSignal): Promise<string>;
}

export interface GroqChatOptions {
  fetcher: Fetcher;
  model: string;
  systemPromptFile: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logger: Logger;
  apiKey: () => Promise<string | undefined>;
  clock: Clock;
  conversations: ConversationRepo;
  /** Assembles the analyses, statistics, brief and thread for this chat. */
  context: (chatId: string, signal: AbortSignal) => Promise<AskContext>;
}

/**
 * Questions on the same provider that writes the brief.
 *
 * Deliberately no output contract: a chat answer is prose, and demanding a
 * heading would reject every useful reply. The brief's shape check protects
 * the brief; a bad answer here costs you a re-ask.
 */
export function groqChat(opts: GroqChatOptions): ChatService {
  return {
    async available() {
      return Boolean(await opts.apiKey());
    },

    async ask(chatId, question, signal) {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error("GROQ_API_KEY is not set");

      const context = await opts.context(chatId, signal);

      // The disk read sits behind withTimeout's abort guard, not in front of
      // it: an already-aborted signal should fail immediately, without a
      // wasted read of jarvis.md.
      const answer = await withTimeout(signal, opts.timeoutMs, async (abortSignal) => {
        const system = await readFile(opts.systemPromptFile, "utf8");
        return groqComplete(opts.fetcher, {
          apiKey, model: opts.model, system,
          user: renderAskPrompt(context, question),
          maxTokens: opts.maxTokens, temperature: opts.temperature,
          signal: abortSignal,
        });
      });

      // Only now, and both turns together: a thrown call must leave the thread
      // exactly as it was.
      opts.conversations.appendExchange(chatId, question, answer, opts.clock.now());
      opts.logger.debug({ chatId, chars: answer.length, model: opts.model }, "groq chat complete");
      return answer;
    },
  };
}

export function unavailableChat(reason: string): ChatService {
  return {
    async available() { return false; },
    async ask() { throw new Error(reason); },
  };
}
