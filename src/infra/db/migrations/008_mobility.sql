-- Ten measurements the watch and the phone have been collecting all along.
--
-- Nothing here needs a new habit: they accumulate passively. Distance goes back
-- to 2019-02-13 in the owner's export -- the longest continuous series after
-- step count -- and the walking metrics have run since 2021. They were never
-- read because nothing asked for them.
--
-- The aggregation for each is fixed in the rollup's DAILY map and must match
-- what the phone sends, or the same column would hold two different meanings.
ALTER TABLE health_snapshots ADD COLUMN distance_km REAL;
ALTER TABLE health_snapshots ADD COLUMN stand_min REAL;
ALTER TABLE health_snapshots ADD COLUMN walking_speed REAL;
ALTER TABLE health_snapshots ADD COLUMN step_length_cm REAL;
ALTER TABLE health_snapshots ADD COLUMN double_support_pct REAL;
ALTER TABLE health_snapshots ADD COLUMN asymmetry_pct REAL;
ALTER TABLE health_snapshots ADD COLUMN steadiness_pct REAL;
ALTER TABLE health_snapshots ADD COLUMN six_min_walk_m REAL;
ALTER TABLE health_snapshots ADD COLUMN stair_up_ms REAL;
ALTER TABLE health_snapshots ADD COLUMN stair_down_ms REAL;
