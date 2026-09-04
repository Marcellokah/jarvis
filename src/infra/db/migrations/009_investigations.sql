-- What the agent looked at, what it concluded, and what it cost.
--
-- The transcript is stored whole, not summarised. An investigation's finding
-- is only worth as much as the steps behind it, and the failure this table
-- exists to make visible -- a fluent, well-cited, wrong conclusion -- is
-- invisible in the finding alone. Reading the steps back is the only way to
-- tell a real inference from a confident invention.
--
-- `usd` is recorded per run because the $0/month rule is gone: this is the
-- one metered path in the system, and a cost that is never written down is a
-- cost nobody notices.
CREATE TABLE IF NOT EXISTS investigations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  goal        TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('kesz', 'kerdezz', 'kifutott', 'hiba')),
  finding     TEXT,
  transcript  TEXT NOT NULL,   -- JSON array of {step, observation}
  usd         REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS investigations_time ON investigations (started_at DESC);
