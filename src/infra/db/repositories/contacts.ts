import type { Db } from "../index.ts";
import { isoDate } from "../../../shared/dates.ts";

export interface ContactRecord {
  /** ISO instant of the last successful /api/* call. */
  at: string;
  route: string;
  status: number;
}

export interface ContactRepo {
  record(at: Date, route: string, status: number): void;
  last(): ContactRecord | undefined;
  /** True when nothing called /api/* on the local day containing `day`. */
  missingOn(day: Date, tz: string): boolean;
}

/**
 * Records that something authenticated actually reached the HTTP API.
 *
 * Only /api/* counts, and only a successful response: an unauthorized probe is
 * not your phone. Telegram never passes through here, so `/brief` in the chat
 * does not mask a Shortcut that has stopped running.
 */
export function createContactRepo(db: Db): ContactRepo {
  return {
    record(at: Date, route: string, status: number): void {
      db.run(
        `INSERT INTO client_contact (id, last_at, last_route, last_status)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           last_at = excluded.last_at,
           last_route = excluded.last_route,
           last_status = excluded.last_status`,
        at.toISOString(), route, status,
      );
    },

    last(): ContactRecord | undefined {
      const row = db.get<{ last_at: string; last_route: string; last_status: number }>(
        "SELECT last_at, last_route, last_status FROM client_contact WHERE id = 1",
      );
      return row ? { at: row.last_at, route: row.last_route, status: row.last_status } : undefined;
    },

    missingOn(day: Date, tz: string): boolean {
      const row = db.get<{ last_at: string }>(
        "SELECT last_at FROM client_contact WHERE id = 1",
      );
      if (!row) return true;
      // Compared as local calendar days: just past midnight in Budapest is
      // still the previous day in UTC, and a UTC comparison would alert on a
      // phone that did check in.
      return isoDate(new Date(row.last_at), tz) !== isoDate(day, tz);
    },
  };
}
