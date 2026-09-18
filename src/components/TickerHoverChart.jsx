'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { C } from '../lib/cp-shared';

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
 * The chart itself: a daily candlestick embed.
 *
 * The ADVANCED-chart widget rather than the mini widget, because the mini widget is line-only and
 * this is a candle preview. The tradingview-widget-container / __widget class names are REQUIRED —
 * the embed renders blank without them.
 *
 * NO CATALYST PIT MARKET-DATA REQUEST. The embed fetches its own data from the vendor, so adding
 * this to a second page adds nothing to our own API load, and there is no cache to share or
 * invalidate. Remounting on symbol change is the vendor's own teardown, not ours.
 */
function MiniChart({ symbol }) {
  const host = useRef(null);
  useEffect(() => {
    const h = host.current; if (!h) return; h.innerHTML = '';
    const c = document.createElement('div'); c.className = 'tradingview-widget-container'; c.style.height = '100%'; c.style.width = '100%';
    const w = document.createElement('div'); w.className = 'tradingview-widget-container__widget'; w.style.height = '100%'; w.style.width = '100%'; c.appendChild(w);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.innerHTML = JSON.stringify({
      autosize: true, symbol, interval: 'D', range: '3M', timezone: 'America/New_York', theme: (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark') ? 'dark' : 'light',
      style: '1', locale: 'en', hide_top_toolbar: true, hide_side_toolbar: true, hide_legend: true,
      allow_symbol_change: false, save_image: false, withdateranges: false, support_host: 'https://www.tradingview.com',
    });
    c.appendChild(s); h.appendChild(c);
    return () => { h.innerHTML = ''; };
  }, [symbol]);
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} />;
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
