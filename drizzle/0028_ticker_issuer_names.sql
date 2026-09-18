-- SYMBOL SEARCH: stop grouping nine million rows to spell "NVIDIA".
--
-- The nav autocomplete augments SEC's company_tickers.json with our own resolved 13F universe,
-- because SEC's file omits ETFs — VOO, VTI and SPY file under the fund registrant, not as tickers.
-- Deriving that augmentation meant a two-level GROUP BY over the whole of fund_holdings with no
-- quarter bound and no limit: 9.17M rows, 3 GB. The repo's own api-guard.mjs records the cost as
-- "13.1s cold"; measured against production it was 11.6 SECONDS on the first keystroke.
--
-- The only cache was a module-level variable, so every cold lambda, every new concurrent instance
-- and every deploy paid it again — and the trigger is a keystroke in the TopNav search box, which
-- is on every page of the site.
--
-- The mapping changes when 13F ingest resolves a CUSIP to a ticker. That is a cron. So it is stored
-- here, ~14.5k small rows, and the route reads them instead of aggregating.

create table if not exists ticker_issuer (
  ticker      text        primary key,
  name        text        not null,
  holdings    integer     not null default 0,   -- filings backing this name, for the dominant pick
  updated_at  timestamptz not null default now()
);

comment on table ticker_issuer is
  'Ticker -> dominant issuer name, derived from fund_holdings at ingest. Read by /api/symbol-search; never aggregated on a user request.';
