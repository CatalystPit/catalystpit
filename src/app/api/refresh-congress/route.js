import { db } from '../../../lib/db';
import { congressTrades, congressTickerPrices } from '../../../lib/schema';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  fetchTiingoDaily, pickPriceOnOrBefore, fetchFinnhubQuote, throttle,
} from '../../../lib/congress-ingest.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

// NOTE: trade INGEST now runs in /api/cron/congress-sync (official House Clerk +
// Senate eFD sources; FMP retired). This cron is enrichment-only: it fills
// price_at_trade (Tiingo) and rolls current_price (Finnhub) for ingested rows.
const CRON_SECRET    = process.env.CRON_SECRET;
const TIINGO_API_KEY = process.env.TIINGO_API_KEY;
const FINNHUB_KEY    = process.env.FINNHUB_KEY;

// Per-tick caps keep the function inside maxDuration AND under provider limits.
// price_at_trade is immutable, so over a few nights every ticker gets priced;
// current_price refreshes the most-stale tickers, cycling all of them in ~3-4
// nights (rolling) — fresh enough for a since-trade signal spanning weeks.
const TIINGO_TICKER_CAP   = 30;  // new tickers priced per tick (< Tiingo 50/hr)
const PRICE_REFRESH_BATCH = 40;  // current-price refreshes per tick (Finnhub ~60/min)

// ── 1. enrich price_at_trade (Tiingo EOD) for un-priced rows ──
async function enrichPrices(results) {
  try {
    const tickers = await db.selectDistinct({ ticker: congressTrades.ticker })
      .from(congressTrades)
      .where(and(isNull(congressTrades.priceAtTrade), isNotNull(congressTrades.ticker)))
      .limit(TIINGO_TICKER_CAP);
    if (!tickers.length) { console.log('[congress] price_at_trade: nothing to enrich'); return; }

    let priced = 0;
    await throttle(tickers, 3, 1500, async ({ ticker }) => {
      const rows = await db.select({ id: congressTrades.id, td: congressTrades.transactionDate })
        .from(congressTrades)
        .where(and(eq(congressTrades.ticker, ticker), isNull(congressTrades.priceAtTrade)));
      const dates = rows.map(r => r.td).filter(Boolean).sort();
      if (!dates.length) return;
      const { ok, data } = await fetchTiingoDaily(ticker, dates[0], dates[dates.length - 1], TIINGO_API_KEY);
      if (!ok || !Array.isArray(data)) { console.log(`[congress] tiingo ${ticker}: miss`); return; }
      for (const row of rows) {
        if (!row.td) continue;
        const p = pickPriceOnOrBefore(data, row.td);
        if (!p) continue;
        await db.update(congressTrades)
          .set({ priceAtTrade: p.price, priceAtTradeDate: p.priceDate, enrichedAt: new Date() })
          .where(eq(congressTrades.id, row.id));
        priced++;
      }
    });
    console.log(`[congress] price_at_trade: enriched ${priced} rows across ${tickers.length} tickers`);
    results.refreshed.push(`congress:price_at_trade:rows=${priced}`);
  } catch (e) {
    console.log(`[congress] enrichPrices failed: ${e.message}`);
    results.failed.push({ step: 'enrichPrices', error: e.message });
  }
}

// ── 2. rolling current_price refresh (Finnhub /quote, most-stale first) ──
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
    await throttle(stale, 4, 4000, async ({ ticker }) => {
      const q = await fetchFinnhubQuote(ticker, FINNHUB_KEY);
      // Always bump updated_at — even on a null quote (dead/unknown ticker) —
      // so it rotates to the back of the queue and the rolling cycle progresses.
      await db.insert(congressTickerPrices)
        .values({ ticker, currentPrice: q ? q.price : null, asOfDate: q ? q.asOf : null, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: congressTickerPrices.ticker,
          set: { currentPrice: q ? q.price : null, asOfDate: q ? q.asOf : null, updatedAt: new Date() },
        });
      if (q) updated++;
    });
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
