-- What you were paying for, month by month.
--
-- The `subscriptions` table only ever knew the present: `last_used_at` is
-- overwritten in place and a price change leaves no trace. So "how does this
-- month compare to spring" was not a hard query — it was an unanswerable one.
--
-- This table has no history before the day it was created, and that is
-- deliberate: reconstructing past months from `next_renewal` and `cycle` would
-- assume prices never changed. That would be an estimate wearing the clothes
-- of a measurement.
CREATE TABLE IF NOT EXISTS subscription_months (
  month       TEXT NOT NULL,             -- YYYY-MM
  name        TEXT NOT NULL,
  amount_huf  INTEGER NOT NULL,
  cycle       TEXT NOT NULL,
  active      INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (month, name)
);
