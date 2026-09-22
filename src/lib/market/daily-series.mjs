// SPLIT-ADJUSTED DAILY CLOSES FOR ONE TICKER — stored first, provider only for the gap.
//
// ⚠️ ONE HELPER, BECAUSE THREE CALLERS WERE EACH DOING THIS AGAINST POLYGON. The congress price
// enricher, the insider-performance cron and the congress chart all wanted the same thing: a
// split-adjusted daily close series, to price a trade on the day it happened and again today.
// Each had its own `polyBars()` hitting Polygon directly, which meant three copies of the same
// request shape on a provider whose redistribution rights we never established.
//
// ── STORED FIRST, AND THAT IS THE SCALING RULE ──────────────────────────────
//
// ticker_daily_candles already holds Tiingo split-adjusted history for everything the product
// charts. Reading it costs one indexed query and no vendor request at all; the provider is only
// consulted for a ticker (or a span) we do not yet hold, and what comes back is written so the
// next caller does not ask again. Vendor usage therefore scales with how many DISTINCT securities
// we have ever needed, not with how often a cron runs or how many people are looking.
//
// ⚠️ AND THE ADJUSTMENT CONVENTION IS THE STORED ONE. Everything written here goes through
// tiingoDailyToCanonical, so a close fetched today sits in the same table, on the same basis, as
// one written by /api/chart-daily two years ago. Mixing an adjusted series with a raw one under
// the same column names is how a trade marker ends up at the wrong price.

import { db } from '../db';
import { tickerDailyCandles } from '../schema';
import { and, eq, gte, lte, asc } from 'drizzle-orm';

/**
 * @returns [{ date: 'YYYY-MM-DD', close: number }] ascending, or [] when nothing is available.
 *
 * `fetchMissing: false` reads storage only — for callers that must not touch a provider at all.
 */
export async function dailyCloses(ticker, from, to, { fetchMissing = true } = {}) {
  const sym = String(ticker || '').toUpperCase().trim();
  if (!sym || !from || !to) return [];

  const read = async () => {
    const rows = await db
      .select({ date: tickerDailyCandles.date, close: tickerDailyCandles.close })
      .from(tickerDailyCandles)
      .where(and(eq(tickerDailyCandles.ticker, sym),
        gte(tickerDailyCandles.date, from), lte(tickerDailyCandles.date, to)))
      .orderBy(asc(tickerDailyCandles.date));
    return rows
      .map((r) => ({ date: String(r.date).slice(0, 10), close: Number(r.close) }))
      .filter((r) => r.date && Number.isFinite(r.close) && r.close > 0);
  };

  let series = await read();

  // ⚠️ "ENOUGH" IS DELIBERATELY NOT "COMPLETE". A span never has a bar for every calendar day —
  // weekends, holidays and a security's own listing date all leave real gaps, and demanding a
  // full span would re-fetch on every call forever. Roughly two thirds of weekdays covered means
  // we hold the series; below that it is worth asking once.
  const weekdays = countWeekdays(from, to);
  const enough = weekdays === 0 || series.length >= Math.floor(weekdays * 0.6);
  if (enough || !fetchMissing) return series;

  try {
    const [{ getDailyBars }, { tiingoDailyToCanonical }] = await Promise.all([
      import('./tiingo.mjs'), import('./candles.mjs'),
    ]);
    const res = await getDailyBars(sym, { from, to });
    if (!res?.ok || !res.bars?.length) return series;

    // getDailyBars names the day `time`; the canonical converter expects `date`. splitFactor is
    // what makes the adjustment exact rather than approximate, so it is passed through.
    const canonical = tiingoDailyToCanonical(res.bars.map((b) => ({
      date: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume, splitFactor: b.splitFactor,
    })), { ticker: sym });
    if (!canonical.length) return series;

    const CHUNK = 1000;      // 8 columns per row against Postgres' 65535 bind-param cap
    for (let i = 0; i < canonical.length; i += CHUNK) {
      await db.insert(tickerDailyCandles).values(canonical.slice(i, i + CHUNK))
        .onConflictDoNothing({ target: [tickerDailyCandles.ticker, tickerDailyCandles.date] });
    }
    series = await read();
  } catch {
    // A provider failure returns whatever storage had. Fewer points is a smaller chart; a
    // fabricated point is a wrong one.
  }
  return series;
}

/** The close on or just before a date — the "price at trade" question, unchanged in meaning. */
export function closeOnOrBefore(series, targetDate) {
  const target = String(targetDate || '').slice(0, 10);
  if (!target) return null;
  let hit = null;
  for (const b of series) { if (b.date <= target) hit = b; else break; }
  return hit;
}

function countWeekdays(from, to) {
  const a = Date.parse(`${from}T12:00:00Z`), b = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  let n = 0;
  for (let t = a; t <= b; t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
  }
  return n;
}
