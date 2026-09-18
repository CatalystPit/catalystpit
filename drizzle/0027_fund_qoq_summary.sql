-- PIT CONSENSUS: take the 13F quarter-over-quarter roll-up off the request path.
--
-- The confluence board asks one question of the institutional data: for each ticker, how many funds
-- INCREASED their position last quarter and how many REDUCED it. Answering that from fund_holdings
-- means scanning both quarters — 3.09 million rows — hash-aggregating them into 1.74 million
-- (ticker, cik) pairs, spilling ~145 MB to disk, and collapsing the result to 14,474 tickers. It
-- takes about six seconds in the database and eight by the time the rows reach Node.
--
-- That answer changes only when 13F filings are ingested, which is a cron, not a page view. So it is
-- computed once per ingest and stored here, and the board reads 14,474 indexed rows instead of three
-- million. The arithmetic is unchanged — this table holds exactly what the CTE produced.
--
-- `quarter` is the CURRENT quarter of the comparison (q0). Keeping it in the key means a new quarter
-- simply has no row yet, and the board falls back to computing live until the next ingest fills it —
-- which is why a missing summary is a slow board, never a wrong or an empty one.

create table if not exists fund_qoq (
  quarter      date        not null,
  ticker       text        not null,
  acc          integer     not null default 0,   -- funds whose position grew vs the prior quarter
  red          integer     not null default 0,   -- funds whose position shrank
  computed_at  timestamptz not null default now(),
  primary key (quarter, ticker)
);

-- The board's only access pattern: every ticker for one quarter. The primary key already leads with
-- `quarter`, so this INCLUDE index is what makes it an index-only scan rather than 14k heap fetches.
create index if not exists idx_fund_qoq_quarter on fund_qoq (quarter) include (ticker, acc, red);

comment on table fund_qoq is
  'Precomputed 13F quarter-over-quarter accumulation/reduction counts per ticker. Refreshed by the institutions ingest cron; read by the Pit Consensus confluence board. Never written on a user request.';
