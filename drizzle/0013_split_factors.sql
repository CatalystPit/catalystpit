-- Share-count split factors, so a stock split is never read as institutional buying or selling.
--
-- 13F reports raw share counts AS FILED. Our candles are retroactively split-adjusted. A 10-for-1
-- split between two quarters therefore shows as a tenfold increase in shares held with no trade
-- behind it, and a reverse split shows as a collapse.
--
-- Derived only: fund_holdings keeps the numbers exactly as the SEC received them, and the aggregate
-- multiplies the PRIOR quarter's shares by this factor before differencing. A ticker whose factor
-- cannot be established confidently is excluded from quarter-over-quarter rather than shown with a
-- suspect delta, the same rule every other guard follows.
BEGIN;

CREATE TABLE IF NOT EXISTS ticker_split_factor (
  ticker        text NOT NULL,
  quarter       date NOT NULL,          -- the LATER quarter of the pair
  prev_quarter  date NOT NULL,
  factor        double precision,       -- multiply prior-quarter SHARES by this. NULL = undetermined
  status        text NOT NULL,          -- 'none' | 'split' | 'undetermined'
  confidence    text NOT NULL,          -- 'high' | 'none'
  price_ratio   double precision,       -- adjusted close ratio across the boundary
  implied_ratio double precision,       -- filing-implied price ratio across the boundary
  divergence    double precision,       -- implied / price; ~1 means no split, ~N means an N-for-1
  samples       integer NOT NULL DEFAULT 0,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, quarter)
);

CREATE INDEX IF NOT EXISTS idx_split_status ON ticker_split_factor (quarter, status);

COMMIT;
