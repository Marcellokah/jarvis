/**
 * Detects whether another process already holds the Jarvis database open.
 *
 * Shared by `scripts/import-health.ts` and `scripts/analyze.ts` — both write
 * to `./data/jarvis.db`, and both can lose their writes to the same hazard:
 * the launchd agent (`local.jarvis.agent`, running `src/main.ts`) holds its
 * own long-lived connection to the same file. A write from a second process
 * commits, is even briefly visible to an outside reader, and then vanishes
 * once the agent's connection is eventually the one to close the database
 * and discard its WAL.
 *
 * `BEGIN EXCLUSIVE` on a throwaway connection was the first thing tried here,
 * on the theory that it would fail immediately against another holder. It
 * doesn't: in WAL mode a connection that is merely open but not mid-statement
 * — exactly the launchd agent's steady state between requests — holds no
 * lock at all, so EXCLUSIVE is granted anyway (verified directly: with the
 * agent running, `BEGIN EXCLUSIVE` from a fresh connection still succeeds).
 * The actual hazard is the connection's mere existence, not a lock it might
 * transiently hold, so the check has to be file-level rather than SQLite-
 * level. `lsof -t` lists the pids with the file open; nothing here opens the
 * database itself, so there is nothing to disturb.
 *
 * What each caller does with this information differs on purpose: an import
 * refuses to run, because seven years of health history is not
 * reconstructable. An analysis only warns, because its worst case is three
 * minutes of lost work. That difference in consequence lives in each script,
 * not here.
 */
import { execFileSync } from "node:child_process";

/**
 * The fix, with the caller's own retry command spliced into the middle line.
 * Both callers share the same bootout/bootstrap recipe; only the command
 * being retried differs between an import and an analysis run.
 */
export function agentFix(retryCommand: string): string {
  return "  launchctl bootout gui/$(id -u)/local.jarvis.agent\n"
    + `  ${retryCommand}\n`
    + "  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.jarvis.agent.plist\n";
}

/**
 * Which other processes, if any, currently have `dbPath` open.
 */
export function holdersOf(dbPath: string): string[] {
  try {
    return execFileSync("lsof", ["-t", dbPath], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // lsof exits 1 with no output when nobody holds the file — the same
    // path execFileSync takes if lsof itself is missing. Either way there is
    // nothing more to safely conclude here; failing open is deliberate: a
    // missing or unhappy `lsof` must not block a legitimate run, because for
    // the import the post-close verification is the actual guarantee, and
    // this is only the early, friendly warning ahead of it.
    return [];
  }
}
