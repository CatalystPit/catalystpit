'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo, startCheckout, fetchKey, toArr, fmt2 } from '../../lib/cp-shared';
import PitChat from '../../components/PitChat';
import XTape from '../../components/XTape';
import { impactOf, IMPACT_STYLE } from '../../lib/impact';
import { selectTerminalSymbol, onTerminalSymbol } from '../../lib/terminalSymbolBus';

// Custom movable/resizable workspace (React-19-safe — react-grid-layout depends on findDOMNode,
// removed in React 19). Free-floating panels: drag by the header, resize from the corner, layout
// saved to localStorage. Chart center, halt scanner + movers around it.
// Full widget registry — users add/remove any of these (Benzinga-style).
const PANELS = [
  { id: 'tape',      title: 'Tape · X',     tag: 'SOCIAL' },
  { id: 'halts',     title: 'Halt Scanner', tag: 'US · LIVE' },
  { id: 'chart',     title: 'Chart',        tag: 'TRADINGVIEW' },
  { id: 'newswire',  title: 'News Wire',    tag: 'NEWS · PR · 8-K' },
  { id: 'pitscan',   title: 'Pit Scan',        tag: 'PROPRIETARY' },
  { id: 'scanner',   title: 'Custom Scanner',  tag: 'CUSTOM' },
  { id: 'watchlist', title: 'Watchlist',    tag: 'YOURS' },
  { id: 'chat',      title: 'The Pit',      tag: 'CHAT' },
];
const PANEL_BY_ID = Object.fromEntries(PANELS.map((p) => [p.id, p]));
const DEFAULT_VISIBLE = ['tape', 'halts', 'chart', 'newswire', 'watchlist', 'chat'];
const MIN_W = 240, MIN_H = 220;

// Link groups (Benzinga-style): panels sharing a color sync — click a symbol in one and it loads
// in linked chart panels. Click the header chip to cycle a panel's group.
const LINK_COLORS = [
  { key: 'blue', c: '#2A6FDB' }, { key: 'green', c: '#1E5C38' },
  { key: 'orange', c: '#E08A1E' }, { key: 'red', c: '#A83030' }, { key: 'none', c: '#C4C8BE' },
];
const colorOf = (key) => (LINK_COLORS.find((x) => x.key === key) || LINK_COLORS[4]).c;
const nextColor = (key) => { const i = LINK_COLORS.findIndex((x) => x.key === key); return LINK_COLORS[(i + 1) % LINK_COLORS.length].key; };

function defaultLayout(width) {
  const w = width || 1200;
  const gap = 12;
  const unit = (w - gap * 2) / 12;
  const leftW = Math.round(unit * 3);
  const centerX = leftW + gap, centerW = Math.round(unit * 6);
  const rightX = Math.round(unit * 9) + gap * 2, rightW = Math.round(unit * 3) - 2;
  const top = 274, botY = 286;
  // Color categories: blue = market/data/analysis · green = Catalyst Pit proprietary/community ·
  // orange(amber) = news/catalyst/event · red = urgent market state.
  return {
    // left column
    tape:      { x: 0, y: 0, w: leftW, h: top, color: 'orange' },
    halts:     { x: 0, y: botY, w: leftW, h: top, color: 'red' },
    // center column
    chart:     { x: centerX, y: 0, w: centerW, h: 380, color: 'blue' },
    newswire:  { x: centerX, y: 392, w: centerW, h: 220, color: 'orange' },
    // add-only panels default to the center-bottom area (overlap until arranged)
    pitscan:   { x: centerX, y: 392, w: centerW, h: 220, color: 'green' },
    scanner:   { x: centerX + 24, y: 412, w: centerW, h: 260, color: 'blue' },
    // right column
    watchlist: { x: rightX, y: 0, w: rightW, h: top, color: 'blue' },
    chat:      { x: rightX, y: botY, w: rightW, h: top, color: 'green' },
  };
}

const fmtHalt = (t) => (t ? `${String(t).slice(0, 5)} ET` : '—');

// ── Panel bodies ──
function ChartBody({ symbol }) {
  const host = useRef(null);
  useEffect(() => {
    const h = host.current; if (!h) return; h.innerHTML = '';
    const c = document.createElement('div'); c.className = 'tradingview-widget-container'; c.style.height = '100%'; c.style.width = '100%';
    const w = document.createElement('div'); w.className = 'tradingview-widget-container__widget'; w.style.height = '100%'; w.style.width = '100%'; c.appendChild(w);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.innerHTML = JSON.stringify({
      autosize: true, symbol, interval: 'D', timezone: 'America/New_York', theme: 'light',
      style: '1', locale: 'en', hide_side_toolbar: false, allow_symbol_change: true, support_host: 'https://www.tradingview.com',
    });
    c.appendChild(s); h.appendChild(c);
    return () => { h.innerHTML = ''; };
  }, [symbol]);
  // relative wrapper + absolute-fill host so the TradingView autosize widget gets a real height
  return <div style={{ position: 'relative', flex: 1, minHeight: 0 }}><div ref={host} style={{ position: 'absolute', inset: 0 }} /></div>;
}

// Panel content reacts to its OWN width (users resize each panel independently). Returns [ref, width].
function useContainerSize() {
  const ref = useRef(null);
  const [w, setW] = useState(9999);
  useEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => { for (const e of es) setW(Math.round(e.contentRect.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function HaltBody({ onPick }) {
  const [halts, setHalts] = useState(null);
  const [ref, w] = useContainerSize();
  const showReason = w >= 300, showTime = w >= 440;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch('/api/halts', { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (alive) setHalts(j?.halts || []); }
      catch { if (alive) setHalts([]); }
    };
    load(); const id = setInterval(load, 45000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (halts === null) return <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 13 }}>Loading halts…</div>;
  if (halts.length === 0) return <div style={{ padding: '28px 18px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No halts reported yet today — this lights up the moment a stock halts.</div>;
  return (
    <div ref={ref} style={{ overflow: 'auto', flex: 1 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          {halts.map((h, i) => (
            <tr key={`${h.symbol}-${h.haltTime}-${i}`} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
              <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                <span onClick={() => onPick && onPick(h.symbol)} title="Load in chart"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <TickerLogo symbol={h.symbol} size={16} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{h.symbol}</span>
                </span>
                <a href={`/ticker/${encodeURIComponent(h.symbol)}`} title="Open ticker page" style={{ marginLeft: 6, color: C.dim, textDecoration: 'none', fontSize: 11 }}>↗</a>
              </td>
              {showReason && <td style={{ padding: '7px 10px', color: C.text }}>{h.reason}</td>}
              {showTime && <td className="cp-num" style={{ padding: '7px 10px', color: C.muted, whiteSpace: 'nowrap' }}>{fmtHalt(h.haltTime)}</td>}
              <td style={{ padding: '7px 10px', textAlign: 'right' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4, color: h.resumed ? C.green : C.red, background: h.resumed ? C.greenLight : C.redLight }}>{h.resumed ? 'Resumed' : 'Halted'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTORS = ['', 'Technology', 'Financial Services', 'Healthcare', 'Energy', 'Consumer Cyclical', 'Industrials', 'Communication Services', 'Consumer Defensive', 'Basic Materials', 'Real Estate', 'Utilities'];
const scanField = { padding: '5px 7px', borderRadius: 5, border: `1px solid ${C.border}`, fontSize: 11.5, fontFamily: "'DM Sans',sans-serif", outline: 'none', color: C.ink, width: '100%', boxSizing: 'border-box' };
const fmtCap = (m) => (m == null ? '—' : m >= 1e12 ? `$${(m / 1e12).toFixed(1)}T` : m >= 1e9 ? `$${(m / 1e9).toFixed(1)}B` : m >= 1e6 ? `$${(m / 1e6).toFixed(0)}M` : `$${m}`);

// Movers / scanner panel. mode='preset' → Pit Scan (auto-runs our formula). mode='custom' → user filters.
function ScanBody({ mode, onPick }) {
  const [rows, setRows] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [f, setF] = useState({ priceMin: '', priceMax: '', volumeMin: '', mktCapMin: '', sector: '' });
  const setFf = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const run = async () => {
    setRows(null);
    const qs = new URLSearchParams({ mode });
    if (mode === 'custom') { for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v); }
    try {
      const r = await fetch(`/api/scan?${qs.toString()}`, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      setConfigured(j?.configured !== false);
      setRows(j?.rows || []);
    } catch { setRows([]); }
  };
  useEffect(() => { if (mode === 'preset') run(); else setRows([]); /* custom waits for Run */ }, [mode]);

  const results = (
    rows === null ? <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Scanning…</div>
      : !configured ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12, lineHeight: 1.5 }}>Scanner needs a market-data feed. Add <b>FMP_API_KEY</b> to enable live movers.</div>
      : rows.length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>{mode === 'custom' ? 'No matches — adjust your filters and Run.' : 'No results.'}</div>
      : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.symbol + i} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    <span onClick={() => onPick && onPick(r.symbol)} title="Load in chart" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <TickerLogo symbol={r.symbol} size={15} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.symbol}</span>
                    </span>
                  </td>
                  <td className="cp-num" style={{ padding: '7px 10px', textAlign: 'right', color: C.ink }}>{r.price != null ? fmt2(r.price) : '—'}</td>
                  {r.changePct != null
                    ? <td className="cp-num" style={{ padding: '7px 10px', textAlign: 'right', color: r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>{r.changePct > 0 ? '+' : ''}{fmt2(r.changePct)}%</td>
                    : <td className="cp-num" style={{ padding: '7px 10px', textAlign: 'right', color: C.dim }}>{fmtCap(r.marketCap)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  );

  if (mode === 'preset') return results;
  // custom: filter bar + Run + results
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, flexShrink: 0 }}>
        <input style={scanField} placeholder="Min price" value={f.priceMin} onChange={setFf('priceMin')} inputMode="decimal" />
        <input style={scanField} placeholder="Max price" value={f.priceMax} onChange={setFf('priceMax')} inputMode="decimal" />
        <input style={scanField} placeholder="Min volume" value={f.volumeMin} onChange={setFf('volumeMin')} inputMode="numeric" />
        <input style={scanField} placeholder="Min mkt cap" value={f.mktCapMin} onChange={setFf('mktCapMin')} inputMode="numeric" />
        <select style={{ ...scanField, gridColumn: '1 / 2' }} value={f.sector} onChange={setFf('sector')}>
          {SECTORS.map((s) => <option key={s} value={s}>{s || 'Any sector'}</option>)}
        </select>
        <button onClick={run} style={{ gridColumn: '2 / 3', background: C.green, color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Run scan</button>
      </div>
      {rows === null || rows.length === 0 || !configured ? results
        : <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>{results}</div>}
    </div>
  );
}

// ── PIT SCAN — proprietary engine panel (separate product from the Custom Scanner). Renders ONLY the
// approved server output; the formula lives server-side in lib/pitscan.js and is never sent here. ──
const SIG = {
  WATCHING: { fg: '#64748B', bg: '#F1F5F9', label: 'WATCHING' },
  HEATING:  { fg: '#B45309', bg: '#FEF3C7', label: 'HEATING' },
  IGNITION: { fg: '#C2410C', bg: '#FFEDD5', label: 'IGNITION' },
  EXTREME:  { fg: '#B91C1C', bg: '#FEE2E2', label: 'EXTREME' },
};
function PitScanBody({ onPick }) {
  const [dir, setDir] = useState('bull');
  const [rows, setRows] = useState(null);
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/scan?mode=pit&dir=${dir}`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (!alive) return;
        setConfigured(j?.configured !== false);
        setRows(j?.rows || []);
      } catch { if (alive) setRows([]); }
    };
    setRows(null); load();
    const id = setInterval(load, 30000);   // developing-move cadence
    return () => { alive = false; clearInterval(id); };
  }, [dir]);

  const dirBtn = (d, label) => (
    <button onClick={() => setDir(d)} style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 10px', borderRadius: 5, cursor: 'pointer', border: 'none', background: dir === d ? (d === 'bull' ? C.green : C.red) : 'transparent', color: dir === d ? '#fff' : C.muted }}>{label}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {dirBtn('bull', 'Bullish')}{dirBtn('bear', 'Bearish')}
        <span style={{ marginLeft: 'auto', fontSize: 9, color: C.dim, letterSpacing: 0.3 }}>ABNORMAL ACTIVITY · LIVE</span>
      </div>
      {rows === null ? <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Scanning the tape…</div>
        : !configured ? (
          <div style={{ padding: '22px 16px', textAlign: 'center', color: C.muted, fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, color: C.ink, marginBottom: 4 }}>Pit Scan is armed</div>
            Detects unusual momentum &amp; developing activity in real time — stocks whose price, volume, range and liquidity are suddenly accelerating. <b>Awaiting a real-time market feed</b> to go live.
          </div>
        )
        : rows.length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>Quiet right now — nothing crossing Pit Scan thresholds.</div>
          : (
            <div style={{ overflow: 'auto', flex: 1 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr style={{ background: C.surface }}>
                  {['', 'Price', 'Chg%', 'RVOL', 'Signal', 'Prs', 'Ign'].map((h, i) => (
                    <th key={i} style={{ padding: '5px 8px', textAlign: i === 0 ? 'left' : 'right', fontSize: 8.5, color: C.dim, letterSpacing: '0.5px', position: 'sticky', top: 0, background: C.surface }}>{h.toUpperCase()}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => { const s = SIG[r.signal] || SIG.WATCHING; return (
                    <tr key={r.ticker + i} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                        <span onClick={() => onPick && onPick(r.ticker)} title="Load in chart" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <TickerLogo symbol={r.ticker} size={15} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                        </span>
                      </td>
                      <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', color: C.ink }}>{r.price != null ? fmt2(r.price) : '—'}</td>
                      <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>{r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${fmt2(r.changePct)}%`}</td>
                      <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', color: C.text }}>{r.rvol != null ? `${fmt2(r.rvol)}×` : '—'}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}><span style={{ fontSize: 8.5, fontWeight: 700, padding: '2px 6px', borderRadius: 4, color: s.fg, background: s.bg }}>{s.label}</span></td>
                      <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', color: C.ink, fontWeight: 700 }}>{r.pitPressure ?? '—'}</td>
                      <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', color: r.pitIgnition >= 65 ? C.green : C.muted, fontWeight: 700 }}>{r.pitIgnition ?? '—'}</td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            </div>
          )}
    </div>
  );
}

const timeAgoShort = (iso) => {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
};

// One unified wire: market news + press-release wires (/api/news) + 8-K filings (/api/eightk),
// time-sorted, impact-flagged. Clicking a ticker loads it in linked chart panels.
function NewsWireBody({ onPick }) {
  const [items, setItems] = useState(null);
  const [ref, w] = useContainerSize();
  const showMeta = w >= 300;
  const load = useCallback(async () => {
    try {
      const [nRes, eRes] = await Promise.all([
        fetch('/api/news', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/eightk?limit=40', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const pool = [];
      for (const s of toArr(nRes?.data, 'stories', 'top_stories', 'articles', 'items', 'data')) {
        const headline = s.title || s.headline || s.summary || '';
        if (!headline) continue;
        const sym = (s.ticker && s.ticker !== 'N/A' && s.ticker !== 'null') ? s.ticker : (s.symbol || null);
        pool.push({ headline, source: s.source || 'News', url: s.url || null, published: s.published || s.date || null, sym,
          tier: impactOf({ title: headline, category: s.category || s.tag, source: s.source }) });
      }
      for (const f of (eRes?.list || [])) {
        pool.push({ headline: f.primaryLabel || 'Filing', source: '8-K', url: f.url || null, published: f.filedAt || null, sym: f.ticker,
          tier: impactOf({ title: f.primaryLabel, material: f.material, category: f.primaryLabel }) });
      }
      pool.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
      setItems(pool.slice(0, 80));
    } catch { setItems([]); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  if (items === null) return <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 13 }}>Loading the wire…</div>;
  if (items.length === 0) return <div style={{ padding: '24px 18px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No headlines right now.</div>;
  return (
    <div ref={ref} style={{ overflow: 'auto', flex: 1 }}>
      {items.map((n, i) => {
        const st = IMPACT_STYLE[n.tier];
        return (
          <div key={i} className="hov" style={{ padding: '7px 11px', borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              {st && <span style={{ fontSize: 8, fontWeight: 700, color: st.fg, background: st.bg, borderRadius: 3, padding: '1px 5px' }}>{st.label}</span>}
              {n.sym && <span onClick={() => onPick && onPick(n.sym)} title={`Load ${n.sym} in chart`} className="cp-tkr"
                style={{ fontSize: 11, fontWeight: 700, color: C.green, cursor: onPick ? 'pointer' : 'default' }}>{n.sym}</span>}
              {showMeta && <span style={{ marginLeft: 'auto', fontSize: 9.5, color: C.dim, whiteSpace: 'nowrap' }}>
                {n.source}{n.published ? ` · ${timeAgoShort(n.published)}` : ''}
              </span>}
            </div>
            {n.url
              ? <a href={n.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: C.ink, fontWeight: 600, lineHeight: 1.3, textDecoration: 'none', display: 'block' }}>{n.headline}</a>
              : <div style={{ fontSize: 12, color: C.ink, fontWeight: 600, lineHeight: 1.3 }}>{n.headline}</div>}
          </div>
        );
      })}
    </div>
  );
}

function WatchlistBody({ onPick }) {
  const [rows, setRows] = useState(null);
  const [ref, w] = useContainerSize();
  const showPrice = w >= 220;
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await fetch('/api/watchlist?prices=1', { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (alive) setRows(Array.isArray(j) ? j : []); }
      catch { if (alive) setRows([]); }
    })();
    return () => { alive = false; };
  }, []);
  if (rows === null) return <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 13 }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ padding: '24px 18px', textAlign: 'center', color: C.muted, fontSize: 12.5, lineHeight: 1.5 }}>Your watchlist is empty. Tap the ★ on any ticker page to track it here. <a href="/watchlist" style={{ color: C.green, fontWeight: 600 }}>Manage</a></div>;
  return (
    <div ref={ref} style={{ overflow: 'auto', flex: 1 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.ticker} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
              <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                <span onClick={() => onPick && onPick(r.ticker)} title="Load in chart" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <TickerLogo symbol={r.ticker} size={16} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                </span>
                <a href={`/ticker/${encodeURIComponent(r.ticker)}`} title="Open ticker page" style={{ marginLeft: 6, color: C.dim, textDecoration: 'none', fontSize: 11 }}>↗</a>
              </td>
              {showPrice && <td className="cp-num" style={{ padding: '7px 10px', textAlign: 'right', color: C.ink }}>{r.price != null ? (r.price > 1000 ? (+r.price).toLocaleString() : fmt2(+r.price)) : '—'}</td>}
              <td className="cp-num" style={{ padding: '7px 10px', textAlign: 'right', color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>
                {r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${fmt2(r.changePct)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Rolling ticker strip for the bottom of the Terminal (SPY/QQQ/DIA/etc. from the pit tape).
function BottomTape() {
  const [tk, setTk] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tape = await fetchKey('ticker_tape');
        const arr = toArr(tape, 'tickers', 'ticker_tape', 'data');
        const mapped = arr.map((t) => ({
          sym: t.symbol || t.sym || t.ticker || '?',
          price: parseFloat(t.price ?? t.last ?? t.close ?? t.regularMarketPrice) || 0,
          chg: parseFloat(t.changePct ?? t.chg ?? t.change_pct ?? t.changePercent) || 0,
        })).filter((t) => t.price > 0);
        if (alive) setTk(mapped);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, []);
  if (!tk.length) return null;
  const items = [...tk, ...tk];
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, background: C.white, overflow: 'hidden', padding: '8px 0' }}>
      <div style={{ display: 'inline-flex', whiteSpace: 'nowrap', animation: 'cp-btape 55s linear infinite' }}>
        {items.map((t, i) => (
          <span key={i} onClick={() => selectTerminalSymbol(t.sym)} title={`Load ${t.sym} in chart`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 16px', cursor: 'pointer' }}>
            <TickerLogo symbol={t.sym} size={15} />
            <span className="cp-tkr" style={{ fontSize: 11, color: C.muted }}>{t.sym}</span>
            <span className="cp-num" style={{ fontSize: 11, color: C.ink, fontWeight: 600 }}>{t.price > 1000 ? (+t.price).toLocaleString() : fmt2(+t.price)}</span>
            <span className="cp-num" style={{ fontSize: 10, color: t.chg >= 0 ? C.green : C.red, fontWeight: 600 }}>{t.chg > 0 ? '+' : ''}{fmt2(t.chg)}%</span>
          </span>
        ))}
      </div>
      <style>{`@keyframes cp-btape { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
    </div>
  );
}

// ── Panel chrome ──
function PanelCard({ def, colorKey, onCycleColor, onMoveStart, onResizeStart, draggable, headerRight, onRemove, children }) {
  return (
    <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div onPointerDown={draggable ? onMoveStart : undefined}
        style={{ cursor: draggable ? 'move' : 'default', padding: '6px 10px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, touchAction: 'none' }}>
        {draggable && (
          <button onPointerDown={(e) => e.stopPropagation()} onClick={onCycleColor}
            title="Link group — panels sharing this color sync (click to change)"
            style={{ width: 12, height: 12, borderRadius: 3, border: '1px solid rgba(0,0,0,0.15)', background: colorOf(colorKey), cursor: 'pointer', padding: 0, flexShrink: 0 }} />
        )}
        <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{def.title}</span>
        {def.tag && <span style={{ fontSize: 9, color: C.dim, letterSpacing: 0.5 }}>{def.tag}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {headerRight}
          {draggable && <span style={{ color: C.hint, fontSize: 13, letterSpacing: -1 }}>⠿</span>}
          {onRemove && (
            <button onPointerDown={(e) => e.stopPropagation()} onClick={onRemove} title="Remove panel"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.dim, fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
          )}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{children}</div>
      {draggable && (
        <div onPointerDown={onResizeStart}
          style={{ position: 'absolute', right: 0, bottom: 0, width: 22, height: 22, cursor: 'se-resize', touchAction: 'none', zIndex: 5 }}>
          <span style={{ position: 'absolute', right: 4, bottom: 4, width: 8, height: 8, borderRight: `2px solid ${C.muted}`, borderBottom: `2px solid ${C.muted}` }} />
        </div>
      )}
    </div>
  );
}

function Workspace() {
  const ref = useRef(null);
  const layoutRef = useRef(null);           // always-current layout for pointer math
  const [layout, setLayoutState] = useState(null);
  const [mobile, setMobile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState('SPY');   // centralized Terminal symbol
  const [visible, setVisibleState] = useState(DEFAULT_VISIBLE);
  const visibleRef = useRef(DEFAULT_VISIBLE);
  const [addOpen, setAddOpen] = useState(false);

  const setLayout = (l) => { layoutRef.current = l; setLayoutState(l); };
  const setVisible = (v) => { visibleRef.current = v; setVisibleState(v); };

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const apply = () => setMobile(mq.matches);
    apply(); mq.addEventListener('change', apply);
    const width = ref.current ? ref.current.clientWidth : 1200;
    let saved = null; try { saved = JSON.parse(localStorage.getItem('cp_terminal_layout') || 'null'); } catch { /* ignore */ }
    const raw = saved && saved.chart ? saved : {};
    const dl = defaultLayout(width);
    // Merge: default coords as the base, saved values on top — so panels added after a layout was
    // saved (e.g. Watchlist) still get valid x/y/w/h instead of NaN.
    const norm = {};
    // 'newswire' inherits the old 'news' panel's saved position for users who had it placed.
    for (const d of PANELS) { const s = raw[d.id] || (d.id === 'newswire' ? raw.news : null) || {}; norm[d.id] = { ...dl[d.id], ...s, color: s.color || dl[d.id].color || 'blue' }; }
    setLayout(norm);
    let vis = null; try { vis = JSON.parse(localStorage.getItem('cp_terminal_visible') || 'null'); } catch { /* ignore */ }
    // Migrate the old split panels → the unified News Wire (dedupe if both were present).
    if (Array.isArray(vis)) vis = [...new Set(vis.map((id) => (id === 'news' || id === 'eightk') ? 'newswire' : id))];
    setVisible(Array.isArray(vis) && vis.length ? vis.filter((id) => PANEL_BY_ID[id]) : DEFAULT_VISIBLE);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const persist = (l) => { try { localStorage.setItem('cp_terminal_layout', JSON.stringify(l)); } catch { /* ignore */ } };

  const start = (id, e, mode) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const o = { ...layoutRef.current[id] };   // real current position (from the ref)
    setDragging(true);
    const move = (ev) => {
      const next = mode === 'move'
        ? { ...o, x: Math.max(0, o.x + (ev.clientX - sx)), y: Math.max(0, o.y + (ev.clientY - sy)) }
        : { ...o, w: Math.max(MIN_W, o.w + (ev.clientX - sx)), h: Math.max(MIN_H, o.h + (ev.clientY - sy)) };
      setLayout({ ...layoutRef.current, [id]: next });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDragging(false);
      persist(layoutRef.current);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const persistVisible = (v) => { try { localStorage.setItem('cp_terminal_visible', JSON.stringify(v)); } catch { /* ignore */ } };
  const addPanel = (id) => { if (visibleRef.current.includes(id)) return; const v = [...visibleRef.current, id]; setVisible(v); persistVisible(v); setAddOpen(false); };
  const removePanel = (id) => { const v = visibleRef.current.filter((x) => x !== id); setVisible(v); persistVisible(v); };
  const reset = () => { const l = defaultLayout(ref.current?.clientWidth); setLayout(l); persist(l); setVisible(DEFAULT_VISIBLE); persistVisible(DEFAULT_VISIBLE); };

  // Centralized symbol selection: clicking a ticker ANYWHERE in the Terminal sets the active symbol
  // (drives the chart + future symbol-aware panels) instead of navigating away. Color link-groups are
  // retained (chip still cycles) for future multi-chart routing; with a single chart it's global.
  const selectSymbol = useCallback((sym) => { if (sym) setSelectedSymbol(String(sym).toUpperCase()); }, []);
  const linkSymbol = (sourceId, sym) => selectSymbol(sym);
  // Receive selections from globally-mounted tapes (top/bottom ticker tape) via the symbol bus.
  useEffect(() => onTerminalSymbol(selectSymbol), [selectSymbol]);
  const cycleColor = (id) => { const l = layoutRef.current; const nl = { ...l, [id]: { ...l[id], color: nextColor(l[id].color) } }; setLayout(nl); persist(nl); };

  const bodyOf = (def) => (def.id === 'chart' ? <ChartBody symbol={selectedSymbol} />
    : def.id === 'halts' ? <HaltBody onPick={(s) => linkSymbol('halts', s)} />
    : def.id === 'watchlist' ? <WatchlistBody onPick={(s) => linkSymbol('watchlist', s)} />
    : def.id === 'chat' ? <PitChat bare onSymbol={selectSymbol} />
    : def.id === 'tape' ? <XTape bare />
    : def.id === 'newswire' ? <NewsWireBody onPick={(s) => linkSymbol('newswire', s)} />
    : def.id === 'pitscan' ? <PitScanBody onPick={(s) => linkSymbol('pitscan', s)} />
    : def.id === 'scanner' ? <ScanBody mode="custom" onPick={(s) => linkSymbol('scanner', s)} />
    : null);
  const headerRightOf = (def) => (def.id === 'chart'
    ? <span className="cp-tkr" style={{ fontSize: 11, color: C.ink, fontWeight: 700 }}>{selectedSymbol}</span> : null);

  if (!layout) return <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading workspace…</div>;

  // Mobile: stack the panels, no dragging.
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {visible.map((id) => { const def = PANEL_BY_ID[id]; if (!def) return null; return (
          <div key={id} style={{ position: 'relative', height: id === 'chart' ? 420 : id === 'chat' ? 460 : id === 'tape' ? 500 : 320 }}>
            <PanelCard def={def} draggable={false} colorKey={layout[id]?.color} headerRight={headerRightOf(def)} onRemove={() => removePanel(id)}>{bodyOf(def)}</PanelCard>
          </div>
        ); })}
      </div>
    );
  }

  const containerH = Math.max(...visible.map((id) => (layout[id]?.y || 0) + (layout[id]?.h || 0)), 400) + 8;
  const hidden = PANELS.filter((d) => !visible.includes(d.id));
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setAddOpen((o) => !o)}
            style={{ background: C.green, border: 'none', color: '#fff', borderRadius: 6, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
            + Add panel
          </button>
          {addOpen && (
            <>
              <div onClick={() => setAddOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
              <div style={{ position: 'absolute', right: 0, top: '112%', zIndex: 21, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', minWidth: 180, overflow: 'hidden' }}>
                {hidden.length === 0 ? (
                  <div style={{ padding: '10px 14px', fontSize: 12, color: C.dim }}>All panels added.</div>
                ) : hidden.map((d) => (
                  <button key={d.id} onClick={() => addPanel(d.id)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: C.ink, fontFamily: "'DM Sans',sans-serif" }}>
                    {d.title}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button onClick={reset} style={{ background: C.white, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Reset layout</button>
      </div>
      <div ref={ref} style={{ position: 'relative', width: '100%', height: containerH }}>
        {visible.map((id) => {
          const def = PANEL_BY_ID[id]; const p = layout[id];
          if (!def || !p) return null;
          return (
            <div key={id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}>
              <PanelCard def={def} draggable colorKey={p.color} onCycleColor={() => cycleColor(id)}
                onMoveStart={(e) => start(id, e, 'move')} onResizeStart={(e) => start(id, e, 'resize')}
                headerRight={headerRightOf(def)} onRemove={() => removePanel(id)}>{bodyOf(def)}</PanelCard>
            </div>
          );
        })}
        {/* transparent overlay during drag/resize so pointer moves aren't swallowed by the chart iframe */}
        {dragging && <div style={{ position: 'fixed', inset: 0, zIndex: 50, cursor: 'grabbing', userSelect: 'none' }} />}
      </div>
    </>
  );
}

export default function TerminalClient() {
  const [tier, setTier] = useState(null);
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [p, a] = await Promise.all([
          fetch('/api/me/plan', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/me/admin', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        setTier(p?.tier || 'free'); setAdmin(!!a?.admin);
      } catch { setTier('free'); }
    })();
  }, []);
  const isPro = tier === 'pro' || tier === 'elite' || admin;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Terminal" />
      <BottomTape />
      {/* full-bleed (no centered max-width) so the free-floating panels can be dragged to the screen edges */}
      <div style={{ margin: '18px 0', padding: '0 12px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 28, fontWeight: 600, color: C.ink, margin: 0 }}>Terminal</h1>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: '#B8860B', borderRadius: 3, padding: '2px 6px', letterSpacing: 0.5 }}>PRO</span>
          <span style={{ fontSize: 12, color: C.dim }}>drag panels by their header · resize from the corner</span>
        </div>

        {tier === null ? (
          <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading…</div>
        ) : !isPro ? (
          <div style={{ background: C.white, border: `1px solid ${C.greenBorder}`, borderRadius: 10, padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, marginBottom: 8 }}>The Terminal is a Pro feature</div>
            <div style={{ fontSize: 14, color: C.muted, maxWidth: 440, margin: '0 auto 18px' }}>A movable trading workspace — live halt scanner, chart, movers and catalysts, arranged your way.</div>
            <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '12px 26px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Start Pro — $12/mo</button>
          </div>
        ) : (
          <Workspace />
        )}
      </div>
      <Footer />
    </div>
  );
}
