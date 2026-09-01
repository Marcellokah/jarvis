import type { Db } from "../index.ts";

export interface SentNotification {
  id: number;
  sentAt: string;
  kinds: string[];
  keys: string[];
  text: string;
}

export interface NotificationRepo {
  /** ISO instant of the most recent send, or null if nothing was ever sent. */
  lastSentAt(): string | null;
  record(entry: { sentAt: Date; kinds: readonly string[]; keys: readonly string[]; text: string }): void;
  /** Newest first. */
  recent(n: number): SentNotification[];
}

interface Row {
  id: number; sent_at: string; kinds: string; keys: string; text: string;
}

const toSent = (r: Row): SentNotification => ({
  id: r.id, sentAt: r.sent_at, text: r.text,
  kinds: JSON.parse(r.kinds) as string[],
  keys: JSON.parse(r.keys) as string[],
});

export function createNotificationRepo(db: Db): NotificationRepo {
  return {
    lastSentAt() {
      return db.get<{ sent_at: string }>(
        "SELECT sent_at FROM notifications ORDER BY sent_at DESC, id DESC LIMIT 1",
      )?.sent_at ?? null;
    },

    record(entry) {
      db.run(
        "INSERT INTO notifications (sent_at, kinds, keys, text) VALUES (?, ?, ?, ?)",
        entry.sentAt.toISOString(),
        JSON.stringify([...entry.kinds]),
        JSON.stringify([...entry.keys]),
        entry.text,
      );
    },

    recent(n) {
      return db.all<Row>(
        "SELECT * FROM notifications ORDER BY sent_at DESC, id DESC LIMIT ?", n,
      ).map(toSent);
    },
  };
}
