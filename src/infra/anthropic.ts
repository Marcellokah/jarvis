import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "./logger.ts";
import type { InvestigatorModel, Step } from "../core/agent/loop.ts";
import type { TranscriptEntry } from "./db/repositories/investigations.ts";
import { buildSystemPrompt, buildUserTurn, parseStep } from "../core/agent/prompt.ts";

/** The Anthropic API key, from the login Keychain. */
export const ANTHROPIC_KEY_VAR = "ANTHROPIC_API_KEY";

/** Claude Opus 5 list pricing. Logged per step so the metered path is never invisible. */
export function estimateUsd(usage: Anthropic.Usage): number {
  const input = (usage.input_tokens ?? 0) / 1e6 * 5;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) / 1e6 * 6.25;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) / 1e6 * 0.5;
  const output = (usage.output_tokens ?? 0) / 1e6 * 25;
  return Number((input + cacheWrite + cacheRead + output).toFixed(4));
}

export interface AnthropicInvestigatorOptions {
  apiKey: string;
  today: string;
  logger: Logger;
  model?: string;
  /** Hard ceiling for one investigation. Reaching it aborts the run. */
  maxUsd: number;
}

export interface AnthropicInvestigator extends InvestigatorModel {
  /** What this investigation has cost so far. */
  spentUsd(): number;
}

/**
 * The measured brain.
 *
 * The local-model evaluation showed the loop's navigation is easy and its
 * closing judgement is not: a 9B model produced a fluent, well-cited, wrong
 * causal claim. This is the part that was bought, and nothing else.
 */
export function anthropicInvestigator(opts: AnthropicInvestigatorOptions): AnthropicInvestigator {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const system = buildSystemPrompt(opts.today);
  let spent = 0;

  return {
    spentUsd: () => Number(spent.toFixed(4)),

    async nextStep(goal: string, transcript: readonly TranscriptEntry[], signal: AbortSignal): Promise<Step> {
      if (spent >= opts.maxUsd) {
        throw new Error(`elérte a nyomozásonkénti költségplafont ($${opts.maxUsd})`);
      }

      const stream = client.messages.stream({
        model: opts.model ?? "claude-opus-5",
        max_tokens: 4_000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                lepes: { type: "string" },
                parameterek: { type: "object" },
                miert: { type: "string" },
              },
              required: ["lepes", "parameterek", "miert"],
              additionalProperties: false,
            },
          },
        },
        // The menu and the rules never change within a run, so they sit
        // behind the breakpoint and the growing transcript sits after it.
        // The loop is append-only, which is the best case for a prefix cache.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: buildUserTurn(goal, transcript) }],
      }, { signal });

      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        throw new Error(`a modell elutasította: ${message.stop_details?.explanation ?? "nincs indoklás"}`);
      }

      const cost = estimateUsd(message.usage);
      spent += cost;
      opts.logger.info(
        {
          usd: cost, spentUsd: Number(spent.toFixed(4)),
          cacheRead: message.usage.cache_read_input_tokens,
        },
        "investigation step (THIS COSTS MONEY)",
      );

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text).join("").trim();

      return parseStep(text);
    },
  };
}
