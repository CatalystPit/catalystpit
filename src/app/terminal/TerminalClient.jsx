'use client';

import { useEffect, useRef, useState } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo, startCheckout, fetchKey, toArr, fmt2 } from '../../lib/cp-shared';

// Custom movable/resizable workspace (React-19-safe — react-grid-layout depends on findDOMNode,
// removed in React 19). Free-floating panels: drag by the header, resize from the corner, layout
// saved to localStorage. Chart center, halt scanner + movers around it.
const PANELS = [
  { id: 'halts',     title: 'Halt Scanner', tag: 'US · LIVE' },
  { id: 'chart',     title: 'Chart',        tag: 'TRADINGVIEW' },
  { id: 'movers',    title: 'Movers',       tag: 'SOON' },
  { id: 'watchlist', title: 'Watchlist',    tag: 'YOURS' },
];
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
  const h = 560;
  const rightX = Math.round(unit * 9) + gap * 2;
  const rightW = Math.round(unit * 3) - 2;
  return {
    halts:     { x: 0, y: 0, w: Math.round(unit * 3), h, color: 'blue' },
    chart:     { x: Math.round(unit * 3) + gap, y: 0, w: Math.round(unit * 6), h, color: 'blue' },
    movers:    { x: rightX, y: 0, w: rightW, h: 274, color: 'blue' },
    watchlist: { x: rightX, y: 286, w: rightW, h: 274, color: 'blue' },
  };
}

const fmtHalt = (t) => (t ? `${String(t).slice(0, 5)} ET` : '—');

// ── Panel bodies ──
function ChartBody({ symbol }) {
  const host = useRef(null);
  useEffect(() => {
    const h = host.current; if (!h) return; h.innerHTML = '';
    const c = document.createElement('div'); c.style.height = '100%'; c.style.width = '100%';
    const w = document.createElement('div'); w.style.height = '100%'; w.style.width = '100%'; c.appendChild(w);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.innerHTML = JSON.stringify({
      autosize: true, symbol, interval: 'D', timezone: 'America/New_York', theme: 'light',
      style: '1', locale: 'en', hide_side_toolbar: true, allow_symbol_change: true, support_host: 'https://www.tradingview.com',
    });
    c.appendChild(s); h.appendChild(c);
    return () => { h.innerHTML = ''; };
  }, [symbol]);
  // relative wrapper + absolute-fill host so the TradingView autosize widget gets a real height
  return <div style={{ position: 'relative', flex: 1, minHeight: 0 }}><div ref={host} style={{ position: 'absolute', inset: 0 }} /></div>;
}

function HaltBody({ onPick }) {
  const [halts, setHalts] = useState(null);
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
    <div style={{ overflow: 'auto', flex: 1 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          {halts.map((h, i) => (
            <tr key={`${h.symbol}-${h.haltTime}-${i}`} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
              <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                <span onClick={() => onPick && onPick(h.symbol)} title="Load in chart"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <TickerLogo symbol={h.symbol} size={16} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{h.symbol}</span>
                </span>
                <a href={`/ticker/${encodeURIComponent(h.symbol)}`} title="Open ticker page" style={{ marginLeft: 6, color: C.dim, textDecoration: 'none', fontSize: 11 }}>↗</a>
              </td>
              <td style={{ padding: '8px 12px', color: C.text }}>{h.reason}</td>
              <td className="cp-num" style={{ padding: '8px 12px', color: C.muted, whiteSpace: 'nowrap' }}>{fmtHalt(h.haltTime)}</td>
              <td style={{ padding: '8px 12px' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4, color: h.resumed ? C.green : C.red, background: h.resumed ? C.greenLight : C.redLight }}>{h.resumed ? 'Resumed' : 'Halted'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MoversBody = () => <div style={{ padding: '28px 18px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>Top gainers, losers & unusual volume — landing here next.</div>;

function WatchlistBody({ onPick }) {
  const [rows, setRows] = useState(null);
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
    <div style={{ overflow: 'auto', flex: 1 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.ticker} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
              <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                <span onClick={() => onPick && onPick(r.ticker)} title="Load in chart" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <TickerLogo symbol={r.ticker} size={16} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                </span>
                <a href={`/ticker/${encodeURIComponent(r.ticker)}`} title="Open ticker page" style={{ marginLeft: 6, color: C.dim, textDecoration: 'none', fontSize: 11 }}>↗</a>
              </td>
              <td className="cp-num" style={{ padding: '8px 12px', textAlign: 'right', color: C.ink }}>{r.price != null ? (r.price > 1000 ? (+r.price).toLocaleString() : fmt2(+r.price)) : '—'}</td>
              <td className="cp-num" style={{ padding: '8px 12px', textAlign: 'right', color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>
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
          <a key={i} href={`/ticker/${encodeURIComponent(t.sym)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 16px', textDecoration: 'none' }}>
            <TickerLogo symbol={t.sym} size={15} />
            <span className="cp-tkr" style={{ fontSize: 11, color: C.muted }}>{t.sym}</span>
            <span className="cp-num" style={{ fontSize: 11, color: C.ink, fontWeight: 600 }}>{t.price > 1000 ? (+t.price).toLocaleString() : fmt2(+t.price)}</span>
            <span className="cp-num" style={{ fontSize: 10, color: t.chg >= 0 ? C.green : C.red, fontWeight: 600 }}>{t.chg > 0 ? '+' : ''}{fmt2(t.chg)}%</span>
          </a>
        ))}
      </div>
      <style>{`@keyframes cp-btape { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
    </div>
  );
}

// ── Panel chrome ──
function PanelCard({ def, colorKey, onCycleColor, onMoveStart, onResizeStart, draggable, headerRight, children }) {
  return (
    <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div onPointerDown={draggable ? onMoveStart : undefined}
        style={{ cursor: draggable ? 'move' : 'default', padding: '9px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, touchAction: 'none' }}>
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
  const [chartSymbol, setChartSymbol] = useState('SPY');

  const setLayout = (l) => { layoutRef.current = l; setLayoutState(l); };

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const apply = () => setMobile(mq.matches);
    apply(); mq.addEventListener('change', apply);
    const width = ref.current ? ref.current.clientWidth : 1200;
    let saved = null; try { saved = JSON.parse(localStorage.getItem('cp_terminal_layout') || 'null'); } catch { /* ignore */ }
    const raw = saved && saved.chart ? saved : defaultLayout(width);
    const norm = {}; for (const d of PANELS) norm[d.id] = { ...raw[d.id], color: raw[d.id]?.color || 'blue' };
    setLayout(norm);
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

  const reset = () => { const l = defaultLayout(ref.current?.clientWidth); setLayout(l); persist(l); };

  // Link-group sync: clicking a symbol in a source panel loads it in chart panels sharing its color.
  const linkSymbol = (sourceId, sym) => {
    const src = layoutRef.current?.[sourceId]?.color;
    const chartColor = layoutRef.current?.chart?.color;
    if (src && src !== 'none' && src === chartColor) setChartSymbol(sym);
  };
  const cycleColor = (id) => { const l = layoutRef.current; const nl = { ...l, [id]: { ...l[id], color: nextColor(l[id].color) } }; setLayout(nl); persist(nl); };

  const bodyOf = (def) => (def.id === 'chart' ? <ChartBody symbol={chartSymbol} />
    : def.id === 'halts' ? <HaltBody onPick={(s) => linkSymbol('halts', s)} />
    : def.id === 'watchlist' ? <WatchlistBody onPick={(s) => linkSymbol('watchlist', s)} />
    : <MoversBody />);
  const headerRightOf = (def) => (def.id === 'chart'
    ? <span className="cp-tkr" style={{ fontSize: 11, color: C.ink, fontWeight: 700 }}>{chartSymbol}</span> : null);

  if (!layout) return <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading workspace…</div>;

  // Mobile: stack the panels, no dragging.
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PANELS.map((def) => (
          <div key={def.id} style={{ position: 'relative', height: def.id === 'chart' ? 420 : 320 }}>
            <PanelCard def={def} draggable={false} colorKey={layout[def.id]?.color} headerRight={headerRightOf(def)}>{bodyOf(def)}</PanelCard>
          </div>
        ))}
      </div>
    );
  }

  const containerH = Math.max(...PANELS.map((d) => layout[d.id].y + layout[d.id].h)) + 8;
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button onClick={reset} style={{ background: C.white, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Reset layout</button>
      </div>
      <div ref={ref} style={{ position: 'relative', width: '100%', height: containerH }}>
        {PANELS.map((def) => {
          const p = layout[def.id];
          return (
            <div key={def.id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}>
              <PanelCard def={def} draggable colorKey={p.color} onCycleColor={() => cycleColor(def.id)}
                onMoveStart={(e) => start(def.id, e, 'move')} onResizeStart={(e) => start(def.id, e, 'resize')}
                headerRight={headerRightOf(def)}>{bodyOf(def)}</PanelCard>
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
      <div style={{ maxWidth: 1440, margin: '18px auto', padding: '0 16px 48px' }}>
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
      <BottomTape />
      <Footer />
    </div>
  );
}
