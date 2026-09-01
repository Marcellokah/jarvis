/**
 * Detects whether another process already holds the Jarvis database open.
 *
 * Shared by `scripts/import-health.ts` and `scripts/analyze.ts`. Both write to
 * `./data/jarvis.db` while the launchd agent (`local.jarvis.agent`, running
 * `src/main.ts`) may hold its own long-lived connection to the same file.
 *
 * What is actually known, stated carefully because an earlier version of this
 * comment stated more than was ever established:
 *
 *  - Imported values have been observed to go missing, three times, when an
 *    import ran while the agent was up. That happened, and it cost data.
 *  - The cause was never established. This file used to assert one — that the
 *    agent's connection discards a second process's WAL on close — and that
 *    assertion does not hold: during this branch's verification the agent was
 *    up throughout while separate processes applied a migration and wrote six
 *    rows, and all of it persisted. A committed WAL frame is shared state; the
 *    last connection to close checkpoints it rather than throwing it away.
 *  - The likeliest explanation found since is a different, verified defect: an
 *    unconditional upsert that let a phone POST overwrite imported columns
 *    with blanks — which can only fire while the agent is running, and so fits
 *    the "only when the agent is up" shape that the WAL story was invented to
 *    explain. That is a hypothesis about the losses, not a proven cause.
 *
 * So this check is a heuristic, not a proof. The real guarantee is the
 * import's post-close verification: a fresh connection, opened after the
 * writing one has closed, counting what is actually on disk. This function
 * only moves the complaint earlier, before a minute of reading a 1 GB export.
 *
 * `BEGIN EXCLUSIVE` on a throwaway connection was tried first, on the theory
 * that it would fail against another holder. It doesn't: in WAL mode a
 * connection that is merely open but not mid-statement — the agent's steady
 * state between requests — holds no lock, so EXCLUSIVE is granted anyway
 * (verified directly). Whatever the hazard is, it is not a lock, so the check
 * is file-level instead. `lsof -t` lists the pids with the file open; nothing
 * here opens the database itself, so there is nothing to disturb.
 *
 * What each caller does with this information differs on purpose: an import
 * refuses to run, because seven years of health history is not
 * reconstructable and the observed losses were real whatever caused them. An
 * analysis only warns, because its worst case is three minutes of lost work.
 * That difference in consequence lives in each script, not here.
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
    // lsof exits 1 with no output when nobody holds the file — the same path
    // execFileSync takes if lsof itself is missing. Either way there is
    // nothing more to safely conclude here; failing open is deliberate: a
    // missing or unhappy `lsof` must not block a legitimate run, because for
    // the import the post-close verification is the actual guarantee and this
    // is only the early warning ahead of it.
    return [];
  }
}
