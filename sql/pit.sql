-- The Pit — live chat (Phase 1). Run once against the CatalystPit database.
-- Matches src/lib/schema.js (pitMessages, pitReports).

CREATE TABLE IF NOT EXISTS pit_messages (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL,
  avatar_url TEXT,
  tier       TEXT,
  body       TEXT NOT NULL,
  deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pit_messages_created ON pit_messages (created_at);

CREATE TABLE IF NOT EXISTS pit_reports (
  id               SERIAL PRIMARY KEY,
  message_id       INTEGER NOT NULL,
  reporter_user_id TEXT NOT NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pit_reports_message ON pit_reports (message_id);
