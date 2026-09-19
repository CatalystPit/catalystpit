-- POINT-IN-TIME FUNDAMENTALS. Today begins the historical series.
--
-- The Pit Consensus research audit found the single gap that cannot be closed retroactively:
-- `screener_stocks` is a CLEAN-REBUILD SNAPSHOT — it is DELETEd and rewritten nightly, and every row
-- carries the same `updated_at`. There is exactly one historical observation of it: now. Valuation,
-- margins, growth, balance-sheet health and market cap therefore have NO history to research, and no
-- provider sells us ours back. Every day we do not capture is a day permanently lost to research.
--
-- ⚠️ NO BACKFILL. There is deliberately no INSERT ... SELECT from today's values into past dates.
-- Fabricating history is the one thing that would make this table worse than not existing: a model
-- validated against back-filled "history" would be validated against today's facts pretended into
-- the past, which is look-ahead bias with a schema.
--
-- WHAT IS DELIBERATELY *NOT* CAPTURED, and why — this table is small on purpose:
--
--   PRICE AND TECHNICALS (price, rsi14, sma*, hi52, atr14, perf_*, volatility, gap, beta, volume…)
--   are all recomputable from `ticker_daily_candles`, which we already keep permanently, back to
--   1962. Snapshotting them would duplicate 2.8M rows of data we own.
--
--   PROPRIETARY SIGNALS (consensus_score, insider_net_90d, congress_net_90d, fund_net_qoq…) are
--   recomputable point-in-time from insider_trades / congress_trades / fund_qoq, which carry their
--   own information dates. Worse, capturing them today would freeze the CURRENT definitions into the
--   record — including any dating bug they have — and a research dataset must be able to recompute a
--   signal with a corrected rule.
--
--   PRESENTATION ARTIFACTS (candlestick, pattern, news_category, breaking_today) are heuristic labels
--   and transient UI state, not facts about a company.
--
--   EMPTY COLUMNS (forward_pe, peg, insider_own_pct, p_cash, perf_5y) are 0% populated today.
--
-- WHAT IS CAPTURED is what a future price cannot reconstruct: identity and classification, size, the
-- PRICE-INDEPENDENT raw fundamentals, and the derived ratios as they stood. Storing eps_ttm,
-- revenue_ttm, equity, total_debt, cash and ebitda alongside market_cap is the efficient core —
-- every valuation ratio can be recomputed from those plus a historical price, so the raw inputs are
-- worth more than the ratios and both are kept while storage allows.

create table if not exists security_fundamental_snapshot (
  ticker        text not null,
  -- The trading day the observation describes. One row per ticker per day; re-running a capture
  -- REPLACES rather than duplicates, which is what makes the daily job idempotent.
  as_of         date not null,
  -- When the row was actually written. Distinct from as_of on purpose: a late or re-run capture is
  -- visible as such rather than silently presented as having happened on the day.
  captured_at   timestamptz not null default now(),

  -- ── identity and classification. A sector reclassification is invisible after the fact, and
  --    `company` doubles as a check that a ticker still refers to the same issuer. ──
  company       text,
  sector        text,
  industry      text,
  exchange      text,
  country       text,
  asset_type    text,
  ipo_date      date,

  -- ── size ──
  market_cap    double precision,
  shares_out    double precision,
  float_shares  double precision,

  -- ── raw, PRICE-INDEPENDENT fundamentals. The most valuable columns here: every ratio below can be
  --    recomputed from these plus a historical price, so they survive a change of formula. ──
  eps_ttm       double precision,
  revenue_ttm   double precision,
  equity        double precision,
  total_debt    double precision,
  cash          double precision,
  ebitda        double precision,

  -- ── valuation, as it stood ──
  pe            double precision,
  ps            double precision,
  pb            double precision,
  ev_sales      double precision,
  ev_ebitda     double precision,
  dividend_yield double precision,
  payout_ratio  double precision,

  -- ── profitability and margins ──
  roe           double precision,
  roa           double precision,
  roic          double precision,
  gross_margin  double precision,
  oper_margin   double precision,
  net_margin    double precision,

  -- ── balance sheet ──
  debt_equity     double precision,
  lt_debt_equity  double precision,
  current_ratio   double precision,
  quick_ratio     double precision,

  -- ── growth ──
  eps_growth_ttm    double precision,
  rev_growth_ttm    double precision,
  eps_growth_qoq    double precision,
  sales_growth_qoq  double precision,
  eps_growth_3y     double precision,
  sales_growth_3y   double precision,
  eps_growth_5y     double precision,
  sales_growth_5y   double precision,
  eps_growth_this_yr double precision,

  -- ── ownership ──
  inst_own_pct  double precision,
  short_float   double precision,

  -- ── provenance. Which pipeline produced the row, so a later methodology change is attributable
  --    rather than indistinguishable. ──
  source        text not null default 'screener_rebuild',

  primary key (ticker, as_of)
);

comment on table security_fundamental_snapshot is
  'Point-in-time fundamentals, captured daily. Immutable history for Pit Consensus research; never back-filled, never forward-filled, never read by production scoring. NULL means we did not have the value that day.';

-- The research access pattern is "this ticker across time" (primary key, already covered) and "the
-- whole cross-section on one day", which is what this second index serves.
create index if not exists idx_fund_snapshot_asof on security_fundamental_snapshot (as_of);

-- ── CHANGE-ONLY WRITES, and the run log that makes them auditable ────────────
--
-- Measured on the first capture: 6,439 eligible tickers, 2.2 MB a day, which is ~550 MB a year of
-- overwhelmingly identical rows — fundamentals update QUARTERLY, not daily.
--
-- So a row is written only when the captured payload DIFFERS from that ticker's most recent row.
-- `fundamentalsAsOf()` already reads "the latest row at or before this date", so a sparse series is
-- read identically to a dense one, and the point-in-time guarantee is unchanged.
--
-- Market capitalisation is deliberately NOT part of the change test: it moves every day with price,
-- and it is recoverable anyway as shares_out x close from ticker_daily_candles, which we keep
-- permanently. Letting it force a daily write would defeat the whole saving to store something we
-- can already reconstruct.
--
-- The cost of sparse writes is that "unchanged" and "the job did not run" would look alike — so the
-- run log records every capture, and coverage is checked against it rather than inferred.
create table if not exists security_snapshot_run (
  as_of        date primary key,
  captured_at  timestamptz not null default now(),
  considered   integer not null default 0,   -- eligible tickers examined
  written      integer not null default 0,   -- rows actually inserted or updated
  source       text not null default 'screener_rebuild'
);

comment on table security_snapshot_run is
  'One row per fundamental-snapshot capture. Distinguishes "nothing changed" from "the job did not run", which sparse change-only writes would otherwise conflate.';
