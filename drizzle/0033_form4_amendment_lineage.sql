-- FORM 4/A AMENDMENT LINEAGE.
--
-- A Form 4/A does not name the accession it amends — measured across every 4/A in the corpus, not
-- one carries an accession-shaped string anywhere in the document. What it does carry is
-- <dateOfOriginalSubmission>, which with the issuer, the reporting owners and the period identifies
-- the amended filing whenever exactly one filing matches.
--
-- Three columns, each doing one job:
--   orig_submission_date  the SEC's own statement, stored verbatim, so a link can be audited
--                         against the filing rather than against this migration's reasoning
--   amend_link_basis      EXPLICIT | DETERMINISTIC | UNRESOLVED — so nothing downstream can mistake
--                         an unresolved amendment for a decided one, and so an unresolved case
--                         stays visible as debt instead of silently looking like a filing that
--                         amends nothing
--   amends_accession      already present on the table but absent from the drizzle schema, so
--                         nothing could write it; declared here for completeness on a fresh database
ALTER TABLE insider_trades ADD COLUMN IF NOT EXISTS amends_accession TEXT;
ALTER TABLE insider_trades ADD COLUMN IF NOT EXISTS orig_submission_date DATE;
ALTER TABLE insider_trades ADD COLUMN IF NOT EXISTS amend_link_basis TEXT;

-- The backfill and the integrity checks both ask "which filings does this accession supersede" and
-- "what is the authoritative version of this filing", and the consumers already filter on
-- superseded_by. Partial, because the overwhelming majority of rows are neither.
CREATE INDEX IF NOT EXISTS idx_insider_amends
  ON insider_trades (amends_accession) WHERE amends_accession IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insider_superseded
  ON insider_trades (superseded_by) WHERE superseded_by IS NOT NULL;
