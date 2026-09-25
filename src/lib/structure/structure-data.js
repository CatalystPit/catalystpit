// Market Structure — the database half. Read-only.
//
// One query for the adjusted daily history, one for the continuity verdict. Everything else is the
// pure engine. ticker_daily_candles already stores Tiingo's adjusted series, so splits and dividends
// are handled at ingest and no level here needs correcting for them.
//
// What adjustment cannot fix is a series that stops describing the same security — a retired symbol
// reassigned, or a reverse split the vendor never applied. price-continuity.mjs detects those; a
// support level built across one is a level from two different companies, so an unusable series
// produces no structure at all rather than confident nonsense.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { marketStructure } from './engine.mjs';

const rows = (res) => res?.rows ?? res ?? [];

/** How much daily history the engine is given. Monthly structure needs years, not months. */
export const HISTORY_DAYS = 365 * 12;

export async function loadDailyHistory(ticker, { asOf = null, days = HISTORY_DAYS, ctx = null } = {}) {
  const symbol = String(ticker || '').toUpperCase();
  const cutoff = asOf ? String(asOf).slice(0, 10) : null;
  // ⚠️ ONE CANDLE LOAD PER TICKER SERVES THREE READERS. The context holds the full HISTORY_DAYS
  // window; market facts (400d) and the reaction attach (evidence age + pad) are strict subsets and
  // filter it in memory. The predicate below is reproduced exactly so the rows are the same rows.
  const pre = ctx?.rows('price.candles', symbol);
  const res = pre ?? await db.execute(sql`
    select date::text as date, open, high, low, close, volume
      from ticker_daily_candles
     where ticker = ${symbol}
       and date >= (current_date - make_interval(days => ${days}))
       ${cutoff ? sql`and date <= ${cutoff}` : sql``}
     order by date asc`);
  return rows(res)
    .filter((r) => !cutoff || String(r.date) <= cutoff)
    .map((r) => ({
    date: String(r.date),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: Number(r.volume) || 0,
  })).filter((b) => Number.isFinite(b.close) && Number.isFinite(b.high) && Number.isFinite(b.low));
}

export async function loadPriceQuality(ticker, { ctx = null } = {}) {
  const symbol = String(ticker || '').toUpperCase();
  try {
    const pre = ctx?.rows('price.quality', symbol);
    const res = pre ?? await db.execute(sql`
      select coalesce(usable, true) as usable, reason, last_break::text as last_break, break_count
        from ticker_price_quality where ticker = ${symbol}`);
    const r = rows(res)[0];
    // Unscanned tickers are treated as usable, which is what every other surface does.
    return r ? { usable: r.usable !== false, reason: r.reason, lastBreak: r.last_break, breakCount: Number(r.break_count || 0) } : null;
  } catch { return null; }
}

/** The engine, against real stored candles. Two queries, run in parallel. */
export async function tickerStructure(ticker, { asOf = null, ctx = null } = {}) {
  const [bars, quality] = await Promise.all([
    loadDailyHistory(ticker, { asOf, ctx }),
    loadPriceQuality(ticker, { ctx }),
  ]);
  const structure = marketStructure(bars, { asOf, priceQuality: quality });
  return { ticker: String(ticker).toUpperCase(), bars: bars.length, priceQuality: quality, ...structure };
}
