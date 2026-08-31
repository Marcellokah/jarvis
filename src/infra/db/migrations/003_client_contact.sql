-- When the phone last spoke to the server.
--
-- The whole system exists to answer one HTTP request a morning, and a
-- successful one used to leave no trace anywhere: an Adblock DNS profile, a
-- dropped Tailscale session or a disabled automation all look identical from
-- here — nothing arrives, nothing is logged, nothing is missed until you
-- notice the notification never came.
--
-- One row, overwritten. History lives in the request log; this is only the
-- answer to "did it check in today?".
CREATE TABLE IF NOT EXISTS client_contact (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_at     TEXT    NOT NULL,
  last_route  TEXT    NOT NULL,
  last_status INTEGER NOT NULL
);
