import { auth } from '@clerk/nextjs/server';
import { resolveUserAccess, isRealtime } from '../../../../lib/entitlements';
import { heatmapBoard, compactRows } from '../../../../lib/heatmap/heatmap-store';
import { isTimeframe, DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../../../lib/heatmap/heatmap-window.mjs';
import { universeLimit, DEFAULT_UNIVERSE, UNIVERSES } from '../../../../lib/heatmap/heatmap-universe.mjs';
import { coalesce } from '../../../../lib/market/refresh-policy.mjs';

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
// ⚠️ THE LICENSED PROVIDER HAS LANDED, AND THE CONTRACT DID NOT CHANGE SHAPE — which is what the
// previous note promised. `freshness` is no longer 'eod' for everybody: for an entitled reader on
// the 1D window the live price replaces the NUMERATOR in heatmap-store and nothing else moves.
// The universe, sectors, tile sizing, market-cap methodology, baseline session and every other
// window are exactly as they were.
//
// ⚠️ 'realtime' DESCRIBES THE ROWS, NOT THE READER. An entitled viewer whose quote feed returned
// nothing usable gets 'eod', because that is what is on their screen.

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

    // Whether the CALLER is asking on the entitled URL. This decides the cache header only — see
    // the response below. It grants nothing.
    const wantsRealtime = sp.get('rt') === '1';

    // Resolved server-side from the session, and now ACTED ON for the 1D window. Free and signed-out
    // readers keep the completed-session board and its public cache; nothing a client sends can
    // change this value.
    let realtime = false;
    try {
      const { userId } = await auth();
      if (userId) { const { tier, beta } = await resolveUserAccess(); realtime = isRealtime(tier) && !beta; }
    } catch { /* signed out → delayed entitlement, same EOD board today */ }

    // ⚠️ CONCURRENT VIEWERS SHARE ONE COMPUTATION, AND NOTHING IS STORED. coalesce() collapses
    // requests that are in flight at the same moment for the same board; it is not a cache. That
    // is the same choice /api/quotes makes for entitled prices — reusing one entitled reader's
    // realtime values for another, from storage, is a redistribution question we have not answered,
    // and collapsing two identical questions asked at the same instant is not that.
    //
    // The cost of declining to store: an unsynchronised Pro poller triggers its own refresh, so
    // upstream load grows with concurrent Pro viewers rather than staying flat. Measured against
    // TIINGO_BUDGET that is roughly 900 requests/hour per viewer at top500/20s — comfortable now,
    // and the thing to revisit before it is not.
    const board = await coalesce(`heatmap:${timeframe}:${limit}:${realtime ? 'rt' : 'eod'}`,
      () => heatmapBoard({ timeframe, limit, realtime }));

    // ⚠️ FRESHNESS IS WHAT THE BOARD ACTUALLY CONTAINS, NOT WHAT THE VIEWER IS ENTITLED TO. An
    // entitled reader whose quote feed returned nothing usable is looking at completed-session
    // closes, and labelling those 'realtime' because of who they are would be the exact lie this
    // route's contract was written to prevent. So it asks the rows.
    const liveRows = board.rows.filter((r) => r.live).length;
    const freshness = realtime && liveRows > 0 ? 'realtime' : 'eod';
    const measured = board.rows.filter((r) => r.pct != null).length;

    return Response.json({
      timeframe, universe, asOf: board.asOf,
      // What the percentages are measured FROM. A reader comparing against another site needs this
      // more than anything else on the page.
      baselineDate: board.baselineDate,
      anchorDate: board.anchorDate ?? null,
      freshness,
      // ⚠️ `applied` IS NOW A FACT ABOUT THIS RESPONSE, NOT A PLACEHOLDER. It used to be hardcoded
      // false with a pre-launch note, which was true when no live price existed. Entitlement alone
      // does not make it true: an entitled reader whose feed returned nothing usable has `realtime`
      // true and `applied` false, which is precisely the state a reader needs to be able to see.
      access: {
        realtime,
        applied: freshness === 'realtime',
        liveRows,
        note: freshness === 'realtime'
          ? 'Intraday return from the previous close, on live prices.'
          : (realtime
            ? 'Entitled, but no live prices were available — showing the completed session.'
            : 'Completed-session data.'),
      },
      // Where the NUMERATOR came from. The baseline is always a stored session close.
      source: freshness === 'realtime' ? 'tiingo-realtime + ticker_daily_candles' : 'ticker_daily_candles',
      counts: { rows: board.rows.length, measured, unmeasured: board.rows.length - measured },
      timeframes: TIMEFRAMES,
      universes: UNIVERSES,
      rows: compactRows(board.rows, { asOf: board.asOf, baselineDate: board.baselineDate }),
    // ⚠️ THE CACHE DECISION CANNOT WAIT FOR THE OUTCOME, AND THAT IS WHAT BROKE PRO IN PRODUCTION.
    //
    // Choosing the header from `freshness` looks right and is too late. Free and Pro requested the
    // SAME URL, so the first anonymous response populated the edge with `public, s-maxage=300` —
    // and every entitled request afterwards was answered by the CDN, never reaching this function.
    // auth() never ran, `realtime` was never true, and a Pro viewer was served an EOD board by
    // infrastructure rather than by any line of code. Confirmed in production:
    // `X-Vercel-Cache: HIT` with `Cache-Control: public` on the second request.
    //
    // So the two audiences now occupy DIFFERENT URLs, and `wantsRealtime` — not the result — picks
    // the header, before any caching can happen.
    //
    // ⚠️ `rt=1` IS A CACHE KEY, NEVER AN AUTHORISATION. A Free reader who adds it reaches this
    // function, is resolved as unentitled, and receives the EOD board — just uncached. The
    // entitlement still comes from the session and only from the session.
    }, { headers: wantsRealtime ? PRIVATE : (freshness === 'eod' ? EOD_CACHE : PRIVATE) });
  } catch (e) {
    console.log(`[heatmap-performance] ${e.message}`);
    // Explicit failure, never an empty board that reads as "the market is flat".
    return Response.json({ rows: [], error: 'unavailable', asOf: null, freshness: null },
      { status: 200, headers: PRIVATE });
  }
}
