-- What the analysis concluded, and the numbers it concluded it from.
--
-- This is the memory. Without it every run would start from zero and could
-- never say "the third month running", nor notice that something it flagged
-- has since resolved.
--
-- `summary` is not a convenience copy of `markdown`: the next run feeds the
-- last three summaries back into the prompt, and three full reports would be
-- roughly 3,600 tokens -- more than the statistics they are supposed to
-- accompany, against a 6,000 token/minute ceiling.
--
-- `metrics` keeps the input beside the conclusion, so an old finding can be
-- checked against the numbers that produced it rather than taken on trust.
CREATE TABLE IF NOT EXISTS analyses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  domain     TEXT NOT NULL,
  markdown   TEXT NOT NULL,
  summary    TEXT NOT NULL,
  metrics    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS analyses_domain_time ON analyses (domain, created_at DESC);
