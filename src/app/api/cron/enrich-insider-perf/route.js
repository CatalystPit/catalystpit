// Cron: keep insider-trade subsequent-performance (1d/1w/1m/6m) fresh via Polygon (unlimited stocks).
// Prices never-attempted trades AND re-fills recent trades whose later horizons have since elapsed.
// Bounded per run (the initial backfill is a one-time script); one bars fetch + updates per ticker.
import { db } from '../../../../lib/db';
import { insiderTrades } from '../../../../lib/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { computePerf } from '../../../../lib/insider-perf.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;
const K = process.env.POLYGON_API_KEY;
const TODAY = () => new Date().toISOString().slice(0, 10);
const TICKER_CAP = 12;

async function polyBars(ticker) {
  try {
    const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/2018-01-01/${TODAY()}?adjusted=true&sort=asc&limit=50000&apiKey=${K}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).map((b) => ({ date: new Date(b.t).toISOString().slice(0, 10), c: b.c }));
  } catch { return []; }
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const today = TODAY();
  // Trades needing perf: never attempted, OR recent (≤6mo) with a still-empty 6m horizon that may have elapsed.
  const needsPerf = or(
    isNull(insiderTrades.perfPricedAt),
    and(sql`${insiderTrades.transactionDate} >= current_date - interval '6 months'`, isNull(insiderTrades.perf6m)),
  );

  const tickers = await db.select({ ticker: insiderTrades.ticker })
    .from(insiderTrades)
    .where(and(sql`${insiderTrades.ticker} is not null`, sql`${insiderTrades.transactionDate} is not null`, needsPerf))
    .groupBy(insiderTrades.ticker)
    .orderBy(sql`max(${insiderTrades.filingDate}) desc`)
    .limit(TICKER_CAP);

  let rowsSet = 0, noData = 0;
  for (const { ticker } of tickers) {
    const trades = await db.select({ id: insiderTrades.id, td: insiderTrades.transactionDate, pps: insiderTrades.pricePerShare })
      .from(insiderTrades).where(and(eq(insiderTrades.ticker, ticker), needsPerf));
    const bars = await polyBars(ticker);
    if (!bars.length) {
      await db.update(insiderTrades).set({ perfPricedAt: new Date() }).where(and(eq(insiderTrades.ticker, ticker), isNull(insiderTrades.perfPricedAt)));
      noData++; continue;
    }
    for (const t of trades) {
      const p = computePerf(bars, t.td, Number(t.pps), today);
      await db.update(insiderTrades)
        .set({ perf1d: p.p1d, perf1w: p.p1w, perf1m: p.p1m, perf6m: p.p6m, perfPricedAt: new Date() })
        .where(eq(insiderTrades.id, t.id));
      rowsSet++;
    }
  }
  return Response.json({ tickers: tickers.length, rowsSet, noData, ts: new Date().toISOString() }, { status: 200 });
}
