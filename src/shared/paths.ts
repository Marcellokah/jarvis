import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolved from this file's own location, not from cwd.
 *
 * launchd starts agents with an unpredictable working directory, so anything
 * cwd-relative — the database, jarvis.md, the YAML configs — silently resolves
 * somewhere else and the brief comes back empty.
 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolves a configured path against the project root unless it is absolute. */
export function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}
