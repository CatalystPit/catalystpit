import { auth } from '@clerk/nextjs/server';
import { callerHasRealtime } from '../../../lib/entitlements';
import { marketMovers } from '../../../lib/movers/movers-store';
import { apiRateLimit } from '../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const LIMIT = 25;

// MARKET MOVERS FOR THE TERMINAL PANEL.
//
// ⚠️ MIGRATED OFF POLYGON. This served gainers, losers and most-active from Polygon snapshots
// (`/v2/snapshot/locale/us/markets/stocks/...`), and our redistribution rights for public
// commercial display of Polygon market data were never established. "It works technically" is not
// a right, so the source moved rather than the feature.
//
// Gainers and losers now come from the LICENSED market-wide Tiingo movers the product already
// builds — the same shared 15-minute snapshot the Heatmap page's lists read. This panel therefore
// adds NO upstream cost at all, and inherits everything that snapshot already gets right: the
// eligible-security universe, split-adjusted baselines, stale/dead-print rejection, the session
// lifecycle and the after-close freeze.
//
// ⚠️ MOST ACTIVE RETURNS EMPTY, AND THAT IS THE POINT. Polygon's "active" ranked INTRADAY volume,
// which is exactly the claim we do not have: the intraday volume on this Tiingo entitlement is one
// venue's print, measured at 0.17%–0.40% of the consolidated tape. Migrating it would have meant
// either keeping the unlicensed source or inventing a volume standard we have already decided we
// cannot defend. An empty tab is what "we do not have this" should look like.
//
// No RVOL, no VWAP, no unusual-volume signal is introduced here, and `volume` is returned as null
// rather than as a number nobody should rank on.

export async function GET(request) {
  const _rl = await apiRateLimit(request, 'movers', 'provider');
  if (_rl) return _rl;

  try {
    // Entitlement from the session ONLY. Pro sees the current shared snapshot, everyone else the
    // completed session; no query parameter reaches this decision.
    // ⚠️ ONE ANSWER TO "IS THIS CALLER REALTIME?", AND IT INCLUDES THE LICENSING STOP ORDER.
    // This inlined `isRealtime(tier) && !beta`, which is correct about TIER and silent about licence:
    // market:tiingo:realtime_stop was consulted only inside getQuotes, so with the switch thrown this
    // still reported realtime and the surface described previous-close prices as live. Five routes
    // carried this same two-line copy; callerHasRealtime is now the single answer for all of them.
    const realtime = await callerHasRealtime();

    const m = await marketMovers({ realtime, limit: LIMIT });
    const row = (r) => ({ ticker: r.ticker, company: r.company ?? null, price: r.price, changePct: r.pct, volume: null });

    return Response.json({
      configured: true,
      gainers: (m.gainers || []).map(row),
      losers: (m.losers || []).map(row),
      active: [],
      // Describes the rows, so the panel can label itself honestly instead of assuming a delay.
      freshness: m.freshness,
      asOf: m.snapshotAt || m.asOf || null,
      session: m.session ? { phase: m.session.phase, frozen: Boolean(m.session.frozen) } : null,
    }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[movers] ${e.message}`);
    // Explicit failure, never empty lists presented as "nothing is moving".
    return Response.json({ configured: true, gainers: [], losers: [], active: [], error: 'unavailable' },
      { status: 200, headers: NO_STORE });
  }
}
