import { readFile } from "node:fs/promises";
import type { Synthesizer, BriefContext } from "./synthesizer.ts";
import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";
import { groqComplete } from "../../infra/groq.ts";
import { withTimeout } from "../../infra/abort.ts";
import { buildPrompt, assertContract } from "./prompt.ts";

export interface GroqSynthOptions {
  fetcher: Fetcher;
  /** A production model id — verified against GET /openai/v1/models. */
  model: string;
  /** Path to jarvis.md: the persona and the output contract. */
  systemPromptFile: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logger: Logger;
  /** Resolved lazily so the key can live in the Keychain, not the environment. */
  apiKey: () => Promise<string | undefined>;
}

/**
 * Synthesis on Groq's free tier.
 *
 * Two properties earned it the slot: its Services Agreement forbids training on
 * inputs unless explicitly permitted, and the models it serves are an order of
 * magnitude larger than anything that fits in this Mac's 16 GB. The cost is a
 * 6,000 token/minute ceiling, which is why the prompt carries pre-computed
 * facts rather than raw history.
 */
export function groqSynthesizer(opts: GroqSynthOptions): Synthesizer {
  return {
    name: "groq",

    async available() {
      // Free and instant: no key means the chain should skip straight to the
      // template rather than spend a round trip discovering it.
      return Boolean(await opts.apiKey());
    },

    async synthesize(ctx: BriefContext, signal: AbortSignal): Promise<string> {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error("GROQ_API_KEY is not set");

      // The disk read sits behind withTimeout's abort guard, not in front of
      // it: an already-aborted signal should fail immediately, without a
      // wasted read of jarvis.md. Still read per call rather than at
      // construction, so editing jarvis.md takes effect on the next brief.
      const markdown = await withTimeout(signal, opts.timeoutMs, async (abortSignal) => {
        const system = await readFile(opts.systemPromptFile, "utf8");
        return groqComplete(opts.fetcher, {
          apiKey,
          model: opts.model,
          system,
          user: buildPrompt(ctx),
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          signal: abortSignal,
        });
      });

      opts.logger.debug({ chars: markdown.length, model: opts.model }, "groq synthesis complete");
      return assertContract(markdown);
    },
  };
}
