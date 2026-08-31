import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Secrets are never stored in files. They come from the environment, or from
 * the macOS Keychain when running on this Mac.
 */
export interface SecretResolver {
  get(key: string): Promise<string | undefined>;
  require(key: string): Promise<string>;
}

function withRequire(get: (key: string) => Promise<string | undefined>): SecretResolver {
  return {
    get,
    async require(key) {
      const value = await get(key);
      if (!value) throw new Error(`Missing secret: ${key}`);
      return value;
    },
  };
}

export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return withRequire(async (key) => env[key] || undefined);
}

/**
 * Reads from the login keychain: `security find-generic-password -s jarvis -a <key> -w`.
 * Falls through to the environment so a single .env still works in development.
 */
export function keychainSecrets(service = "jarvis", env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return withRequire(async (key) => {
    if (env[key]) return env[key];
    try {
      const { stdout } = await exec("/usr/bin/security", [
        "find-generic-password", "-s", service, "-a", key, "-w",
      ]);
      return stdout.trim() || undefined;
    } catch {
      // Not in the keychain is a normal outcome, not an error.
      return undefined;
    }
  });
}

/** For tests. */
export function staticSecrets(values: Record<string, string>): SecretResolver {
  return withRequire(async (key) => values[key]);
}
