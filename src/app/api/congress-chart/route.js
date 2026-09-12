import { db } from '../../../lib/db';
import { congressTrades, tickerDailyCandles } from '../../../lib/schema';
import { and, eq, gte, lte, sql, asc } from 'drizzle-orm';
import {
  resolveRange, startDateFor, isoDate, fetchPolygonDaily, spanToFetch, DEFAULT_RANGE, RANGES,
  lastFetchableDay, MAX_RANGE,
} from '../../../lib/congress-chart.mjs';

export const runtime = 'nodejs';

// Price series + congressional trade markers for ONE ticker over ONE range.
//
// Deliberately scoped: the browser never receives three years of every politician's activity.
// A request is bounded by ticker and by range, and the trades returned are only those whose
// transaction date falls inside the window actually being charted.
//
//   /api/congress-chart?ticker=NVDA&range=6M
//
// Price data is Polygon, cached in ticker_daily_candles (see lib/congress-chart.mjs for why).

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const CACHE = { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' };

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get('ticker')?.toUpperCase().trim() || '';
    // Over-max requests clamp DOWN to 3Y rather than falling back to the default: asking for
    // 5Y and receiving 6M would hand back less history than asking for nothing. Only genuinely
    // malformed input is rejected.
    const resolved = resolveRange(searchParams.get('range'));

    if (!TICKER_RE.test(ticker)) {
      return Response.json({ error: 'invalid ticker', ranges: RANGES }, { status: 400 });
    }
    if (resolved.invalid) {
      return Response.json({ error: 'invalid range', ranges: RANGES, max: MAX_RANGE }, { status: 400 });
    }
    const range = resolved.range;

    const now = new Date();
    const startDate = startDateFor(range, now);
    const endDate = isoDate(now);

    // What do we already hold for this ticker?
    const [cov] = await db
      .select({ minD: sql`min(${tickerDailyCandles.date})`, maxD: sql`max(${tickerDailyCandles.date})` })
      .from(tickerDailyCandles)
      .where(eq(tickerDailyCandles.ticker, ticker));
    const minStored = cov?.minD ? String(cov.minD).slice(0, 10) : null;
    const maxStored = cov?.maxD ? String(cov.maxD).slice(0, 10) : null;

    const fetchFrom = spanToFetch({ minStored, maxStored, startDate, endDate });
    const fetchTo = lastFetchableDay(now);
    let fetched = 0, priceError = null;

    // Skip when the only missing day is today: Polygon rejects a today-only window on our plan.
    if (fetchFrom && fetchFrom <= fetchTo) {
      const { ok, bars, reason } = await fetchPolygonDaily(ticker, fetchFrom, fetchTo);
      if (!ok) {
        priceError = reason;
      } else if (bars.length) {
        const rows = bars.map((b) => ({ ...b, ticker, source: 'polygon' }));
        // 8 columns per row against Postgres' 65535 bind-param cap; 1000 keeps a wide margin
        // and comfortably handles a cold 3-year fetch (~750 rows).
        const CHUNK = 1000;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const ins = await db.insert(tickerDailyCandles)
            .values(rows.slice(i, i + CHUNK))
            .onConflictDoNothing({ target: [tickerDailyCandles.ticker, tickerDailyCandles.date] })
            .returning({ date: tickerDailyCandles.date });
          fetched += ins.length;
        }
      }
    }

    const candles = await db
      .select({
        date: tickerDailyCandles.date, open: tickerDailyCandles.open, high: tickerDailyCandles.high,
        low: tickerDailyCandles.low, close: tickerDailyCandles.close, volume: tickerDailyCandles.volume,
      })
      .from(tickerDailyCandles)
      .where(and(
        eq(tickerDailyCandles.ticker, ticker),
        gte(tickerDailyCandles.date, startDate),
        lte(tickerDailyCandles.date, endDate),
      ))
      .orderBy(asc(tickerDailyCandles.date));

    // Trades inside the charted window only. amount_range is carried through verbatim because it
    // is what the filer actually disclosed; amount_mid comes along solely to size markers and is
    // labelled as an estimate wherever it surfaces.
    const trades = await db
      .select({
        id: congressTrades.id,
        representative: congressTrades.representative,
        memberSlug: congressTrades.memberSlug,
        chamber: congressTrades.chamber,
        party: congressTrades.party,
        state: congressTrades.state,
        district: congressTrades.district,
        ticker: congressTrades.ticker,
        action: congressTrades.action,
        type: congressTrades.type,
        owner: congressTrades.owner,
        amountRange: congressTrades.amountRange,
        amountMid: congressTrades.amountMid,
        transactionDate: congressTrades.transactionDate,
        disclosureDate: congressTrades.disclosureDate,
        filingLagDays: congressTrades.filingLagDays,
        link: congressTrades.link,
      })
      .from(congressTrades)
      .where(and(
        eq(congressTrades.ticker, ticker),
        gte(congressTrades.transactionDate, startDate),
        lte(congressTrades.transactionDate, endDate),
      ))
      .orderBy(asc(congressTrades.transactionDate));

    return Response.json({
      ticker, range, startDate, endDate,
      rangeClamped: resolved.clamped,   // lets the UI say the window was capped at 3 years
      candles, trades,
      counts: {
        candles: candles.length,
        trades: trades.length,
        buys: trades.filter((t) => t.action === 'BUY').length,
        sells: trades.filter((t) => t.action === 'SELL').length,
        other: trades.filter((t) => t.action !== 'BUY' && t.action !== 'SELL').length,
      },
      fetched,
      priceError,
    }, { headers: CACHE });
  } catch (e) {
    console.error('[congress_chart]', e);
    return Response.json({ error: 'chart unavailable' }, { status: 500 });
  }
}
