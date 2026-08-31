import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Logger } from "../../infra/logger.ts";

interface ClaudeJson {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  duration_ms?: number;
}

interface AuthStatus { loggedIn?: boolean; authMethod?: string }

const authCache = new Map<string, { at: number; ok: boolean }>();
const AUTH_TTL_MS = 60_000;

/**
 * The long-lived token from `claude setup-token`, which is how a launchd agent
 * authenticates — there is no on-disk CLI profile to inherit.
 */
export const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Runs the CLI as a tool, not as the user's assistant.
 *
 * `claude -p` otherwise inherits the logged-in user's whole Claude Code setup:
 * installed plugins, the MCP servers they bring, and hooks. `--allowedTools`
 * and `--tools` govern only the *built-in* set, so those MCP tools stay in the
 * model's schema regardless — the model can call one, the call is denied for
 * want of a permission grant, the denial costs a turn, and with `--max-turns 1`
 * the run ends as `error_max_turns` carrying no text at all. Raising the turn
 * limit does not help; it only buys more denied attempts.
 *
 * Observed in production: a `claude-mem` plugin put 14 MCP tools into a brief
 * synthesis, the model reached for one, and the morning's prose silently
 * degraded to the template renderer. Isolation also roughly halves the run
 * time, since none of that is loaded.
 *
 * Pair with `--tools`, which the caller sets: "" for none, or a comma list.
 */
export const ISOLATION_ARGS: readonly string[] = [
  // Only MCP servers from --mcp-config, which we never pass. So: none.
  "--strict-mcp-config",
  // Load no user/project/local settings — no plugins, no hooks.
  "--setting-sources", "",
];

/** Environment for a spawned CLI, with the token injected when we hold one. */
function childEnv(token?: string): NodeJS.ProcessEnv {
  return token ? { ...process.env, [OAUTH_TOKEN_VAR]: token } : process.env;
}

/**
 * Cheap, cost-free login probe. Worth doing before every run: otherwise a
 * logged-out CLI burns 2-5 seconds spawning a doomed subprocess first.
 *
 * Note this is a liveness check, not a validity one — `auth status` reports
 * `loggedIn: true` for any non-empty token, valid or revoked. A stale token
 * therefore passes here and fails during synthesis, which the fallback chain
 * handles by demoting to the template renderer.
 */
export async function claudeAvailable(
  bin: string, logger: Logger, ttlMs = AUTH_TTL_MS, token?: string,
): Promise<boolean> {
  if (!existsSync(bin)) {
    logger.warn({ bin }, "claude CLI not found");
    return false;
  }
  // Key on the token too: adding one must invalidate a "logged out" verdict.
  const cacheKey = `${bin}:${token ? "tok" : "none"}`;
  const cached = authCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlMs) return cached.ok;

  let ok = false;
  try {
    const raw = await exec(bin, ["auth", "status", "--json"], null, 10_000, undefined, childEnv(token));
    const status = JSON.parse(raw.stdout) as AuthStatus;
    ok = status.loggedIn === true;
    if (!ok) {
      logger.warn(
        { authMethod: status.authMethod },
        `claude CLI is not logged in — run \`claude setup-token\` and store the result as ${OAUTH_TOKEN_VAR}`,
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "could not determine claude CLI auth status");
  }

  authCache.set(cacheKey, { at: Date.now(), ok });
  return ok;
}

/** Clears the cached probe. Used by tests and after a re-login. */
export function resetAuthCache(): void {
  authCache.clear();
}

/**
 * Records that the CLI rejected our credentials, so `available()` stops
 * recommending it until the cache expires.
 *
 * `auth status` cannot tell us this: it reports `loggedIn: true` for any
 * non-empty token, valid or revoked. Without this, a stale token costs a
 * multi-second doomed subprocess on every brief — and on every Telegram
 * message, which is where it actually hurts.
 */
export function markAuthFailed(bin: string, token: string | undefined, logger: Logger): void {
  authCache.set(`${bin}:${token ? "tok" : "none"}`, { at: Date.now(), ok: false });
  logger.warn(
    {},
    `claude CLI rejected the credentials — regenerate with \`claude setup-token\` and re-store ${OAUTH_TOKEN_VAR}`,
  );
}

/** A 401 from the CLI, as opposed to a transient failure. */
export function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /401|authenticate|oauth access token|invalid api key|not logged in/i.test(message);
}

export interface RunClaudeOptions {
  bin: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Long-lived OAuth token, injected into the child's environment. */
  token?: string;
}

/**
 * Runs `claude -p` and returns its text result.
 *
 * The CLI exits 0 even when it fails — "Not logged in" arrives as exit 0 with
 * `is_error: true` and the message in `result`. Trusting the exit code would
 * publish that string as your morning brief.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<string> {
  const { stdout, code } = await exec(
    opts.bin, opts.args, opts.stdin, opts.timeoutMs, opts.signal, childEnv(opts.token),
  );

  let parsed: ClaudeJson;
  try {
    parsed = JSON.parse(stdout) as ClaudeJson;
  } catch {
    throw new Error(`unparseable CLI output (exit ${code}): ${stdout.slice(0, 200)}`);
  }

  if (parsed.is_error) {
    throw new Error(`CLI reported an error: ${parsed.result ?? parsed.subtype ?? "unknown"}`);
  }
  const text = (parsed.result ?? "").trim();
  if (!text) throw new Error("CLI returned an empty result");
  return text;
}

interface ExecResult { stdout: string; stderr: string; code: number | null }

/** Spawns with a hard deadline; a wedged child is killed, not waited on. */
function exec(
  bin: string, args: string[], stdin: string | null, timeoutMs: number,
  signal?: AbortSignal, env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // Check before spawning: the caller may already have aborted while we were
    // resolving credentials, and attaching a listener afterwards would miss it.
    if (signal?.aborted) {
      reject(new Error("claude CLI aborted"));
      return;
    }

    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const kill = (reason: string) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), 2_000);
      hard.unref?.();
      reject(new Error(reason));
    };

    const timer = setTimeout(() => kill(`claude CLI timed out after ${timeoutMs} ms`), timeoutMs);
    const onAbort = () => kill("claude CLI aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });

    child.on("error", (err) => { cleanup(); if (!settled) { settled = true; reject(err); } });
    child.on("close", (code) => { cleanup(); if (!settled) { settled = true; resolve({ stdout, stderr, code }); } });

    child.stdin.on("error", () => { /* the child may exit before we finish writing */ });
    child.stdin.end(stdin ?? "");
  });
}
