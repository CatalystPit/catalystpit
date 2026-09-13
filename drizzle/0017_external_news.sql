-- External (non-SEC) news ingestion layer.
--
-- Adds the two-stage pipeline to primary_events: ingest writes a row immediately as 'pending' and
-- a separate enrich worker fills in the Catalyst Pit headline, extracted facts, tickers and cluster.
-- Capture is therefore never blocked by the LLM path.
--
-- SEC IS UNTOUCHED. Rows projected from eightk_filings are stamped source_kind='sec' and land
-- already 'ready', so the enrich worker's queue query can never select them. They keep source='SEC',
-- their direct EDGAR link, and their original headline forever.
--
-- Every column here is ADDITIVE. Nothing existing is dropped or rewritten except the one-time
-- backfill at the bottom, which is written so that NO row changes how it currently displays.

BEGIN;

ALTER TABLE primary_events
  -- 'sec' bypasses rewriting entirely; 'external' is eligible for it.
  ADD COLUMN IF NOT EXISTS source_kind      text NOT NULL DEFAULT 'external',
  -- Human-readable outlet name ("Reuters"), distinct from the registry key in `source` ("REUTERS").
  ADD COLUMN IF NOT EXISTS source_name      text,
  -- The source's OWN headline, verbatim and permanent. `headline` may be replaced by a Catalyst Pit
  -- original; this is what proves what the source actually said.
  ADD COLUMN IF NOT EXISTS source_headline  text,
  -- not_required (SEC) | original (CP-written, validated) | source_fallback (validation failed,
  -- source headline kept) | pending
  ADD COLUMN IF NOT EXISTS headline_status  text NOT NULL DEFAULT 'pending',
  -- pending | ready | failed. The enrich worker's queue.
  ADD COLUMN IF NOT EXISTS pipeline_status  text NOT NULL DEFAULT 'pending',
  -- Structured extraction {actor, action, object, value, effective_date}, each field grounded
  -- against the source text before it is stored.
  ADD COLUMN IF NOT EXISTS facts            jsonb,
  -- Deterministic cross-source fingerprint (canonical URL / entity+action+day).
  ADD COLUMN IF NOT EXISTS event_key        text,
  -- Earliest seq in this event's cluster. Grouping is NON-DESTRUCTIVE: every source row survives
  -- with its own URL and raw payload, they simply share a cluster_id.
  ADD COLUMN IF NOT EXISTS cluster_id       bigint,
  ADD COLUMN IF NOT EXISTS enrich_attempts  smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enriched_at      timestamptz;

-- The enrich worker's queue scan: newest pending first, SEC excluded.
CREATE INDEX IF NOT EXISTS idx_primary_events_queue
  ON primary_events (pipeline_status, seq DESC)
  WHERE pipeline_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_primary_events_cluster ON primary_events (cluster_id);
CREATE INDEX IF NOT EXISTS idx_primary_events_event_key ON primary_events (event_key);
-- Clustering compares against a short recent window, not the whole table.
CREATE INDEX IF NOT EXISTS idx_primary_events_recent ON primary_events (received_at DESC);

-- ── one-time backfill: preserve current behaviour exactly ────────────────────
-- Every existing row becomes 'ready' so the worker does not retroactively rewrite history.

-- SEC: permanently exempt.
UPDATE primary_events
   SET source_kind = 'sec',
       source_name = 'SEC EDGAR',
       source_headline = COALESCE(source_headline, headline),
       headline_status = 'not_required',
       pipeline_status = 'ready'
 WHERE source = 'SEC';

-- Nasdaq halts are mechanical, not prose. Nothing to rewrite.
UPDATE primary_events
   SET source_name = 'Nasdaq Trader',
       source_headline = COALESCE(source_headline, headline),
       headline_status = 'not_required',
       pipeline_status = 'ready'
 WHERE source = 'NASDAQ';

-- Existing agency rows: eligible for rewriting in future, but marked ready now so today's display
-- is unchanged. Re-queue deliberately (set pipeline_status='pending') to have them rewritten.
UPDATE primary_events
   SET source_headline = COALESCE(source_headline, headline),
       headline_status = 'source_fallback',
       pipeline_status = 'ready'
 WHERE source NOT IN ('SEC', 'NASDAQ');

COMMIT;
