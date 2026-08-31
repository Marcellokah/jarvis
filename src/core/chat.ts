import { readFile } from "node:fs/promises";
import type { Logger } from "../infra/logger.ts";
import type { Fetcher } from "../infra/http-client.ts";
import { groqComplete } from "../infra/groq.ts";
import { withTimeout } from "../infra/abort.ts";
import { runClaude, claudeAvailable, isAuthFailure, markAuthFailed, ISOLATION_ARGS } from "./synthesis/claude-cli.ts";

export interface ChatService {
  available(): Promise<boolean>;
  /** Answers a follow-up with today's brief as context. */
  ask(question: string, briefMarkdown: string, signal: AbortSignal): Promise<string>;
}

export interface ClaudeChatOptions {
  bin: string;
  model: string;
  systemPromptFile: string;
  timeoutMs: number;
  logger: Logger;
  /** Long-lived token from `claude setup-token`; see ClaudeCodeOptions. */
  token?: () => Promise<string | undefined>;
}

/**
 * Follow-up questions ("adj másik meal prep ötletet") on the same subscription
 * that writes the brief — no metered tokens.
 */
export function claudeChat(opts: ClaudeChatOptions): ChatService {
  return {
    async available() {
      return claudeAvailable(opts.bin, opts.logger, undefined, await opts.token?.());
    },

    async ask(question, briefMarkdown, signal) {
      const prompt = [
        "A mai briefing:",
        "",
        briefMarkdown,
        "",
        "---",
        "",
        "A felhasználó kérdése ehhez kapcsolódóan:",
        question,
        "",
        "Válaszolj tömören, magyarul, a persona szerint. Ha a kérdés nem a briefingről szól,",
        "attól még válaszolj — de ne találj ki tényeket a fenti adatokon túl.",
      ].join("\n");

      const token = await opts.token?.();

      try {
        return await runClaude({
          bin: opts.bin,
          args: [
            "-p", "--output-format", "json",
            "--model", opts.model,
            "--append-system-prompt-file", opts.systemPromptFile,
            ...ISOLATION_ARGS,
            "--tools", "",
            "--max-turns", "1",
          ],
          stdin: prompt,
          timeoutMs: opts.timeoutMs,
          signal,
          token,
        });
      } catch (err) {
        if (isAuthFailure(err)) markAuthFailed(opts.bin, token, opts.logger);
        throw err;
      }
    },
  };
}

export function unavailableChat(reason: string): ChatService {
  return {
    async available() { return false; },
    async ask() { throw new Error(reason); },
  };
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
}

/**
 * Follow-up questions on the same provider that writes the brief.
 *
 * Deliberately no output contract here: a chat answer is prose, and demanding
 * a '#' heading would reject every useful reply. The brief's shape check
 * protects the brief; a bad chat answer costs you a re-ask.
 */
export function groqChat(opts: GroqChatOptions): ChatService {
  return {
    async available() {
      return Boolean(await opts.apiKey());
    },

    async ask(question, briefMarkdown, signal) {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error("GROQ_API_KEY is not set");

      const system = await readFile(opts.systemPromptFile, "utf8");
      const user = [
        "A mai briefing:",
        "",
        briefMarkdown,
        "",
        "---",
        "",
        "A felhasználó kérdése ehhez kapcsolódóan:",
        question,
        "",
        "Válaszolj tömören, magyarul, a persona szerint. Ha a kérdés nem a briefingről szól,",
        "attól még válaszolj — de ne találj ki tényeket a fenti adatokon túl.",
      ].join("\n");

      const answer = await withTimeout(signal, opts.timeoutMs, (abortSignal) =>
        groqComplete(opts.fetcher, {
          apiKey, model: opts.model, system, user,
          maxTokens: opts.maxTokens, temperature: opts.temperature,
          signal: abortSignal,
        }),
      );
      opts.logger.debug({ chars: answer.length, model: opts.model }, "groq chat complete");
      return answer;
    },
  };
}
