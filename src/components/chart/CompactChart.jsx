'use client';
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../lib/cp-shared';
import { barsUrl, normalizeBars, isValidSymbol } from '../../lib/chart/chart-source.mjs';
import { palette } from '../../lib/chart/chart-theme.mjs';
import { chartTypeOf } from '../../lib/chart/chart-types.mjs';

// THE SMALL CHART FOR THE HOMEPAGE MARKET TILES.
//
// ── WHY NOT CPChart WITH showToolbar={false} ─────────────────────────────────
//
// CPChart is 1,510 lines and pulls in drawings, indicators, panes, undo history, export and the
// drawing store. Hiding its toolbar hides the controls; it does not stop any of that mounting. Four
// of them on the homepage would be four crosshair subscriptions, four pane managers and four
// drawing layers to serve four tiles that show one candle series each — the "unnecessary rendering
// work" the brief rules out, on the most performance-sensitive page we have.
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

// Candle width in pixels, including the gap. Six is the point where a body is a body and a wick is
// still visible at tile scale — below about four they read as a bar code, above about ten a desktop
// card shows too little history to be worth a chart.
const BAR_SPACING = 6;
// The widest a tile gets is roughly half the MARKETS card, so ~120 candles is more than any card can
// display at BAR_SPACING. Loading more would be history nobody can scroll to — these tiles do not
// pan.
const MAX_BARS = 120;

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

      // Enough history to fill the widest tile at BAR_SPACING, and no more. The chart shows the
      // right-hand end of this, so anything further back is only there to fill a wide card.
      const slice = bars.slice(-MAX_BARS);

      const lwc = await import('lightweight-charts');
      if (disposed || !hostRef.current) return;

      const p = palette(theme);
      // Built from the shared palette, then stripped to what a 150px tile can show. Axes, grid and
      // crosshair are removed because at this size they are noise that hides the candles.
      chart = lwc.createChart(hostRef.current, {
        autoSize: true,
        layout: { background: { color: 'transparent' }, textColor: p.text, attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        // Hidden, not absent. The series still autoscales to the VISIBLE candles, which is what
        // keeps the bodies filling the tile instead of collapsing toward a flat line; the margins
        // stop the extremes touching the edges.
        rightPriceScale: { visible: false, autoScale: true, scaleMargins: { top: 0.12, bottom: 0.08 } },
        leftPriceScale: { visible: false },
        // ⚠️ barSpacing, NOT fitContent(). fitContent squeezes every loaded bar into the tile, and at
        // this width that renders candles about a pixel wide — the "unreadable hairlines" a compact
        // chart is most likely to become. Fixing the spacing instead makes the WIDTH decide how many
        // candles are shown: a wide card shows more, a narrow one fewer, each of them legible, and
        // the count re-adapts on resize with no refetch.
        timeScale: { visible: false, rightOffset: 1, barSpacing: BAR_SPACING, minBarSpacing: 2, fixRightEdge: true },
        crosshair: { mode: 0, vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
        handleScroll: false,
        handleScale: false,
      });

      // THE CANONICAL CANDLE DEFINITION, taken from the chart-type registry rather than retyped.
      // Same series, same OHLC mapping and same palette colours CPChart draws with, so the tiles and
      // the full chart cannot drift apart — and if the registry gains Heikin Ashi or Bars, this
      // follows without being edited.
      const ct = chartTypeOf('Candles');
      const series = chart.addSeries(lwc[ct.series], {
        ...ct.options(p),
        // The only departures, and both are because a 150px tile has no room for them.
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(slice.map(ct.map));           // full OHLC — never reduced to close
      chart.timeScale().scrollToRealTime();

      // The tiles reflow at every homepage breakpoint. Re-anchoring to the right keeps the most
      // recent candles in view after the grid collapses to a single column; barSpacing handles how
      // many of them fit, so nothing needs re-slicing.
      ro = new ResizeObserver(() => { try { chart.timeScale().scrollToRealTime(); } catch { /* disposed */ } });
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
