'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { C } from '../../lib/cp-shared';
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
const DEFAULT_RANGE = '6M';
const GREEN = '#1E5C38', RED = '#A83030', NEUTRAL = '#7A7F86';

// Purchases green, sales red, anything else (exchanges) neutral rather than mislabelled as either.
const styleFor = (dir) => (
  dir === 'buy' ? { position: 'belowBar', color: GREEN, shape: 'arrowUp' }
  : dir === 'sell' ? { position: 'aboveBar', color: RED, shape: 'arrowDown' }
  : { position: 'aboveBar', color: NEUTRAL, shape: 'circle' }
);

/**
 * One marker per (trading day, direction). Several members buying the same name on the same day
 * collapse into a single marker carrying a count, instead of stacking identical glyphs until the
 * chart is unreadable. Every underlying trade stays reachable through the map.
 *
 * Trades are snapped forward to the first trading day on or after the transaction date, so a trade
 * dated on a weekend or holiday still lands on a bar.
 */
function buildMarkers(candles, trades) {
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
  const markers = [...groups.values()]
    .map((g) => ({ time: g.time, ...styleFor(g.dir), text: g.n > 1 ? String(g.n) : '' }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return { markers, map };
}

function TradeCard({ trades, onClose, pinned }) {
  if (!trades?.length) return null;
  const many = trades.length > 1;
  return (
    <div style={{
      position: 'absolute', zIndex: 40, top: 10, right: 10, width: 268, maxWidth: 'calc(100% - 20px)',
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
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState(null);     // trades under the crosshair
  const [pinned, setPinned] = useState(null);   // tapped/clicked, survives pointer leaving

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
      const chart = lwc.createChart(wrapRef.current, {
        autoSize: true,
        layout: { background: { type: lwc.ColorType.Solid, color: 'transparent' }, textColor: C.muted, fontFamily: "'DM Sans', sans-serif", fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(0,0,0,0.04)' } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false },
        crosshair: { mode: lwc.CrosshairMode.Magnet, vertLine: { color: 'rgba(0,0,0,0.12)', width: 1 }, horzLine: { visible: false } },
      });
      chartRef.current = chart;
      seriesRef.current = chart.addSeries(lwc.AreaSeries, {
        lineColor: C.green, topColor: 'rgba(30, 92, 56, 0.18)', bottomColor: 'rgba(30, 92, 56, 0)',
        lineWidth: 2, priceLineVisible: false,
      });
      chart.subscribeCrosshairMove((p) => {
        const key = typeof p?.time === 'string' ? p.time : null;
        setHover(key ? (mapRef.current.get(key) || null) : null);
      });
      // Click pins the card so it survives the pointer leaving, which is also how a tap works.
      chart.subscribeClick((p) => {
        const key = typeof p?.time === 'string' ? p.time : null;
        const hit = key ? mapRef.current.get(key) : null;
        setPinned(hit || null);
      });
    })();
    return () => {
      disposed = true;
      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; seriesRef.current = null; markersRef.current = null; }
    };
  }, []);

  // Push data + markers whenever the payload changes.
  useEffect(() => {
    const lwc = lwcRef.current, s = seriesRef.current, chart = chartRef.current;
    if (!lwc || !s || !chart) return;
    const candles = data?.candles || [];
    s.setData(candles.map((c) => ({ time: c.date, value: c.close })));
    const { markers, map } = buildMarkers(candles, data?.trades || []);
    mapRef.current = map;
    if (markersRef.current) markersRef.current.setMarkers(markers);
    else markersRef.current = lwc.createSeriesMarkers(s, markers);
    chart.timeScale().fitContent();
  }, [data]);

  const shown = pinned || hover;
  const counts = data?.counts;

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

      <div style={{ position: 'relative', height: 340 }} onClick={() => { if (pinned) setPinned(null); }}>
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
        <TradeCard trades={shown} pinned={!!pinned} onClose={() => setPinned(null)} />
      </div>

      <div style={{ padding: '7px 12px', borderTop: `1px solid ${C.surface}`, fontSize: 10, color: C.dim,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span><span style={{ color: GREEN, fontWeight: 700 }}>&#9650;</span> purchase</span>
        <span><span style={{ color: RED, fontWeight: 700 }}>&#9660;</span> sale</span>
        <span><span style={{ color: NEUTRAL, fontWeight: 700 }}>&#9679;</span> other</span>
        <span>A number on a marker means several disclosures that day. Hover or tap for detail.</span>
      </div>
    </div>
  );
}
