-- Fast multi-layer dedupe + immediate display.
--
-- Two goals: an event becomes user-visible the moment it is captured (no AI in the path), and the
-- same real-world event reported by many sources collapses to ONE canonical event before display.
--
-- The new columns are the deterministic dedupe keys. They are computed at ingest, in microseconds,
-- so layers 2-4 of dedupe are plain indexed equality checks rather than any kind of scan.

BEGIN;

ALTER TABLE primary_events
  -- Entity + event type + the headline number: "xyz|buyback|500000000". This is what collapses
  -- differently-worded reports of one event, and what keeps a $500M buyback apart from a $750M
  -- acquisition by the same company.
  ADD COLUMN IF NOT EXISTS fact_key      text,
  -- The numeric signature alone, so similarity matching can refuse to merge across different figures.
  ADD COLUMN IF NOT EXISTS fact_sig      text,
  -- Normalized headline (stopwords stripped). Catches verbatim syndication of the same release.
  ADD COLUMN IF NOT EXISTS norm_hash     text,
  -- Normalized company token, used as the shared-entity test before any similarity comparison when
  -- no ticker has been resolved yet. A dedupe hint only — never displayed, never a ticker.
  ADD COLUMN IF NOT EXISTS entity        text,
  -- Enough factual substance to show. Set deterministically at ingest; never waits on the model.
  ADD COLUMN IF NOT EXISTS display_ready boolean NOT NULL DEFAULT false,
  -- When the FIRST source reported this event, and when the most recent one did.
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_primary_events_fact_key  ON primary_events (fact_key)  WHERE fact_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_primary_events_norm_hash ON primary_events (norm_hash) WHERE norm_hash IS NOT NULL;

-- The user-facing read path: canonical, displayable, newest first.
CREATE INDEX IF NOT EXISTS idx_primary_events_wire
  ON primary_events (published_at DESC NULLS LAST, seq DESC)
  WHERE cluster_id IS NULL AND display_ready;

-- Quota accounting for metered APIs, reset per UTC day. Kept in Postgres with the rest of feed
-- state so that polling never costs a Redis command.
ALTER TABLE feed_state
  ADD COLUMN IF NOT EXISTS quota_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quota_date date;

-- Backfill: existing rows keep their current behaviour and become displayable, since they are all
-- real captured events that already carry a headline.
UPDATE primary_events
   SET first_seen_at = COALESCE(first_seen_at, received_at),
       last_seen_at  = COALESCE(last_seen_at, received_at),
       display_ready = true
 WHERE first_seen_at IS NULL OR last_seen_at IS NULL OR display_ready = false;

-- One row per real-world event, for the News page and the future Pit Wire panel. Raw per-source
-- records stay in primary_events and are reachable by cluster_id, so nothing is hidden — collapsed.
DROP VIEW IF EXISTS canonical_events;
CREATE VIEW canonical_events AS
  SELECT seq, source, source_name, source_kind, source_type, headline, source_headline, summary,
         published_at, received_at, first_seen_at, last_seen_at, original_url, canonical_url,
         tickers, entity, category, importance, facts, event_key, fact_key, fact_sig, source_count,
         headline_status, pipeline_status, display_ready, enriched_at
    FROM primary_events
   WHERE cluster_id IS NULL AND display_ready;

COMMIT;
