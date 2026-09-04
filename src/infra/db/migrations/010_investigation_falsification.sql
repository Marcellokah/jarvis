-- Which step killed the claim, and which steps the finding rests on.
--
-- 009's comment promises that a stored investigation can be audited: that
-- reading the steps back is how a real inference is told from a confident
-- invention. It could not keep that promise. The gate's whole output -- the
-- step number that tested the claim, and the steps the finding rests on --
-- lived only on the accepted `kesz`, and the accepted `kesz` is the one step
-- the loop never pushes onto the transcript. Both fields were dropped at the
-- moment the finding was written down.
--
-- Columns rather than transcript entries, because the audit question ("which
-- step falsified this finding?") is asked across runs, and a column answers
-- it in SQL instead of by parsing every stored transcript.
ALTER TABLE investigations ADD COLUMN falsified_by INTEGER;
ALTER TABLE investigations ADD COLUMN cites TEXT;   -- JSON array of 1-based step numbers
