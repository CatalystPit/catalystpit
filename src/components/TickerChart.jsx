'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { C, Dot } from '../lib/cp-shared';

// Timeframe buttons, left→right. Intraday (Polygon) vs daily (Tiingo) split by route.
const TIMEFRAMES = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'All'];
const CHART_TYPES = ['Line', 'Candles'];
const isIntraday = (r) => r === '1D' || r === '5D';
// UI label "All" maps to the route's lowercase "all"; the rest match 1:1.
const toRouteRange = (r) => (r === 'All' ? 'all' : r);

const GREEN = '#1E5C38';
const RED = '#C0392B';        // matches the SELL color in insider/government tables

// Force US Eastern on intraday timestamps so every viewer sees the NY market session
// (9:30–16:00 ET) regardless of their local tz — trader-UX standard. Daily candles use
// date-only display (no tz ambiguity), so the ET formatters no-op for them.
const ET_HHMM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_DATETIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }); // 'YYYY-MM-DD'
const businessDayToDate = (t) =>            // BusinessDay {year,month,day} | 'YYYY-MM-DD' → Date(UTC)
  (t && typeof t === 'object') ? new Date(Date.UTC(t.year, t.month - 1, t.day))
  : (typeof t === 'string') ? new Date(Date.UTC(...t.split('-').map((n, i) => i === 1 ? +n - 1 : +n)))
  : null;

// timeScale.tickMarkFormatter: ET HH:mm for intraday (numeric time); null → LWC default for daily.
function etTickMarkFormatter(time) {
  if (typeof time === 'number') return ET_HHMM.format(new Date(time * 1000));
  return null;
}
// localization.timeFormatter (crosshair time label): ET date+time intraday, date for daily.
function etCrosshairTimeFormatter(time) {
  if (typeof time === 'number') return ET_DATETIME.format(new Date(time * 1000)) + ' ET';
  const d = businessDayToDate(time);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}
// Floating-tooltip time: ET date+time intraday, MMM d for daily.
function fmtTooltipTime(time, intraday) {
  if (intraday && typeof time === 'number') return ET_DATETIME.format(new Date(time * 1000)) + ' ET';
  const d = businessDayToDate(time);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}

const fmtVal = (v) => {
  const n = Number(v);
  if (!n || isNaN(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pad2 = (n) => String(n).padStart(2, '0');
const partyAbbr = (p) => { const s = (p || '').toLowerCase(); return s.startsWith('democrat') ? 'DEM' : s.startsWith('republican') ? 'REP' : p ? 'IND' : '—'; };
const chamberLabel = (c) => c === 'senate' ? 'Senate' : c === 'house' ? 'House' : '';

// Stable keys so a crosshair/click param.time can look up the markers placed at that time.
// Daily marker time = 'YYYY-MM-DD' string; param.time = BusinessDay obj. Intraday = number.
const keyOfMarkerTime = (t) => (typeof t === 'number') ? `t${t}` : `d${t}`;
const keyOfParamTime = (t) =>
  (typeof t === 'number') ? `t${t}`
  : (t && typeof t === 'object') ? `d${t.year}-${pad2(t.month)}-${pad2(t.day)}`
  : `d${t}`;
const timeLt = (a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b)));

// Vertical convention: BUYS at bottom (belowBar), SELLS at top (aboveBar); color green=buy/red=sell.
// SHAPE differentiates source: insider = arrows, congress = circles.
const INSIDER_STYLE = (action) => action === 'BUY'
  ? { position: 'belowBar', color: GREEN, shape: 'arrowUp' }
  : { position: 'aboveBar', color: RED, shape: 'arrowDown' };
const CONGRESS_STYLE = (action) => action === 'BUY'
  ? { position: 'belowBar', color: GREEN, shape: 'circle' }
  : { position: 'aboveBar', color: RED, shape: 'circle' };

// Build markers from a trade list + loaded candle rows. BUY/SELL only (drops OTHER/EXCHANGE);
// anchored on transactionDate snapped to nearest candle on/after; filtered to visible range;
// same-day same-action aggregated to one marker. Returns { markers (sorted), map: timeKey→trades[] }.
function buildMarkers(rows, intraday, trades, styleFor) {
  if (!rows?.length || !trades?.length) return { markers: [], map: new Map() };
  let snap, inRange;
  if (!intraday) {
    const dates = rows.map((r) => r.date);          // ascending
    const first = dates[0], last = dates[dates.length - 1];
    inRange = (d) => d >= first && d <= last;
    snap = (d) => { for (let i = 0; i < dates.length; i++) if (dates[i] >= d) return dates[i]; return null; };
  } else {
    const openByDate = new Map();                    // session date → first (open) bar time
    for (const b of rows) { const ds = ET_YMD.format(new Date(b.time * 1000)); if (!openByDate.has(ds)) openByDate.set(ds, b.time); }
    inRange = (d) => openByDate.has(d);              // intraday: only exact session-date matches
    snap = (d) => openByDate.get(d) ?? null;
  }
  const groups = new Map();   // `${timeKey}|${action}` → { time, action }
  const map = new Map();      // timeKey → trades[]
  for (const t of trades) {
    if (t.action !== 'BUY' && t.action !== 'SELL') continue;
    const d = (t.transactionDate || '').slice(0, 10);
    if (!d || !inRange(d)) continue;
    const time = snap(d);
    if (time == null) continue;
    const tk = keyOfMarkerTime(time);
    groups.set(`${tk}|${t.action}`, { time, action: t.action });
    if (!map.has(tk)) map.set(tk, []);
    map.get(tk).push(t);
  }
  const markers = [...groups.values()].map((g) => ({ time: g.time, ...styleFor(g.action), text: '' }));
  markers.sort((a, b) => timeLt(a.time, b.time));
  return { markers, map };
}

// ── tooltip sections (labeled only when both insider + congress share a date) ──
function insiderSection(trades, labeled) {
  const head = labeled ? `<div style="font-size:8px;letter-spacing:0.8px;color:${C.dim};font-family:'DM Mono',monospace;margin-bottom:2px">INSIDER</div>` : '';
  if (trades.length === 1) {
    const t = trades[0], col = t.action === 'BUY' ? GREEN : RED;
    return head
      + `<div style="font-weight:600;color:${C.ink};font-size:12px">${esc(t.executive)}</div>`
      + `<div style="color:${C.dim};font-size:10px;margin-top:1px">${esc(t.title || '—')}</div>`
      + `<div style="margin-top:4px;font-size:11px"><span style="color:${col};font-weight:600">${t.action}</span> · ${fmtVal(t.totalValue)}</div>`;
  }
  const rows = trades.slice(0, 6).map((t) => {
    const col = t.action === 'BUY' ? GREEN : RED;
    return `<div style="font-size:10px;margin-top:2px"><span style="color:${col};font-weight:600">${t.action}</span> ${esc(t.executive)} · ${fmtVal(t.totalValue)}</div>`;
  }).join('');
  const more = trades.length > 6 ? `<div style="font-size:10px;color:${C.dim};margin-top:3px">+${trades.length - 6} more — click for all</div>` : '';
  return head + `<div style="font-weight:600;color:${C.ink};font-size:12px">${trades.length} insider trades</div>${rows}${more}`;
}
function congressSection(trades, labeled) {
  const head = labeled ? `<div style="font-size:8px;letter-spacing:0.8px;color:${C.dim};font-family:'DM Mono',monospace;margin-bottom:2px">CONGRESS</div>` : '';
  if (trades.length === 1) {
    const t = trades[0], col = t.action === 'BUY' ? GREEN : RED;
    const sub = [partyAbbr(t.party), t.state, chamberLabel(t.chamber)].filter(Boolean).join(' · ');
    return head
      + `<div style="font-weight:600;color:${C.ink};font-size:12px">${esc(t.representative)}</div>`
      + `<div style="color:${C.dim};font-size:10px;margin-top:1px">${esc(sub)}</div>`
      + `<div style="margin-top:4px;font-size:11px"><span style="color:${col};font-weight:600">${t.action}</span> · ${esc(t.amountRange || fmtVal(t.amountMid))}</div>`;
  }
  const rows = trades.slice(0, 6).map((t) => {
    const col = t.action === 'BUY' ? GREEN : RED;
    return `<div style="font-size:10px;margin-top:2px"><span style="color:${col};font-weight:600">${t.action}</span> ${esc(t.representative)} (${partyAbbr(t.party)} ${esc(t.state || '')}) · ${fmtVal(t.amountMid)}</div>`;
  }).join('');
  const more = trades.length > 6 ? `<div style="font-size:10px;color:${C.dim};margin-top:3px">+${trades.length - 6} more — click for all</div>` : '';
  return head + `<div style="font-weight:600;color:${C.ink};font-size:12px">${trades.length} congress trades</div>${rows}${more}`;
}

export default function TickerChart({ ticker, initialRange = '1D', insiderTrades = [], congressTrades = [] }) {
  const [range, setRange] = useState(initialRange);
  const [chartType, setChartType] = useState('Line');   // 'Line' | 'Candles' — session-only, not in URL
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [delayed, setDelayed] = useState(false);

  const router = useRouter();
  const wrapRef = useRef(null);        // chart container div
  const tipRef = useRef(null);         // floating tooltip div
  const lwcRef = useRef(null);         // imported lightweight-charts module
  const chartRef = useRef(null);       // IChartApi
  const seriesRef = useRef(null);      // current ISeriesApi (area or candlestick)
  const seriesTypeRef = useRef('Line');
  const lastRowsRef = useRef(null);    // { rows, intraday } — raw OHLC, source for either series shape
  const markersApiRef = useRef(null);  // ISeriesMarkersPluginApi (per series instance)
  const insiderMapRef = useRef(new Map());   // timeKey → insider trades[]
  const congressMapRef = useRef(new Map());  // timeKey → congress trades[]
  const insiderRef = useRef(insiderTrades);
  const congressRef = useRef(congressTrades);
  const rangeRef = useRef(range);
  const chartTypeRef = useRef(chartType);
  const routerRef = useRef(router);
  insiderRef.current = insiderTrades;
  congressRef.current = congressTrades;
  rangeRef.current = range;
  chartTypeRef.current = chartType;
  routerRef.current = router;

  // (Re)compute + place both insider (arrows) and congress (circles) markers in one call.
  const applyMarkers = useCallback(() => {
    const lwc = lwcRef.current, s = seriesRef.current, lr = lastRowsRef.current;
    if (!lwc || !s) return;
    const ins = lr ? buildMarkers(lr.rows, lr.intraday, insiderRef.current, INSIDER_STYLE) : { markers: [], map: new Map() };
    const con = lr ? buildMarkers(lr.rows, lr.intraday, congressRef.current, CONGRESS_STYLE) : { markers: [], map: new Map() };
    insiderMapRef.current = ins.map;
    congressMapRef.current = con.map;
    const combined = [...ins.markers, ...con.markers].sort((a, b) => timeLt(a.time, b.time));
    if (markersApiRef.current) markersApiRef.current.setMarkers(combined);
    else markersApiRef.current = lwc.createSeriesMarkers(s, combined);
  }, []);

  // Build the series data shape for the active chart type from the cached raw rows.
  const applyData = useCallback(() => {
    const lr = lastRowsRef.current, s = seriesRef.current, chart = chartRef.current;
    if (!lr || !s || !chart) return;
    const { rows, intraday } = lr;
    const t = (r) => (intraday ? r.time : r.date);     // intraday: UNIX secs; daily: 'YYYY-MM-DD'
    const data = seriesTypeRef.current === 'Candles'
      ? rows.map((r) => ({ time: t(r), open: r.open, high: r.high, low: r.low, close: r.close }))
      : rows.map((r) => ({ time: t(r), value: r.close }));
    s.setData(data);
    chart.timeScale().fitContent();
    applyMarkers();
  }, [applyMarkers]);

  // Mount (or swap) the series of a given type. Removes the old series + its markers first.
  const buildSeries = useCallback((type) => {
    const chart = chartRef.current, lwc = lwcRef.current;
    if (!chart || !lwc) return;
    if (seriesRef.current) { chart.removeSeries(seriesRef.current); seriesRef.current = null; }
    markersApiRef.current = null;        // old markers plugin died with the old series
    seriesRef.current = type === 'Candles'
      ? chart.addSeries(lwc.CandlestickSeries, {
          upColor: GREEN, downColor: RED, borderUpColor: GREEN, borderDownColor: RED,
          wickUpColor: GREEN, wickDownColor: RED, priceLineVisible: false,
        })
      : chart.addSeries(lwc.AreaSeries, {
          lineColor: GREEN, topColor: 'rgba(30, 92, 56, 0.20)', bottomColor: 'rgba(30, 92, 56, 0)',
          lineWidth: 2, priceLineVisible: false,
        });
    seriesTypeRef.current = type;
  }, []);

  // ── create the chart once on mount (dynamic import keeps the lib out of SSR) ──
  useEffect(() => {
    let disposed = false;
    let chart;
    (async () => {
      const lwc = await import('lightweight-charts');
      if (disposed || !wrapRef.current) return;
      lwcRef.current = lwc;
      chart = lwc.createChart(wrapRef.current, {
        autoSize: true,
        layout: { background: { type: lwc.ColorType.Solid, color: 'transparent' }, textColor: C.muted, fontFamily: "'DM Mono', monospace", fontSize: 11 },
        localization: { timeFormatter: etCrosshairTimeFormatter },
        grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(0,0,0,0.04)' } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: isIntraday(rangeRef.current), secondsVisible: false, tickMarkFormatter: etTickMarkFormatter },
        crosshair: { mode: lwc.CrosshairMode.Magnet, vertLine: { color: 'rgba(0,0,0,0.12)', width: 1 }, horzLine: { color: 'rgba(0,0,0,0.12)' } },
        handleScroll: true, handleScale: true,
      });
      chartRef.current = chart;

      // crosshair → floating tooltip. Over a marker date → insider/congress card(s); else price.
      chart.subscribeCrosshairMove((param) => {
        const tip = tipRef.current;
        if (!tip) return;
        const offscreen = !param.point || param.point.x < 0 || param.point.y < 0;
        if (!param.time || offscreen) { tip.style.display = 'none'; return; }
        const key = keyOfParamTime(param.time);
        const ins = insiderMapRef.current.get(key);
        const con = congressMapRef.current.get(key);
        let html = null;
        if ((ins && ins.length) || (con && con.length)) {
          const both = (ins && ins.length) && (con && con.length);
          html = [ins?.length ? insiderSection(ins, both) : '', con?.length ? congressSection(con, both) : '']
            .filter(Boolean)
            .join(`<div style="border-top:1px solid ${C.border};margin:6px 0"></div>`);
        } else {
          const v = param.seriesData?.get(seriesRef.current);
          const price = v ? (v.value ?? v.close) : null;
          if (price != null) {
            html = `<span style="color:${C.dim}">${fmtTooltipTime(param.time, isIntraday(rangeRef.current))}</span>` +
              `&nbsp;&nbsp;<strong style="color:${C.ink}">$${Number(price).toFixed(2)}</strong>`;
          }
        }
        if (!html) { tip.style.display = 'none'; return; }
        tip.innerHTML = html;
        tip.style.display = 'block';
        const w = wrapRef.current.clientWidth;
        const left = Math.min(param.point.x + 14, w - 170);
        tip.style.left = `${Math.max(8, left)}px`;
        tip.style.top = `${Math.max(8, param.point.y - 36)}px`;
      });

      // click a marker's candle → congress takes priority (single → /politicians/{slug} or
      // ?tab=government when slug is null; aggregated → ?tab=government); else insider → ?tab=insider.
      chart.subscribeClick((param) => {
        if (!param.time) return;
        const key = keyOfParamTime(param.time);
        const con = congressMapRef.current.get(key);
        const ins = insiderMapRef.current.get(key);
        if (con && con.length) {
          if (con.length === 1 && con[0].slug) routerRef.current.push(`/politicians/${encodeURIComponent(con[0].slug)}`);
          else routerRef.current.push(`/ticker/${encodeURIComponent(ticker)}?tab=government`);
        } else if (ins && ins.length) {
          routerRef.current.push(`/ticker/${encodeURIComponent(ticker)}?tab=insider`);
        }
      });

      buildSeries(chartTypeRef.current);
      if (lastRowsRef.current) applyData();
    })();
    return () => { disposed = true; if (chart) chart.remove(); chartRef.current = null; seriesRef.current = null; markersApiRef.current = null; lwcRef.current = null; };
  }, [buildSeries, applyData, ticker]);

  // ── fetch + render whenever ticker or range changes (chart type preserved) ──
  const load = useCallback(async () => {
    setLoading(true); setError(false);
    const intraday = isIntraday(range);
    const url = intraday
      ? `/api/chart-intraday?ticker=${encodeURIComponent(ticker)}&range=${range}`
      : `/api/chart-daily?ticker=${encodeURIComponent(ticker)}&range=${toRouteRange(range)}`;
    try {
      const r = await fetch(url);
      const j = await r.json();
      const rows = intraday ? (j.bars || []) : (j.candles || []);
      if (j.error || rows.length === 0) { setDelayed(false); setError(true); setLoading(false); return; }
      setDelayed(intraday && j.meta?.delayed === true);
      lastRowsRef.current = { rows, intraday };
      if (chartRef.current) {
        chartRef.current.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
        applyData();
      }
      setError(false); setLoading(false);
    } catch {
      setError(true); setLoading(false);
    }
  }, [ticker, range, applyData]);

  useEffect(() => { load(); }, [load]);

  // ── swap series when chart type changes (timeframe + data preserved) ──
  useEffect(() => {
    if (chartRef.current && lwcRef.current) { buildSeries(chartType); applyData(); }
  }, [chartType, buildSeries, applyData]);

  // ── re-apply markers when insider/congress data resolves (chart isn't blocked on those fetches) ──
  useEffect(() => { applyMarkers(); }, [insiderTrades, congressTrades, applyMarkers]);

  const showDelayedPrefix = isIntraday(range) && delayed;

  const btn = (label, active, onClick) => (
    <button key={label} className="hov" onClick={onClick}
      style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 10px', borderRadius: 4,
        fontFamily: "'DM Mono',monospace", fontSize: 12, color: active ? C.ink : C.muted, fontWeight: active ? 700 : 400,
        borderBottom: active ? `2px solid ${GREEN}` : '2px solid transparent', flexShrink: 0, whiteSpace: 'nowrap' }}>
      {label}
    </button>
  );

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {/* header — sentence case, matches Section shell */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Price chart</span>
      </div>

      <div style={{ padding: 14 }}>
        {/* controls row: timeframes (left) · divider · chart types (right). Scrolls horizontally on overflow. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 12, overflowX: 'auto' }}>
          {TIMEFRAMES.map((tf) => btn(tf, tf === range, () => setRange(tf)))}
          <div style={{ width: 1, height: 18, background: 'rgba(0,0,0,0.12)', margin: '0 10px', marginLeft: 'auto', flexShrink: 0 }} />
          {CHART_TYPES.map((ct) => btn(ct, ct === chartType, () => setChartType(ct)))}
        </div>

        {/* chart container (always mounted so the ref is stable); overlays for loading/error */}
        <div style={{ position: 'relative' }}>
          <div ref={wrapRef} className="tk-chart" style={{ width: '100%' }} />

          {loading && (
            <div style={{ position: 'absolute', inset: 0, background: C.surface, borderRadius: 6,
              animation: 'cp-pulse 1.5s ease-in-out infinite' }} />
          )}
          {error && !loading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: C.muted, fontSize: 14, fontStyle: 'italic', fontWeight: 300 }}>
              Chart data unavailable
            </div>
          )}

          {/* floating tooltip — positioned by the crosshair handler */}
          <div ref={tipRef} style={{ position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: 5, maxWidth: 280,
            background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px',
            fontFamily: "'DM Sans',sans-serif", fontSize: 11, lineHeight: 1.35,
            boxShadow: '0 4px 16px rgba(0,0,0,0.14)' }} />
        </div>

        {/* attribution (Apache-2.0 requirement) + dynamic delayed prefix */}
        <div style={{ marginTop: 8, fontFamily: "'DM Mono',monospace", fontSize: 10, color: C.dim, letterSpacing: '0.3px' }}>
          {showDelayedPrefix ? '15-min delayed · ' : ''}Charts by TradingView
        </div>
      </div>
    </div>
  );
}
