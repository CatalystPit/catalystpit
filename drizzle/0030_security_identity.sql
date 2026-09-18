-- THE SECURITY MASTER: one canonical display name per ticker.
--
-- The Dividend Calendar printed "—" in the Company column for 3,343 covered tickers — FPF, IDE, IGA,
-- IHD, FOF, LDP, PTA, RFI, RNP, UTF and every other closed-end fund on the board. The names were not
-- missing from our data; they were missing from the ONE table the calendar asked.
--
-- Company identity was derived inside the screener rebuild from SEC filings only: the Form 4 issuer
-- name, then the 8-K registrant name, then null. That is right about quality and wrong about
-- coverage — funds, ETFs, ADRs, preferred lines and unit trusts file neither form, so they had no
-- name anywhere, while SEC's own company_tickers.json named every one of them.
--
-- Identity is now resolved once, with a stated precedence (see security-identity.mjs), and read by
-- the calendar and the screener rebuild alike. `source` records which rung of that ladder answered,
-- so a vendor-supplied name is auditable and removable in one statement if the vendor changes.

create table if not exists security_identity (
  ticker      text        primary key,
  name        text        not null,
  source      text        not null,   -- form4 | registrant | sec_ticker | provider
  updated_at  timestamptz not null default now()
);

comment on table security_identity is
  'Ticker -> canonical display name. Precedence: Form 4 issuer > 8-K registrant > SEC company_tickers.json > market-data vendor. Never 13F issuer strings, FINRA security names or SIC descriptions. Rebuilt on the nightly screener cron.';

-- The vendor's ticker-details endpoint returns a security name on every call and we were discarding
-- it — 2,727 of the unnamed tickers already had a row here, fetched and thrown away. It is the only
-- source that knows ETFs, so it is captured; it sits LAST in the precedence and is recorded as
-- 'provider' so vendor naming can never be mistaken for filed identity.
alter table screener_meta add column if not exists name text;
