import type { Db } from "../index.ts";

export interface CalendarWrite {
  id: number;
  actionId: string | null;
  eventUid: string;
  calendar: string;
  title: string;
  startsAt: string;
  createdAt: string;
  deletedAt: string | null;
}

/**
 * The undo trail. Writing to iCloud is the one irreversible thing this system
 * does, so every event Jarvis creates is recorded and can be found again.
 */
export interface CalendarWriteRepo {
  record(w: Omit<CalendarWrite, "id" | "deletedAt">): void;
  recent(limit: number): CalendarWrite[];
  findByUid(uid: string): CalendarWrite | undefined;
  markDeleted(uid: string, at: Date): void;
}

interface Row {
  id: number; action_id: string | null; event_uid: string; calendar: string;
  title: string; starts_at: string; created_at: string; deleted_at: string | null;
}

const toWrite = (r: Row): CalendarWrite => ({
  id: r.id, actionId: r.action_id, eventUid: r.event_uid, calendar: r.calendar,
  title: r.title, startsAt: r.starts_at, createdAt: r.created_at, deletedAt: r.deleted_at,
});

export function createCalendarWriteRepo(db: Db): CalendarWriteRepo {
  return {
    record(w) {
      db.run(
        `INSERT INTO calendar_writes (action_id, event_uid, calendar, title, starts_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        w.actionId, w.eventUid, w.calendar, w.title, w.startsAt, w.createdAt,
      );
    },
    recent(limit) {
      return db
        .all<Row>("SELECT * FROM calendar_writes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?", limit)
        .map(toWrite);
    },
    findByUid(uid) {
      const row = db.get<Row>("SELECT * FROM calendar_writes WHERE event_uid = ?", uid);
      return row ? toWrite(row) : undefined;
    },
    markDeleted(uid, at) {
      db.run("UPDATE calendar_writes SET deleted_at = ? WHERE event_uid = ?", at.toISOString(), uid);
    },
  };
}
