import { createHash } from "node:crypto";
import type { Db } from "../index.ts";

/**
 * Suppresses items already reported. Without this the brief re-announces the
 * same Hacker News story and the same three-week game sale every morning,
 * which is the fastest way to make a daily briefing worth ignoring.
 */
export interface SeenStore {
  /** Returns only the keys not seen before. Does not record them. */
  filterNew(module: string, keys: string[]): string[];
  /** Records keys as seen. Call after a brief is successfully delivered. */
  record(module: string, keys: string[], now: Date): void;
  /** Drops entries older than `days`, so a re-released item can resurface. */
  prune(olderThanDays: number, now: Date): number;
}

function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function createSeenStore(db: Db): SeenStore {
  return {
    filterNew(module, keys) {
      if (keys.length === 0) return [];
      const placeholders = keys.map(() => "?").join(",");
      const hashes = keys.map(hash);
      const found = new Set(
        db
          .all<{ item_hash: string }>(
            `SELECT item_hash FROM seen_items WHERE module = ? AND item_hash IN (${placeholders})`,
            module,
            ...hashes,
          )
          .map((r) => r.item_hash),
      );
      return keys.filter((_, i) => !found.has(hashes[i]!));
    },

    record(module, keys, now) {
      if (keys.length === 0) return;
      const ts = now.toISOString();
      db.transaction(() => {
        for (const key of keys) {
          db.run(
            `INSERT INTO seen_items (module, item_hash, first_seen_at)
             VALUES (?, ?, ?) ON CONFLICT (module, item_hash) DO NOTHING`,
            module,
            hash(key),
            ts,
          );
        }
      });
    },

    prune(olderThanDays, now) {
      const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString();
      const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM seen_items")?.n ?? 0;
      db.run("DELETE FROM seen_items WHERE first_seen_at < ?", cutoff);
      const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM seen_items")?.n ?? 0;
      return before - after;
    },
  };
}

/** For tests: nothing has ever been seen. */
export function nullSeenStore(): SeenStore {
  return { filterNew: (_m, keys) => keys, record: () => {}, prune: () => 0 };
}
