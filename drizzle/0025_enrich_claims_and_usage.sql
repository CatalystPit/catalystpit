-- Rewrite claiming, retry scheduling and Anthropic usage accounting.
--
-- ADDITIVE ONLY. Every column is nullable with no default, so the ALTERs are metadata changes that
-- do not rewrite the table, and the code already running in production ignores them. This file is
-- applied BEFORE the code that reads them is deployed.
--
--   enrich_claimed_at   when a worker claimed the row for a model call; a claim older than the
--                       stale window is treated as abandoned (crashed or timed-out worker)
--   enrich_claim_token  which worker holds it; the result write is guarded on it, so a worker whose
--                       claim was taken over can never overwrite the newer result
--   enrich_next_at      earliest time the row may be sent again; 'infinity' means no further retry
--   enrich_last_error   why the last rewrite did not produce Catalyst wording (validation reason or
--                       model outcome), so failed rows stay visible and diagnosable
--
-- anthropic_usage: one row per Anthropic API call, with no prompt or response content. Enough to
-- compute calls, tokens and cost per day per feature.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE primary_events ADD COLUMN IF NOT EXISTS enrich_claimed_at  timestamptz;
ALTER TABLE primary_events ADD COLUMN IF NOT EXISTS enrich_claim_token text;
ALTER TABLE primary_events ADD COLUMN IF NOT EXISTS enrich_next_at     timestamptz;
ALTER TABLE primary_events ADD COLUMN IF NOT EXISTS enrich_last_error  text;

-- The rewrite queue. primary_events is ~24k rows, so a plain build takes milliseconds.
CREATE INDEX IF NOT EXISTS idx_primary_events_rewrite_queue
  ON primary_events (seq DESC)
  WHERE headline_status = 'rewrite_pending' AND source_kind <> 'sec';

CREATE TABLE IF NOT EXISTS anthropic_usage (
  id                 bigserial PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  feature            text        NOT NULL,
  model              text,
  ok                 boolean     NOT NULL,
  status             integer,
  error_class        text,
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  items              integer,
  ms                 integer
);

CREATE INDEX IF NOT EXISTS idx_anthropic_usage_at ON anthropic_usage (at DESC);
CREATE INDEX IF NOT EXISTS idx_anthropic_usage_feature_at ON anthropic_usage (feature, at DESC);

COMMIT;
