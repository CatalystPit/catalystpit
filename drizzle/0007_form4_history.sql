-- 0007_form4_history.sql
-- Phase 3 foundation: 3-year Form 4 history, provenance, validation quarantine,
-- resumable ingest state, and precomputed historical context.
--
-- Designed so the history window can be EXTENDED later (4y, 5y, full) without
-- redesigning anything: nothing here encodes "3 years". The window lives only in
-- the backfill job's cursor (insider_ingest_state.cursor_date) and in
-- insider_history_meta.covered_from, which is what the UI reads to phrase badges.
--
-- Apply:  psql "$DATABASE_URL" -f drizzle/0007_form4_history.sql
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.

BEGIN;

-- ─── 1. Provenance + raw SEC fields on the existing trade rows ──────────────
-- Raw transaction_code is already stored and is NEVER overwritten. These add the
-- parts of the filing we were dropping, so we can classify honestly rather than
-- assuming acquisition = buy.
ALTER TABLE insider_trades
  ADD COLUMN IF NOT EXISTS issuer_cik        text,
  ADD COLUMN IF NOT EXISTS owner_cik         text,
  ADD COLUMN IF NOT EXISTS form_type         text,        -- '4' | '4/A'
  ADD COLUMN IF NOT EXISTS is_amendment      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS amends_accession  text,        -- original accession when form_type='4/A'
  ADD COLUMN IF NOT EXISTS superseded_by     text,        -- accession of the 4/A that replaced this row
  ADD COLUMN IF NOT EXISTS period_of_report  date,        -- SEC's own key for linking a 4/A to what it amends
  ADD COLUMN IF NOT EXISTS acquired_disposed text,        -- raw A/D flag, NOT interpreted as buy/sell
  ADD COLUMN IF NOT EXISTS ownership_type    text,        -- 'D' direct | 'I' indirect
  ADD COLUMN IF NOT EXISTS ownership_nature  text,        -- indirect-ownership explanation
  ADD COLUMN IF NOT EXISTS is_derivative     boolean NOT NULL DEFAULT false,  -- Table II vs Table I
  ADD COLUMN IF NOT EXISTS is_officer        boolean,
  ADD COLUMN IF NOT EXISTS is_director       boolean,
  ADD COLUMN IF NOT EXISTS is_ten_pct_owner  boolean,
  ADD COLUMN IF NOT EXISTS is_other_relation boolean;

-- ─── 2. Precomputed historical context ─────────────────────────────────────
-- Multi-year lookbacks are far too expensive to run per row per request, so they
-- are materialised here by scripts/build-insider-context.mjs and only ever READ
-- at request time. ctx_computed_at lets the job resume and lets us detect staleness.
ALTER TABLE insider_trades
  ADD COLUMN IF NOT EXISTS ctx_computed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS is_first_om_buy        boolean,   -- first open-market buy WITHIN STORED HISTORY
  ADD COLUMN IF NOT EXISTS prev_om_buy_date       date,
  ADD COLUMN IF NOT EXISTS months_since_prev_buy  double precision,
  ADD COLUMN IF NOT EXISTS om_buys_3m             integer,
  ADD COLUMN IF NOT EXISTS om_buys_6m             integer,
  ADD COLUMN IF NOT EXISTS om_buys_12m            integer,
  ADD COLUMN IF NOT EXISTS om_buys_24m            integer,
  ADD COLUMN IF NOT EXISTS om_buys_36m            integer,
  ADD COLUMN IF NOT EXISTS om_buys_total          integer,   -- total in stored history
  ADD COLUMN IF NOT EXISTS ownership_increase_pct double precision,
  ADD COLUMN IF NOT EXISTS is_repeat_buyer        boolean,
  ADD COLUMN IF NOT EXISTS cluster_insiders_10d   integer,   -- distinct insiders buying same issuer within 10d
  ADD COLUMN IF NOT EXISTS conviction_band        text,      -- LOW|MODERATE|HIGH|VERY HIGH|EXTREME
  ADD COLUMN IF NOT EXISTS conviction_tags        text,      -- JSON array of APPROVED display tags only
  ADD COLUMN IF NOT EXISTS conviction_at          timestamptz;
-- NOTE: insider_trades.conviction (the 0-100 score) already exists and stays.
-- No weight, threshold, or intermediate factor is ever persisted here - only the
-- final score, its band, and the approved display tags. See src/lib/conviction.server.js.

CREATE INDEX IF NOT EXISTS idx_insider_owner_cik    ON insider_trades (owner_cik);
CREATE INDEX IF NOT EXISTS idx_insider_issuer_cik   ON insider_trades (issuer_cik);
CREATE INDEX IF NOT EXISTS idx_insider_conviction   ON insider_trades (conviction DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_insider_ctx_pending  ON insider_trades (ctx_computed_at) WHERE ctx_computed_at IS NULL;
-- open-market buy lookups drive every historical-context query
CREATE INDEX IF NOT EXISTS idx_insider_om_buy       ON insider_trades (owner_cik, transaction_date)
  WHERE transaction_code = 'P' AND is_derivative = false;
-- cluster detection asks "which insiders bought THIS issuer in the last 10 days", per row
CREATE INDEX IF NOT EXISTS idx_insider_issuer_buy   ON insider_trades (issuer_cik, transaction_date)
  WHERE transaction_code = 'P' AND is_derivative = false;
-- a 4/A restates an earlier filing for the SAME (issuer, owner, period); this is the lookup
-- that lets the amendment mark its predecessor superseded instead of double-counting it.
CREATE INDEX IF NOT EXISTS idx_insider_amend_key    ON insider_trades (issuer_cik, owner_cik, period_of_report);

-- ─── 3. Per-insider baselines (normalisation inputs for Conviction) ────────
-- Keeps the scorer from leaning on raw dollars: a purchase is judged against this
-- insider's OWN history, which is what makes the score work across mega caps and
-- ordinary directors alike.
CREATE TABLE IF NOT EXISTS insider_people (
  owner_cik        text PRIMARY KEY,
  name             text,
  first_seen       date,
  last_seen        date,
  om_buy_count     integer NOT NULL DEFAULT 0,
  om_buy_total     double precision NOT NULL DEFAULT 0,
  om_buy_avg       double precision,
  om_buy_median    double precision,
  om_buy_p90       double precision,
  om_buy_max       double precision,
  issuers_count    integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ─── 4. Quarantine - suspicious rows are held, never silently dropped ──────
-- We have already seen malformed filings capable of destroying heatmap totals.
-- Anything failing validation lands here WITH its raw source so it can be
-- investigated and replayed, and is kept out of insider_trades entirely.
CREATE TABLE IF NOT EXISTS insider_quarantine (
  id            bigserial PRIMARY KEY,
  accession     text NOT NULL,
  issuer_cik    text,
  owner_cik     text,
  ticker        text,
  filing_date   date,
  reason        text NOT NULL,        -- machine code, e.g. ABSURD_PRICE
  detail        text,                 -- human-readable specifics
  parsed        jsonb,                -- what we parsed, pre-insert
  raw_url       text NOT NULL,        -- SEC source document, for investigation
  resolved      boolean NOT NULL DEFAULT false,
  resolved_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quarantine_reason   ON insider_quarantine (reason);
CREATE INDEX IF NOT EXISTS idx_quarantine_unresolved ON insider_quarantine (created_at DESC) WHERE resolved = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_quarantine_row ON insider_quarantine (accession, reason, md5(coalesce(parsed::text, '')));

-- ─── 5. Resumable ingest state ─────────────────────────────────────────────
-- The backfill is a long job that WILL be interrupted. It walks EDGAR day by day
-- and commits a cursor after each day, so restarting resumes rather than redoing.
CREATE TABLE IF NOT EXISTS insider_ingest_state (
  job            text PRIMARY KEY,     -- e.g. 'form4-backfill'
  cursor_date    date,                 -- last EDGAR index day fully committed
  target_from    date,                 -- oldest day this run intends to reach
  filings_seen   bigint NOT NULL DEFAULT 0,
  filings_parsed bigint NOT NULL DEFAULT 0,
  rows_written   bigint NOT NULL DEFAULT 0,
  rows_quarantined bigint NOT NULL DEFAULT 0,
  last_error     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ─── 6. What history we can actually claim ─────────────────────────────────
-- Single source of truth for badge wording. The UI must phrase claims against
-- covered_from, so we can never say "first buy ever" when we hold 3 years.
CREATE TABLE IF NOT EXISTS insider_history_meta (
  id            integer PRIMARY KEY DEFAULT 1,
  covered_from  date,                  -- oldest filing date we believe is COMPLETE
  covered_to    date,
  complete      boolean NOT NULL DEFAULT false,
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insider_history_meta_singleton CHECK (id = 1)
);
INSERT INTO insider_history_meta (id, covered_from, covered_to, complete, note)
  VALUES (1, NULL, NULL, false, 'awaiting first backfill run')
  ON CONFLICT (id) DO NOTHING;

COMMIT;
