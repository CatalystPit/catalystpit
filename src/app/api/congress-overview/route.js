import { bestThirtyDayRecord, mostTradedStocks, lateFilings, LB_MIN_TRADES } from '../../../lib/congress-overview';
import { STOCK_ACT_DEADLINE_DAYS } from '../../../lib/disclosure';

export const runtime = 'nodejs';

// The three Congress discovery modules in one response. All are small aggregates over a bounded
// window, so the browser gets summary rows rather than any slice of the underlying history.
//
//   /api/congress-overview?window=30d
//
// Public and identical for every viewer, so unlike the gated row endpoints this can be CDN-cached.

const CACHE = { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' };
const WINDOWS = new Set(['30d', '3m', '6m', '1y', '2y', '3y']);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const window = WINDOWS.has(searchParams.get('window') || '') ? searchParams.get('window') : '30d';
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '10', 10) || 10, 3), 25);
    // The chart's ticker rail wants a deeper list than the discovery panel shows.
    const tickerLimit = Math.min(Math.max(parseInt(searchParams.get('tickers') ?? '0', 10) || 0, 0), 40);
    const sort = ['trades', 'recent', 'value'].includes(searchParams.get('sort')) ? searchParams.get('sort') : 'trades';

    const [best, traded, filers] = await Promise.all([
      bestThirtyDayRecord({ min: LB_MIN_TRADES }),
      mostTradedStocks({ window, limit: Math.max(limit, tickerLimit), sort }),
      lateFilings({ limit }),
    ]);

    return Response.json({
      window,
      bestRecord: {
        list: best.slice(0, limit),
        qualified: best.length,   // total qualifying members, not the page size
        minPositions: LB_MIN_TRADES,
        days: 30,
        // Shown in the UI. This measures how disclosed holdings MOVED over the last 30 days. It is
        // not portfolio performance: filers disclose an amount range rather than a position size,
        // they may have sold since, and we only ever see what was disclosed.
        headline: `How each member’s disclosed holdings moved over the last 30 days`,
        methodology: 'Size-weighted 30 day price move of the securities each member disclosed buying '
          + `within our 3 year history. Weighted by the disclosed amount range midpoint, with no single `
          + `position counting for more than 30 percent. A member needs at least ${LB_MIN_TRADES} priced `
          + 'positions to appear. This is not portfolio performance: filers disclose an amount range rather '
          + 'than a position size, and may have sold since.',
      },
      mostTraded: traded.slice(0, limit),
      tickerList: tickerLimit ? traded.slice(0, tickerLimit) : undefined,
      sort,
      lateFilings: {
        list: filers,
        threshold: STOCK_ACT_DEADLINE_DAYS,
        headline: `Disclosures filed past the ${STOCK_ACT_DEADLINE_DAYS} day STOCK Act deadline`,
        methodology: `The STOCK Act gives members ${STOCK_ACT_DEADLINE_DAYS} days from a transaction to disclose it. `
          + 'These are the filings that ran past that, worst first. The delay is measured from the OLDEST '
          + 'trade in the filing, because that is the transaction that waited longest. A late filing is a '
          + 'reporting failure, not evidence of anything about the trade itself.',
      },
    }, { headers: CACHE });
  } catch (e) {
    console.error('[congress_overview]', e);
    return Response.json({ error: 'overview unavailable' }, { status: 500 });
  }
}
