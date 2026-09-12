'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { C, useTheme } from '../../lib/cp-shared';
import { partyStyle, chamberLabel, fmtDate } from './ui';
import { formatDisclosureDelay, formatDisclosedAmount, formatSeat, tradeDirection } from '../../lib/disclosure';

// Congressional trades plotted on the price history of the security they traded.
//
// Purpose-built rather than reusing components/TickerChart: that one is bound to the ticker page,
// carries intraday ranges and a chart-type switch we do not want here, and its range vocabulary
// (1D through 5Y and all) conflicts with the 3 year cap. What IS reused is the proven approach:
// dynamic import so the library stays out of SSR, the v5 createSeriesMarkers API, and a
// timeKey to trades map so a hover can resolve which disclosures sit under a marker.

const RANGES = ['1M', '3M', '6M', '1Y', '3Y'];
const CHART_HEIGHT = 460;   // a primary focal point of this section, not a strip

// lightweight-charts draws to a CANVAS, which cannot resolve CSS variables. Passing C.muted
// hands it the literal string "var(--cp-muted,#5A6458)", so axis text and grid lines fall back to
// a default that is wrong against the dark theme. These read the computed value instead, and are
// re-read whenever the theme flips.
function themeColors() {
  const fallback = { text: '#5A6458', grid: 'rgba(0,0,0,0.06)', bg: '#FFFFFF', line: '#1E5C38', fill: 'rgba(30,92,56,0.18)' };
  if (typeof window === 'undefined') return fallback;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, f) => (cs.getPropertyValue(name) || '').trim() || f;
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    text: v('--cp-muted', fallback.text),
    grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
    // Solid, never transparent: a see-through canvas lets whatever sits behind it bleed into the
    // plot area, which is how the green header appeared to cut through the chart in dark mode.
    bg: v('--cp-white', fallback.bg),
    line: dark ? '#4FB37C' : v('--cp-green', fallback.line),
    fill: dark ? 'rgba(79,179,124,0.16)' : 'rgba(30,92,56,0.18)',
  };
}
const DEFAULT_RANGE = '6M';

// Marker palette, per theme. Purchase markers must NOT reuse the price line's forest green: at
// #1E5C38 both were the same hex, so buy arrows disappeared into the line they sat on. These are
// brighter and more saturated than the line in light mode, and mint against the dark surface.
//
// lightweight-charts markers have no border property (SeriesMarkerBase is time, position, shape,
// color, id, text, size only), so the outline is drawn as a larger marker of the outline colour
// underneath the fill marker. Same shape, same point, bigger size: the result reads as a rim.
// Chosen against the price line each theme actually draws, not in the abstract. The first dark
// pick (#34D399) sat 1.35 contrast and 11 degrees of hue from the dark line #4FB37C, which would
// have reproduced the same blending problem the light theme had. Teal moves the hue 25 degrees
// away and lifts contrast against the line to 1.76 while reading 11.4 against the surface.
const MARKERS = {
  //                                                    vs its own price line
  light: { buy: '#22C55E', sell: '#DC2626', other: '#6B7280', outline: '#FFFDF7' },   // buy 3.49
  dark:  { buy: '#5EEAD4', sell: '#F87171', other: '#9AA3AE', outline: 'rgba(14,21,18,0.92)' }, // buy 1.76 + 25 deg hue
};
const FILL_SIZE = 1.3;      // slightly larger than default so direction reads at a glance
const OUTLINE_SIZE = 1.95;  // the rim sitting behind the fill

const shapeFor = (dir) => (
  dir === 'buy' ? { position: 'belowBar', shape: 'arrowUp' }
  : dir === 'sell' ? { position: 'aboveBar', shape: 'arrowDown' }
  : { position: 'aboveBar', shape: 'circle' }
);

/**
 * One marker per (trading day, direction). Several members buying the same name on the same day
 * collapse into a single marker carrying a count, instead of stacking identical glyphs until the
 * chart is unreadable. Every underlying trade stays reachable through the map.
 *
 * Trades are snapped forward to the first trading day on or after the transaction date, so a trade
 * dated on a weekend or holiday still lands on a bar.
 */
function buildMarkers(candles, trades, pal) {
  if (!candles?.length || !trades?.length) return { markers: [], map: new Map() };
  const dates = candles.map((c) => c.date);
  const first = dates[0], last = dates[dates.length - 1];
  const snap = (d) => { for (let i = 0; i < dates.length; i++) if (dates[i] >= d) return dates[i]; return null; };

  const groups = new Map();   // `${day}|${dir}` -> { time, dir, n }
  const map = new Map();      // day -> trades[]
  for (const t of trades) {
    const d = String(t.transactionDate || '').slice(0, 10);
    if (!d || d < first || d > last) continue;
    const time = snap(d);
    if (!time) continue;
    const dir = tradeDirection(t);
    const k = `${time}|${dir}`;
    const g = groups.get(k) || { time, dir, n: 0 };
    g.n += 1; groups.set(k, g);
    if (!map.has(time)) map.set(time, []);
    map.get(time).push(t);
  }
  // Outline pass first so every rim is painted before any fill, otherwise a neighbouring marker's
  // rim could overdraw the fill of the one next to it. Only the fill carries the count text.
  const ordered = [...groups.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const outlines = ordered.map((g) => ({ time: g.time, ...shapeFor(g.dir), color: pal.outline, size: OUTLINE_SIZE, text: '' }));
  const fills = ordered.map((g) => ({ time: g.time, ...shapeFor(g.dir), color: pal[g.dir] || pal.other, size: FILL_SIZE, text: g.n > 1 ? String(g.n) : '' }));
  return { markers: [...outlines, ...fills], map };
}

function TradeCard({ trades, onClose, pinned, side = 'right' }) {
  if (!trades?.length) return null;
  const many = trades.length > 1;
  return (
    <div style={{
      position: 'absolute', zIndex: 40, top: 10, width: 268, maxWidth: 'calc(100% - 20px)',
      ...(side === 'left' ? { left: 10 } : { right: 10 }),
      // THE FLICKER FIX. A hover card sits inside the chart container, so when the pointer is over
      // the region the card occupies, the card swallows the mousemove. lightweight-charts then sees
      // the pointer leave the canvas, fires crosshairMove with no time, hover clears, the card
      // unmounts, the pointer is over the canvas again, hover re-fires, and the card remounts. That
      // self-retriggering loop is the flicker. A hover card is purely informational, so it takes no
      // pointer events at all and cannot start the loop. A PINNED card does accept them, which is
      // what makes View Official Disclosure clickable.
      pointerEvents: pinned ? 'auto' : 'none',
      background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px',
      boxShadow: '0 10px 28px rgba(0,0,0,0.18)', fontFamily: "'DM Sans',sans-serif",
      maxHeight: 300, overflowY: 'auto',
    }}>
      {pinned && (
        <button type="button" onClick={onClose} aria-label="Close"
          style={{ position: 'absolute', top: 6, right: 8, border: 'none', background: 'transparent',
            color: C.dim, fontSize: 15, cursor: 'pointer', lineHeight: 1, padding: 2 }}>×</button>
      )}
      {many && (
        <div style={{ fontSize: 10, color: C.dim, letterSpacing: '0.5px', marginBottom: 6, fontWeight: 700 }}>
          {trades.length} DISCLOSURES THIS DAY
        </div>
      )}
      {!pinned && (
        // A hover card takes no pointer events, so its link is not clickable yet. Say so, rather
        // than showing a link that silently ignores the pointer.
        <div style={{ fontSize: 9.5, color: C.dim, marginBottom: 6, letterSpacing: '0.3px' }}>
          Click the marker to keep this open
        </div>
      )}
      {trades.map((t, i) => {
        const dir = tradeDirection(t);
        const ps = partyStyle(t.party);
        const col = dir === 'buy' ? C.green : dir === 'sell' ? C.red : C.muted;
        const label = dir === 'buy' ? 'PURCHASE' : dir === 'sell' ? 'SALE' : String(t.type || 'OTHER').toUpperCase();
        const delay = formatDisclosureDelay(t);
        return (
          <div key={t.id ?? i} style={{ paddingTop: i ? 9 : 0, marginTop: i ? 9 : 0, borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, lineHeight: 1.25 }}>{t.representative || 'Unknown'}</div>
            <div style={{ fontSize: 10.5, color: C.muted, marginTop: 1 }}>
              {formatSeat(t) || chamberLabel(t.chamber)}{t.party ? ` · ${ps.abbr}` : ''}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 4px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', color: col,
                background: dir === 'buy' ? C.greenLight : dir === 'sell' ? C.redLight : C.surface,
                padding: '2px 7px', borderRadius: 4 }}>{label}</span>
              <span style={{ fontSize: 11.5, color: C.text, fontWeight: 600 }}>{t.ticker}</span>
              {t.owner && <span style={{ fontSize: 10, color: C.dim }}>{t.owner}</span>}
            </div>
            {/* The filer's disclosed bracket, verbatim. Never a midpoint presented as an amount. */}
            <div style={{ fontSize: 12, color: C.text, fontWeight: 500 }}>{formatDisclosedAmount(t) || 'Amount not disclosed'}</div>
            <div style={{ fontSize: 10.5, color: C.muted, marginTop: 4, lineHeight: 1.6 }}>
              Traded {fmtDate(t.transactionDate)}<br />
              Disclosed {fmtDate(t.disclosureDate)}{delay ? ` (${delay.toLowerCase()})` : ''}
            </div>
            {t.link && (
              <a href={t.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                style={{ display: 'inline-block', marginTop: 7, fontSize: 11, fontWeight: 600,
                  color: C.green, textDecoration: 'none', borderBottom: `1px solid ${C.greenBorder}` }}>
                View Official Disclosure
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function CongressChart({ ticker, onSelectTicker }) {
  const theme = useTheme();
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState(null);     // trades under the crosshair
  const [side, setSide] = useState('right');    // card sits opposite the cursor
  const [pinned, setPinned] = useState(null);   // tapped/clicked, survives pointer leaving

  // The crosshair subscription is registered once, so it closes over the first render's state.
  // A ref is how it reads the CURRENT pin without being torn down and rebuilt on every change.
  const pinnedRef = useRef(null);
  pinnedRef.current = pinned;

  const wrapRef = useRef(null);
  const lwcRef = useRef(null), chartRef = useRef(null), seriesRef = useRef(null), markersRef = useRef(null);
  const mapRef = useRef(new Map());

  // Price and markers both move with the range: the API returns only trades inside the window.
  useEffect(() => {
    if (!ticker) { setData(null); return; }
    let alive = true;
    setLoading(true); setHover(null); setPinned(null);
    fetch(`/api/congress-chart?ticker=${encodeURIComponent(ticker)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) { setData(j && !j.error ? j : null); setLoading(false); } })
      .catch(() => { if (alive) { setData(null); setLoading(false); } });
    return () => { alive = false; };
  }, [ticker, range]);

  // Create the chart once. Dynamic import keeps the library out of the server bundle.
  useEffect(() => {
    let disposed = false;
    (async () => {
      const lwc = await import('lightweight-charts');
      if (disposed || !wrapRef.current || chartRef.current) return;
      lwcRef.current = lwc;
      const tc = themeColors();
      const chart = lwc.createChart(wrapRef.current, {
        autoSize: true,
        layout: { background: { type: lwc.ColorType.Solid, color: tc.bg }, textColor: tc.text, fontFamily: "'DM Sans', sans-serif", fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: tc.grid } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false },
        crosshair: { mode: lwc.CrosshairMode.Magnet, vertLine: { color: 'rgba(0,0,0,0.12)', width: 1 }, horzLine: { visible: false } },
      });
      chartRef.current = chart;
      seriesRef.current = chart.addSeries(lwc.AreaSeries, {
        lineColor: tc.line, topColor: tc.fill, bottomColor: 'rgba(0,0,0,0)',
        lineWidth: 2, priceLineVisible: false,
      });
      chart.subscribeCrosshairMove((p) => {
        // A pinned card is frozen. Without this, moving the pointer toward the card keeps firing
        // the crosshair, side keeps recomputing from the cursor, and the card jumps left and right
        // as you reach for it. Hover also stops mattering while pinned, since pinned wins for
        // display, so skipping the whole handler avoids pointless re-renders too.
        if (pinnedRef.current) return;
        const key = typeof p?.time === 'string' ? p.time : null;
        const hit = key ? (mapRef.current.get(key) || null) : null;
        setHover(hit);
        // Put the card on the far side of the chart from the cursor so it never covers the marker
        // being read. setState with an unchanged value is a no-op, so this does not add renders.
        if (hit && p?.point && wrapRef.current) {
          setSide(p.point.x > wrapRef.current.clientWidth / 2 ? 'left' : 'right');
        }
      });
      // Click pins the card so it survives the pointer leaving, which is also how a tap works.
      // This is the ONLY place pinning changes. A container-level onClick used to run on the same
      // click and cleared the pin, so clicking a second marker while one was pinned dismissed the
      // card instead of switching to it.
      chart.subscribeClick((p) => {
        const key = typeof p?.time === 'string' ? p.time : null;
        const hit = key ? mapRef.current.get(key) : null;
        setPinned(hit || null);      // clicking empty chart space clears the pin
        // Drop the stale hover captured before the pin, so unpinning cannot flash an old card.
        setHover(null);
      });
    })();
    return () => {
      disposed = true;
      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; seriesRef.current = null; markersRef.current = null; }
    };
  }, []);

  // The chart is created once, so a theme flip has to be pushed into it. Without this the axis
  // text and plot background keep the colours captured at mount and the chart stays light after
  // switching to dark.
  useEffect(() => {
    const chart = chartRef.current, s2 = seriesRef.current;
    if (!chart || !s2) return;
    const tc = themeColors();
    chart.applyOptions({
      layout: { background: { type: 'solid', color: tc.bg }, textColor: tc.text },
      grid: { vertLines: { visible: false }, horzLines: { color: tc.grid } },
    });
    s2.applyOptions({ lineColor: tc.line, topColor: tc.fill, bottomColor: 'rgba(0,0,0,0)' });
  }, [theme, data]);

  // Push data + markers whenever the payload changes.
  useEffect(() => {
    const lwc = lwcRef.current, s = seriesRef.current, chart = chartRef.current;
    if (!lwc || !s || !chart) return;
    const candles = data?.candles || [];
    s.setData(candles.map((c) => ({ time: c.date, value: c.close })));
    const pal = document.documentElement.dataset.theme === 'dark' ? MARKERS.dark : MARKERS.light;
    const { markers, map } = buildMarkers(candles, data?.trades || [], pal);
    mapRef.current = map;
    if (markersRef.current) markersRef.current.setMarkers(markers);
    else markersRef.current = lwc.createSeriesMarkers(s, markers);
    chart.timeScale().fitContent();
  }, [data, theme]);

  const shown = pinned || hover;
  const counts = data?.counts;
  // Same palette the canvas markers use, so the legend can never drift from the chart.
  const pal = theme === 'dark' ? MARKERS.dark : MARKERS.light;

  const rangeBtn = (r) => ({
    background: range === r ? C.green : C.white, color: range === r ? '#fff' : C.muted,
    border: `1px solid ${range === r ? C.green : C.border}`, borderRadius: 5,
    padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
    fontFamily: "'DM Sans',sans-serif",
  });

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '10px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.green }}>
            {ticker || 'Select a stock'}
          </span>
          {counts && (
            <span style={{ fontSize: 10.5, color: C.muted, whiteSpace: 'nowrap' }}>
              {counts.trades} {counts.trades === 1 ? 'disclosure' : 'disclosures'}
              {' · '}<span style={{ color: C.green }}>{counts.buys} bought</span>
              {' · '}<span style={{ color: C.red }}>{counts.sells} sold</span>
              {counts.other ? ` · ${counts.other} other` : ''}
            </span>
          )}
        </span>
        <span style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button key={r} type="button" onClick={() => setRange(r)} style={rangeBtn(r)}>{r}</button>
          ))}
        </span>
      </div>

      {/* Says why the line starts later than the period asked for. Without this a trimmed chart
          reads as missing data rather than as history we decline to splice onto the current one. */}
      {data?.seriesTrimmed && (
        <div style={{ padding: '7px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface,
          fontSize: 11, color: C.muted, lineHeight: 1.45 }}>
          Price history for {ticker} before {fmtDate(data.seriesBreak)} belongs to a different security or a
          different share basis, so this chart starts there. Disclosures before that date are not plotted.
        </div>
      )}

      <div style={{ position: 'relative', height: CHART_HEIGHT }}>
        <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }} />
        {!ticker && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: C.muted, fontSize: 12.5, textAlign: 'center', padding: 20 }}>
            Pick a stock to see congressional purchases and sales on its price history.
          </div>
        )}
        {ticker && loading && (
          <div style={{ position: 'absolute', top: 10, left: 12, fontSize: 11, color: C.dim }}>Loading.</div>
        )}
        {ticker && !loading && data && !data.candles?.length && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: C.muted, fontSize: 12.5, textAlign: 'center', padding: 20 }}>
            No price history available for {ticker} in this period.
          </div>
        )}
        <TradeCard trades={shown} pinned={!!pinned} side={side} onClose={() => setPinned(null)} />
      </div>

      <div style={{ padding: '7px 12px', borderTop: `1px solid ${C.surface}`, fontSize: 10, color: C.dim,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span><span style={{ color: pal.buy, fontWeight: 700 }}>&#9650;</span> purchase</span>
        <span><span style={{ color: pal.sell, fontWeight: 700 }}>&#9660;</span> sale</span>
        <span><span style={{ color: pal.other, fontWeight: 700 }}>&#9679;</span> other</span>
        <span>A number on a marker means several disclosures that day. Hover or tap for detail.</span>
      </div>
    </div>
  );
}
