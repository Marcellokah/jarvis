import { z } from "zod";
import { homedir } from "node:os";
import type { SecretResolver } from "./infra/secrets.ts";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  JARVIS_HOST: z.string().default("127.0.0.1"),
  JARVIS_PORT: z.coerce.number().int().positive().default(8787),
  JARVIS_DB: z.string().default("./data/jarvis.db"),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === undefined ? undefined : v !== "false"),

  /** Overrides config.synthesis.chain. Comma-separated, e.g. "claude-code,template". */
  SYNTHESIS_CHAIN: z.string().optional(),
  /**
   * Where `claude setup-token` installs the CLI. Derived from the running
   * user's home rather than hardcoded: a literal path bakes one developer's
   * username into the repository and breaks every other machine.
   */
  CLAUDE_BIN: z.string().default(`${homedir()}/.local/bin/claude`),
  /** From `claude setup-token`. Env or Keychain; needed for headless runs. */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),

  /** iCloud CalDAV. An app-specific password from appleid.apple.com — never your Apple ID password. */
  ICLOUD_USERNAME: z.string().optional(),
  ICLOUD_APP_PASSWORD: z.string().optional(),

  /** Telegram. Bot token from @BotFather; the chat id restricts who may talk to it. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_CHAT_ID: z.string().optional(),
});

export type Env = z.infer<typeof schema> & { LOG_PRETTY: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}\n\nSee .env.example`);
  }
  const env = parsed.data;
  return { ...env, LOG_PRETTY: env.LOG_PRETTY ?? env.NODE_ENV !== "production" };
}

export const API_TOKEN_VAR = "JARVIS_TOKEN";

/** Short enough to brute-force is the same as absent. `openssl rand -hex 32` gives 64. */
const MIN_TOKEN_LENGTH = 16;

/**
 * The bearer token for /api/*, resolved through the secret resolver rather than
 * `loadEnv`.
 *
 * Every other secret already lives in the login Keychain; this one guards the
 * endpoint that `tailscale serve` publishes to the tailnet, so a plaintext
 * `.env` entry was the weakest link in the set. `keychainSecrets` still reads
 * the environment first, so a `.env` value and the test fixtures keep working.
 */
export async function requireApiToken(secrets: SecretResolver): Promise<string> {
  const token = await secrets.get(API_TOKEN_VAR);

  if (!token) {
    throw new Error(
      `Missing ${API_TOKEN_VAR} — the bearer token that guards /api/*.\n`
      + `  Generate and store one:\n`
      + `    ./scripts/set-secret.sh ${API_TOKEN_VAR}   # openssl rand -hex 32`,
    );
  }

  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `${API_TOKEN_VAR} is ${token.length} characters — at least ${MIN_TOKEN_LENGTH} required.`,
    );
  }

  return token;
}
