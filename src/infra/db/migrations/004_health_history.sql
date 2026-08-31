-- Seven and a half years of Apple Health history, at daily resolution.
--
-- The export holds 2.4 million raw samples and re-reads in nine seconds, so
-- storing raw samples would buy nothing that a re-import cannot: the source of
-- truth stays in the zip, and the database holds what the analysis layer
-- actually reads.
--
-- One row per day whatever the source. The iOS Shortcut writes today's
-- readings; the import fills gaps in any day. They never compete, because the
-- import only ever writes a column that is NULL.

ALTER TABLE health_snapshots ADD COLUMN asleep_min     REAL;
ALTER TABLE health_snapshots ADD COLUMN in_bed_min     REAL;
ALTER TABLE health_snapshots ADD COLUMN core_min       REAL;
ALTER TABLE health_snapshots ADD COLUMN rem_min        REAL;
ALTER TABLE health_snapshots ADD COLUMN deep_min       REAL;
ALTER TABLE health_snapshots ADD COLUMN awakenings     REAL;
ALTER TABLE health_snapshots ADD COLUMN vo2max         REAL;
ALTER TABLE health_snapshots ADD COLUMN hr_recovery    REAL;
ALTER TABLE health_snapshots ADD COLUMN walking_hr     REAL;
ALTER TABLE health_snapshots ADD COLUMN basal_kcal     REAL;
ALTER TABLE health_snapshots ADD COLUMN flights        REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_kcal      REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_protein_g REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_carbs_g   REAL;
ALTER TABLE health_snapshots ADD COLUMN diet_fat_g     REAL;

-- Workouts do not fit the daily row: there can be several in a day, and each
-- has its own type, length and cost. (started_at, type) is the natural key —
-- re-importing the same export must not duplicate them.
CREATE TABLE IF NOT EXISTS workouts (
  started_at    TEXT NOT NULL,
  type          TEXT NOT NULL,
  date          TEXT NOT NULL,           -- YYYY-MM-DD, the day it began
  duration_min  REAL NOT NULL,
  energy_kcal   REAL,
  source        TEXT,
  PRIMARY KEY (started_at, type)
);
CREATE INDEX IF NOT EXISTS workouts_date_idx ON workouts (date DESC);
