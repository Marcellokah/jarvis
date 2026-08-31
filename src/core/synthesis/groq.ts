import { readFile } from "node:fs/promises";
import type { Synthesizer, BriefContext } from "./synthesizer.ts";
import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";
import { groqComplete } from "../../infra/groq.ts";
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

      // Read per call rather than at construction: editing jarvis.md should
      // take effect on the next brief, not the next restart.
      const system = await readFile(opts.systemPromptFile, "utf8");

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

      try {
        const markdown = await groqComplete(opts.fetcher, {
          apiKey,
          model: opts.model,
          system,
          user: buildPrompt(ctx),
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          signal: controller.signal,
        });

        opts.logger.debug({ chars: markdown.length, model: opts.model }, "groq synthesis complete");
        return assertContract(markdown);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
