'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { C, Dot } from '../lib/cp-shared';

// Timeframe buttons, left→right. Intraday (Polygon) vs daily (Tiingo) split by route.
const TIMEFRAMES = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'All'];
const isIntraday = (r) => r === '1D' || r === '5D';
// UI label "All" maps to the route's lowercase "all"; the rest match 1:1.
const toRouteRange = (r) => (r === 'All' ? 'all' : r);

const GREEN = '#1E5C38';

// Force US Eastern on intraday timestamps so every viewer sees the NY market session
// (9:30–16:00 ET) regardless of their local tz — trader-UX standard. Daily candles use
// date-only display (no tz ambiguity), so the ET formatters no-op for them.
const ET_HHMM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_DATETIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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

export default function TickerChart({ ticker, initialRange = '1D', insiderTrades = [], congressTrades = [] }) {
  // insiderTrades / congressTrades are accepted now for stable wiring; markers land in Steps 8–9.
  const [range, setRange] = useState(initialRange);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [delayed, setDelayed] = useState(false);

  const wrapRef = useRef(null);       // chart container div
  const tipRef = useRef(null);        // floating tooltip div
  const chartRef = useRef(null);      // IChartApi
  const seriesRef = useRef(null);     // ISeriesApi (area)
  const lastDataRef = useRef(null);   // latest mapped data, for setData once chart is ready
  const rangeRef = useRef(range);     // current range, for the crosshair handler (intraday vs daily)
  rangeRef.current = range;

  // ── create the chart once on mount (dynamic import keeps the lib out of SSR) ──
  useEffect(() => {
    let disposed = false;
    let chart;
    (async () => {
      const { createChart, AreaSeries, ColorType, CrosshairMode } = await import('lightweight-charts');
      if (disposed || !wrapRef.current) return;
      chart = createChart(wrapRef.current, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: C.muted, fontFamily: "'DM Mono', monospace", fontSize: 11 },
        localization: { timeFormatter: etCrosshairTimeFormatter },
        grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(0,0,0,0.04)' } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: isIntraday(rangeRef.current), secondsVisible: false, tickMarkFormatter: etTickMarkFormatter },
        crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: 'rgba(0,0,0,0.12)', width: 1 }, horzLine: { color: 'rgba(0,0,0,0.12)' } },
        handleScroll: true, handleScale: true,
      });
      const series = chart.addSeries(AreaSeries, {
        lineColor: GREEN, topColor: 'rgba(30, 92, 56, 0.20)', bottomColor: 'rgba(30, 92, 56, 0)',
        lineWidth: 2, priceLineVisible: false,
      });
      chartRef.current = chart;
      seriesRef.current = series;

      // built-in crosshair → our floating tooltip (date/time + price)
      chart.subscribeCrosshairMove((param) => {
        const tip = tipRef.current;
        if (!tip) return;
        const v = param.seriesData?.get(series);
        if (!param.time || !param.point || !v || param.point.x < 0 || param.point.y < 0) {
          tip.style.display = 'none';
          return;
        }
        tip.style.display = 'block';
        tip.innerHTML = `<span style="color:${C.dim}">${fmtTooltipTime(param.time, isIntraday(rangeRef.current))}</span>` +
          `&nbsp;&nbsp;<strong style="color:${C.ink}">$${Number(v.value).toFixed(2)}</strong>`;
        // keep the tooltip inside the container
        const w = wrapRef.current.clientWidth;
        const left = Math.min(param.point.x + 14, w - 120);
        tip.style.left = `${Math.max(8, left)}px`;
        tip.style.top = `${Math.max(8, param.point.y - 36)}px`;
      });

      if (lastDataRef.current) {
        series.setData(lastDataRef.current);
        chart.timeScale().fitContent();
      }
    })();
    return () => { disposed = true; if (chart) chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // ── fetch + render whenever ticker or range changes ──
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
      const data = intraday
        ? rows.map((b) => ({ time: b.time, value: b.close }))
        : rows.map((c) => ({ time: c.date, value: c.close }));   // 'YYYY-MM-DD' business-day (tz-safe)
      if (j.error || data.length === 0) { setDelayed(false); setError(true); setLoading(false); return; }
      setDelayed(intraday && j.meta?.delayed === true);
      lastDataRef.current = data;
      if (chartRef.current && seriesRef.current) {
        chartRef.current.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
        seriesRef.current.setData(data);
        chartRef.current.timeScale().fitContent();
      }
      setError(false); setLoading(false);
    } catch {
      setError(true); setLoading(false);
    }
  }, [ticker, range]);

  useEffect(() => { load(); }, [load]);

  const showDelayedPrefix = isIntraday(range) && delayed;

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {/* header — sentence case, matches Section shell */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Price chart</span>
      </div>

      <div style={{ padding: 14 }}>
        {/* timeframe buttons — green underline on active, matching the tab bar */}
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginBottom: 12 }}>
          {TIMEFRAMES.map((tf) => {
            const on = tf === range;
            return (
              <button key={tf} className="hov" onClick={() => setRange(tf)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 10px', borderRadius: 4,
                  fontFamily: "'DM Mono',monospace", fontSize: 12, color: on ? C.ink : C.muted, fontWeight: on ? 700 : 400,
                  borderBottom: on ? `2px solid ${GREEN}` : '2px solid transparent' }}>
                {tf}
              </button>
            );
          })}
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
          <div ref={tipRef} style={{ position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: 5,
            background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 9px',
            fontFamily: "'DM Mono',monospace", fontSize: 11, whiteSpace: 'nowrap',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }} />
        </div>

        {/* attribution (Apache-2.0 requirement) + dynamic delayed prefix */}
        <div style={{ marginTop: 8, fontFamily: "'DM Mono',monospace", fontSize: 10, color: C.dim, letterSpacing: '0.3px' }}>
          {showDelayedPrefix ? '15-min delayed · ' : ''}Charts by TradingView
        </div>
      </div>
    </div>
  );
}
