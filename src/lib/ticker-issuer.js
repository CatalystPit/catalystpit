// TICKER -> ISSUER NAME, derived once at ingest instead of per keystroke.
//
// Symbol search needs the tickers SEC's company_tickers.json leaves out — ETFs like VOO, VTI and
// SPY, which file under their fund registrant rather than as tickers. We already know those names
// from 13F holdings, but working them out meant grouping all 9.17M rows of fund_holdings twice,
// unbounded, on a cold lambda: 11.6 seconds, measured in production, in front of somebody typing in
// the nav search box.
//
// The answer changes when ingest resolves a CUSIP to a ticker, so it is computed there and read
// here. Same shape as fund-qoq.js, same reason.

import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * Rebuild the ticker -> dominant-issuer-name map.
 *
 * "Dominant" is the issuer string the most filings agree on for that ticker, which is what the old
 * inline query picked with `(array_agg(issuer ORDER BY n DESC))[1]`. THE CHOICE IS UNCHANGED; only
 * where and when it happens is different.
 */
export async function refreshTickerIssuer() {
  const startedAt = Date.now();
  await db.execute(sql`
    insert into ticker_issuer (ticker, name, holdings, updated_at)
    select ticker, name, n, now() from (
      select ticker,
             (array_agg(issuer order by n desc))[1] name,
             max(n) n,
             row_number() over (partition by ticker order by max(n) desc) rn
        from (
          select ticker, issuer, count(*)::int n
            from fund_holdings
           where ticker is not null and coalesce(put_call, '') = '' and issuer is not null
           group by ticker, issuer
        ) t
       group by ticker
    ) d
    where rn = 1
    on conflict (ticker) do update
       set name = excluded.name, holdings = excluded.holdings, updated_at = excluded.updated_at`);

  const res = await db.execute(sql`select count(*)::int n from ticker_issuer`);
  return { ok: true, tickers: Number((res.rows ?? res)[0]?.n) || 0, ms: Date.now() - startedAt };
}

/**
 * The whole map, for the in-memory matcher the route already has.
 *
 * Returns null when the table has not been built, so the caller can fall back rather than quietly
 * losing every ETF from autocomplete — the exact symbols this augmentation exists to supply.
 */
export async function readTickerIssuer() {
  const res = await db.execute(sql`select ticker, name from ticker_issuer`);
  const rows = res.rows ?? res;
  return rows.length ? rows.map((r) => ({ ticker: String(r.ticker).toUpperCase(), name: r.name || '' })) : null;
}
