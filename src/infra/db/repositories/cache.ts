import type { Db } from "../index.ts";
import type { Logger } from "../../logger.ts";

/**
 * Per-module response cache, so a brief generation and an on-demand `/dev`
 * moments later share one fetch — and so a brief rebuilt after a health
 * snapshot arrives does not re-hit every upstream API.
 */
export interface ModuleCache {
  /** Returns the cached value, or computes and stores it. */
  through<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T>;
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  prune(now: Date): number;
}

export function createModuleCache(
  db: Db, module: string, now: () => Date, logger: Logger,
): ModuleCache {
  const cache: ModuleCache = {
    get<T>(key: string): T | undefined {
      const row = db.get<{ payload_json: string; expires_at: string }>(
        "SELECT payload_json, expires_at FROM module_cache WHERE module = ? AND key = ?",
        module, key,
      );
      if (!row) return undefined;
      if (Date.parse(row.expires_at) <= now().getTime()) return undefined;
      try {
        return JSON.parse(row.payload_json) as T;
      } catch {
        return undefined;
      }
    },

    set<T>(key: string, value: T, ttlMs: number): void {
      const at = now();
      db.run(
        `INSERT INTO module_cache (module, key, payload_json, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (module, key) DO UPDATE SET
           payload_json = excluded.payload_json,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at`,
        module, key, JSON.stringify(value), at.toISOString(),
        new Date(at.getTime() + ttlMs).toISOString(),
      );
    },

    async through<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
      const hit = cache.get<T>(key);
      if (hit !== undefined) return hit;

      try {
        const value = await compute();
        cache.set(key, value, ttlMs);
        return value;
      } catch (err) {
        // A stale answer beats no answer: serve the expired entry if we have
        // one, so one flaky upstream does not blank a whole section.
        const stale = db.get<{ payload_json: string }>(
          "SELECT payload_json FROM module_cache WHERE module = ? AND key = ?", module, key,
        );
        if (stale) {
          logger.warn({ module, key, err: String(err) }, "fetch failed; serving stale cache");
          return JSON.parse(stale.payload_json) as T;
        }
        throw err;
      }
    },

    prune(at: Date): number {
      const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM module_cache")?.n ?? 0;
      db.run("DELETE FROM module_cache WHERE expires_at < ?", at.toISOString());
      const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM module_cache")?.n ?? 0;
      return before - after;
    },
  };

  return cache;
}
