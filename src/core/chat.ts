import type { Logger } from "../infra/logger.ts";
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
