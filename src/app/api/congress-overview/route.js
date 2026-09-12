import { bestThirtyDayRecord, mostTradedStocks, lateFilings, BEST30_MIN_TRADES, BEST30_MIN_TICKERS } from '../../../lib/congress-overview';
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
      bestThirtyDayRecord(),
      mostTradedStocks({ window, limit: Math.max(limit, tickerLimit), sort }),
      lateFilings({ limit }),
    ]);

    return Response.json({
      window,
      bestRecord: {
        list: best.slice(0, limit),
        qualified: best.length,   // total qualifying members, not the page size
        minTrades: BEST30_MIN_TRADES,
        minTickers: BEST30_MIN_TICKERS,
        days: 30,
        // Shown in the UI. This is a per-trade TIMING record, not portfolio performance.
        headline: 'How each member’s disclosed trades performed over the 30 days after they were made',
        methodology: 'Average 30 day return of each member’s disclosed trades, measured from the transaction '
          + 'date to 30 calendar days later. Purchases score the price move and sales score its inverse, so a '
          + 'sale ahead of a decline reads positively. That convention is applied mechanically and is not a '
          + 'claim about intent: many sales are rebalancing, tax or liquidity driven. Each stock counts once '
          + `no matter how many times it was traded, and a member needs at least ${BEST30_MIN_TRADES} priced `
          + `trades across at least ${BEST30_MIN_TICKERS} stocks. Options are excluded, and a trade is skipped `
          + 'rather than scored when a price is missing or the price history breaks inside its 30 day window. '
          + 'This is a trade timing record, not portfolio performance.',
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
