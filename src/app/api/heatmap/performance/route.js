import { auth } from '@clerk/nextjs/server';
import { resolveUserAccess, isRealtime } from '../../../../lib/entitlements';
import { heatmapBoard } from '../../../../lib/heatmap/heatmap-store';
import { isTimeframe, DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../../../lib/heatmap/heatmap-window.mjs';
import { universeLimit, DEFAULT_UNIVERSE, UNIVERSES } from '../../../../lib/heatmap/heatmap-universe.mjs';

// THE MARKET HEATMAP API — performance over a selected window.
//
// A SEPARATE ROUTE FROM /api/heatmap, deliberately. That one feeds the Terminal panel and must keep
// working exactly as it does; this one answers a different question (return over a window, with
// freshness and entitlement) and the two are not worth merging while the Terminal's contract is
// stable.
//
// ⚠️ FRESHNESS IS PART OF THE PAYLOAD, NOT A FOOTNOTE.
//
// The audit recorded in HANDOFF found that /api/heatmap returns rows and nothing else, so a tile
// showing yesterday's close is indistinguishable from a live one — which is exactly why the board
// looked broken beside a live source. This route states, on every response: the session it is
// measured to (`asOf`), the session it is measured FROM (`baselineDate`), and what KIND of data that
// is (`freshness`). A client that cannot say how old its numbers are should not be showing them.
//
// ⚠️ PRE-LAUNCH: `freshness` is 'eod' for everybody, because the only price we hold is the last
// completed session. The entitlement is resolved and REPORTED but deliberately NOT enforced — see
// `access` below. When the licensed provider lands, the live price replaces the numerator in
// heatmap-store and this contract does not change shape.

export const runtime = 'nodejs';
export const maxDuration = 20;

// PUBLIC CACHING IS VALID ONLY WHILE EVERY VIEWER GETS THE SAME ANSWER.
//
// Today they do: the board is end-of-day data, identical for a signed-out reader and an Elite
// subscriber, so the CDN can hold it and the origin sees one request per window per five minutes.
// The moment `freshness` becomes entitlement-dependent this MUST become private/no-store, or a Pro
// viewer's real-time board will be served to a free one from the edge. The cache header is therefore
// chosen from the freshness that was actually computed, not hard-coded.
const EOD_CACHE = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' };
const PRIVATE = { 'Cache-Control': 'private, no-store' };

export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const timeframe = isTimeframe(sp.get('timeframe')) ? sp.get('timeframe') : DEFAULT_TIMEFRAME;
    const universe = sp.get('universe') || DEFAULT_UNIVERSE;
    const limit = universeLimit(universe);

    // Resolved and reported, NEVER enforced yet. The Free/Pro matrix is not decided, and shipping a
    // gate before the decision means removing one later in front of paying users.
    let realtime = false;
    try {
      const { userId } = await auth();
      if (userId) { const { tier, beta } = await resolveUserAccess(); realtime = isRealtime(tier) && !beta; }
    } catch { /* signed out → delayed entitlement, same EOD board today */ }

    const board = await heatmapBoard({ timeframe, limit });

    // 'eod' is the honest answer for every viewer right now. This is the ONE place that decides it,
    // so when a live provider lands there is a single expression to change.
    const freshness = 'eod';
    const measured = board.rows.filter((r) => r.pct != null).length;

    return Response.json({
      timeframe, universe, asOf: board.asOf,
      // What the percentages are measured FROM. A reader comparing against another site needs this
      // more than anything else on the page.
      baselineDate: board.baselineDate,
      anchorDate: board.anchorDate ?? null,
      freshness,
      // The entitlement the viewer HAS, and whether it currently changes anything. Both are reported
      // so the UI can be built against the final shape without a gate existing yet.
      access: { realtime, applied: false, note: 'Pre-launch: every viewer sees end-of-day data.' },
      source: 'ticker_daily_candles',
      counts: { rows: board.rows.length, measured, unmeasured: board.rows.length - measured },
      timeframes: TIMEFRAMES,
      universes: UNIVERSES,
      rows: board.rows,
    }, { headers: freshness === 'eod' ? EOD_CACHE : PRIVATE });
  } catch (e) {
    console.log(`[heatmap-performance] ${e.message}`);
    // Explicit failure, never an empty board that reads as "the market is flat".
    return Response.json({ rows: [], error: 'unavailable', asOf: null, freshness: null },
      { status: 200, headers: PRIVATE });
  }
}
