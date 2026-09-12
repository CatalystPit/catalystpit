import { db } from '../../../lib/db';
import { congressTrades, congressTickerPrices, tickerPriceQuality } from '../../../lib/schema';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { analyzeSeries } from '../../../lib/price-continuity.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

// NOTE: trade INGEST now runs in /api/cron/congress-sync (official House Clerk +
// Senate eFD sources; FMP retired). This cron is enrichment-only. It uses POLYGON
// (unlimited for stocks on our plan) on ONE consistent split-adjusted basis for
// BOTH price_at_trade and current_price — no more Tiingo 30/night throttle, no
// raw-vs-adjusted split mismatch.
const CRON_SECRET     = process.env.CRON_SECRET;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;

// Polygon is unlimited for stocks, so caps are bounded only by maxDuration.
const PRICE_TICKER_CAP    = 150; // new tickers priced per tick
const PRICE_REFRESH_BATCH = 150; // current-price refreshes per tick (most-stale first)
const TODAY = () => new Date().toISOString().slice(0, 10);
const isoDay = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));

// Whole-history split-adjusted daily bars for a ticker (asc). One call covers entry + current.
async function polyBars(ticker) {
  try {
    const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/2022-01-01/${TODAY()}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).map((b) => ({ date: new Date(b.t).toISOString().slice(0, 10), c: b.c }));
  } catch { return []; }
}
const onOrBefore = (bars, target) => { let hit = null; for (const b of bars) { if (b.date <= target) hit = b; else break; } return hit; };

// ── 1. enrich price_at_trade (Polygon adjusted close) for un-priced rows ──
async function enrichPrices(results) {
  try {
    const tickers = await db.selectDistinct({ ticker: congressTrades.ticker })
      .from(congressTrades)
      .where(and(isNull(congressTrades.priceAtTrade), isNotNull(congressTrades.ticker)))
      .limit(PRICE_TICKER_CAP);
    if (!tickers.length) { console.log('[congress] price_at_trade: nothing to enrich'); return; }

    let priced = 0;
    for (const { ticker } of tickers) {
      const rows = await db.select({ id: congressTrades.id, td: congressTrades.transactionDate })
        .from(congressTrades)
        .where(and(eq(congressTrades.ticker, ticker), isNull(congressTrades.priceAtTrade)));
      const bars = await polyBars(ticker);
      if (!bars.length) continue;
      for (const row of rows) {
        if (!row.td) continue;
        const p = onOrBefore(bars, isoDay(row.td));
        if (!p) continue;
        await db.update(congressTrades)
          .set({ priceAtTrade: p.c, priceAtTradeDate: p.date, enrichedAt: new Date() })
          .where(eq(congressTrades.id, row.id));
        priced++;
      }
      // fold in the current price from the same bars (avoids a second fetch)
      const cur = bars[bars.length - 1].c;
      await db.insert(congressTickerPrices)
        .values({ ticker, currentPrice: cur, updatedAt: new Date() })
        .onConflictDoUpdate({ target: congressTickerPrices.ticker, set: { currentPrice: cur, updatedAt: new Date() } });
    }
    console.log(`[congress] price_at_trade: enriched ${priced} rows across ${tickers.length} tickers`);
    results.refreshed.push(`congress:price_at_trade:rows=${priced}`);
  } catch (e) {
    console.log(`[congress] enrichPrices failed: ${e.message}`);
    results.failed.push({ step: 'enrichPrices', error: e.message });
  }
}

// ── 2. rolling current_price refresh (Polygon adjusted close, most-stale first) ──
async function refreshCurrentPrices(results) {
  try {
    const stale = await db
      .selectDistinct({ ticker: congressTrades.ticker, updatedAt: congressTickerPrices.updatedAt })
      .from(congressTrades)
      .leftJoin(congressTickerPrices, eq(congressTickerPrices.ticker, congressTrades.ticker))
      .where(isNotNull(congressTrades.ticker))
      .orderBy(sql`${congressTickerPrices.updatedAt} asc nulls first`)
      .limit(PRICE_REFRESH_BATCH);
    if (!stale.length) return;

    let updated = 0;
    for (const { ticker } of stale) {
      const bars = await polyBars(ticker);
      const cur = bars.length ? bars[bars.length - 1].c : null;
      // Always bump updated_at (even on null) so the ticker rotates to the back of the queue.
      await db.insert(congressTickerPrices)
        .values({ ticker, currentPrice: cur, updatedAt: new Date() })
        .onConflictDoUpdate({ target: congressTickerPrices.ticker, set: { currentPrice: cur, updatedAt: new Date() } });
      if (cur != null) updated++;

      // The continuity verdict is refreshed from the SAME bars, so the protection maintains itself.
      // A symbol reassigned next month would otherwise keep producing returns across the break until
      // someone remembered to run scripts/scan-price-breaks.mjs by hand.
      if (bars.length) {
        const a = analyzeSeries(bars.map((b) => ({ date: b.date, close: b.c })));
        await db.insert(tickerPriceQuality)
          .values({ ticker, usable: a.usable, reason: a.reason, lastBreak: a.lastBreak,
            breakCount: a.breaks.length, bars: a.bars, level: a.level, scannedAt: new Date() })
          .onConflictDoUpdate({ target: tickerPriceQuality.ticker,
            set: { usable: a.usable, reason: a.reason, lastBreak: a.lastBreak,
              breakCount: a.breaks.length, bars: a.bars, level: a.level, scannedAt: new Date() } });
      }
    }
    console.log(`[congress] current_price: refreshed ${updated}/${stale.length} tickers`);
    results.refreshed.push(`congress:current_price:ok=${updated}/${stale.length}`);
  } catch (e) {
    console.log(`[congress] refreshCurrentPrices failed: ${e.message}`);
    results.failed.push({ step: 'refreshCurrentPrices', error: e.message });
  }
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const results = { refreshed: [], failed: [], timestamp: new Date().toISOString() };

  // Sequential so the 60s budget is shared predictably; each step is independent
  // and self-contained (a failure in one logs and the next still runs).
  await enrichPrices(results);
  await refreshCurrentPrices(results);

  return Response.json(results, { status: 200 });
}
