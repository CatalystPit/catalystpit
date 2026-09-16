'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useTheme } from '../../lib/cp-shared';
import {
  TIMEFRAMES, DEFAULT_TIMEFRAME, timeframe, isIntraday, supportsExtendedHours,
  barsUrl, normalizeBars, refreshIntervalMs, diffBars, isValidSymbol,
} from '../../lib/chart/chart-source.mjs';
import { chartOptions, palette, CHART_ATTRIBUTION, CHART_ATTRIBUTION_HREF } from '../../lib/chart/chart-theme.mjs';

// CATALYST PIT PRICE CHART — TradingView Lightweight Charts v5, on our own licensed data.
//
// The chart knows nothing about vendors. It asks chart-source for a URL, hands back the payload for
// normalisation, and draws what it gets; swapping the market-data provider is an edit in that module
// and not in this file. See src/lib/chart/chart-source.mjs.
//
// STRUCTURED FOR WHAT COMES NEXT. Series are created through addOverlay/removeOverlay against a
// registry of pure indicator functions, and Lightweight Charts v5 panes are addressable by index, so
// SMA/EMA/VWAP land on the price pane and RSI/MACD/ATR get their own without this component
// changing shape. Drawing tools attach to the same chart instance through its plugin API.

const fmtVolume = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

// US Eastern for every viewer: a market chart is read in market time, not the reader's.
const ET_HHMM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_FULL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const businessDayToDate = (t) => (t && typeof t === 'object')
  ? new Date(Date.UTC(t.year, t.month - 1, t.day))
  : (typeof t === 'string' ? new Date(`${t}T00:00:00Z`) : null);
const fmtTime = (time, intraday) => {
  if (intraday && typeof time === 'number') return `${ET_FULL.format(new Date(time * 1000))} ET`;
  const d = businessDayToDate(time);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
};

export default function CPChart({
  symbol,
  initialTimeframe = DEFAULT_TIMEFRAME,
  height = 0,            // floor only; the parent normally supplies the height
  showToolbar = true,
  transparent = false,
  onSymbolResolved = null,
}) {
  const theme = useTheme();
  const [tf, setTf] = useState(initialTimeframe);
  const [chartType, setChartType] = useState('Candles');
  const [extended, setExtended] = useState(false);
  const [status, setStatus] = useState('loading');   // loading | ready | empty | error
  const [meta, setMeta] = useState(null);
  const [legend, setLegend] = useState(null);

  const hostRef = useRef(null);
  const tipRef = useRef(null);
  const lwcRef = useRef(null);
  const chartRef = useRef(null);
  const priceRef = useRef(null);
  const volumeRef = useRef(null);
  const overlaysRef = useRef(new Map());     // indicator id -> ISeriesApi
  const barsRef = useRef([]);
  const kindRef = useRef('daily');
  const themeRef = useRef(theme);
  const typeRef = useRef(chartType);
  themeRef.current = theme;
  typeRef.current = chartType;

  const intraday = isIntraday(tf);

  // ── draw the cached bars in the currently selected shape ──
  const draw = useCallback(() => {
    const chart = chartRef.current, lwc = lwcRef.current;
    if (!chart || !lwc) return;
    const bars = barsRef.current;
    const p = palette(themeRef.current);

    if (priceRef.current) { chart.removeSeries(priceRef.current); priceRef.current = null; }
    priceRef.current = typeRef.current === 'Candles'
      ? chart.addSeries(lwc.CandlestickSeries, {
        upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down,
        wickUpColor: p.up, wickDownColor: p.down, priceLineVisible: false,
      })
      : chart.addSeries(lwc.AreaSeries, {
        lineColor: p.areaLine, topColor: p.areaTop, bottomColor: p.areaBottom,
        lineWidth: 2, priceLineVisible: false,
      });
    priceRef.current.setData(typeRef.current === 'Candles'
      ? bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
      : bars.map((b) => ({ time: b.time, value: b.close })));

    // VOLUME, on its own invisible scale pinned to the bottom so it never rescales price.
    const hasVolume = bars.some((b) => Number(b.volume) > 0);
    if (volumeRef.current) { chart.removeSeries(volumeRef.current); volumeRef.current = null; }
    if (hasVolume) {
      volumeRef.current = chart.addSeries(lwc.HistogramSeries, {
        priceFormat: { type: 'volume' }, priceScaleId: 'cp-volume', priceLineVisible: false, lastValueVisible: false,
      });
      chart.priceScale('cp-volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
      volumeRef.current.setData(bars.map((b) => ({
        time: b.time, value: Number(b.volume) || 0,
        color: b.close >= b.open ? p.volumeUp : p.volumeDown,
      })));
    }
    chart.timeScale().fitContent();
  }, []);

  // ── create once; never rebuilt on theme or timeframe change (that would lose zoom/pan) ──
  useEffect(() => {
    let disposed = false;
    let chart = null;
    (async () => {
      const lwc = await import('lightweight-charts');
      if (disposed || !hostRef.current) return;
      lwcRef.current = lwc;
      chart = lwc.createChart(hostRef.current, {
        autoSize: true,
        ...chartOptions(themeRef.current, { intraday: isIntraday(tf), transparent }),
        localization: {
          timeFormatter: (t) => fmtTime(t, typeof t === 'number'),
        },
        timeScale: {
          ...chartOptions(themeRef.current, { intraday: isIntraday(tf), transparent }).timeScale,
          tickMarkFormatter: (t) => (typeof t === 'number' ? ET_HHMM.format(new Date(t * 1000)) : null),
        },
      });
      chartRef.current = chart;

      chart.subscribeCrosshairMove((param) => {
        const tip = tipRef.current;
        const off = !param.point || param.point.x < 0 || param.point.y < 0 || !param.time;
        if (!tip) return;
        if (off) { tip.style.display = 'none'; setLegend(null); return; }
        const pv = param.seriesData?.get(priceRef.current);
        const vv = volumeRef.current ? param.seriesData?.get(volumeRef.current) : null;
        if (!pv) { tip.style.display = 'none'; return; }
        const o = pv.open, h = pv.high, l = pv.low, c = pv.close ?? pv.value;
        setLegend({ o, h, l, c, v: vv?.value ?? null, up: o == null ? null : c >= o });
        const p = palette(themeRef.current);
        tip.innerHTML = `<div style="color:${p.text};font-size:10px">${fmtTime(param.time, kindRef.current === 'intraday')}</div>`
          + `<div style="color:${p.textStrong};font-weight:600;font-size:12px;margin-top:2px">$${Number(c).toFixed(2)}</div>`
          + (vv?.value ? `<div style="color:${p.text};font-size:10px;margin-top:2px">Vol ${fmtVolume(vv.value)}</div>` : '');
        tip.style.display = 'block';
        const w = hostRef.current.clientWidth;
        tip.style.left = `${Math.max(6, Math.min(param.point.x + 14, w - 150))}px`;
        tip.style.top = `${Math.max(6, param.point.y - 44)}px`;
      });
      if (barsRef.current.length) draw();
    })();
    return () => {
      disposed = true;
      if (chart) chart.remove();
      chartRef.current = null; priceRef.current = null; volumeRef.current = null;
      overlaysRef.current.clear(); lwcRef.current = null;
    };
    // Created once for the life of the component. Symbol, timeframe and theme are applied to the
    // live instance below rather than by recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── theme: applied to the live chart, then the series are recoloured ──
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions(chartOptions(theme, { intraday, transparent }));
    if (barsRef.current.length) draw();
  }, [theme, intraday, transparent, draw]);

  // ── load bars for the current symbol + timeframe ──
  const load = useCallback(async ({ incremental = false } = {}) => {
    if (!isValidSymbol(symbol)) { setStatus('error'); return; }
    const url = barsUrl(symbol, tf, { session: extended ? 'extended' : 'regular' });
    if (!url) { setStatus('error'); return; }
    if (!incremental) setStatus('loading');
    try {
      const r = await fetch(url);
      const json = await r.json();
      const { bars, meta: m } = normalizeBars(json, tf);
      setMeta(m);
      kindRef.current = m.kind;
      if (!bars.length) {
        barsRef.current = [];
        setStatus(json?.error ? 'error' : 'empty');
        return;
      }
      // INCREMENTAL WHERE POSSIBLE. A full setData() resets the user's zoom and pan, so a refresh
      // that only appends or updates the live bar is applied through update() instead.
      const delta = incremental ? diffBars(barsRef.current, bars) : null;
      barsRef.current = bars;
      if (delta && priceRef.current) {
        for (const b of delta) {
          priceRef.current.update(typeRef.current === 'Candles'
            ? { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }
            : { time: b.time, value: b.close });
          if (volumeRef.current && Number(b.volume) > 0) {
            const p = palette(themeRef.current);
            volumeRef.current.update({ time: b.time, value: Number(b.volume), color: b.close >= b.open ? p.volumeUp : p.volumeDown });
          }
        }
      } else {
        chartRef.current?.applyOptions({ timeScale: { timeVisible: m.kind === 'intraday' } });
        draw();
      }
      setStatus('ready');
      if (onSymbolResolved) onSymbolResolved(symbol);
    } catch {
      setStatus('error');
    }
  }, [symbol, tf, extended, draw, onSymbolResolved]);

  useEffect(() => { load(); }, [load]);

  // ── polling refresh. There is no stream to subscribe to; see REALTIME in chart-source.mjs ──
  useEffect(() => {
    const ms = refreshIntervalMs(tf);
    if (!ms) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;   // no work in a background tab
      load({ incremental: true });
    }, ms);
    return () => clearInterval(id);
  }, [tf, load]);

  const p = palette(theme);
  const canExtend = supportsExtendedHours(tf);
  const btn = (label, active, onClick, key) => (
    <button key={key ?? label} onClick={onClick} type="button"
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 9px', borderRadius: 4,
        fontFamily: "'DM Sans',sans-serif", fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0,
        color: active ? p.textStrong : p.text, fontWeight: active ? 700 : 400,
        borderBottom: active ? `2px solid ${p.up}` : '2px solid transparent',
      }}>{label}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {showToolbar && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 2px 8px', overflowX: 'auto' }}>
          {TIMEFRAMES.map((t) => btn(t.label, t.id === tf, () => setTf(t.id), t.id))}
          <div style={{ width: 1, height: 16, background: p.border, margin: '0 8px 0 auto', flexShrink: 0 }} />
          {['Candles', 'Line'].map((t) => btn(t, t === chartType, () => setChartType(t)))}
          {canExtend && btn(extended ? 'Ext ✓' : 'Ext', extended, () => setExtended((v) => !v), 'ext')}
        </div>
      )}

      {/* The chart autosizes to THIS box, so the box must have a real height. It takes it from the
          parent's flex column; `height` is only the floor for a caller that provides none, and is
          never added on top of the parent's — a spacer here double-counted and overflowed the card. */}
      <div style={{ position: 'relative', flex: 1, minHeight: height || 0 }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

        {legend && status === 'ready' && (
          <div style={{ position: 'absolute', left: 8, top: 6, zIndex: 4, pointerEvents: 'none',
            fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: p.text, display: 'flex', gap: 8 }}>
            {legend.o != null && <span>O <b style={{ color: p.textStrong }}>{legend.o.toFixed(2)}</b></span>}
            {legend.h != null && <span>H <b style={{ color: p.textStrong }}>{legend.h.toFixed(2)}</b></span>}
            {legend.l != null && <span>L <b style={{ color: p.textStrong }}>{legend.l.toFixed(2)}</b></span>}
            {legend.c != null && <span>C <b style={{ color: legend.up == null ? p.textStrong : legend.up ? p.up : p.down }}>{legend.c.toFixed(2)}</b></span>}
            {legend.v ? <span>V <b style={{ color: p.textStrong }}>{fmtVolume(legend.v)}</b></span> : null}
          </div>
        )}

        {status === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 6, background: p.background, opacity: 0.85,
            animation: 'cp-pulse 1.5s ease-in-out infinite' }} />
        )}
        {status === 'empty' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: p.text, fontSize: 13, fontStyle: 'italic' }}>No price history for this range</div>
        )}
        {status === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 8,
            alignItems: 'center', justifyContent: 'center', color: p.text, fontSize: 13 }}>
            <span style={{ fontStyle: 'italic' }}>Chart data unavailable</span>
            <button type="button" onClick={() => load()} style={{ cursor: 'pointer', background: 'transparent',
              border: `1px solid ${p.border}`, borderRadius: 4, padding: '3px 10px', color: p.text, fontSize: 11 }}>Retry</button>
          </div>
        )}

        <div ref={tipRef} style={{ position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: 5,
          background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6, padding: '5px 9px',
          fontFamily: "'DM Sans',sans-serif", lineHeight: 1.3, boxShadow: '0 4px 16px rgba(0,0,0,0.16)' }} />
      </div>

      {/* Apache-2.0 attribution — required, and asserted by scripts/verify-chart.mjs */}
      <div style={{ paddingTop: 6, fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: p.text, letterSpacing: '0.3px' }}>
        {meta?.delayed === true ? '15-min delayed · ' : ''}
        {extended && canExtend ? 'Extended hours · ' : ''}
        <a href={CHART_ATTRIBUTION_HREF} target="_blank" rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'none' }}>{CHART_ATTRIBUTION}</a>
      </div>
    </div>
  );
}
