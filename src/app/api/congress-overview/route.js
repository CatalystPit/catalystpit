import { bestThirtyDayRecord, mostTradedStocks, latestFilers, LB_MIN_TRADES } from '../../../lib/congress-overview';

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

    const [best, traded, filers] = await Promise.all([
      bestThirtyDayRecord({ min: LB_MIN_TRADES }),
      mostTradedStocks({ window, limit }),
      latestFilers({ limit }),
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
      mostTraded: traded,
      latestFilers: filers,
    }, { headers: CACHE });
  } catch (e) {
    console.error('[congress_overview]', e);
    return Response.json({ error: 'overview unavailable' }, { status: 500 });
  }
}
