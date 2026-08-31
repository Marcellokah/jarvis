import type { ModuleOutcome } from "../module.ts";
import type { Logger } from "../../infra/logger.ts";

export interface BriefContext {
  /** YYYY-MM-DD, Europe/Budapest. */
  date: string;
  /** '2026. augusztus 30., vasárnap' */
  dateLabel: string;
  /** HH:MM the brief was generated. */
  time: string;
  outcomes: ModuleOutcome[];
}

export interface Synthesizer {
  readonly name: string;
  /** Cheap check — is this path usable at all right now? */
  available(): Promise<boolean>;
  /** Returns markdown following the shared output contract. */
  synthesize(ctx: BriefContext, signal: AbortSignal): Promise<string>;
}

export interface SynthesisOutcome {
  markdown: string;
  synthesizer: string;
  /** Synthesizers that were tried and rejected, with the reason. */
  demoted: { name: string; reason: string }[];
}

/**
 * Walks the configured chain and uses the first synthesizer that is available
 * and succeeds. A failure is logged and demoted, never surfaced mid-brief.
 *
 * The last entry in the chain must be one that cannot fail — in practice
 * TemplateSynthesizer, which needs neither network nor subprocess.
 */
export async function synthesizeWithFallback(
  chain: readonly Synthesizer[],
  ctx: BriefContext,
  logger: Logger,
  signal: AbortSignal,
): Promise<SynthesisOutcome> {
  if (chain.length === 0) throw new Error("Synthesis chain is empty");
  const demoted: { name: string; reason: string }[] = [];

  for (const synth of chain) {
    try {
      if (!(await synth.available())) {
        demoted.push({ name: synth.name, reason: "not available" });
        logger.warn({ synthesizer: synth.name }, "synthesizer unavailable, trying next");
        continue;
      }
      const markdown = await synth.synthesize(ctx, signal);
      if (!markdown.trim()) throw new Error("produced empty output");
      return { markdown, synthesizer: synth.name, demoted };
    } catch (err) {
      const reason = String(err instanceof Error ? err.message : err);
      demoted.push({ name: synth.name, reason });
      logger.warn({ synthesizer: synth.name, err: reason }, "synthesizer failed, trying next");
    }
  }

  throw new Error(
    `Every synthesizer failed: ${demoted.map((d) => `${d.name} (${d.reason})`).join(", ")}`,
  );
}
