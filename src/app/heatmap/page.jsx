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
// ⚠️ REVISIT WHEN REALTIME ENTITLEMENTS SHIP. The moment the board differs by subscription tier this
// must go back to per-request rendering, or a cached EOD page will be served to a realtime viewer —
// and the reverse, which is the licensing-sensitive direction. The `access` object below is the
// signal: while `realtime` is a constant false, this cache is safe.
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
      // Pre-launch: end-of-day for every viewer. The API route is the one place that decides this;
      // the same literal is used here so the first paint cannot disagree with the first refresh.
      freshness: 'eod',
      access: { realtime: false, applied: false, note: 'Pre-launch: every viewer sees end-of-day data.' },
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
