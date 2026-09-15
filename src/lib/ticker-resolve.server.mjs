import 'server-only';
import { unstable_cache } from 'next/cache';
import { sql } from 'drizzle-orm';
import { db } from './db';

// IS THIS SYMBOL A SECURITY CATALYST PIT ACTUALLY HOLDS DATA FOR?
//
// Used for ONE decision: whether a syntactically valid ticker URL may be presented to search engines
// as a verified security, or must be served noindex. It is not a gate — the page renders identically
// either way, and nothing a signed-in user can do changes.
//
// DELIBERATELY NOT "is it in screener_stocks". That table has 15,968 rows but only 5,701 carry a
// company name, and it does not cover everything the rest of the product does: PPTINC appears in
// insider filings and not in the screener at all. Keying verification to one incomplete table would
// have quietly de-indexed real securities. This asks all six first-party ticker-keyed tables and
// takes any hit as evidence. Measured against the live universe that is 19,199 symbols rather than
// 15,968, and every column probed here carries a btree index on ticker, so each EXISTS is an index
// lookup that short-circuits on the first row.
//
// SOURCE EXPOSURE: the return value is a single boolean. No table name, no column, no row, no count
// and no vendor identity crosses back to the caller, let alone into the HTML — which matters more
// here than in an API response, because anything a server component renders is permanently
// crawlable. The protections in 4e2163e are unaffected: nothing here touches the wire payload, the
// source roster or any feed.
const probe = unstable_cache(
  async (symbol) => {
    const res = await db.execute(sql`
      SELECT
        EXISTS (SELECT 1 FROM screener_stocks      WHERE ticker = ${symbol}) AS a,
        EXISTS (SELECT 1 FROM insider_trades       WHERE ticker = ${symbol}) AS b,
        EXISTS (SELECT 1 FROM ticker_daily_candles WHERE ticker = ${symbol}) AS c,
        EXISTS (SELECT 1 FROM fund_holdings        WHERE ticker = ${symbol}) AS d,
        EXISTS (SELECT 1 FROM eightk_filings       WHERE ticker = ${symbol}) AS e,
        EXISTS (SELECT 1 FROM congress_trades      WHERE ticker = ${symbol}) AS f
    `);
    const row = (res?.rows ?? res ?? [])[0] || {};
    return Object.values(row).some((v) => v === true || v === 't' || v === 1);
  },
  ['ticker-symbol-known'],
  // The set of symbols we hold data for moves on the timescale of a filing, not a quote. Six hours
  // keeps a crawl of thousands of ticker URLs from becoming thousands of database round trips.
  { revalidate: 21600, tags: ['ticker-symbol-known'] },
);

/**
 * True only if we can positively demonstrate we hold data for `symbol`.
 *
 * A database failure returns false, i.e. "unresolved". That is the safe direction: an unresolved
 * ticker is still fully usable, it is merely not advertised to Google as a verified security, and a
 * transient outage costs a re-crawl rather than a wrong claim. The opposite default would let an
 * outage mark every arbitrary string as verified.
 */
export async function isKnownSymbol(symbol) {
  if (!symbol) return false;
  try {
    return await probe(symbol);
  } catch (err) {
    console.error('[ticker-resolve] probe failed', err?.message || err);
    return false;
  }
}
