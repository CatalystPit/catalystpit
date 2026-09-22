import MarketHeatmapClient from './MarketHeatmapClient';
import { pageMeta } from '../../lib/seo';
import { heatmapBoard, compactRows } from '../../lib/heatmap/heatmap-store';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../lib/heatmap/heatmap-window.mjs';
import { DEFAULT_UNIVERSE, universeLimit, UNIVERSES } from '../../lib/heatmap/heatmap-universe.mjs';

export const metadata = pageMeta({
  title: { absolute: 'Market Heatmap · US Market Performance by Sector · CatalystPit' },
  description: 'A market heatmap of the largest US-listed securities, sized by market capitalisation and coloured by return over one day, week, month or year.',
  path: '/heatmap',
});

// ── CACHING MATCHED TO HOW OFTEN THE DATA ACTUALLY CHANGES ───────────────────
//
// This was `dynamic = 'force-dynamic'`, so every request re-ran the whole board query against
// Postgres. Measured in production: 2,431ms cold, 336ms warm, a cache MISS every time — the slowest
// route on the site by a factor of three, while every cached page answered in 70-90ms.
//
// Nothing here varies per request. No cookies, no headers, no auth, no searchParams, and `access` is
// the hardcoded pre-launch literal — every viewer gets the same end-of-day board. Re-deriving it per
// request bought nothing. 300s matches the s-maxage the API route already uses, so the page and its
// first refresh cannot disagree about how fresh the data is.
//
// ⚠️ REALTIME ENTITLEMENTS HAVE SHIPPED, AND THIS WARNING CAME TRUE. A cached EOD page WAS served
// to a realtime viewer — it was one of three layers doing so, together with the API route's public
// CDN entry and a client that fetched exactly once.
//
// The resolution is not per-request rendering, which would hand every anonymous reader the 2,431ms
// cold render this cache was created to remove. It is that the page stays an EOD first paint for
// everybody, and the CLIENT replaces it for an entitled reader as soon as the session resolves.
// The licensing-sensitive direction is still safe: nothing realtime is ever rendered here, so
// nothing realtime can be cached here.
export const revalidate = 300;

/**
 * SERVER-RENDERED FIRST PAINT.
 *
 * The opening board is read straight from the store — no HTTP hop back into our own API, no client
 * waterfall — so the first frame already has the market in it. The client takes over for the
 * timeframe, universe and sector controls.
 *
 * Failure renders the page with an empty board rather than a 500: the controls still work, and one
 * bad query should not cost the whole route.
 */
export default async function HeatmapPage() {
  let initial = null;
  try {
    const board = await heatmapBoard({ timeframe: DEFAULT_TIMEFRAME, limit: universeLimit(DEFAULT_UNIVERSE) });
    const measured = board.rows.filter((r) => r.pct != null).length;
    initial = {
      timeframe: DEFAULT_TIMEFRAME, universe: DEFAULT_UNIVERSE,
      asOf: board.asOf, baselineDate: board.baselineDate, anchorDate: board.anchorDate ?? null,
      // ⚠️ THIS FIRST PAINT IS ALWAYS END-OF-DAY, AND THAT IS NOW A DELIBERATE COMPROMISE RATHER
      // THAN THE WHOLE TRUTH. The page is statically cached (revalidate below) and has no session,
      // so it cannot know who is asking — and making it per-request would cost every anonymous
      // reader the 2.4s cold render this cache exists to avoid.
      //
      // So an entitled reader's opening frame is the EOD board and the client replaces it the
      // moment /api/me/plan resolves. What must never happen is this literal claiming to be
      // something it is not: it says eod because it IS eod, for everyone, for one frame.
      freshness: 'eod',
      // ⚠️ AND DELIBERATELY NO `session`, FOR THE SAME REASON THE FRESHNESS IS HARDCODED. Whether
      // the market is open is a fact about NOW, and this render is cached for five minutes — a
      // cached "regular session" served at 16:02, or a cached "market closed" served at 09:31,
      // would be a confidently wrong statement about the market. Omitting it makes the first paint
      // say only what it can prove ("End of day"), and the client fills in the session state from
      // the API, which is computed per request. An absent field is honest; a stale one is not.
      access: { realtime: false, applied: false, liveRows: 0, note: 'Completed-session data.' },
      source: 'ticker_daily_candles',
      counts: { rows: board.rows.length, measured, unmeasured: board.rows.length - measured },
      timeframes: TIMEFRAMES, universes: UNIVERSES,
      rows: compactRows(board.rows, { asOf: board.asOf, baselineDate: board.baselineDate }),
    };
  } catch {
    initial = null;
  }
  return <MarketHeatmapClient initial={initial} />;
}
