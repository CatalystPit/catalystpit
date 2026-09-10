'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { C, Skel, Dot, TopNav, Footer, BrandStyles, TickerLogo } from '../../lib/cp-shared';

// Stock Screener — composable filters over our screener_stocks universe (/api/screener). Proprietary
// smart-money filters are live now; descriptive/fundamental filters render "coming soon" until a
// bulk market-data feed is connected. Catalyst Pit design system; no third-party embeds.

const REAL_CATS = ['Descriptive', 'Fundamental', 'Technical', 'Performance', 'Ownership', 'News', 'ETF'];
const CATS = [...REAL_CATS, 'All'];   // Descriptive first (default), All last

const num0 = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
const num2 = (n) => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(2);
const pct = (n) => (n == null || isNaN(n)) ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const price = (n) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}`;
const cap = (n) => { if (n == null || isNaN(n)) return '—'; if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`; if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`; if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`; return `$${Math.round(n).toLocaleString()}`; };
const vol = (n) => { if (n == null || isNaN(n)) return '—'; if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`; if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`; return String(Math.round(n)); };
const money = (n) => { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n); const s = n < 0 ? '-' : ''; if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`; if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`; if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`; return `${s}$${Math.round(a)}`; };
const yesNo = (b) => b
  ? <span style={{ fontSize: 10, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 3, padding: '2px 6px' }}>YES</span>
  : <span style={{ color: C.dim }}>—</span>;

// column key → { label, fmt, sort?, align?, color? }
const COL = {
  company:  { label: 'Company', fmt: (v) => v || '—' },
  price:    { label: 'Price', fmt: price, sort: 'price', align: 'right' },
  changePct:{ label: 'Chg %', fmt: pct, sort: 'changePct', align: 'right', color: true },
  volume:   { label: 'Volume', fmt: vol, sort: 'volume', align: 'right' },
  avgVol:   { label: 'Avg Vol', fmt: vol, align: 'right' },
  relVol:   { label: 'Rel Vol', fmt: num2, sort: 'relVol', align: 'right' },
  marketCap:{ label: 'Mkt Cap', fmt: cap, sort: 'marketCap', align: 'right' },
  floatShares: { label: 'Float', fmt: vol, align: 'right' },
  shortFloat:  { label: 'Short %', fmt: (v) => v == null ? '—' : `${v.toFixed(1)}%`, sort: 'shortFloat', align: 'right' },
  rsi14:    { label: 'RSI', fmt: num0, sort: 'rsi14', align: 'right' },
  sma20:    { label: '20 SMA', fmt: price, align: 'right' },
  sma50:    { label: '50 SMA', fmt: price, align: 'right' },
  sma200:   { label: '200 SMA', fmt: price, align: 'right' },
  hi52:     { label: '52W High', fmt: price, align: 'right' },
  lo52:     { label: '52W Low', fmt: price, align: 'right' },
  perf1w:   { label: '1W', fmt: pct, align: 'right', color: true },
  perf1m:   { label: '1M', fmt: pct, sort: 'perf1m', align: 'right', color: true },
  perf3m:   { label: '3M', fmt: pct, sort: 'perf3m', align: 'right', color: true },
  perf6m:   { label: '6M', fmt: pct, align: 'right', color: true },
  perf1y:   { label: '1Y', fmt: pct, align: 'right', color: true },
  consensusScore:  { label: 'Convergence', fmt: num0, sort: 'consensusScore', align: 'right', pit: true },
  insiderBuy90d:   { label: 'Insider Buy', fmt: yesNo, align: 'center', pit: true },
  insiderBuyers90d:{ label: 'Buyers', fmt: (v) => v || '—', align: 'right' },
  insiderNet90d:   { label: 'Insider $', fmt: money, sort: 'insiderNet90d', align: 'right', pit: true },
  congressBuy90d:  { label: 'Congress', fmt: yesNo, align: 'center', pit: true },
  fundNetQoq:      { label: '13F Net', fmt: (v) => v == null ? '—' : (v > 0 ? `+${v}` : String(v)), align: 'right', pit: true },
  hasMaterial8k:   { label: '8-K', fmt: yesNo, align: 'center', pit: true },
  pe: { label: 'P/E', fmt: num2, sort: 'pe', align: 'right' }, ps: { label: 'P/S', fmt: num2, align: 'right' }, pb: { label: 'P/B', fmt: num2, align: 'right' },
  roe: { label: 'ROE', fmt: (v) => v == null ? '—' : `${v.toFixed(1)}%`, align: 'right' },
  grossMargin: { label: 'Gross M', fmt: (v) => v == null ? '—' : `${v.toFixed(1)}%`, align: 'right' },
  netMargin: { label: 'Net M', fmt: (v) => v == null ? '—' : `${v.toFixed(1)}%`, align: 'right' },
  sector: { label: 'Sector', fmt: (v) => v || '—', sort: 'sector' },
  industry: { label: 'Industry', fmt: (v) => v || '—' },
  country: { label: 'Country', fmt: (v) => v || '—' },
};

const VIEWS = {
  Overview:    ['company', 'sector', 'industry', 'country', 'marketCap', 'pe', 'price', 'changePct', 'volume'],
  Ownership:   ['insiderBuy90d', 'insiderBuyers90d', 'insiderNet90d', 'congressBuy90d', 'fundNetQoq', 'consensusScore'],
  Technical:   ['price', 'rsi14', 'sma20', 'sma50', 'sma200', 'hi52', 'lo52', 'relVol'],
  Performance: ['price', 'changePct', 'perf1w', 'perf1m', 'perf3m', 'perf6m', 'perf1y'],
  Valuation:   ['price', 'marketCap', 'pe', 'ps', 'pb'],
  Financial:   ['roe', 'grossMargin', 'netMargin', 'sector'],
  News:        ['hasMaterial8k', 'consensusScore', 'insiderBuy90d', 'changePct'],
};

// Preset filter combos (all use available-now columns).
const PRESETS = {
  'Insider Buying':            { insiderBuy90d: { eq: true } },
  'Catalyst Convergence 70+':  { consensusScore: { min: 70 } },
  'Congress Buying':           { congressBuy90d: { eq: true } },
  'Institutional Accumulation':{ fundNetQoq: { min: 2 } },
  'Oversold (RSI < 30)':       { rsi14: { max: 30 } },
  'Above 200-day SMA':         { priceVsSma200: { op: 'above' } },
  'Near 52-Week High':         { near52wHigh: { pct: 5 } },
  'High Relative Volume':      { relVol: { min: 2 } },
};

const inputStyle = { width: 72, height: 26, borderRadius: 5, border: `1px solid ${C.border}`, padding: '0 7px', fontSize: 11.5, fontFamily: "'DM Sans',sans-serif", outline: 'none' };
const selStyle = { height: 26, borderRadius: 5, border: `1px solid ${C.border}`, padding: '0 7px', fontSize: 11.5, fontFamily: "'DM Sans',sans-serif", background: C.white, cursor: 'pointer', outline: 'none' };

// Compact Finviz-style unit: label + dropdown on ONE line. Predefined metric options + Custom range.
function FilterControl({ def, val, onChange }) {
  const disabled = !def.available;
  const opts = def.opts || [];
  const isRange = def.type === 'range';
  const activeIdx = val ? opts.findIndex((o) => JSON.stringify(o.cond) === JSON.stringify(val)) : -1;
  const [custom, setCustom] = useState(false);
  const isCustomVal = !!val && activeIdx === -1;
  const showInputs = isRange && (custom || isCustomVal);
  const active = !!val;
  const selVal = activeIdx >= 0 ? String(activeIdx) : ((val || custom) ? 'custom' : '');
  const pick = (e) => {
    const v = e.target.value;
    if (v === '') { setCustom(false); onChange(null); }
    else if (v === 'custom') setCustom(true);
    else { setCustom(false); onChange(opts[Number(v)].cond); }
  };
  const sel = { flex: '1 1 auto', minWidth: 0, height: 23, borderRadius: 4, padding: '0 3px', fontSize: 11, fontFamily: "'DM Sans',sans-serif", cursor: disabled ? 'default' : 'pointer', outline: 'none', border: `1px solid ${active ? C.green : C.border}`, background: active ? C.greenLight : C.white, color: active ? C.green : C.text, fontWeight: active ? 600 : 400 };
  const inp = { width: 58, height: 22, borderRadius: 4, border: `1px solid ${C.border}`, padding: '0 5px', fontSize: 11, outline: 'none' };
  return (
    <div style={{ opacity: disabled ? 0.5 : 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span title={def.label} style={{ fontSize: 10.5, color: def.pit ? C.green : C.muted, fontWeight: def.pit ? 700 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', maxWidth: '52%' }}>
          {def.pit && '◆'}{def.label}
        </span>
        <select disabled={disabled} value={selVal} onChange={pick} style={sel}>
          <option value="">Any</option>
          {opts.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
          {isRange && <option value="custom">Custom…</option>}
        </select>
        {disabled && <span style={{ fontSize: 8, color: C.dim, flexShrink: 0 }}>soon</span>}
      </div>
      {showInputs && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', paddingLeft: 2 }}>
          <input type="number" placeholder="min" value={val?.min ?? ''} onChange={(e) => onChange({ ...(val || {}), min: e.target.value })} style={inp} />
          <span style={{ color: C.dim, fontSize: 10 }}>–</span>
          <input type="number" placeholder="max" value={val?.max ?? ''} onChange={(e) => onChange({ ...(val || {}), max: e.target.value })} style={inp} />
        </div>
      )}
    </div>
  );
}

// Small daily CANDLESTICK chart for the Finviz-style hover preview. Advanced-chart embed (mini widget
// is line-only), stripped to just the candles. The classNames tradingview-widget-container(__widget)
// are REQUIRED or it renders blank.
function MiniChart({ symbol }) {
  const host = useRef(null);
  useEffect(() => {
    const h = host.current; if (!h) return; h.innerHTML = '';
    const c = document.createElement('div'); c.className = 'tradingview-widget-container'; c.style.height = '100%'; c.style.width = '100%';
    const w = document.createElement('div'); w.className = 'tradingview-widget-container__widget'; w.style.height = '100%'; w.style.width = '100%'; c.appendChild(w);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.innerHTML = JSON.stringify({
      autosize: true, symbol, interval: 'D', range: '3M', timezone: 'America/New_York', theme: (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark') ? 'dark' : 'light',
      style: '1', locale: 'en', hide_top_toolbar: true, hide_side_toolbar: true, hide_legend: true,
      allow_symbol_change: false, save_image: false, withdateranges: false, support_host: 'https://www.tradingview.com',
    });
    c.appendChild(s); h.appendChild(c);
    return () => { h.innerHTML = ''; };
  }, [symbol]);
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} />;
}

export default function ScreenerClient() {
  const router = useRouter();
  const search = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState('consensusScore');
  const [dir, setDir] = useState('desc');
  const [ticker, setTicker] = useState('');
  const [page, setPage] = useState(0);
  const [view, setView] = useState('Overview');
  const [activeCat, setActiveCat] = useState('Descriptive');
  const [showFilters, setShowFilters] = useState(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState([]);
  const [prices, setPrices] = useState({});   // on-demand quote overlay for the visible page
  const [hover, setHover] = useState(null);   // Finviz-style ticker-hover daily-chart preview { sym, rect }
  const hoverTimer = useRef(null);
  const debTimer = useRef(null);

  // Load registry + saved + initial state from URL.
  useEffect(() => {
    fetch('/api/screener?meta=1').then((r) => r.json()).then((j) => setMeta(j.filters || {})).catch(() => setMeta({}));
    fetch('/api/screener/saved').then((r) => r.json()).then((j) => setSaved(j.saved || [])).catch(() => {});
    try {
      const f = search.get('f'); if (f) setFilters(JSON.parse(decodeURIComponent(f)) || {});
      if (search.get('sort')) setSort(search.get('sort'));
      if (search.get('dir')) setDir(search.get('dir'));
      if (search.get('view')) setView(search.get('view'));
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set('filters', JSON.stringify(filters));
    p.set('sort', sort); p.set('dir', dir); p.set('page', String(page)); if (ticker) p.set('ticker', ticker);
    return p.toString();
  }, [filters, sort, dir, page, ticker]);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/screener?${qs}`, { cache: 'no-store' }).then((r) => r.json()).then((j) => { setData(j); setLoading(false); }).catch(() => { setData({ rows: [], total: 0 }); setLoading(false); });
  }, [qs]);

  // Debounced fetch + URL sync on any change.
  useEffect(() => {
    if (debTimer.current) clearTimeout(debTimer.current);
    debTimer.current = setTimeout(() => {
      load();
      const u = new URLSearchParams();
      if (Object.keys(filters).length) u.set('f', encodeURIComponent(JSON.stringify(filters)));
      u.set('sort', sort); u.set('dir', dir); u.set('view', view);
      router.replace(`/screener?${u.toString()}`, { scroll: false });
    }, 250);
    return () => clearTimeout(debTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort, dir, page, ticker, view]);

  const setFilter = (key, val) => { setPage(0); setFilters((prev) => { const next = { ...prev }; if (val == null || (typeof val === 'object' && Object.values(val).every((v) => v === '' || v == null))) delete next[key]; else next[key] = val; return next; }); };
  const removeFilter = (key) => setFilters((prev) => { const n = { ...prev }; delete n[key]; return n; });
  const clearAll = () => { setFilters({}); setTicker(''); };
  const applyPreset = (obj) => { setFilters(obj || {}); setPage(0); };
  const toggleSort = (col) => { if (!col) return; if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSort(col); setDir('desc'); } };

  const saveScreener = async () => {
    const name = window.prompt('Name this screener:'); if (!name) return;
    const r = await fetch('/api/screener/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, filters, sortBy: sort, sortDir: dir, view }) });
    const j = r.ok ? await r.json() : null; if (j?.saved) setSaved(j.saved);
  };
  const loadSaved = (s) => { setFilters(s.filters || {}); if (s.sortBy) setSort(s.sortBy); if (s.sortDir) setDir(s.sortDir); if (s.view) setView(s.view); setPage(0); };
  const delSaved = async (id) => { const r = await fetch(`/api/screener/saved?id=${id}`, { method: 'DELETE' }); const j = r.ok ? await r.json() : null; if (j?.saved) setSaved(j.saved); };

  const rows = data?.rows || [];
  const total = data?.total || 0;

  // Freshen the VISIBLE page's price/change/volume via the entitlement-aware quotes API (Pro=real-time,
  // Free=delayed). Provider-agnostic (Polygon now, Twelve Data later). Runs once per page/filter change.
  useEffect(() => {
    const need = (data?.rows || []).map((r) => r.ticker).slice(0, 80);
    if (!need.length) return;
    let alive = true;
    fetch(`/api/quotes?symbols=${encodeURIComponent(need.join(','))}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setPrices((p) => ({ ...p, ...j })); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const activeChips = Object.entries(filters).filter(([k]) => meta?.[k]?.available);
  const cols = VIEWS[view] || VIEWS.Overview;
  const groupsToShow = activeCat === 'All' ? REAL_CATS : [activeCat];

  const chipLabel = (key, cond) => {
    const d = meta?.[key]; if (!d) return key;
    const opt = (d.opts || []).find((o) => JSON.stringify(o.cond) === JSON.stringify(cond));
    if (opt) return `${d.label}: ${opt.label}`;
    const lo = cond.min != null && cond.min !== '' ? cond.min : '', hi = cond.max != null && cond.max !== '' ? cond.max : '';
    return `${d.label}: ${lo || '−∞'}–${hi || '∞'}`;
  };

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Screener" />

      {/* HEADER CONTROLS */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '7px 20px' }}>
        <div style={{ maxWidth: 1760, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 19, fontWeight: 600, color: C.ink, marginRight: 4 }}>Screener</span>
          <select onChange={(e) => { if (e.target.value) applyPreset(PRESETS[e.target.value]); e.target.value = ''; }} style={selStyle} defaultValue="">
            <option value="">Presets…</option>
            {Object.keys(PRESETS).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {saved.length > 0 && (
            <select onChange={(e) => { const s = saved.find((x) => String(x.id) === e.target.value); if (s) loadSaved(s); e.target.value = ''; }} style={selStyle} defaultValue="">
              <option value="">Saved…</option>
              {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <span style={{ fontSize: 10, color: C.dim }}>ORDER</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)} style={selStyle}>
            {Object.keys(COL).filter((k) => COL[k].sort).map((k) => <option key={k} value={COL[k].sort}>{COL[k].label}</option>)}
          </select>
          <button onClick={() => setDir((d) => (d === 'asc' ? 'desc' : 'asc'))} style={{ ...selStyle, cursor: 'pointer', minWidth: 40 }}>{dir === 'asc' ? '↑' : '↓'}</button>
          <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="Ticker…" style={{ ...inputStyle, width: 110 }} />
          <button onClick={() => setShowFilters((v) => !v)} style={{ ...selStyle, cursor: 'pointer', fontWeight: 600, color: showFilters ? C.green : C.muted }}>Filters {showFilters ? '▾' : '▸'}</button>
          <button onClick={clearAll} style={{ background: 'transparent', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>Reset</button>
          <button onClick={saveScreener} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 5, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
        </div>
      </div>

      {/* FILTER PANEL */}
      {showFilters && meta && (
        <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: '7px 20px 9px' }}>
          <div style={{ maxWidth: 1760, margin: '0 auto' }}>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
              {CATS.map((cat) => (
                <button key={cat} onClick={() => setActiveCat(cat)} style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 11, cursor: 'pointer', border: `1px solid ${activeCat === cat ? C.ink : C.border}`, background: activeCat === cat ? C.ink : C.white, color: activeCat === cat ? '#fff' : C.muted }}>{cat}</button>
              ))}
            </div>
            {groupsToShow.map((cat) => {
              const fs = Object.entries(meta).filter(([, d]) => d.category === cat);
              if (!fs.length) return null;
              return (
                <div key={cat} style={{ marginBottom: 8 }}>
                  {activeCat === 'All' && <div style={{ fontSize: 9.5, fontWeight: 700, color: C.dim, letterSpacing: '1px', margin: '2px 0 4px' }}>— {cat.toUpperCase()} —</div>}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '4px 16px' }}>
                    {fs.map(([key, def]) => <FilterControl key={key} fkey={key} def={def} val={filters[key]} onChange={(v) => setFilter(key, v)} />)}
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop: 4, fontSize: 9.5, color: C.dim }}>◆ = Catalyst Pit signal (live) · soon = awaiting market-data feed · * = subset of tickers</div>
          </div>
        </div>
      )}

      {/* ACTIVE CHIPS + COUNTS */}
      <div style={{ maxWidth: 1760, margin: '0 auto', padding: '7px 20px 0', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Active: {activeChips.length}</span>
        <span style={{ fontSize: 12, color: C.ink, fontWeight: 700 }} className="cp-num">{loading ? '…' : `${total.toLocaleString()} stocks`}</span>
        {activeChips.map(([key, cond]) => (
          <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: C.greenLight, border: `1px solid ${C.greenBorder}`, borderRadius: 14, padding: '4px 10px', fontSize: 11, color: C.green, fontWeight: 600 }}>
            {chipLabel(key, cond)}
            <button onClick={() => removeFilter(key)} style={{ background: 'transparent', border: 'none', color: C.green, cursor: 'pointer', fontWeight: 700, padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
        {activeChips.length > 0 && <button onClick={clearAll} style={{ background: 'transparent', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>Clear all</button>}
      </div>

      {/* VIEW TABS */}
      <div style={{ maxWidth: 1760, margin: '0 auto', padding: '7px 20px 0', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {Object.keys(VIEWS).map((v) => (
          <button key={v} onClick={() => setView(v)} style={{ fontSize: 10.5, fontWeight: 600, padding: '3px 10px', borderRadius: 5, cursor: 'pointer', border: 'none', background: view === v ? C.green : 'transparent', color: view === v ? '#fff' : C.muted }}>{v}</button>
        ))}
      </div>

      {/* RESULTS */}
      <div style={{ maxWidth: 1760, margin: '8px auto', padding: '0 20px 40px' }}>
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                  <th onClick={() => toggleSort('ticker')} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 9, color: sort === 'ticker' ? C.green : C.dim, letterSpacing: '0.6px', cursor: 'pointer', whiteSpace: 'nowrap' }}>TICKER{sort === 'ticker' ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>
                  {cols.map((ck) => { const c = COL[ck]; return (
                    <th key={ck} onClick={() => toggleSort(c.sort)} style={{ padding: '9px 14px', textAlign: c.align || 'left', fontSize: 9, color: sort === c.sort && c.sort ? C.green : C.dim, letterSpacing: '0.6px', cursor: c.sort ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
                      {c.pit && <span style={{ color: C.green }}>◆</span>}{c.label.toUpperCase()}{c.sort && sort === c.sort ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  ); })}
                </tr>
              </thead>
              <tbody>
                {loading ? Array(10).fill(0).map((_, i) => <tr key={i}><td colSpan={cols.length + 1} style={{ padding: '10px 14px' }}><Skel h={16} mb={0} /></td></tr>)
                  : rows.length === 0 ? <tr><td colSpan={cols.length + 1} style={{ padding: '40px 14px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No stocks match these filters. Widen them or clear a chip.</td></tr>
                  : rows.map((r0) => {
                    const pr = prices[r0.ticker];
                    const r = pr ? { ...r0, price: pr.price ?? r0.price, changePct: pr.changePct ?? r0.changePct, volume: pr.volume ?? r0.volume } : r0;
                    return (
                    <tr key={r.ticker} className="row-hov" onClick={() => router.push(`/ticker/${encodeURIComponent(r.ticker)}`)} style={{ borderBottom: `1px solid ${C.surface}`, cursor: 'pointer' }}>
                      <td className="cp-tkr" style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: C.green, whiteSpace: 'nowrap' }}
                        onMouseEnter={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const sym = r.ticker; clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setHover({ sym, rect }), 220); }}
                        onMouseLeave={() => { clearTimeout(hoverTimer.current); setHover(null); }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><TickerLogo symbol={r.ticker} size={18} />{r.ticker}</span>
                      </td>
                      {cols.map((ck) => { const c = COL[ck]; const v = r[ck];
                        const color = c.color && typeof v === 'number' ? (v > 0 ? C.green : v < 0 ? C.red : C.text) : (ck === 'consensusScore' ? C.green : C.text);
                        return <td key={ck} className={typeof v === 'number' ? 'cp-num' : undefined} style={{ padding: '10px 14px', textAlign: c.align || 'left', fontSize: 12.5, color, fontWeight: ck === 'consensusScore' ? 700 : 400, maxWidth: ck === 'company' ? 220 : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.fmt(v)}</td>;
                      })}
                    </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>

        {/* PAGINATION */}
        {total > (data?.pageSize || 50) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 14 }}>
            <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} style={{ ...selStyle, cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.5 : 1 }}>← Prev</button>
            <span style={{ fontSize: 12, color: C.muted }} className="cp-num">Page {page + 1} of {Math.ceil(total / (data?.pageSize || 50))}</span>
            <button disabled={(page + 1) * (data?.pageSize || 50) >= total} onClick={() => setPage((p) => p + 1)} style={{ ...selStyle, cursor: 'pointer', opacity: (page + 1) * (data?.pageSize || 50) >= total ? 0.5 : 1 }}>Next →</button>
          </div>
        )}

        {saved.length > 0 && (
          <div style={{ marginTop: 16, fontSize: 11, color: C.dim, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>Saved:</span>
            {saved.map((s) => (
              <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: '3px 9px', color: C.muted }}>
                <button onClick={() => loadSaved(s)} style={{ background: 'transparent', border: 'none', color: C.green, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>{s.name}</button>
                <button onClick={() => delSaved(s.id)} style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 12 }}>×</button>
              </span>
            ))}
          </div>
        )}

        <div style={{ marginTop: 14, fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
          Live now: Catalyst Pit smart-money signals (◆) + price/volume/technicals for our covered universe (short interest, RSI, SMAs, performance). Descriptive & fundamental filters unlock when a market-data feed is connected. Not investment advice.
        </div>

      </div>

      {/* FINVIZ-STYLE HOVER PREVIEW — hovering a ticker pops a little daily chart. Non-interactive
          (pointer-events none) so the row click still navigates to the stock page. Flips to stay on-screen. */}
      {hover && (() => {
        const W = 360, H = 224;
        const rc = hover.rect;
        let left = rc.right + 10; if (left + W > window.innerWidth - 8) left = Math.max(8, rc.left - W - 10);
        let top = rc.top - 8; if (top + H > window.innerHeight - 8) top = window.innerHeight - H - 8; if (top < 8) top = 8;
        return (
          <div style={{ position: 'fixed', top, left, width: W, height: H, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.18)', zIndex: 70, pointerEvents: 'none', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '5px 10px', fontSize: 11, fontWeight: 700, color: C.muted, borderBottom: `1px solid ${C.surface}`, background: C.surface }}>{hover.sym} · Daily · 3M</div>
            <div style={{ position: 'absolute', top: 25, left: 0, right: 0, bottom: 0 }}><MiniChart symbol={hover.sym} /></div>
          </div>
        );
      })()}

      <Footer />
      <style>{`.row-hov:hover{background:${C.surface}!important}`}</style>
    </div>
  );
}
