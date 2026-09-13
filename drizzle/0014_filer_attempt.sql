-- Records that we TRIED to ingest a filer, whether or not it yielded holdings.
--
-- Without this the ingest kept re-selecting the same first N filers every pass. Any filer that
-- legitimately has nothing to ingest (a 13F-NT notice filer, say) therefore blocked the slice
-- forever: a 2,000-pass run worked the same 120 CIKs and never reached the other 2,444.
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_institutions_attempt ON institutions (last_attempt_at NULLS FIRST);
