import { hostname } from "node:os";
import type { Db } from "./db/index.ts";
import type { Logger } from "./logger.ts";

export interface InstanceLock {
  release(): void;
}

const STALE_AFTER_MS = 90_000;
const HEARTBEAT_MS = 30_000;

/**
 * Only one process may long-poll Telegram; a second one makes the Bot API
 * return HTTP 409 and both instances start missing messages.
 *
 * The lock is heartbeated rather than held, so a crashed process (which never
 * runs its release) does not lock the next start-up out forever.
 */
export function acquireInstanceLock(db: Db, logger: Logger, now: Date): InstanceLock | null {
  const existing = db.get<{ pid: number; hostname: string; heartbeat_at: string }>(
    "SELECT pid, hostname, heartbeat_at FROM instance_lock WHERE id = 1",
  );

  if (existing) {
    const age = now.getTime() - Date.parse(existing.heartbeat_at);
    const sameHost = existing.hostname === hostname();

    if (age < STALE_AFTER_MS && !(sameHost && !isAlive(existing.pid))) {
      logger.error(
        { holder: `${existing.hostname}:${existing.pid}`, ageMs: age },
        "another Jarvis instance holds the lock",
      );
      return null;
    }
    logger.warn(
      { holder: `${existing.hostname}:${existing.pid}`, ageMs: age },
      "taking over a stale instance lock",
    );
  }

  const stamp = now.toISOString();
  db.run(
    `INSERT INTO instance_lock (id, pid, hostname, acquired_at, heartbeat_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       pid = excluded.pid, hostname = excluded.hostname,
       acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`,
    process.pid, hostname(), stamp, stamp,
  );

  const timer = setInterval(() => {
    try {
      db.run("UPDATE instance_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?",
        new Date().toISOString(), process.pid);
    } catch (err) {
      logger.warn({ err: String(err) }, "instance lock heartbeat failed");
    }
  }, HEARTBEAT_MS);
  timer.unref();

  return {
    release() {
      clearInterval(timer);
      try {
        db.run("DELETE FROM instance_lock WHERE id = 1 AND pid = ?", process.pid);
      } catch {
        // Shutting down; a stale row will be reclaimed on the next start.
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without signalling.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
