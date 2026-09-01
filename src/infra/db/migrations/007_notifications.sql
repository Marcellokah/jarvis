-- What the assistant said on its own, and when.
--
-- This table holds the four-hour gate. A key-value store would have been
-- enough for the timestamp alone, and `module_cache` was the obvious candidate
-- -- but it has expiry semantics and the 04:00 sweep deletes its expired rows,
-- which would open the gate silently. A log cannot expire out from under the
-- thing that depends on it.
--
-- It also answers "which analyses arrived since I last spoke", and leaves a
-- record of what was actually sent, so a notification can be checked after the
-- fact rather than taken on trust.
CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at TEXT NOT NULL,
  kinds   TEXT NOT NULL,   -- JSON array
  keys    TEXT NOT NULL,   -- JSON array, the same keys given to SeenStore
  text    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_time ON notifications (sent_at DESC);
