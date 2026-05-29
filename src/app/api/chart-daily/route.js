import { db } from '../../../lib/db';
import { tickerDailyCandles } from '../../../lib/schema';
import { and, eq, gte, lte, asc, sql } from 'drizzle-orm';
import { fetchTiingoDaily } from '../../../lib/congress-ingest.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const TIINGO_API_KEY = process.env.TIINGO_API_KEY;

// Daily-range timeframes served by this route (intraday 1D/5D live in /api/chart-intraday).
const RANGES = new Set(['1M', '3M', '6M', 'YTD', '1Y', '5Y', 'all']);
const DEFAULT_RANGE = '3M';

// Same ticker format gate as /api/ticker — uppercase, leading letter, alnum + . -, ≤10.
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

const DAY = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);          // UTC YYYY-MM-DD
const nextDay = (d) => isoDate(Date.parse(d) + DAY);
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;

// Earliest boundary for "all" — Tiingo only returns from the ticker's actual
// inception anyway, so this floor is just a safe lower bound (no IPO lookup needed).
const ALL_FLOOR = '1990-01-01';

// Boundary tolerance (calendar days): a cache whose earliest stored row is within
// this many days of the requested start is treated as already covering the head —
// prevents weekend/holiday boundaries from triggering a needless re-fetch, while a
// genuinely wider range (e.g. 1M→5Y, ~tens-to-thousands of days) still backfills.
const HEAD_TOL = 7;

function startDateFor(range, now) {
  switch (range) {
    case '1M':  return isoDate(now - 30 * DAY);
    case '3M':  return isoDate(now - 90 * DAY);
    case '6M':  return isoDate(now - 180 * DAY);
    case 'YTD': return `${new Date(now).getUTCFullYear()}-01-01`;
    case '1Y':  return isoDate(now - 365 * DAY);
    case '5Y':  return isoDate(now - 1825 * DAY);
    case 'all': return ALL_FLOOR;
    default:    return isoDate(now - 90 * DAY);
  }
}

export async function GET(request) {
  let ticker = '', range = DEFAULT_RANGE;
  try {
    const params = new URL(request.url).searchParams;
    ticker = (params.get('ticker') || '').toUpperCase().trim();
    range  = params.get('range') || DEFAULT_RANGE;
    if (!RANGES.has(range)) range = DEFAULT_RANGE;     // invalid/missing → default 3M

    if (!TICKER_RE.test(ticker)) {
      return Response.json({ ticker, range, count: 0, candles: [], error: 'invalid_ticker', meta: { cached: 0, fetched: 0 } });
    }

    const now = Date.now();
    const startDate = startDateFor(range, now);
    const endDate = isoDate(now);

    // Ticker's global stored coverage drives the fetch decision (cheap, Postgres-only).
    const [cov] = await db
      .select({ minD: sql`min(${tickerDailyCandles.date})`, maxD: sql`max(${tickerDailyCandles.date})` })
      .from(tickerDailyCandles)
      .where(eq(tickerDailyCandles.ticker, ticker));
    const minStored = cov?.minD ? String(cov.minD).slice(0, 10) : null;
    const maxStored = cov?.maxD ? String(cov.maxD).slice(0, 10) : null;

    // Decide the single Tiingo span to fetch (if any):
    //  - cold (nothing stored)            → whole requested range
    //  - head missing (range starts well before earliest stored) → whole range (covers head+tail)
    //  - tail missing (newer days)        → just latest_stored+1 … end
    //  - fully covered                    → no fetch
    let fetchFrom = null;
    if (!minStored) {
      fetchFrom = startDate;
    } else {
      const needHead = startDate < minStored && daysBetween(startDate, minStored) > HEAD_TOL;
      const needTail = !maxStored || maxStored < endDate;
      if (needHead) fetchFrom = startDate;
      else if (needTail) fetchFrom = nextDay(maxStored);
    }

    let fetched = 0;
    let tiingoFailed = false;
    if (fetchFrom && fetchFrom <= endDate) {
      const { ok, data } = await fetchTiingoDaily(ticker, fetchFrom, endDate, TIINGO_API_KEY);
      if (!ok || !Array.isArray(data)) {
        tiingoFailed = true;
        console.log(`[chart_daily] ${ticker} tiingo fetch failed for ${fetchFrom}..${endDate}`);
      } else {
        // Store ADJUSTED OHLCV under canonical column names (no split-induced gaps).
        const rows = data
          .map((d) => ({
            ticker,
            date: String(d.date || '').slice(0, 10),
            open: d.adjOpen, high: d.adjHigh, low: d.adjLow, close: d.adjClose,
            volume: Number.isFinite(d.adjVolume) ? d.adjVolume : 0,
            source: 'tiingo',
          }))
          .filter((r) => r.date && [r.open, r.high, r.low, r.close].every(Number.isFinite));
        if (rows.length) {
          const ins = await db.insert(tickerDailyCandles)
            .values(rows)
            .onConflictDoNothing({ target: [tickerDailyCandles.ticker, tickerDailyCandles.date] })
            .returning({ date: tickerDailyCandles.date });
          fetched = ins.length;
        }
      }
    }

    // Re-query the full requested range (now backfilled) — this is the response series.
    const finalRows = await db
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

    // Tiingo failed AND we have nothing to show → empty, but still 200 (page renders clean).
    if (tiingoFailed && finalRows.length === 0) {
      return Response.json({ ticker, range, count: 0, candles: [], error: 'data_unavailable', meta: { cached: 0, fetched: 0 } });
    }

    const cachedCount = Math.max(0, finalRows.length - fetched);
    console.log(`[chart_daily] ${ticker} range=${range} candles=${finalRows.length} cached=${cachedCount} fetched=${fetched}${tiingoFailed ? ' (tiingo failed; served cache)' : ''}`);
    return Response.json({
      ticker, range, count: finalRows.length, candles: finalRows,
      meta: { cached: cachedCount, fetched },
    });
  } catch (e) {
    // Never 503/500 for the chart — log and return an empty-but-valid payload.
    console.log(`[chart_daily] ${ticker} failed: ${e.message}`);
    return Response.json({ ticker, range, count: 0, candles: [], error: 'data_unavailable', meta: { cached: 0, fetched: 0 } });
  }
}
