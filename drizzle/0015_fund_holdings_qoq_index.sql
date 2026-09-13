-- Covering index for the quarter-over-quarter roll-up that Pit Consensus and the institutional
-- heatmap both run. Those queries read (ticker, cik, shares) for common-stock rows in one or two
-- quarters; with 7.5M rows and growing that was a 3.4 second sequential scan on every request.
--
-- CONCURRENTLY because the 13F backfill is writing while this builds. No transaction wrapper:
-- Postgres refuses CREATE INDEX CONCURRENTLY inside one.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fund_holdings_qoq
  ON fund_holdings (quarter, ticker)
  INCLUDE (cik, shares)
  WHERE put_call = '' AND ticker IS NOT NULL;
