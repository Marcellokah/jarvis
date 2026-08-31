-- Recurring subscriptions. No bank API: PSD2 for Hungarian banks is neither
-- free nor worth the build, so this is the source of truth and you edit it.
CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  amount_huf    INTEGER NOT NULL,
  cycle         TEXT NOT NULL CHECK (cycle IN ('monthly', 'quarterly', 'annual')),
  -- Any past occurrence works; the module rolls it forward to the next one.
  next_renewal  TEXT NOT NULL,
  category      TEXT,
  cancel_url    TEXT,
  last_used_at  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT
);

-- Undo trail for anything Jarvis wrote to the calendar. Writing to iCloud is
-- the one irreversible thing this system does, so every event is recoverable.
CREATE TABLE IF NOT EXISTS calendar_writes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id   TEXT,
  event_uid   TEXT NOT NULL,
  calendar    TEXT NOT NULL,
  title       TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS calendar_writes_created_idx ON calendar_writes (created_at DESC);

-- Telegram follow-up context.
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_chat_idx ON conversations (chat_id, created_at DESC);
