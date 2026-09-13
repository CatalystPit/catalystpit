-- Canonical event layer + ingest-time deduplication.
--
-- Requirement: cross-source dedupe must happen BEFORE anything is user-facing, so two outlets
-- reporting the same event collapse into ONE Catalyst Pit event — while every raw source record is
-- kept internally for traceability.
--
-- Design: cluster_id IS NULL means "this row is the canonical event". A row that joins an existing
-- cluster gets cluster_id = the head's seq. That makes canonicality a property of the row itself,
-- self-maintaining, with no second write to assign a cluster head and no possibility of a row being
-- visible before its cluster is decided — the value is written by the INSERT that creates the row.
--
-- Consumers read the canonical_events view and see exactly one row per real-world event.

BEGIN;

ALTER TABLE primary_events
  -- Tracking-stripped URL. Tier-1 dedupe: same article, different link decoration.
  ADD COLUMN IF NOT EXISTS canonical_url text,
  -- Number of distinct source records folded into this event. Maintained on the head only, so the
  -- display query never needs a correlated subquery or a join.
  ADD COLUMN IF NOT EXISTS source_count  integer NOT NULL DEFAULT 1;

-- The canonical read path: one row per event, newest first.
CREATE INDEX IF NOT EXISTS idx_primary_events_canonical
  ON primary_events (published_at DESC NULLS LAST)
  WHERE cluster_id IS NULL;

-- Tier-1 dedupe lookup.
CREATE INDEX IF NOT EXISTS idx_primary_events_canon_url ON primary_events (canonical_url);

-- Backfill: every existing row is its own canonical event. cluster_id stays NULL, which already
-- means canonical, so this only fills the URL used for future dedupe. No row changes meaning.
UPDATE primary_events
   SET canonical_url = regexp_replace(lower(split_part(original_url, '?', 1)), '/+$', '')
 WHERE canonical_url IS NULL;

-- One row per real-world event. Raw per-source records remain in primary_events and are reachable
-- by cluster_id, so nothing is hidden — only collapsed.
CREATE OR REPLACE VIEW canonical_events AS
  SELECT seq, source, source_name, source_kind, source_type, headline, source_headline, summary,
         published_at, received_at, original_url, canonical_url, tickers, category, importance,
         facts, event_key, source_count, headline_status, pipeline_status, enriched_at
    FROM primary_events
   WHERE cluster_id IS NULL;

COMMIT;
