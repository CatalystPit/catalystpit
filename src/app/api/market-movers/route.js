import { auth } from '@clerk/nextjs/server';
import { resolveUserAccess, isRealtime } from '../../../lib/entitlements';
import { marketMovers } from '../../../lib/movers/movers-store';
import { coalesce } from '../../../lib/market/refresh-policy.mjs';

// MARKET-WIDE TOP GAINERS / TOP LOSERS.
//
// ⚠️ A SEPARATE ROUTE FROM THE HEATMAP BECAUSE IT IS A SEPARATE QUESTION. The heatmap shows the
// Top 500 by market cap; this ranks every eligible US operating company. Measured on 2026-09-22,
// all ten of the day's true top gainers were outside the Top 500, so deriving these lists from
// heatmap rows could not have surfaced a single one of them.
//
// ⚠️ THE SAME CACHE DISCIPLINE AS THE HEATMAP, FOR THE SAME REASON. Free and entitled readers must
// not share a CDN entry: a public response cached from an anonymous request would be served to an
// entitled one (and vice versa) by infrastructure, never reaching this function. So the entitled
// audience asks on a different URL (`rt=1`) and that marker — not the outcome — picks the header,
// before any caching can happen. `rt=1` authorises nothing: the tier is resolved from the session
// and only from the session, and a Free caller who adds it gets the completed-session list.

export const runtime = 'nodejs';
export const maxDuration = 30;

const EOD_CACHE = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' };
const PRIVATE = { 'Cache-Control': 'private, no-store' };

export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const wantsRealtime = sp.get('rt') === '1';
    const limit = Math.max(1, Math.min(25, Number(sp.get('limit')) || 10));

    let realtime = false;
    try {
      const { userId } = await auth();
      if (userId) { const { tier, beta } = await resolveUserAccess(); realtime = isRealtime(tier) && !beta; }
    } catch { /* signed out → the completed-session list */ }

    // ⚠️ ONE REBUILD SERVES EVERY VIEWER. coalesce() collapses concurrent requests inside this
    // instance; the 15-minute KV snapshot inside marketMovers() shares the provider work ACROSS
    // instances. Measured upstream cost: ONE Tiingo request per rebuild, four rebuilds an hour,
    // flat whether one person is watching or ten thousand.
    const data = await coalesce(`movers:${realtime ? 'rt' : 'eod'}:${limit}`,
      () => marketMovers({ realtime, limit }));

    return Response.json({
      gainers: data.gainers, losers: data.losers,
      // What the percentages are measured BETWEEN. Both ends named, always.
      baselineDate: data.baselineDate, asOf: data.asOf,
      snapshotAt: data.snapshotAt ?? null,
      // ⚠️ DESCRIBES THE ROWS, NOT THE READER. An entitled viewer whose snapshot produced nothing
      // gets 'eod', because that is what is on their screen.
      freshness: data.freshness,
      universeCount: data.universeCount ?? null,
      session: data.session
        ? {
          phase: data.session.phase, sessionDate: data.session.sessionDate ?? null,
          frozen: Boolean(data.session.frozen), final: Boolean(data.session.final),
        }
        : null,
      // The universe these lists rank — stated so it can never be confused with the heatmap's.
      universe: 'us-equities-stock-adrc',
      source: data.freshness === 'realtime' ? 'tiingo-iex-market-snapshot + ticker_daily_candles' : 'ticker_daily_candles',
    }, { headers: wantsRealtime ? PRIVATE : (data.freshness === 'eod' ? EOD_CACHE : PRIVATE) });
  } catch (e) {
    console.log(`[market-movers] ${e.message}`);
    // Explicit failure, never empty lists that read as "nothing is moving".
    return Response.json({ gainers: [], losers: [], error: 'unavailable', freshness: null },
      { status: 200, headers: PRIVATE });
  }
}
