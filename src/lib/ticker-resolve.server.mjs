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
/**
 * EVERY SYMBOL THAT WOULD BE SERVED index:true — the sitemap's set, by construction.
 *
 * ⚠️ IT IS THE SAME SIX TABLES isKnownSymbol PROBES, asked once in bulk instead of once per symbol.
 * The sitemap and the robots directive must not be able to disagree about which ticker URLs are
 * indexable: advertising a URL we then serve noindex wastes a crawl and teaches Google to trust the
 * file less, and omitting one we DO index is the gap this exists to close. Deriving both from one
 * definition is what makes that a property rather than a promise.
 *
 * Bounded and shaped: the symbol filter is the canonical form the route redirects to, so nothing
 * lowercase, suffixed or malformed can enter the file — those URLs are 308s or 404s, never content.
 */
export async function knownSymbols({ limit = 50000 } = {}) {
  // ⚠️ SIX QUERIES IN PARALLEL, MERGED HERE — NOT ONE UNION. As a single statement with the shape
  // filter and ORDER BY on top, the planner took 59 SECONDS; the same six DISTINCTs asked separately
  // cost 0.06–2.0s each and run concurrently. A sitemap that takes a minute to build is a sitemap
  // that times out on the crawl it exists for.
  const tables = [
    sql`SELECT DISTINCT ticker FROM screener_stocks`,
    sql`SELECT DISTINCT ticker FROM insider_trades`,
    sql`SELECT DISTINCT ticker FROM ticker_daily_candles`,
    sql`SELECT DISTINCT ticker FROM fund_holdings WHERE ticker IS NOT NULL`,
    sql`SELECT DISTINCT ticker FROM eightk_filings`,
    sql`SELECT DISTINCT ticker FROM congress_trades WHERE ticker IS NOT NULL`,
  ];
  try {
    const results = await Promise.all(tables.map((q) => db.execute(q)));
    const seen = new Set();
    for (const res of results) {
      for (const r of (res?.rows ?? res ?? [])) {
        const t = String(r.ticker ?? '');
        // The canonical form the route redirects TO. Anything lowercase, suffixed or malformed is a
        // 308 or a 404, never content, so it must not enter the file.
        if (SITEMAP_SYMBOL.test(t)) seen.add(t);
      }
    }
    return [...seen].sort().slice(0, limit);
  } catch (err) {
    // A sitemap that cannot be built is served without tickers rather than not served at all — the
    // static routes still matter, and the next revalidation gets another go.
    console.error('[ticker-resolve] knownSymbols failed', err?.message || err);
    return [];
  }
}

const SITEMAP_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;

export async function isKnownSymbol(symbol) {
  if (!symbol) return false;
  try {
    return await probe(symbol);
  } catch (err) {
    console.error('[ticker-resolve] probe failed', err?.message || err);
    return false;
  }
}
