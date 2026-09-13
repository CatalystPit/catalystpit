-- Normalized primary-source event stream.
--
-- Today's News has NO database: it is KV blobs rewritten every five minutes, which is why it went
-- blank the moment Upstash hit its request cap, and why nothing can be pushed incrementally. This
-- table is the durable spine for both the News page and future Terminal/Pit Wire delivery.
--
-- `seq` is the point of the design. A bigserial gives every event a monotonic cursor, so a future
-- SSE or WebSocket endpoint is `WHERE seq > :cursor ORDER BY seq` and nothing about ingestion has to
-- change to support it.
--
-- SEC 8-K and Nasdaq halts are PROJECTED into this table from the pipelines that already fetch them.
-- No second SEC request, no second halt poll.

BEGIN;

CREATE TABLE IF NOT EXISTS primary_events (
  seq           bigserial PRIMARY KEY,
  source        text NOT NULL,          -- FED | BLS | BEA | TREASURY | FDA | FTC | DOJ | NASDAQ | SEC
  source_type   text NOT NULL,          -- statement | release | speech | testimony | approval |
                                        -- enforcement | halt | filing
  source_uid    text NOT NULL,          -- the feed's own guid/id/accession, verbatim
  headline      text NOT NULL,
  summary       text,                   -- NULL when the feed provides none; never invented
  published_at  timestamptz,            -- as stated by the source
  received_at   timestamptz NOT NULL DEFAULT now(),
  original_url  text NOT NULL,          -- always the official source, never a rehost
  tickers       text[] NOT NULL DEFAULT '{}',   -- empty unless confidently resolved
  category      text,
  importance    smallint NOT NULL DEFAULT 0,    -- 0 routine, 1 notable, 2 high
  content_hash  text NOT NULL,          -- catches the same event arriving on two feeds
  raw           jsonb,                  -- original item, so any normalisation can be re-derived
  CONSTRAINT uq_primary_event UNIQUE (source, source_uid)
);

-- Cross-feed dedupe: the same Fed statement appears on press_all AND press_monetary. The unique key
-- above cannot catch that because the guids differ, so the hash does.
CREATE UNIQUE INDEX IF NOT EXISTS uq_primary_event_hash ON primary_events (content_hash);
CREATE INDEX IF NOT EXISTS idx_primary_events_published ON primary_events (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_primary_events_source ON primary_events (source, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_primary_events_tickers ON primary_events USING gin (tickers);

-- Conditional-GET state, deliberately in Postgres rather than Redis. Polling a feed every 30 seconds
-- must not add 2,880 Redis commands a day per feed; that is the mistake that took the cache down.
CREATE TABLE IF NOT EXISTS feed_state (
  feed_key             text PRIMARY KEY,
  etag                 text,
  last_modified        text,
  last_polled_at       timestamptz,
  last_success_at      timestamptz,
  last_status          integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  events_seen          bigint NOT NULL DEFAULT 0,
  note                 text
);

COMMIT;
