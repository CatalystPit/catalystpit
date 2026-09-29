import 'server-only';
import { unstable_cache } from 'next/cache';
import { sql } from 'drizzle-orm';
import { db } from './db';

// DOES THE SERVER-RENDERED TICKER PAGE FOR THIS SYMBOL CONTAIN ANYTHING?
//
// That is the whole question, and it decides two things that must never disagree: whether the page is
// served index:true, and whether the sitemap advertises it. Both come from the sources listed once
// below, so they cannot drift.
//
// ── ⚠️ WHY THIS IS NO LONGER "IS THE SYMBOL IN ANY OF SIX TABLES" ────────────
//
// It used to take a row in ANY of screener_stocks, insider_trades, ticker_daily_candles,
// fund_holdings, eightk_filings or congress_trades as proof the symbol was a security worth indexing.
// Measured against the live corpus, that advertised 1,809 URLs whose page renders NOTHING BUT THE
// SYMBOL — no company name from either identity source, no listing fact, no close, no filing, no
// holding. Fetched from production: /ticker/ALXN, /ticker/BITF and /ticker/AACB each returned a page
// whose entire body text was the ticker string, and /ticker/AAGPX and /ticker/AAGRW returned an empty
// card.
//
// 1,543 of those 1,809 were there on the strength of fund_holdings alone, and that is the specific
// defect: fund_holdings.ticker is FILER-SUPPLIED on a 13F. It carries mutual-fund share classes
// (1,022 of the 1,809 end in X — AAGPX, AALTX, ABTHX), foreign ordinaries (…F), warrants (…W),
// rights (…R), units (…U) and at least one currency pair, ABNYUSD. A fund saying it holds something
// is not evidence that we have a page's worth of content about it. The reverse-13F product still
// reads fund_holdings exactly as before; it simply stops being a claim made to Google.
//
// ⚠️ AND THE SAME MEASUREMENT FOUND THE OPPOSITE ERROR, LARGER. 2,323 symbols carry a company name —
// every one of them — and were served noindex and left out of the sitemap, because a name in
// security_identity was not among the six things asked about. AAGH renders "America Great Health",
// AATC "AUTOSCOPE TECHNOLOGIES CORP", ABAKF "ABRDN ASIA-PACIFIC INCOME FUND, INC.", all noindex. That
// is the same class of defect as the ticker page reading only screener_stocks for its identity.
//
// Net: 20,519 advertised URLs become 21,033, and the 1,809 that leave are the ones with nothing on
// them. This is not a quality threshold and not a judgement about which companies matter — it is the
// difference between a page that has content and a page that does not, which is why it is safe to
// apply automatically and why it heals itself: the moment we ingest a name or a filing for BITF, its
// page has content and becomes indexable again with no list to maintain.
//
// SOURCE EXPOSURE: the per-symbol return value is a single boolean. No table name, no column, no row
// and no count crosses back to the caller, let alone into the HTML — which matters more here than in
// an API response, because anything a server component renders is permanently crawlable.

// The listing facts the page's About block actually prints. `country` is in the list because it is
// rendered: AAVVF's page reads "ADVANTAGE ENERGY LTD · Country USA", and an earlier draft of this
// rule that omitted country would have dropped it.
const SCREENER_RENDERS = sql`
  (company IS NOT NULL AND company <> '') OR exchange IS NOT NULL OR sector IS NOT NULL
  OR industry IS NOT NULL OR country IS NOT NULL OR asset_type IS NOT NULL OR market_cap IS NOT NULL`;

const probe = unstable_cache(
  async (symbol) => {
    // Seven EXISTS in one statement. Every column probed carries a btree index on ticker (two are
    // primary keys), so each is an index lookup that short-circuits on the first row.
    const res = await db.execute(sql`
      SELECT
        EXISTS (SELECT 1 FROM security_identity WHERE ticker = ${symbol}
                  AND name IS NOT NULL AND name <> '')                            AS a,
        EXISTS (SELECT 1 FROM screener_stocks WHERE ticker = ${symbol}
                  AND (${SCREENER_RENDERS}))                                      AS b,
        EXISTS (SELECT 1 FROM insider_trades WHERE ticker = ${symbol})            AS c,
        EXISTS (SELECT 1 FROM ticker_institutional_ownership WHERE ticker = ${symbol}
                  AND filer_count > 0)                                            AS d,
        EXISTS (SELECT 1 FROM eightk_filings WHERE ticker = ${symbol})            AS e,
        EXISTS (SELECT 1 FROM congress_trades WHERE ticker = ${symbol})           AS f,
        EXISTS (SELECT 1 FROM ticker_daily_candles WHERE ticker = ${symbol})      AS g
    `);
    const row = (res?.rows ?? res ?? [])[0] || {};
    return Object.values(row).some((v) => v === true || v === 't' || v === 1);
  },
  ['ticker-symbol-known'],
  // The set of symbols we hold content for moves on the timescale of a filing, not a quote. Six hours
  // keeps a crawl of thousands of ticker URLs from becoming thousands of database round trips.
  { revalidate: 21600, tags: ['ticker-symbol-known'] },
);

/**
 * True only if the server-rendered page for `symbol` would contain something.
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

const SITEMAP_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * THE DATE THE PAGE'S SUBSTANTIVE CONTENT LAST CHANGED, per symbol — or nothing.
 *
 * ⚠️ A REAL TIMESTAMP OR NONE AT ALL. The sitemap has always omitted lastmod, for the recorded reason
 * that `new Date()` at build time is a fabrication Google discounts. What it also recorded is that the
 * date becomes genuine once the page server-renders its content — which it now does. These are the
 * four events the SSR payload actually prints: the newest Form 4 filing, 8-K, congressional
 * disclosure and news item. When one of them lands, the rendered page changes; that is what a lastmod
 * is supposed to mean.
 *
 * ⚠️ DELIBERATELY NOT THE LAST CLOSE. A candle arrives for ~13,500 symbols every trading day, so
 * using it would stamp two thirds of the file with yesterday's date and ask Google to recrawl 13,500
 * URLs daily to observe one number. Understating change costs a later re-crawl; overstating it on
 * that scale trains the crawler to ignore the field.
 *
 * A symbol with none of the four gets no lastmod rather than a guess. Four aggregates, in parallel,
 * behind the sitemap's 24-hour revalidate — measured at 4.4s, dominated by the insider one.
 */
export async function tickerLastModified() {
  const sources = [
    sql`SELECT ticker, max(filing_date)::text AS d FROM insider_trades
         WHERE is_amendment IS NOT TRUE GROUP BY 1`,
    sql`SELECT ticker, max(filed_at)::date::text AS d FROM eightk_filings GROUP BY 1`,
    sql`SELECT ticker, max(disclosure_date)::text AS d FROM congress_trades
         WHERE ticker IS NOT NULL GROUP BY 1`,
    sql`SELECT unnest(tickers) AS ticker, max(published_at)::date::text AS d FROM primary_events
         WHERE cluster_id IS NULL AND display_ready GROUP BY 1`,
  ];
  const out = new Map();
  try {
    const results = await Promise.all(sources.map((q) => db.execute(q)));
    const today = new Date().toISOString().slice(0, 10);
    for (const res of results) {
      for (const r of (res?.rows ?? res ?? [])) {
        const t = String(r.ticker ?? '');
        const d = String(r.d ?? '');
        if (!SITEMAP_SYMBOL.test(t) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        // A stored date in the future would advertise a modification that has not happened.
        if (d > today) continue;
        const prev = out.get(t);
        if (!prev || d > prev) out.set(t, d);
      }
    }
  } catch (err) {
    // No lastmod is a complete, valid sitemap. A failure here must not cost the file.
    console.error('[ticker-resolve] tickerLastModified failed', err?.message || err);
    return new Map();
  }
  return out;
}

/**
 * EVERY SYMBOL THAT WOULD BE SERVED index:true — the sitemap's set, by construction.
 *
 * ⚠️ IT IS THE SAME SEVEN SOURCES isKnownSymbol PROBES, asked once in bulk instead of once per symbol.
 * The sitemap and the robots directive must not be able to disagree about which ticker URLs are
 * indexable: advertising a URL we then serve noindex wastes a crawl and teaches Google to trust the
 * file less, and omitting one we DO index is the gap this exists to close. Deriving both from one
 * definition is what makes that a property rather than a promise.
 *
 * Bounded and shaped: the symbol filter is the canonical form the route redirects to, so nothing
 * lowercase, suffixed or malformed can enter the file — those URLs are 308s or 404s, never content.
 */
export async function knownSymbols({ limit = 50000 } = {}) {
  // ⚠️ ONE QUERY PER SOURCE, IN PARALLEL — NOT ONE UNION. As a single statement with the shape filter
  // and ORDER BY on top, the planner took 59 SECONDS; the same DISTINCTs asked separately cost
  // 0.06–3.5s each and run concurrently. A sitemap that takes a minute to build is a sitemap that
  // times out on the crawl it exists for.
  const sources = [
    sql`SELECT ticker FROM security_identity WHERE name IS NOT NULL AND name <> ''`,
    sql`SELECT ticker FROM screener_stocks WHERE ${SCREENER_RENDERS}`,
    sql`SELECT DISTINCT ticker FROM insider_trades`,
    sql`SELECT ticker FROM ticker_institutional_ownership WHERE filer_count > 0`,
    sql`SELECT DISTINCT ticker FROM eightk_filings`,
    sql`SELECT DISTINCT ticker FROM congress_trades WHERE ticker IS NOT NULL`,
    sql`SELECT DISTINCT ticker FROM ticker_daily_candles`,
  ];
  try {
    const results = await Promise.all(sources.map((q) => db.execute(q)));
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
