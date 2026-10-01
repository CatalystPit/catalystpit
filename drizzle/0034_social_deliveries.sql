-- Per-destination delivery state for Catalyst Pit social publishing.
--
-- WHY A ROW PER (CHANNEL, EVENT) AND NOT A FLAG ON THE EVENT. A single "published" boolean cannot
-- express the state this system actually has: Facebook posted, X posted, Instagram failed on a rate
-- limit, Threads posted. One flag forces every channel to share one outcome, so a retry for the one
-- that failed re-sends the three that succeeded. The durable identity is therefore the PAIR —
-- canonical event + destination — and each pair owns its own status, attempt count, failure class and
-- provider post id.
--
-- WHY FACEBOOK AND X ARE NOT IN HERE. They already have fb_post_candidates and x_post_candidates,
-- both proven in production (519 and 1,445 posts). Migrating them would be a rewrite of two working
-- publishers to gain nothing a UNION in the monitoring query does not already give. They keep their
-- tables; this table serves the channels being added.
--
-- CHANNEL IS CONSTRAINED, not free text, so a typo cannot quietly create a fourth destination that
-- nothing drains and nothing monitors.

BEGIN;

CREATE TABLE IF NOT EXISTS social_deliveries (
  id              bigserial PRIMARY KEY,
  channel         text NOT NULL,
  -- The canonical primary_events.seq. Not a foreign key on purpose: the publisher's provenance gate
  -- checks the event still exists and fails the row terminally when it does not, which is more
  -- informative than a cascade silently deleting the audit trail of what we sent.
  event_seq       bigint NOT NULL,
  -- The canonical event's own content hash: unique per real-world story, so it is the second,
  -- independent dedupe axis when two sources produce two event rows for one story.
  content_hash    text NOT NULL,
  source_uid      text,

  -- Exactly what would be sent, character for character. Caption for Instagram, post text for
  -- Threads. Never rewritten after the fact, so what we published stays auditable.
  payload_text    text NOT NULL,
  -- Instagram only: the publicly fetchable JPEG the Graph API will cURL. NULL for text channels.
  media_url       text,

  -- ⚠️ THE IDEMPOTENCY HANDLE, and the reason these channels are safer than Facebook's /feed.
  -- Instagram and Threads both publish in TWO steps: create a container, then publish that container.
  -- Creating a container publishes nothing, so step 1 is free to retry. Step 2 is the only moment a
  -- post can come into existence, and it names the container rather than the content — so a process
  -- that dies after step 1 resumes with the SAME container instead of creating a second post.
  container_id    text,
  container_at    timestamptz,

  -- pending | publishing | posted | failed | skipped
  status          text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  provider_post_id text,

  -- The failure, split into the part that is safe to keep and the part that is not. failure_reason
  -- may contain a provider's own error text, which for Meta can ECHO THE SUBMITTED TOKEN back inside
  -- the "Malformed access token" class — so it is written redacted, and treated as credential-bearing
  -- regardless: counted and matched against, never returned to a caller or rendered.
  failure_reason  text,
  -- transient | permanent | rate_limited | auth | timeout — what monitoring groups by, and what the
  -- drain reads to decide whether this row may be tried again.
  failure_class   text,
  -- Set on a 429 or a 5xx. The drain skips rows whose backoff has not elapsed, so a rate limit slows
  -- the channel down instead of being retried into a harder rate limit.
  retry_after     timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  posted_at       timestamptz,

  CONSTRAINT ck_social_channel CHECK (channel IN ('instagram', 'threads')),
  CONSTRAINT ck_social_status  CHECK (status IN ('pending', 'publishing', 'posted', 'failed', 'skipped'))
);

-- ⚠️ THE TWO DEDUPE AXES, both at the database rather than in application logic, because a guard a
-- caller has to remember is a guard a future caller will forget. Scoped to the channel: Instagram
-- failing must leave Threads free to publish the same event, which a global unique key would forbid.
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_channel_event ON social_deliveries (channel, event_seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_channel_hash  ON social_deliveries (channel, content_hash);

-- The drain's own query shape: one channel, pending, oldest first.
CREATE INDEX IF NOT EXISTS idx_social_drain ON social_deliveries (channel, status, created_at);
-- The monitoring query's shape: per channel, most recent first.
CREATE INDEX IF NOT EXISTS idx_social_recent ON social_deliveries (channel, created_at DESC);

-- ⚠️ THE WATERMARK THAT STOPS A NEW CHANNEL DUMPING HISTORY.
--
-- The freshness window alone is not enough. A 30-minute window bounds how old a QUEUED row may be,
-- but the moment a new channel's scan runs for the first time it sees every canonical event inside
-- that window at once, and if the switch is turned on during a busy session that is a burst of
-- unrelated posts. Worse, a window measured in minutes says nothing about intent: the operator who
-- enables Instagram on Tuesday did not ask for Tuesday morning's news.
--
-- So a channel records the instant it was first activated, BEFORE it queues anything, and only
-- events received after that instant are ever eligible. The first run therefore queues nothing by
-- construction — not by luck of timing — and there is no code path that can backfill, because the
-- comparison is against a stored timestamp rather than against a sliding interval.
CREATE TABLE IF NOT EXISTS social_channel_activation (
  channel       text PRIMARY KEY,
  activated_at  timestamptz NOT NULL DEFAULT now(),
  note          text,
  CONSTRAINT ck_social_activation_channel CHECK (channel IN ('instagram', 'threads'))
);

COMMIT;
