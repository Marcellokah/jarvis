import type { Synthesizer, BriefContext } from "./synthesizer.ts";
import type { Logger } from "../../infra/logger.ts";
import { claudeAvailable, isAuthFailure, markAuthFailed, runClaude, ISOLATION_ARGS } from "./claude-cli.ts";
import { buildPrompt, assertContract } from "./prompt.ts";

export interface ClaudeCodeOptions {
  bin: string;
  /** 'sonnet' | 'opus' | 'haiku', or a full model id. */
  model: string;
  /** Path to jarvis.md — the persona and the output contract. */
  systemPromptFile: string;
  /** Let the CLI use its own WebSearch to fill gaps in the feed data. */
  webGapFill: boolean;
  timeoutMs: number;
  logger: Logger;
  /** Auth state does not change mid-morning; don't re-probe on every call. */
  authCacheMs?: number;
  /**
   * Long-lived token from `claude setup-token`. Resolved lazily so it can live
   * in the macOS Keychain rather than the process environment — a launchd agent
   * inherits neither a shell profile nor an on-disk CLI login.
   */
  token?: () => Promise<string | undefined>;
}

/**
 * Synthesis at zero marginal cost, through the Claude Code subscription that
 * is already paid for. No API key, no metered tokens.
 *
 * The CLI's two non-obvious behaviours — exit 0 on failure, and a free
 * `auth status --json` probe — are handled in `claude-cli.ts`, which is the
 * single place that knows how this binary actually behaves.
 */
export function claudeCodeSynthesizer(opts: ClaudeCodeOptions): Synthesizer {
  return {
    name: "claude-code",

    async available() {
      return claudeAvailable(opts.bin, opts.logger, opts.authCacheMs, await opts.token?.());
    },

    async synthesize(ctx: BriefContext, signal: AbortSignal): Promise<string> {
      const args = [
        "-p",
        "--output-format", "json",
        "--model", opts.model,
        "--append-system-prompt-file", opts.systemPromptFile,
        ...ISOLATION_ARGS,
      ];

      // `--tools` decides what exists; `--allowedTools` only decides what is
      // permitted. Writing prose from a JSON payload needs nothing at all, and
      // a tool the model cannot reach is one it cannot waste its turn on.
      if (opts.webGapFill) {
        args.push(
          "--tools", "WebSearch,WebFetch",
          "--allowedTools", "WebSearch,WebFetch",
          "--max-turns", "4",
        );
      } else {
        args.push("--tools", "", "--max-turns", "1");
      }

      const token = await opts.token?.();

      let markdown: string;
      try {
        markdown = await runClaude({
          bin: opts.bin,
          args,
          stdin: buildPrompt(ctx),
          timeoutMs: opts.timeoutMs,
          signal,
          token,
        });
      } catch (err) {
        // Bad credentials are not transient; stop paying for the round trip.
        if (isAuthFailure(err)) markAuthFailed(opts.bin, token, opts.logger);
        throw err;
      }

      opts.logger.debug({ chars: markdown.length }, "claude-code synthesis complete");
      return assertContract(markdown);
    },
  };
}
