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
  { id: 'movers',    title: 'Movers',       tag: 'DELAYED' },
  { id: 'why',       title: 'Why Moving',   tag: 'CATALYST' },
  { id: 'convergence', title: 'Catalyst Convergence', tag: '◆ SMART MONEY' },
  { id: 'alerts',    title: 'Alerts',       tag: 'ENGINE' },
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
    movers:    { x: centerX + 12, y: 402, w: centerW, h: 260, color: 'blue' },
    why:       { x: centerX + 36, y: 422, w: centerW, h: 220, color: 'green' },
    convergence: { x: centerX + 48, y: 432, w: centerW, h: 260, color: 'green' },
    alerts:    { x: centerX + 60, y: 442, w: centerW, h: 260, color: 'blue' },
    // right column
    watchlist: { x: rightX, y: 0, w: rightW, h: top, color: 'blue' },
    chat:      { x: rightX, y: botY, w: rightW, h: top, color: 'green' },
  };
}

// Category color per panel id (used when a station preset auto-arranges panels).
const COLOR_BY_ID = { tape: 'orange', halts: 'red', chart: 'blue', newswire: 'orange', pitscan: 'green', scanner: 'blue', movers: 'blue', why: 'green', convergence: 'green', alerts: 'blue', watchlist: 'blue', chat: 'green' };

// Built-in Station presets — starting layouts only (code config, not stored per user). Panels that
// don't exist yet are simply skipped; add more panel ids as future panels land. After loading a
// preset the user can rearrange and Save As their own custom station.
const STATION_PRESETS = [
  { key: 'day',      name: 'Day Trader', visible: ['chart', 'pitscan', 'scanner', 'watchlist', 'newswire', 'halts'] },
  { key: 'smallcap', name: 'Small Cap',  visible: ['pitscan', 'newswire', 'halts', 'watchlist', 'scanner', 'chat', 'chart'] },
  { key: 'macro',    name: 'Macro',      visible: ['chart', 'newswire', 'tape', 'watchlist'] },
  { key: 'investor', name: 'Investor',   visible: ['chart', 'watchlist', 'convergence', 'newswire'] },
  { key: 'minimal',  name: 'Minimal',    visible: ['chart', 'watchlist', 'newswire'] },
  { key: 'newsdesk', name: 'News Desk',  visible: ['newswire', 'tape', 'pitscan', 'halts', 'watchlist', 'chart'] },
];
const presetVisible = (p) => p.visible.filter((id) => PANEL_BY_ID[id]);

// Auto-arrange a set of panels into a clean, non-overlapping layout (chart center-large, the rest
// stacked in side columns). Reuses the {x,y,w,h,color} format so it plugs into the existing engine.
function arrangeStation(ids, width) {
  const w = width || 1200, gap = 12, unit = (w - gap * 2) / 12;
  const col = (u) => Math.round(unit * u);
  const out = {}, color = (id) => COLOR_BY_ID[id] || 'blue';
  const put = (id, x, y, ww, h) => { out[id] = { x, y, w: ww, h, color: color(id) }; };
  if (ids.includes('chart')) {
    const leftX = 0, leftW = col(3), centerX = col(3) + gap, centerW = col(6), rightX = col(9) + gap * 2, rightW = col(3) - 2, H = 300;
    put('chart', centerX, 0, centerW, 560);
    let leftY = 0, rightY = 0, side = 0;
    for (const id of ids) { if (id === 'chart') continue; if (side % 2 === 0) { put(id, leftX, leftY, leftW, H); leftY += H + gap; } else { put(id, rightX, rightY, rightW, H); rightY += H + gap; } side++; }
  } else {
    const cW = col(4), xs = [0, col(4) + gap, col(8) + gap * 2], ys = [0, 0, 0], H = 320;
    ids.forEach((id, i) => { const c = i % 3; put(id, xs[c], ys[c], cW - (c === 2 ? 2 : 0), H); ys[c] += H + gap; });
  }
  return out;
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

// ── CUSTOM SCANNER — user-controlled, compact "+ Add Filter" scanner over OUR screener backend
// (/api/screener → screener_stocks + buildConds). Transparent filters only (no Pit Scan proprietary
// metrics). Saved scans persist per user (scope='terminal'). Results react to panel width. ──
const fmtVol = (n) => (n == null || isNaN(n)) ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n));

function CustomScannerBody({ onPick }) {
  const [meta, setMeta] = useState(null);        // FILTERS registry from the screener backend
  const [conds, setConds] = useState([]);        // [{ key, cond }]
  const [rows, setRows] = useState(null);        // null = not run yet
  const [running, setRunning] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [saved, setSaved] = useState([]);
  const [ref, w] = useContainerSize();

  const loadSaved = useCallback(() => {
    fetch('/api/screener/saved?scope=terminal', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => setSaved(j?.saved || [])).catch(() => {});
  }, []);
  useEffect(() => {
    fetch('/api/screener?meta=1', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => setMeta(j?.filters || {})).catch(() => setMeta({}));
    loadSaved();
  }, [loadSaved]);

  const byCat = {};
  if (meta) for (const [k, f] of Object.entries(meta)) { if (f.available) (byCat[f.category] ||= []).push([k, f]); }

  const addFilter = (key) => { setConds((c) => (c.some((x) => x.key === key) ? c : [...c, { key, cond: meta[key]?.opts?.[0]?.cond || null }])); setAddOpen(false); };
  const setCond = (i, cond) => setConds((c) => c.map((x, j) => (j === i ? { ...x, cond } : x)));
  const removeCond = (i) => setConds((c) => c.filter((_, j) => j !== i));
  const buildFilters = () => { const f = {}; for (const c of conds) if (c.cond) f[c.key] = c.cond; return f; };

  const run = useCallback(async (condList) => {
    setRunning(true);
    const list = condList || conds;
    const filters = {}; for (const c of list) if (c.cond) filters[c.key] = c.cond;
    try {
      const r = await fetch(`/api/screener?filters=${encodeURIComponent(JSON.stringify(filters))}&pageSize=100`, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null; setRows(j?.rows || []);
    } catch { setRows([]); }
    setRunning(false);
  }, [conds]);

  const save = async () => {
    const name = window.prompt('Save this scan as:'); if (!name) return;
    await fetch('/api/screener/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, filters: buildFilters(), scope: 'terminal' }) }).catch(() => {});
    loadSaved();
  };
  const loadScan = (s) => { const c = Object.entries(s.filters || {}).map(([key, cond]) => ({ key, cond })); setConds(c); run(c); };
  const delScan = async (id) => { await fetch(`/api/screener/saved?scope=terminal&id=${id}`, { method: 'DELETE' }).catch(() => {}); loadSaved(); };
  const alertScan = async () => {
    if (!conds.length) return;
    const name = window.prompt('Alert me when a NEW ticker matches this scan — name it:'); if (!name) return;
    try { await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, filters: buildFilters() }) }); window.alert('Alert set — you’ll get a bell notification when a new name enters this scan.'); } catch { /* ignore */ }
  };

  const btn = { fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 5, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", border: `1px solid ${C.border}`, background: C.white, color: C.muted };
  const showPrice = w >= 280, showVol = w >= 340, showCompany = w >= 560, showFloat = w >= 460, showMcap = w >= 420;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', position: 'relative', flexWrap: 'wrap' }}>
          <button onClick={() => setAddOpen((v) => !v)} style={{ ...btn, color: C.green, borderColor: C.greenBorder }}>+ Add Filter</button>
          <button onClick={() => run()} style={{ ...btn, background: C.green, color: '#fff', border: 'none' }}>{running ? 'Running…' : 'Run Scan'}</button>
          <button onClick={save} disabled={!conds.length} style={{ ...btn, opacity: conds.length ? 1 : 0.5 }}>Save</button>
          <button onClick={alertScan} disabled={!conds.length} title="Alert when a new ticker matches" style={{ ...btn, opacity: conds.length ? 1 : 0.5 }}>🔔 Alert</button>
          {conds.length > 0 && <button onClick={() => { setConds([]); setRows(null); }} style={{ ...btn, border: 'none', background: 'transparent', color: C.dim, textDecoration: 'underline' }}>Clear</button>}
          {addOpen && meta && (
            <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 30, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', minWidth: 210, maxHeight: 300, overflow: 'auto', padding: '4px 0' }}>
              {Object.keys(byCat).length === 0 ? <div style={{ padding: '10px 14px', fontSize: 12, color: C.dim }}>Loading filters…</div>
                : Object.entries(byCat).map(([cat, list]) => (
                  <div key={cat}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: 0.6, padding: '6px 12px 2px' }}>{cat.toUpperCase()}</div>
                    {list.map(([k, f]) => (
                      <button key={k} onClick={() => addFilter(k)} disabled={conds.some((x) => x.key === k)}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: conds.some((x) => x.key === k) ? C.hint : C.ink, fontFamily: "'DM Sans',sans-serif" }}>
                        {f.pit ? '◆ ' : ''}{f.label}
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </div>
        {conds.map((c, i) => { const f = meta?.[c.key]; const opts = f?.opts || []; const idx = opts.findIndex((o) => JSON.stringify(o.cond) === JSON.stringify(c.cond)); return (
          <div key={c.key} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <span style={{ fontSize: 11, color: f?.pit ? C.green : C.muted, fontWeight: 600, minWidth: 92, flexShrink: 0 }}>{f?.pit ? '◆' : ''}{f?.label || c.key}</span>
            <select value={idx} onChange={(e) => setCond(i, opts[+e.target.value]?.cond)} style={{ ...scanField, flex: 1 }}>
              {opts.map((o, j) => <option key={j} value={j}>{o.label}</option>)}
            </select>
            <button onClick={() => removeCond(i)} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' }}>×</button>
          </div>
        ); })}
        {saved.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: C.dim }}>Saved:</span>
            {saved.map((s) => (
              <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 11, padding: '2px 8px' }}>
                <button onClick={() => loadScan(s)} style={{ background: 'none', border: 'none', color: C.green, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>{s.name}</button>
                <button onClick={() => delScan(s.id)} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 12 }}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div ref={ref} style={{ overflow: 'auto', flex: 1 }}>
        {rows === null ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Add filters and Run Scan.</div>
          : rows.length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No matches — widen your filters.</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.ticker + i} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
                      <td style={{ padding: '6px 9px', whiteSpace: 'nowrap' }}>
                        <span onClick={() => onPick && onPick(r.ticker)} title="Load in chart" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <TickerLogo symbol={r.ticker} size={15} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                        </span>
                      </td>
                      {showCompany && <td style={{ padding: '6px 9px', color: C.muted, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company || '—'}</td>}
                      {showPrice && <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: C.ink }}>{r.price != null ? fmt2(r.price) : '—'}</td>}
                      <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>{r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${fmt2(r.changePct)}%`}</td>
                      {showVol && <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: C.text }}>{fmtVol(r.volume)}</td>}
                      <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: C.text }}>{r.relVol != null ? `${fmt2(r.relVol)}×` : '—'}</td>
                      {showFloat && <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: C.muted }}>{fmtVol(r.floatShares)}</td>}
                      {showMcap && <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: C.muted }}>{fmtCap(r.marketCap)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </div>
    </div>
  );
}

// ── MOVERS — top gainers / losers / most-active from Polygon (delayed). Clicking a ticker sets the
// Terminal symbol; columns react to panel width. ──
function MoversBody({ onPick }) {
  const [tab, setTab] = useState('gainers');
  const [data, setData] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [ref, w] = useContainerSize();
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/movers', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (!alive) return;
        setConfigured(j?.configured !== false);
        setData(j || {});
      } catch { if (alive) setData({}); }
    };
    load(); const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const rows = data ? (data[tab] || []) : null;
  const showPrice = w >= 260, showVol = w >= 340;
  const tabBtn = (k, label) => (
    <button key={k} onClick={() => setTab(k)} style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 5, cursor: 'pointer', border: 'none', background: tab === k ? C.ink : 'transparent', color: tab === k ? '#fff' : C.muted }}>{label}</button>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {tabBtn('gainers', 'Gainers')}{tabBtn('losers', 'Losers')}{tabBtn('active', 'Active')}
        <span style={{ marginLeft: 'auto', fontSize: 8.5, color: C.dim, letterSpacing: 0.3 }}>~15m DELAYED</span>
      </div>
      <div ref={ref} style={{ overflow: 'auto', flex: 1 }}>
        {rows === null ? <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Loading movers…</div>
          : !configured ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12, lineHeight: 1.5 }}>Movers needs a market-data feed.</div>
            : rows.length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No movers right now.</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.ticker + i} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
                        <td style={{ padding: '6px 9px', whiteSpace: 'nowrap' }}>
                          <span onClick={() => onPick && onPick(r.ticker)} title="Load in chart" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <TickerLogo symbol={r.ticker} size={15} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                          </span>
                        </td>
                        {showPrice && <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: C.ink }}>{r.price != null ? fmt2(r.price) : '—'}</td>}
                        <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>{r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${fmt2(r.changePct)}%`}</td>
                        {showVol && <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', color: C.text }}>{fmtVol(r.volume)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
      </div>
    </div>
  );
}

// ── WHY MOVING — symbol-aware panel. For the active Terminal symbol, surfaces the grounded catalyst
// (recent 8-K) + the market reaction context we already track. No AI speculation. ──
function WhyMovingBody({ symbol }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!symbol) { setD(null); return; }
    let alive = true; setD(null);
    fetch(`/api/why?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive) setD(j || {}); }).catch(() => { if (alive) setD({}); });
    return () => { alive = false; };
  }, [symbol]);

  if (!symbol) return <div style={{ padding: '24px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>Click any ticker to see why it&apos;s moving.</div>;
  if (d === null) return <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 13 }}>Reading the tape for {symbol}…</div>;
  const ctx = d.context, cat = d.catalyst;
  const chip = (label, tone) => <span style={{ fontSize: 10, fontWeight: 700, color: tone ? tone.fg : C.muted, background: tone ? tone.bg : C.surface, borderRadius: 4, padding: '2px 7px' }}>{label}</span>;

  return (
    <div style={{ padding: 12, overflow: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <TickerLogo symbol={symbol} size={22} />
        <span className="cp-tkr" style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>{symbol}</span>
        {ctx?.changePct != null && <span className="cp-num" style={{ fontSize: 15, fontWeight: 700, color: ctx.changePct >= 0 ? C.green : C.red }}>{ctx.changePct > 0 ? '+' : ''}{fmt2(ctx.changePct)}%</span>}
        {ctx?.price != null && <span className="cp-num" style={{ fontSize: 12, color: C.muted, marginLeft: 'auto' }}>{fmt2(ctx.price)}</span>}
      </div>

      <div style={{ fontSize: 9, fontWeight: 800, color: C.dim, letterSpacing: 1, marginBottom: 5 }}>WHY IT&apos;S MOVING</div>
      {cat ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {chip(cat.type, cat.material ? { fg: '#B45309', bg: '#FEF3C7' } : null)}
            <span style={{ fontSize: 11, color: C.muted }}>{cat.source} · {cat.agoMin < 60 ? `${cat.agoMin}m ago` : cat.agoMin < 1440 ? `${Math.round(cat.agoMin / 60)}h ago` : `${Math.round(cat.agoMin / 1440)}d ago`}</span>
            {cat.url && <a href={cat.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: C.green, fontWeight: 600, textDecoration: 'none' }}>View filing ↗</a>}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
          {ctx?.breakingToday || ctx?.newsCategory ? `Fresh ${ctx.newsCategory || 'news'} today — check the News Wire.` : 'No fresh SEC catalyst on file (last 7 days). The move may be news-, sector- or flow-driven.'}
        </div>
      )}

      <div style={{ fontSize: 9, fontWeight: 800, color: C.dim, letterSpacing: 1, marginBottom: 5 }}>CONTEXT</div>
      {ctx ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ctx.relVol != null && chip(`RVOL ${fmt2(ctx.relVol)}×`, ctx.relVol >= 2 ? { fg: '#C2410C', bg: '#FFEDD5' } : null)}
          {ctx.nearHigh && chip('Near 20D high', { fg: '#1E5C38', bg: '#E8F5EE' })}
          {ctx.volume != null && chip(`Vol ${fmtVol(ctx.volume)}`)}
          {ctx.consensusScore != null && chip(`◆ Convergence ${ctx.consensusScore}`, { fg: '#1E5C38', bg: '#E8F5EE' })}
          {ctx.company && <div style={{ width: '100%', fontSize: 10.5, color: C.dim, marginTop: 4 }}>{ctx.company}</div>}
        </div>
      ) : <div style={{ fontSize: 11.5, color: C.dim }}>Not in our covered universe yet — no reaction context.</div>}
    </div>
  );
}

// ── CATALYST CONVERGENCE — surfaces the Pit Consensus board (insiders + Congress + 13F stacking the
// same direction) inside the Terminal. Reuses /api/confluence; free sees a teaser, Pro the full board. ──
const CONV_SRC = { insider: 'INSIDER', congress: 'CONGRESS', fund: '13F' };
function ConvergenceBody({ onPick }) {
  const [dir, setDir] = useState('bull');
  const [data, setData] = useState(null);
  const [ref, w] = useContainerSize();
  useEffect(() => {
    let alive = true; setData(null);
    const load = () => fetch(`/api/confluence?dir=${dir}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setData(j); }).catch(() => { if (alive) setData({ list: [] }); });
    load(); const id = setInterval(load, 120000);
    return () => { alive = false; clearInterval(id); };
  }, [dir]);
  const list = data ? (data.list || []) : null; const locked = data?.lockedCount || 0;
  const showChips = w >= 300;
  const dirBtn = (k, label) => (
    <button key={k} onClick={() => setDir(k)} style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 10px', borderRadius: 5, cursor: 'pointer', border: 'none', background: dir === k ? (k === 'bull' ? C.green : C.red) : 'transparent', color: dir === k ? '#fff' : C.muted }}>{label}</button>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {dirBtn('bull', 'Accumulation')}{dirBtn('bear', 'Distribution')}
        <span style={{ marginLeft: 'auto', fontSize: 8.5, color: C.dim, letterSpacing: 0.3 }}>◆ SIGNALS STACKED</span>
      </div>
      <div ref={ref} style={{ overflow: 'auto', flex: 1 }}>
        {list === null ? <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Loading the board…</div>
          : list.length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No stacked signals right now.</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>
                  {list.map((r, i) => (
                    <tr key={r.ticker + i} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
                      <td style={{ padding: '6px 9px', whiteSpace: 'nowrap' }}>
                        <span onClick={() => onPick && onPick(r.ticker)} title="Load in chart" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <TickerLogo symbol={r.ticker} size={15} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                        </span>
                      </td>
                      {showChips && <td style={{ padding: '6px 9px' }}>
                        <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap' }}>
                          {Object.keys(CONV_SRC).filter((k) => r[k]).map((k) => (
                            <span key={k} style={{ fontSize: 8, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 3, padding: '1px 4px' }}>{CONV_SRC[k]}</span>
                          ))}
                        </span>
                      </td>}
                      <td className="cp-num" style={{ padding: '6px 9px', textAlign: 'right', fontWeight: 800, color: dir === 'bull' ? C.green : C.red }}>{r.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        {locked > 0 && (
          <a href="/consensus" style={{ display: 'block', padding: '10px 12px', textAlign: 'center', fontSize: 11.5, fontWeight: 600, color: C.green, textDecoration: 'none', borderTop: `1px solid ${C.surface}`, background: C.greenLight }}>
            🔒 +{locked} more names — unlock the full board with Pro ↗
          </a>
        )}
      </div>
    </div>
  );
}

// ── ALERTS — create/manage alert rules for the active symbol; the engine (server-side) evaluates them
// on a schedule and fires notifications to the bell. ──
function AlertsBody({ symbol }) {
  const [data, setData] = useState(null);   // { alerts, types }
  const [sym, setSym] = useState(symbol || '');
  const [type, setType] = useState('price_above');
  const [thr, setThr] = useState('');
  useEffect(() => { if (symbol) setSym(symbol); }, [symbol]);
  const load = useCallback(() => fetch('/api/alerts', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => setData(j || { alerts: [], types: [] })).catch(() => setData({ alerts: [], types: [] })), []);
  useEffect(() => { load(); }, [load]);
  const types = data?.types || [];
  const meta = types.find((t) => t.key === type);
  const apply = (j) => { if (j?.alerts) setData((d) => ({ ...d, alerts: j.alerts })); };
  const create = async () => {
    const s = sym.trim().toUpperCase(); if (!s) return;
    try { const r = await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: s, type, threshold: meta?.needsThreshold ? thr : null }) }); apply(await r.json()); setThr(''); } catch { /* ignore */ }
  };
  const del = async (id) => { try { apply(await (await fetch(`/api/alerts?id=${id}`, { method: 'DELETE' })).json()); } catch { /* ignore */ } };
  const toggle = async (a) => { try { apply(await (await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: a.id, active: !a.active }) })).json()); } catch { /* ignore */ } };
  const labelOf = (k) => (types.find((t) => t.key === k)?.label || k);
  const fld = { height: 28, boxSizing: 'border-box', borderRadius: 5, border: `1px solid ${C.border}`, padding: '0 7px', fontSize: 11.5, fontFamily: "'DM Sans',sans-serif", outline: 'none', color: C.ink, background: C.white };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} placeholder="SYMBOL" style={{ ...fld, width: 74 }} />
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...fld, flex: 1, minWidth: 120 }}>
          {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        {meta?.needsThreshold && <input value={thr} onChange={(e) => setThr(e.target.value)} placeholder={meta.unit || 'value'} inputMode="decimal" style={{ ...fld, width: 66 }} />}
        <button onClick={create} style={{ height: 28, background: C.green, color: '#fff', border: 'none', borderRadius: 5, padding: '0 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Add</button>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {data === null ? <div style={{ padding: 18, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Loading…</div>
          : (data.alerts || []).length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5, lineHeight: 1.5 }}>No alerts yet. Set one above — you&apos;ll get a bell notification when it triggers.</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>
                  {data.alerts.map((a, i) => { const isScan = a.type === 'scan_new'; return (
                    <tr key={a.id} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none', opacity: a.active ? 1 : 0.55 }}>
                      <td style={{ padding: '7px 9px', whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {isScan ? <span style={{ fontWeight: 700, color: C.ink }}>🔔 {a.note}</span> : <span className="cp-tkr" style={{ fontWeight: 700, color: C.ink }}>{a.symbol}</span>}
                      </td>
                      <td style={{ padding: '7px 9px', color: C.text }}>{isScan ? 'New scan match' : `${labelOf(a.type)}${a.threshold != null ? ` ${a.threshold}` : ''}`}</td>
                      <td style={{ padding: '7px 9px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {isScan
                          ? <span style={{ fontSize: 8.5, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 3, padding: '1px 5px' }}>WATCHING</span>
                          : a.active
                            ? <span style={{ fontSize: 8.5, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 3, padding: '1px 5px' }}>ARMED</span>
                            : <button onClick={() => toggle(a)} title="Re-arm" style={{ fontSize: 8.5, fontWeight: 700, color: C.muted, background: C.surface, border: 'none', borderRadius: 3, padding: '2px 6px', cursor: 'pointer' }}>TRIGGERED · re-arm</button>}
                        <button onClick={() => del(a.id)} title="Delete" style={{ marginLeft: 6, background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
                      </td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            )}
      </div>
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

// Small live-status pills for watchlist tickers.
const WL_BADGE = { news: { label: 'NEWS', fg: '#B45309', bg: '#FEF3C7' }, halt: { label: 'HALT', fg: '#B91C1C', bg: '#FEE2E2' }, pit: { label: 'PIT', fg: '#1E5C38', bg: '#E8F5EE' } };

function WatchlistBody({ onPick }) {
  const [rows, setRows] = useState(null);
  const [sig, setSig] = useState({ news: [], halt: [], pit: [] });
  const [ref, w] = useContainerSize();
  const showPrice = w >= 220;
  useEffect(() => {
    let alive = true;
    const loadRows = async () => {
      try { const r = await fetch('/api/watchlist?prices=1', { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (alive) setRows(Array.isArray(j) ? j : []); }
      catch { if (alive) setRows([]); }
    };
    loadRows();
    return () => { alive = false; };
  }, []);
  // Refresh live status flags (NEWS/HALT/PIT) for the watchlist tickers.
  useEffect(() => {
    if (!rows || !rows.length) return;
    let alive = true;
    const syms = rows.map((r) => r.ticker).join(',');
    const load = async () => {
      try { const r = await fetch(`/api/watchlist/signals?symbols=${encodeURIComponent(syms)}`, { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (alive && j) setSig(j); }
      catch { /* ignore */ }
    };
    load(); const id = setInterval(load, 45000);
    return () => { alive = false; clearInterval(id); };
  }, [rows]);
  const badgesFor = (t) => ['halt', 'news', 'pit'].filter((k) => (sig[k] || []).includes(t));
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
                {badgesFor(r.ticker).map((k) => { const b = WL_BADGE[k]; return <span key={k} title={`${b.label} — live`} style={{ marginLeft: 4, fontSize: 8, fontWeight: 800, color: b.fg, background: b.bg, borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle' }}>{b.label}</span>; })}
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
function PanelCard({ def, colorKey, onSetColor, onMoveStart, onResizeStart, draggable, headerRight, onRemove, children }) {
  const [colorMenu, setColorMenu] = useState(false);
  return (
    <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div onPointerDown={draggable ? onMoveStart : undefined}
        style={{ cursor: draggable ? 'move' : 'default', padding: '6px 10px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, touchAction: 'none' }}>
        {draggable && (
          <span style={{ position: 'relative', flexShrink: 0, display: 'inline-flex' }} onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => setColorMenu((v) => !v)}
              title="Link-group color — pick a group (panels sharing a color sync)"
              style={{ width: 12, height: 12, borderRadius: 3, border: '1px solid rgba(0,0,0,0.15)', background: colorOf(colorKey), cursor: 'pointer', padding: 0, display: 'block' }} />
            {colorMenu && (
              <>
                <div onClick={() => setColorMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
                <div style={{ position: 'absolute', top: '150%', left: 0, zIndex: 40, display: 'flex', gap: 5, background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.18)', padding: 5 }}>
                  {LINK_COLORS.map((lc) => (
                    <button key={lc.key} title={lc.key} onClick={() => { onSetColor && onSetColor(lc.key); setColorMenu(false); }}
                      style={{ width: 15, height: 15, borderRadius: 3, cursor: 'pointer', padding: 0, background: lc.c, border: lc.key === colorKey ? `2px solid ${C.ink}` : '1px solid rgba(0,0,0,0.2)' }} />
                  ))}
                </div>
              </>
            )}
          </span>
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

// Terminal symbol search — type a ticker (autocomplete) to set the shared symbol; drives the chart +
// every symbol-aware panel without depending on the chart's own search.
function SymbolSearchBox() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const timer = useRef(null);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 1) { setResults([]); setOpen(false); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/symbol-search?q=${encodeURIComponent(s)}`, { cache: 'no-store' }); const j = r.ok ? await r.json() : null; const rs = j?.results || []; setResults(rs); setOpen(rs.length > 0); setHi(0); } catch { setResults([]); }
    }, 160);
    return () => clearTimeout(timer.current);
  }, [q]);
  const pick = (sym) => { if (!sym) return; selectTerminalSymbol(sym); setQ(''); setResults([]); setOpen(false); };
  const onKey = (e) => {
    if (!open) { if (e.key === 'Enter') { e.preventDefault(); pick(q.trim().toUpperCase()); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(results[hi]?.ticker || q.trim().toUpperCase()); }
    else if (e.key === 'Escape') { setOpen(false); }
  };
  return (
    <div style={{ position: 'relative', width: 230, maxWidth: '46vw' }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} onFocus={() => results.length && setOpen(true)}
        placeholder="Search symbol → chart" spellCheck={false} autoComplete="off"
        style={{ width: '100%', height: 32, boxSizing: 'border-box', borderRadius: 6, border: `1px solid ${C.border}`, padding: '0 10px', fontSize: 12.5, fontFamily: "'DM Sans',sans-serif", outline: 'none', background: C.white, color: C.ink }} />
      {open && results.length > 0 && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 22 }} />
          <div style={{ position: 'absolute', top: '110%', left: 0, right: 0, zIndex: 23, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', overflow: 'hidden', maxHeight: 320, overflowY: 'auto' }}>
            {results.map((r, i) => (
              <button key={r.ticker} onMouseEnter={() => setHi(i)} onClick={() => pick(r.ticker)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 11px', background: i === hi ? C.surface : 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
                <TickerLogo symbol={r.ticker} size={16} />
                <span className="cp-tkr" style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>{r.ticker}</span>
                <span style={{ fontSize: 11, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              </button>
            ))}
          </div>
        </>
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
  // ── Stations ──
  const [stations, setStations] = useState([]);       // account-backed custom stations
  const [station, setStation] = useState({ id: null, name: 'My Layout', sourceType: 'local', presetKey: null });
  const [stationOpen, setStationOpen] = useState(false);
  const baselineRef = useRef('');                      // JSON snapshot of the loaded station (for dirty)

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

    // Stations: load account stations; auto-load the user's default. If none, keep the CURRENT local
    // layout as an unsaved "My Existing Layout" so no existing workspace is ever lost.
    (async () => {
      const list = await loadStations();
      const def = list.find((s) => s.isDefault);
      if (def) { applyStation(def); return; }
      const meta = { id: null, name: 'My Existing Layout', sourceType: 'local', presetKey: null };
      setStation(meta);
      baselineRef.current = sigOf(layoutRef.current, visibleRef.current);
    })();
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

  // ── STATIONS ── normalizeLayout ensures every panel id has valid coords (old stations still load
  // after new panel types are added — future-compat). sigOf = dirty-tracking signature.
  const normalizeLayout = (lay) => { const dl = defaultLayout(ref.current?.clientWidth); const out = {}; for (const d of PANELS) out[d.id] = { ...dl[d.id], ...((lay && lay[d.id]) || {}) }; return out; };
  const sigOf = (lay, vis) => JSON.stringify({ layout: lay, visible: vis });
  const applyLayoutVisible = (lay, vis) => {
    const nl = normalizeLayout(lay);
    const nv = (Array.isArray(vis) && vis.length ? vis : DEFAULT_VISIBLE).filter((id) => PANEL_BY_ID[id]);
    setLayout(nl); persist(nl); setVisible(nv); persistVisible(nv);
    return { nl, nv };
  };
  const rememberStation = (meta) => { try { localStorage.setItem('cp_terminal_station', JSON.stringify(meta)); } catch { /* ignore */ } };
  const applyStation = (st) => {
    const { nl, nv } = applyLayoutVisible(st.layout, st.visible);
    const meta = { id: st.id ?? null, name: st.name, sourceType: st.sourceType || 'custom', presetKey: st.presetKey || null };
    setStation(meta); rememberStation(meta); baselineRef.current = sigOf(nl, nv); setStationOpen(false);
  };
  const applyPreset = (p) => { const vis = presetVisible(p); applyStation({ id: null, name: p.name, sourceType: 'preset', presetKey: p.key, layout: arrangeStation(vis, ref.current?.clientWidth), visible: vis }); };
  const loadStations = async () => { try { const r = await fetch('/api/stations', { cache: 'no-store' }); const j = r.ok ? await r.json() : null; setStations(j?.stations || []); return j?.stations || []; } catch { return []; } };
  const saveAsStation = async () => {
    const name = window.prompt('Name this station:', station.sourceType === 'preset' ? `${station.name} (mine)` : 'My Station'); if (!name) return;
    try {
      const r = await fetch('/api/stations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, layout: layoutRef.current, visible: visibleRef.current, sourceType: 'custom' }) });
      const j = await r.json(); setStations(j?.stations || []);
      const meta = { id: j?.id ?? null, name, sourceType: 'custom', presetKey: null }; setStation(meta); rememberStation(meta); baselineRef.current = sigOf(layoutRef.current, visibleRef.current);
    } catch { /* ignore */ }
  };
  const saveStation = async () => {
    if (!station.id) { await saveAsStation(); return; }
    try { const r = await fetch('/api/stations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: station.id, layout: layoutRef.current, visible: visibleRef.current }) }); const j = await r.json(); setStations(j?.stations || []); baselineRef.current = sigOf(layoutRef.current, visibleRef.current); } catch { /* ignore */ }
  };
  const renameStation = async () => { if (!station.id) return; const name = window.prompt('Rename station:', station.name); if (!name) return; try { const r = await fetch('/api/stations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: station.id, name }) }); const j = await r.json(); setStations(j?.stations || []); setStation((s) => ({ ...s, name })); } catch { /* ignore */ } };
  const duplicateStation = async () => { try { const r = await fetch('/api/stations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${station.name} copy`, layout: layoutRef.current, visible: visibleRef.current, sourceType: 'custom' }) }); const j = await r.json(); setStations(j?.stations || []); } catch { /* ignore */ } };
  const stationDefault = async (id) => { try { const r = await fetch('/api/stations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, isDefault: true }) }); const j = await r.json(); setStations(j?.stations || []); } catch { /* ignore */ } };
  const stationDelete = async (id, e) => { if (e) e.stopPropagation(); if (!window.confirm('Delete this station?')) return; try { const r = await fetch(`/api/stations?id=${id}`, { method: 'DELETE' }); const j = await r.json(); setStations(j?.stations || []); if (station.id === id) applyPreset(STATION_PRESETS[0]); } catch { /* ignore */ } };
  const revertStation = () => { const b = baselineRef.current; if (!b) return; try { const { layout: lay, visible: vis } = JSON.parse(b); applyLayoutVisible(lay, vis); } catch { /* ignore */ } };
  const resetStation = () => {
    if (station.sourceType === 'preset' && station.presetKey) { const p = STATION_PRESETS.find((x) => x.key === station.presetKey); if (p) applyPreset(p); }
    else if (station.id) { const st = stations.find((s) => s.id === station.id); if (st) applyStation(st); }
    else { reset(); baselineRef.current = sigOf(layoutRef.current, visibleRef.current); }
  };

  // Centralized symbol selection: clicking a ticker ANYWHERE in the Terminal sets the active symbol
  // (drives the chart + future symbol-aware panels) instead of navigating away. Color link-groups are
  // retained (chip still cycles) for future multi-chart routing; with a single chart it's global.
  const selectSymbol = useCallback((sym) => { if (sym) setSelectedSymbol(String(sym).toUpperCase()); }, []);
  const linkSymbol = (sourceId, sym) => selectSymbol(sym);
  // Receive selections from globally-mounted tapes (top/bottom ticker tape) via the symbol bus.
  useEffect(() => onTerminalSymbol(selectSymbol), [selectSymbol]);
  const setColor = (id, key) => { const l = layoutRef.current; const nl = { ...l, [id]: { ...l[id], color: key } }; setLayout(nl); persist(nl); };

  const bodyOf = (def) => (def.id === 'chart' ? <ChartBody symbol={selectedSymbol} />
    : def.id === 'halts' ? <HaltBody onPick={(s) => linkSymbol('halts', s)} />
    : def.id === 'watchlist' ? <WatchlistBody onPick={(s) => linkSymbol('watchlist', s)} />
    : def.id === 'chat' ? <PitChat bare onSymbol={selectSymbol} />
    : def.id === 'tape' ? <XTape bare />
    : def.id === 'newswire' ? <NewsWireBody onPick={(s) => linkSymbol('newswire', s)} />
    : def.id === 'pitscan' ? <PitScanBody onPick={(s) => linkSymbol('pitscan', s)} />
    : def.id === 'scanner' ? <CustomScannerBody onPick={(s) => linkSymbol('scanner', s)} />
    : def.id === 'movers' ? <MoversBody onPick={(s) => linkSymbol('movers', s)} />
    : def.id === 'why' ? <WhyMovingBody symbol={selectedSymbol} />
    : def.id === 'convergence' ? <ConvergenceBody onPick={(s) => linkSymbol('convergence', s)} />
    : def.id === 'alerts' ? <AlertsBody symbol={selectedSymbol} />
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
  const dirty = !!baselineRef.current && sigOf(layout, visible) !== baselineRef.current;
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <SymbolSearchBox />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setStationOpen((o) => !o)}
            style={{ background: C.white, border: `1px solid ${dirty ? '#B45309' : C.border}`, color: dirty ? '#B45309' : C.ink, borderRadius: 6, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {station.name}{dirty ? ' • Unsaved' : ''} ▾
          </button>
          {stationOpen && (
            <>
              <div onClick={() => setStationOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
              <div style={{ position: 'absolute', left: 0, top: '112%', zIndex: 21, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', minWidth: 235, maxHeight: 380, overflowY: 'auto', padding: '4px 0' }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: 0.6, padding: '6px 12px 2px' }}>PRESETS</div>
                {STATION_PRESETS.map((p) => <button key={p.key} onClick={() => applyPreset(p)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, color: C.ink, fontFamily: "'DM Sans',sans-serif" }}>{p.name}</button>)}
                <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: 0.6, padding: '8px 12px 2px' }}>MY STATIONS</div>
                {stations.length === 0 ? <div style={{ padding: '4px 12px 6px', fontSize: 11, color: C.dim }}>None saved yet</div>
                  : stations.map((s) => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
                      <button onClick={() => applyStation(s)} style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, color: C.ink, fontFamily: "'DM Sans',sans-serif", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.isDefault ? '★ ' : ''}{s.name}</button>
                      <button onClick={(e) => { e.stopPropagation(); stationDefault(s.id); }} title="Set as default" style={{ background: 'none', border: 'none', cursor: 'pointer', color: s.isDefault ? '#E08A1E' : C.dim, fontSize: 12, padding: '0 5px' }}>★</button>
                      <button onClick={(e) => stationDelete(s.id, e)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.dim, fontSize: 14, padding: '0 8px 0 3px' }}>×</button>
                    </div>
                  ))}
                <div style={{ borderTop: `1px solid ${C.surface}`, margin: '4px 0' }} />
                <button onClick={saveAsStation} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: C.green, fontFamily: "'DM Sans',sans-serif" }}>+ Save current as new station</button>
                {station.id ? <button onClick={renameStation} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, color: C.ink, fontFamily: "'DM Sans',sans-serif" }}>Rename current</button> : null}
                <button onClick={duplicateStation} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, color: C.ink, fontFamily: "'DM Sans',sans-serif" }}>Duplicate current</button>
              </div>
            </>
          )}
        </div>
        <button onClick={saveStation} disabled={!!station.id && !dirty} style={{ background: (dirty || !station.id) ? C.green : C.surface, border: 'none', color: (dirty || !station.id) ? '#fff' : C.dim, borderRadius: 6, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: (dirty || !station.id) ? 'pointer' : 'default', fontFamily: "'DM Sans',sans-serif" }}>Save</button>
        {dirty && station.id ? <button onClick={revertStation} title="Discard changes" style={{ background: C.white, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Revert</button> : null}
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
        <button onClick={resetStation} title="Restore this station's saved/preset layout" style={{ background: C.white, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Reset</button>
        </div>
      </div>
      <div ref={ref} style={{ position: 'relative', width: '100%', height: containerH }}>
        {visible.map((id) => {
          const def = PANEL_BY_ID[id]; const p = layout[id];
          if (!def || !p) return null;
          return (
            <div key={id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}>
              <PanelCard def={def} draggable colorKey={p.color} onSetColor={(key) => setColor(id, key)}
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
