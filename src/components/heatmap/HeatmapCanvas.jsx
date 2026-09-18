'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { C } from '../../lib/cp-shared';
import { heatColor, layoutTiles, showsTicker, showsPct, SECTOR_HEADER_PX } from '../../lib/heatmap/heatmap-layout.mjs';

// THE TREEMAP SURFACE — drawn once, used by both heatmaps.
//
// The Terminal panel and the dedicated /heatmap page render the SAME component, so there is one
// colour ramp, one sector layout and one set of tile-legibility thresholds. The page adds a hover
// card by passing `renderTooltip`; the Terminal passes nothing and is unchanged.
//
// Layout and colour are imported from heatmap-layout.mjs rather than living here, because they are
// arithmetic and belong somewhere a test can reach without a browser.

export default function HeatmapCanvas({ rows, onPick, scale = 3, renderTooltip = null, emptyLabel = 'No market data yet.' }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null);      // { row, rect }
  const wrap = useRef(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tiles = useMemo(() => layoutTiles(rows, size.w, size.h), [rows, size]);

  return (
    <div ref={wrap} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: C.bg }}>
      {rows === null && <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Loading heat map…</div>}
      {rows && rows.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: C.muted, fontSize: 12.5 }}>{emptyLabel}</div>}

      {tiles.map((t, i) => (t.kind === 'sector'
        ? (
          <div key={`s${i}`} style={{ position: 'absolute', left: t.x, top: t.y, width: t.w, height: SECTOR_HEADER_PX,
            overflow: 'hidden', fontSize: 8.5, fontWeight: 800, letterSpacing: 0.4, color: C.dim,
            textTransform: 'uppercase', padding: '2px 4px', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{t.name}</div>
        )
        : (
          <button key={`t${i}`}
            onClick={() => onPick?.(t.ticker)}
            // The native title stays as the no-JS/assistive fallback even when a rich card is shown.
            title={`${t.ticker}${t.pct != null ? `  ${t.pct > 0 ? '+' : ''}${t.pct.toFixed(2)}%` : ''}`}
            onMouseEnter={renderTooltip ? (e) => setHover({ row: t, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
            onMouseLeave={renderTooltip ? () => setHover(null) : undefined}
            onFocus={renderTooltip ? (e) => setHover({ row: t, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
            onBlur={renderTooltip ? () => setHover(null) : undefined}
            style={{ position: 'absolute', left: t.x, top: t.y, width: t.w, height: t.h,
              background: heatColor(t.pct, scale), border: `1px solid ${C.bg}`, boxSizing: 'border-box',
              cursor: 'pointer', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', overflow: 'hidden', padding: 0, lineHeight: 1.05 }}>
            {showsTicker(t) && (
              <span className="cp-tkr" style={{ fontSize: Math.min(15, Math.max(8, t.w / 5.5)), fontWeight: 700, textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>{t.ticker}</span>
            )}
            {showsPct(t) && t.pct != null && (
              <span className="cp-num" style={{ fontSize: Math.min(11, Math.max(7.5, t.w / 8)), opacity: 0.95 }}>
                {t.pct > 0 ? '+' : ''}{t.pct.toFixed(1)}%
              </span>
            )}
          </button>
        )))}

      {renderTooltip && hover && renderTooltip(hover.row, hover.rect)}
    </div>
  );
}
