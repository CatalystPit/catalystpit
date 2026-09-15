// SERVER-SIDE TICKER SEO DATA BUNDLE — implementation.
//
// App code must import this through ticker-seo.server.mjs, whose `server-only` guard fails the BUILD
// if a client component ever pulls it in. This unguarded file exists so the verification scripts,
// which run in plain Node, can exercise real bundles against the live database; `server-only` throws
// outside a React Server Component and would block them. Same split, for the same reason, as
// wire-sources.mjs / wire-sources.server.mjs.
//
// NO PAID VENDOR CALLS. Not Finnhub, not Polygon, not Tiingo, not anything request-priced. There is
// no fetch in this file at all. Every value comes from data Catalyst Pit already stores, and that is
// a hard constraint rather than a preference: a server-rendered page sits on the critical path of the
// HTML response, so a vendor outage would become a site outage and a crawl would become a metered
// bill. The live quote, the intraday chart and the vendor metrics stay exactly where they are —
// fetched by the client, untouched by this file.
//
// The driver is the same Neon serverless client src/lib/db.js builds on, used directly rather than
// through Drizzle: this module issues one hand-written statement and needs no schema, and keeping it
// import-light is what lets the security suite run it under plain Node.
import { neon } from '@neondatabase/serverless';
import { buildPublicView, buildEligibility } from './ticker-seo-view.mjs';

// Rolling window for the insider summary. Two quarters: long enough that one filing does not define
// the picture, short enough that it still describes the company now.
export const INSIDER_WINDOW_DAYS = 180;

let client = null;
const conn = () => (client ||= neon(process.env.DATABASE_URL));

// ONE ROUND TRIP, NINE INDEPENDENT READS.
//
// Measured both ways against the live database. Nine queries issued with Promise.all and this single
// statement land within a couple of milliseconds of each other in wall time (~50ms from a laptop,
// almost all of it network), because every read here is an index lookup costing well under a
// millisecond on the server. What differs is what they cost the platform: nine HTTP requests and nine
// connections per render, or one. Under a crawl that is the entire argument — so the reads are
// independent subqueries inside a single plan, which Postgres evaluates independently while the
// function pays one round trip.
//
// Every date is cast to text and every timestamp formatted in SQL rather than handed to a driver to
// interpret, so what arrives is already the string the public model publishes and no timezone can
// shift a filing date across a day boundary.
const BUNDLE_SQL = `
  select
    (select to_jsonb(r) from (
        -- industry/sector/country/asset_type come along for the view model's exact test that a
        -- company name is not character-identical to a description of the company; they are public
        -- facts it publishes anyway. The name-sharing count that used to sit here is gone with the
        -- heuristic it fed.
        select ticker, company, exchange, sector, industry, country, asset_type, market_cap
          from screener_stocks where ticker = $1
      ) r) as identity,

    (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
        select transaction_date::text as transaction_date,
               filing_date::text      as filing_date,
               executive, title, action, shares, price_per_share, total_value,
               rule_10b5_1, filing_url
          from insider_trades
         where ticker = $1 and is_amendment is not true
         order by filing_date desc, transaction_date desc
         limit 5
      ) r) as insider_recent,

    (select to_jsonb(r) from (
        -- The stored action vocabulary is BUY / SELL / OTHER, upper case. Matched case-insensitively
        -- rather than against a literal, because a mismatch here is silent: every count comes back
        -- zero and a page reports "35 trades, 0 buys, 0 sells" without anything failing.
        select count(*)::int                                          as trades,
               count(*) filter (where upper(action) = 'BUY')::int     as buys,
               count(*) filter (where upper(action) = 'SELL')::int    as sells,
               -- OTHER covers grants, option exercises and gifts. They are real Form 4 rows and are
               -- counted in the trades total, but they are not purchases or sales and must not move a net.
               sum(case when upper(action) = 'BUY'  then  total_value
                        when upper(action) = 'SELL' then -total_value
                        else 0 end)::numeric                          as net,
               max(filing_date)::text                                 as latest
          from insider_trades
         where ticker = $1
           and is_amendment is not true
           and filing_date > (current_date - $2::int)
      ) r) as insider_summary,

    (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
        select transaction_date::text as transaction_date,
               disclosure_date::text  as disclosure_date,
               representative, member_slug, party, state, chamber, action, amount_range
          from congress_trades
         where ticker = $1
         order by transaction_date desc
         limit 5
      ) r) as congress,

    -- READ FROM THE EXISTING ROLLUP, never recomputed. See the note under this statement.
    (select to_jsonb(r) from (
        select as_of_quarter::text as as_of_quarter, filer_count, inst_shares, inst_value, ownership_pct
          from ticker_institutional_ownership where ticker = $1
      ) r) as institutions,

    -- Canonical events only: cluster_id is null is ONE row per real-world story, which is the whole
    -- point of the engine. TWO columns leave this subquery. The other thirty-three describe our
    -- pipeline — which feed found it, how many found it, when we received it, how it was deduped,
    -- enriched and scored — and are not selected at all, so nothing downstream can publish them by
    -- accident. the summary column is excluded for the same reason it was stripped from the wire payload:
    -- audited live it carried "(Source: Bloomberg)" and, once, a slab of a publisher's raw markup.
    (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
        select headline,
               to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as published_at
          from primary_events
         where $1 = any(tickers)
           and cluster_id is null
           and display_ready
           and headline is not null
         order by published_at desc
         limit 5
      ) r) as news,

    (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
        select report_date::text as report_date,
               to_char(filed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as filed_at,
               items, filing_url
          from eightk_filings
         where ticker = $1
         order by filed_at desc
         limit 3
      ) r) as filings,

    (select to_jsonb(r) from (
        select date::text as date, close, volume
          from ticker_daily_candles where ticker = $1
         order by date desc limit 1
      ) r) as candle,

    (select to_jsonb(r) from (
        select settlement_date::text as settlement_date, short_int_shares, days_to_cover, avg_daily_volume
          from short_interest where ticker = $1
         order by settlement_date desc limit 1
      ) r) as short_interest
`;

// WHY THE 13F FIGURE COMES FROM A ROLLUP.
//
// The audit clocked count(*) + sum(value) over fund_holdings at 342ms and flagged it as the one query
// that gets worse under success. Re-measured for this change, that number was network: the same
// aggregate executes in 25ms on the server for AAPL, and 7ms scoped to the latest quarter through
// the existing idx_fund_holdings_qoq partial index. The 342ms was a laptop-to-Neon round trip.
//
// It is still not what runs here, because a finished rollup already exists. ticker_institutional
// _ownership carries quarter, filer count, shares, value and ownership percent for 14,162 symbols,
// keyed by primary key, and reads in under a millisecond. Using it means no schema change, no new
// index, no new institutional subsystem and no per-request aggregation over a 9.2M-row table — the
// smallest reliable option available. A symbol with no rollup row simply reports no institutional
// data; there is no expensive fallback scan.

/** Raw rows for one already-uppercased symbol. Throws on database failure; the caller catches. */
async function fetchRaw(symbol) {
  const rows = await conn().query(BUNDLE_SQL, [symbol, INSIDER_WINDOW_DAYS]);
  const row = rows?.[0];
  if (!row) return null;
  return {
    identity: row.identity ?? null,
    insiderRecent: row.insider_recent ?? [],
    insiderSummary: row.insider_summary ?? null,
    insiderWindowDays: INSIDER_WINDOW_DAYS,
    congress: row.congress ?? [],
    institutions: row.institutions ?? null,
    news: row.news ?? [],
    filings: row.filings ?? [],
    candle: row.candle ?? null,
    shortInterest: row.short_interest ?? null,
  };
}

/**
 * The ticker SEO bundle.
 *
 * Two halves, deliberately separated:
 *   .public       the whitelisted view model — finished facts, safe to serialize into HTML
 *   .eligibility  internal coverage state that feeds the indexability rule — NEVER serialized
 *
 * Nothing here renders anything. This step builds the boundary; the shell that consumes it is a later
 * change, and until then the only caller is the verification suite.
 *
 * Returns null when we hold nothing or a read failed. A server-rendered page must degrade to "no
 * extra content" rather than fail, so the failure path is silent to the caller and loud in the logs.
 */
export async function getTickerBundle(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  let raw;
  try {
    raw = await fetchRaw(sym);
  } catch (err) {
    // Never let a database error upward: the message names tables and columns, and an SSR caller
    // would be holding it at render time.
    console.error('[ticker-seo] bundle failed', err?.message || err);
    return null;
  }
  if (!raw) return null;
  const view = buildPublicView(sym, raw);
  return { public: view, eligibility: buildEligibility(view) };
}
