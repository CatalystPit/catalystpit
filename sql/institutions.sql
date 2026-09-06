-- Institutions (13F) tables. Run against your Neon DB (SQL console or psql $DATABASE_URL).
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS fund_holdings (
  id           serial PRIMARY KEY,
  cik          text NOT NULL,
  quarter      date NOT NULL,
  cusip        text NOT NULL,
  ticker       text,
  issuer       text,
  class        text NOT NULL DEFAULT '',
  shares       double precision,
  value        double precision,
  put_call     text NOT NULL DEFAULT '',
  filed_date   date,
  inserted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fund_holding            ON fund_holdings (cik, quarter, cusip, class, put_call);
CREATE INDEX        IF NOT EXISTS idx_fund_holdings_cik_quarter ON fund_holdings (cik, quarter);
CREATE INDEX        IF NOT EXISTS idx_fund_holdings_ticker   ON fund_holdings (ticker);
CREATE INDEX        IF NOT EXISTS idx_fund_holdings_cusip    ON fund_holdings (cusip);

CREATE TABLE IF NOT EXISTS fund_filings (
  cik            text NOT NULL,
  quarter        date NOT NULL,
  filed_date     date,
  accession      text,
  total_value    double precision,
  holdings_count integer,
  inserted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cik, quarter)
);
