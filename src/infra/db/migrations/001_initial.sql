-- Health data pushed by the iOS Shortcut before it requests the brief.
CREATE TABLE IF NOT EXISTS health_snapshots (
  date          TEXT PRIMARY KEY,          -- YYYY-MM-DD, Europe/Budapest
  sleep_h       REAL,
  hrv           REAL,
  rhr           REAL,
  move_kcal     REAL,
  exercise_min  REAL,
  steps         INTEGER,
  raw_json      TEXT,
  ingested_at   TEXT NOT NULL
);

-- Every generated brief, so a failed regeneration can fall back to the last good one.
CREATE TABLE IF NOT EXISTS briefs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  synthesizer   TEXT NOT NULL,
  markdown      TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS briefs_date_idx ON briefs (date, generated_at DESC);

-- Per-module response cache, so a pre-warm and an on-demand run share fetches.
CREATE TABLE IF NOT EXISTS module_cache (
  module      TEXT NOT NULL,
  key         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (module, key)
);

-- "Did we already report this?" — stops a three-week sale being announced daily.
CREATE TABLE IF NOT EXISTS seen_items (
  module        TEXT NOT NULL,
  item_hash     TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (module, item_hash)
);

-- Checkboxes and calendar proposals surfaced by modules.
CREATE TABLE IF NOT EXISTS action_items (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,
  module        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('checkbox', 'proposal')),
  text          TEXT NOT NULL,
  proposal_json TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'done', 'accepted', 'declined')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS action_items_date_idx ON action_items (date, status);

-- Weekly meal plan; drives defrost reminders by lead time.
CREATE TABLE IF NOT EXISTS meal_plan (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday         INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  meal            TEXT NOT NULL,
  item            TEXT NOT NULL,
  needs_defrost   INTEGER NOT NULL DEFAULT 0,
  defrost_lead_h  INTEGER NOT NULL DEFAULT 0,
  protein_g       INTEGER,
  kcal            INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS meal_plan_slot_idx ON meal_plan (weekday, meal);

-- Only one process may long-poll Telegram; a second returns HTTP 409.
CREATE TABLE IF NOT EXISTS instance_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER NOT NULL,
  hostname   TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
