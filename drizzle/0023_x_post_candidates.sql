-- Publishing state for the Catalyst Pit X auto-poster.
--
-- Keyed on the CANONICAL EVENT, with a unique constraint, and that is the whole idempotency design.
-- One real-world event is one canonical row whatever number of sources report it, so keying here
-- makes "a canonical event can never generate two posts" a property of the schema rather than a
-- rule some code has to remember. Walter Bloomberg arriving after FinancialJuice merges into the
-- existing canonical event; the seq does not change; the insert conflicts; nothing is posted twice.
--
-- Nothing in this table is ever deleted or rewritten in place except status, attempts and the
-- result fields, so the exact text that would have been published stays auditable.

BEGIN;

CREATE TABLE IF NOT EXISTS x_post_candidates (
  id                bigserial PRIMARY KEY,
  -- The canonical primary_events.seq. UNIQUE is the duplicate guard.
  event_seq         bigint NOT NULL UNIQUE,
  -- 'critical' | 'walter' | 'critical+walter'
  reason            text   NOT NULL,
  -- Exactly what would be sent, character for character.
  post_text         text   NOT NULL,
  char_count        integer NOT NULL,
  -- 'breaking' | 'ticker' | 'breaking_ticker'
  shape             text   NOT NULL,
  ticker            text,
  impact            smallint,
  -- The mode in force when the candidate was created: off | dry_run | live.
  mode              text   NOT NULL,
  -- pending | dry_run | posted | failed | skipped
  status            text   NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  x_post_id         text,
  failure_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  posted_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_x_candidates_created ON x_post_candidates (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_candidates_status  ON x_post_candidates (status, created_at DESC);

COMMIT;
