import type { Fetcher } from "../../infra/http-client.ts";
import type { Logger } from "../../infra/logger.ts";
import type { Metrics } from "./aggregate.ts";
import type { Relation } from "./relations.ts";
import type { AnalysisRepo, Domain } from "../../infra/db/repositories/analyses.ts";
import { GROQ_KEY_VAR, groqComplete } from "../../infra/groq.ts";
import { withTimeout } from "../../infra/abort.ts";
import { buildDomainPrompt, buildSynthesisPrompt, extractSummary } from "./prompts.ts";

const DOMAINS = ["physical", "recovery", "finance"] as const;

export interface AnalystOptions {
  fetcher: Fetcher;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Wait between calls; two in one minute would breach the token ceiling. */
  paceMs: number;
  memoryDepth: number;
  minCorrelationN: number;
  /** Resolved lazily so the key can live in the Keychain, not the environment. */
  apiKey: () => Promise<string | undefined>;
  analyses: AnalysisRepo;
  logger: Logger;
  clock: { now(): Date };
  /** Injected so tests do not spend three real minutes waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DomainOutcome {
  domain: Domain;
  markdown: string | null;
  summary: string | null;
  error: string | null;
}

export interface AnalysisRun {
  outcomes: DomainOutcome[];
  relations: readonly Relation[];
  metrics: Metrics;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The staged analysis: one call per domain, then one that looks across them.
 *
 * Sequential rather than parallel, and paced, because the free tier allows
 * 6,000 tokens a minute and each call wants roughly 3,700. Running them
 * together would earn a 429 and produce nothing at all; running them apart
 * lets each domain have the whole budget to itself.
 *
 * Each domain stands or falls alone. A failed pass costs its own findings and
 * nothing else, and the reason is carried out rather than swallowed.
 */
export async function runAnalysis(
  metrics: Metrics,
  relations: readonly Relation[],
  opts: AnalystOptions,
  signal: AbortSignal,
): Promise<AnalysisRun> {
  const pause = opts.sleep ?? wait;
  const outcomes: DomainOutcome[] = [];
  let calls = 0;

  const ask = async (domain: Domain, system: string, user: string): Promise<DomainOutcome> => {
    try {
      const apiKey = await opts.apiKey();
      if (!apiKey) throw new Error(`${GROQ_KEY_VAR} is not set`);

      // The gap goes before the call and never before the first one, so a
      // single-domain run is not punished for the ceiling it cannot reach.
      if (calls > 0) await pause(opts.paceMs);
      calls++;

      const markdown = await withTimeout(signal, opts.timeoutMs, (abortSignal) =>
        groqComplete(opts.fetcher, {
          apiKey, model: opts.model, system, user,
          maxTokens: opts.maxTokens, temperature: opts.temperature, signal: abortSignal,
        }));

      const summary = extractSummary(markdown);
      opts.analyses.save({
        createdAt: opts.clock.now().toISOString(),
        domain,
        markdown,
        summary,
        metrics: JSON.stringify(
          domain === "synthesis" ? { relations } : metrics[domain as Exclude<Domain, "synthesis">],
        ),
      });
      opts.logger.info({ domain, chars: markdown.length }, "analysis domain complete");
      return { domain, markdown, summary, error: null };
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      opts.logger.warn({ domain, err: error }, "analysis domain failed");
      return { domain, markdown: null, summary: null, error };
    }
  };

  for (const domain of DOMAINS) {
    const { system, user } = buildDomainPrompt(
      domain,
      metrics,
      opts.analyses.recent(domain, opts.memoryDepth).map((r) => r.summary),
    );
    outcomes.push(await ask(domain, system, user));
  }

  const succeeded = outcomes.filter((o) => o.summary !== null);
  if (succeeded.length >= 2) {
    const { system, user } = buildSynthesisPrompt(
      succeeded.map((o) => ({ domain: o.domain, summary: o.summary! })),
      relations,
    );
    outcomes.push(await ask("synthesis", system, user));
  } else {
    // One surviving domain has nothing to be related to; the call would spend
    // tokens restating what we already have.
    opts.logger.warn({ succeeded: succeeded.length }, "skipping synthesis");
  }

  return { outcomes, relations, metrics };
}
