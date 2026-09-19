'use client';
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../lib/cp-shared';
import { barsUrl, normalizeBars, isValidSymbol } from '../../lib/chart/chart-source.mjs';
import { palette } from '../../lib/chart/chart-theme.mjs';

// THE SMALL CHART FOR THE HOMEPAGE MARKET TILES.
//
// ── WHY NOT CPChart WITH showToolbar={false} ─────────────────────────────────
//
// CPChart is 1,510 lines and pulls in drawings, indicators, panes, undo history, export and the
// drawing store. Hiding its toolbar hides the controls; it does not stop any of that mounting. Four
// of them on the homepage would be four crosshair subscriptions, four pane managers and four
// drawing layers to serve four tiles that show one line each — the "unnecessary rendering work" the
// brief rules out, on the most performance-sensitive page we have.
//
// So this reuses the INFRASTRUCTURE and not the UI, which is what the brief asks for:
//
//   data    barsUrl() + normalizeBars() — the same abstraction CPChart uses, so the homepage has no
//           vendor-specific path of its own and a provider change reaches it for free
//   theme   palette() — the same colours, so the tiles match the rest of the product
//   engine  lightweight-charts — the same library, dynamically imported exactly as CPChart does
//
// There is no second chart system here. There is one screenful of glue.
//
// ── ENTITLEMENTS ─────────────────────────────────────────────────────────────
//
// Daily only. barsUrl(symbol, '1D') resolves to /api/chart-daily, which serves end-of-day bars and
// has no realtime path to leak — the tiles are labelled DAILY and show exactly that. This is not a
// permission check that could be got wrong; it is the absence of a realtime request.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
// No toolbar, drawings, indicators, chart types, timeframe row, fullscreen, crosshair subscription,
// legend or refresh timer. One fetch per symbol on mount. A tile is a glance, not an instrument.

const RANGE = '3M';   // matches what the tiles showed before, so the visual change is the renderer

export default function CompactChart({ symbol, height = 150 }) {
  const hostRef = useRef(null);
  const theme = useTheme();
  const [state, setState] = useState('loading');   // loading | ready | empty

  useEffect(() => {
    let disposed = false;
    let chart = null;
    let ro = null;

    (async () => {
      if (!isValidSymbol(symbol)) { setState('empty'); return; }
      const url = barsUrl(symbol, '1D');
      if (!url) { setState('empty'); return; }

      let bars = [];
      try {
        const r = await fetch(url);
        if (!r.ok) { if (!disposed) setState('empty'); return; }
        bars = normalizeBars(await r.json(), '1D').bars || [];
      } catch { if (!disposed) setState('empty'); return; }
      if (disposed) return;
      if (!bars.length) { setState('empty'); return; }

      // The tile shows a recent window, not the full history the payload carries.
      const slice = bars.slice(-90);

      const lwc = await import('lightweight-charts');
      if (disposed || !hostRef.current) return;

      const p = palette(theme);
      // Built from the shared palette, then stripped to what a 150px tile can actually show. Axes,
      // grid and crosshair are removed because at this size they are noise that hides the line.
      chart = lwc.createChart(hostRef.current, {
        autoSize: true,
        layout: { background: { color: 'transparent' }, textColor: p.text, attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { visible: false },
        leftPriceScale: { visible: false },
        timeScale: { visible: false, fixLeftEdge: true, fixRightEdge: true },
        crosshair: { mode: 0, vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
        handleScroll: false,
        handleScale: false,
      });

      // Colour follows the window's own direction, so the tile reads before any number does.
      const first = slice[0]?.close, last = slice[slice.length - 1]?.close;
      const up = !(Number.isFinite(first) && Number.isFinite(last)) || last >= first;
      const line = up ? p.up : p.down;

      const series = chart.addSeries(lwc.AreaSeries, {
        lineColor: line,
        topColor: `${line}33`,
        bottomColor: `${line}00`,
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(slice.map((b) => ({ time: b.time, value: b.close })));
      chart.timeScale().fitContent();

      // The tiles reflow at every homepage breakpoint, and a chart sized once renders at the wrong
      // width after the grid collapses to a single column.
      ro = new ResizeObserver(() => { try { chart.timeScale().fitContent(); } catch { /* disposed */ } });
      if (hostRef.current) ro.observe(hostRef.current);

      setState('ready');
    })();

    return () => {
      disposed = true;
      try { ro?.disconnect(); } catch { /* already gone */ }
      try { chart?.remove(); } catch { /* already gone */ }
    };
  }, [symbol, theme]);

  const C = palette(theme);
  return (
    <div style={{ position: 'relative', height, width: '100%' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {state !== 'ready' && (
        // An explicit state rather than an empty box, so a tile that cannot draw says so instead of
        // looking like a flat market.
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, color: C.text, opacity: 0.45, pointerEvents: 'none' }}>
          {state === 'loading' ? '' : 'no data'}
        </div>
      )}
    </div>
  );
}
