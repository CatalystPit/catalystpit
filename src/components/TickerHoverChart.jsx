'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { C } from '../lib/cp-shared';
import CompactChart from './chart/CompactChart';

// THE FINVIZ-STYLE TICKER HOVER PREVIEW — one implementation, every table that lists tickers.
//
// This was inline in the Screener. The Dividend Calendar needed the same behaviour, and the
// behaviour is not the chart: it is the open delay, the flip-to-stay-on-screen arithmetic, the
// pointer-events rule that keeps the row click working, and the teardown. Copying that into a second
// table means two versions of it, and the second one drifts — so it lives here and both import it.
//
// Non-interactive by design (pointer-events: none), so the popup can never swallow the click that
// navigates to the ticker page, and can never trap keyboard focus.

const W = 360, H = 224;
const OPEN_DELAY_MS = 220;   // long enough that sweeping the cursor down a column opens nothing

/**
 * The chart itself: SYMBOL · DAILY · 3M, drawn by our own renderer on our own data.
 *
 * ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
 *
 * A TradingView-HOSTED advanced-chart embed: a <script> from s3.tradingview.com that fetched its
 * own prices from the vendor. Every hover on the Screener, the Dividend Calendar and the heatmap's
 * movers loaded third-party code into the page and showed a reader TradingView's data rather than
 * the data the rest of the product is measured on — so a preview could disagree with the tile that
 * opened it, and we could not explain why.
 *
 * ⚠️ THE RENDERER IS STILL LIGHTWEIGHT CHARTS, AND THAT IS NOT THE SAME THING. That library is
 * TradingView's, used under its licence with the attribution the product already carries. What is
 * gone is the HOSTED WIDGET and the VENDOR DATA behind it. Removing the library would mean
 * rewriting every chart in the product for no benefit.
 *
 * ── WHY CompactChart AND NOT A NEW MINI CHART ────────────────────────────────
 *
 * It already exists, already speaks barsUrl()/normalizeBars(), already themes from palette() and
 * already tears itself down on symbol change. The hover card needs three things a 150px homepage
 * tile does not — a price axis, a date axis and the last price — and those are opt-in props on
 * that one component rather than a second implementation to drift.
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 *
 * /api/chart-daily reads ticker_daily_candles from Postgres and only contacts a provider when the
 * stored tail is stale. Measured on JAGX: 62 candles, `upstream: false`, `fetched: 0`. Sweeping a
 * cursor across ten tickers is ten Postgres reads and no vendor requests at all.
 */
function MiniChart({ symbol }) {
  return (
    // ⚠️ `key` FORCES A FRESH MOUNT PER SYMBOL, which is the structural version of the SPY→AAPL
    // fix. CompactChart already disposes its chart on cleanup and guards its async fetch, but a
    // remount makes it impossible for one symbol's price scale, candles or last-price line to
    // survive into another's even if that internal guard were ever weakened.
    <div style={{ position: 'absolute', inset: 0, padding: '2px 2px 0' }}>
      <CompactChart
        key={symbol}
        symbol={symbol}
        height={H - 34}
        // The preview contract: a price axis, a date axis and the latest price. No toolbar, no
        // drawings, no indicators, no evidence markers — CompactChart mounts none of them.
        showAxes
        showLastValue
        // ~3 months of daily history. 66 sessions is a quarter, and 4px spacing is what fits that
        // many legibly across the 360px card once the price axis has taken its width.
        // ⚠️ ASK FOR 3 MONTHS, NOT THE DAILY TIMEFRAME'S NATURAL 5Y. Without this every hover
        // downloads ~1,250 candles to draw ~62 of them.
        range="3M"
        maxBars={66}
        barSpacing={4}
      />
    </div>
  );
}

/**
 * The hover state, and the props that drive it.
 *
 * `bind(symbol)` returns the mouse handlers for a ticker cell. Moving between rows re-enters and the
 * timer restarts against the new symbol, so a cursor travelling down a column previews the row it
 * settles on rather than every row it passed. The timer is cleared on unmount, because a table that
 * navigates away 200ms after a hover would otherwise set state on a gone component.
 */
export function useTickerHover() {
  const [hover, setHover] = useState(null);      // { sym, rect }
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const clear = useCallback(() => { clearTimeout(timer.current); setHover(null); }, []);
  const bind = useCallback((symbol) => ({
    onMouseEnter: (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setHover({ sym: symbol, rect }), OPEN_DELAY_MS);
    },
    onMouseLeave: clear,
  }), [clear]);

  return { hover, bind, clear };
}

/**
 * The popup. Render once per page, outside the table.
 *
 * POSITIONED TO STAY ON SCREEN: it opens to the right of the cell, flips to the left when that would
 * cross the viewport edge, and is clamped vertically so it never rides off the top or bottom. The
 * top clamp is what keeps it clear of the fixed navigation on the first rows of a table.
 */
export function TickerHoverPreview({ hover }) {
  if (!hover) return null;
  const rc = hover.rect;
  let left = rc.right + 10; if (left + W > window.innerWidth - 8) left = Math.max(8, rc.left - W - 10);
  let top = rc.top - 8; if (top + H > window.innerHeight - 8) top = window.innerHeight - H - 8; if (top < 8) top = 8;
  return (
    <div style={{ position: 'fixed', top, left, width: W, height: H, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.18)', zIndex: 70, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '5px 10px', fontSize: 11, fontWeight: 700, color: C.muted, borderBottom: `1px solid ${C.surface}`, background: C.surface }}>{hover.sym} · Daily · 3M</div>
      <div style={{ position: 'absolute', top: 25, left: 0, right: 0, bottom: 0 }}><MiniChart symbol={hover.sym} /></div>
    </div>
  );
}
