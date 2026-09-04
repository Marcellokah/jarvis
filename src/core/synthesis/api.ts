import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Synthesizer, BriefContext } from "./synthesizer.ts";
import type { Logger } from "../../infra/logger.ts";
import { buildPrompt, assertContract } from "./prompt.ts";
import { estimateUsd } from "../../infra/anthropic.ts";

export interface ApiSynthesizerOptions {
  /** Path to jarvis.md — the persona and the output contract. */
  systemPromptFile: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  logger: Logger;
}

/**
 * The paid path. OFF BY DEFAULT, and `scripts/smoke.ts` asserts it stays off.
 *
 * Roughly $0.08/day at one brief — trivial, but not zero, and this project's
 * whole premise is $0. It exists so the option is one config line away if the
 * Claude Code subscription ever stops being the right answer.
 *
 * Enable deliberately:  SYNTHESIS_CHAIN=api,template  + ANTHROPIC_API_KEY
 */
export function apiSynthesizer(opts: ApiSynthesizerOptions): Synthesizer {
  let client: Anthropic | null = null;
  let systemPrompt: string | null = null;

  return {
    name: "api",

    async available() {
      if (!process.env.ANTHROPIC_API_KEY) {
        opts.logger.warn({}, "api synthesizer selected but ANTHROPIC_API_KEY is unset");
        return false;
      }
      return true;
    },

    async synthesize(ctx: BriefContext, signal: AbortSignal): Promise<string> {
      client ??= new Anthropic();
      systemPrompt ??= readFileSync(opts.systemPromptFile, "utf8");

      // Streaming: the SDK requires it for large max_tokens, and adaptive
      // thinking on a six-module brief can run past the HTTP timeout.
      const stream = client.messages.stream(
        {
          model: opts.model ?? "claude-opus-5",
          max_tokens: opts.maxTokens ?? 8_000,
          thinking: { type: "adaptive" },
          output_config: { effort: opts.effort ?? "medium" },
          // The persona is byte-stable across every call, so it caches; the
          // volatile module JSON goes after this breakpoint, in the user turn.
          system: [{
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral", ttl: "1h" },
          }],
          messages: [{ role: "user", content: buildPrompt(ctx) }],
        },
        { signal },
      );

      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        throw new Error(`model refused: ${message.stop_details?.explanation ?? "no explanation"}`);
      }

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      if (!text) throw new Error("api returned no text content");

      opts.logger.info(
        {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens,
          // Zero cache reads across repeated briefs means something in the
          // prefix is changing between calls.
          estimatedUsd: estimateUsd(message.usage),
        },
        "api synthesis complete (THIS COSTS MONEY)",
      );

      return assertContract(text);
    },
  };
}
