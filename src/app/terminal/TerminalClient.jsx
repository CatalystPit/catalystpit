'use client';

import { useEffect, useRef, useState } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo, startCheckout } from '../../lib/cp-shared';

// Custom movable/resizable workspace (React-19-safe — react-grid-layout depends on findDOMNode,
// removed in React 19). Free-floating panels: drag by the header, resize from the corner, layout
// saved to localStorage. Chart center, halt scanner + movers around it.
const PANELS = [
  { id: 'halts',  title: 'Halt Scanner', dot: C.red,   tag: 'US · LIVE' },
  { id: 'chart',  title: 'Chart',        dot: C.green, tag: 'TRADINGVIEW' },
  { id: 'movers', title: 'Movers',       dot: C.green, tag: 'SOON' },
];
const MIN_W = 240, MIN_H = 220;

function defaultLayout(width) {
  const w = width || 1200;
  const gap = 12;
  const unit = (w - gap * 2) / 12;
  const h = 560;
  return {
    halts:  { x: 0, y: 0, w: Math.round(unit * 3), h },
    chart:  { x: Math.round(unit * 3) + gap, y: 0, w: Math.round(unit * 6), h },
    movers: { x: Math.round(unit * 9) + gap * 2, y: 0, w: Math.round(unit * 3) - 2, h },
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
  return <div ref={host} style={{ flex: 1, minHeight: 0 }} />;
}

function HaltBody() {
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
                <a href={`/ticker/${encodeURIComponent(h.symbol)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                  <TickerLogo symbol={h.symbol} size={16} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{h.symbol}</span>
                </a>
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
const bodyFor = (id) => (id === 'chart' ? <ChartBody symbol="SPY" /> : id === 'halts' ? <HaltBody /> : <MoversBody />);

// ── Panel chrome ──
function PanelCard({ def, onMoveStart, onResizeStart, draggable }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div onPointerDown={draggable ? onMoveStart : undefined}
        style={{ cursor: draggable ? 'move' : 'default', padding: '9px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, touchAction: 'none' }}>
        {def.dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: def.dot }} />}
        <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{def.title}</span>
        {def.tag && <span style={{ fontSize: 9, color: C.dim, letterSpacing: 0.5 }}>{def.tag}</span>}
        {draggable && <span style={{ marginLeft: 'auto', color: C.hint, fontSize: 13, letterSpacing: -1 }}>⠿</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{bodyFor(def.id)}</div>
      {draggable && (
        <div onPointerDown={onResizeStart}
          style={{ position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'se-resize', touchAction: 'none' }}>
          <span style={{ position: 'absolute', right: 4, bottom: 4, width: 7, height: 7, borderRight: `2px solid ${C.dim}`, borderBottom: `2px solid ${C.dim}` }} />
        </div>
      )}
    </div>
  );
}

function Workspace() {
  const ref = useRef(null);
  const [layout, setLayout] = useState(null);
  const [mobile, setMobile] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const apply = () => setMobile(mq.matches);
    apply(); mq.addEventListener('change', apply);
    const width = ref.current ? ref.current.clientWidth : 1200;
    let saved = null; try { saved = JSON.parse(localStorage.getItem('cp_terminal_layout') || 'null'); } catch { /* ignore */ }
    setLayout(saved && saved.chart ? saved : defaultLayout(width));
    return () => mq.removeEventListener('change', apply);
  }, []);

  const persist = (l) => { try { localStorage.setItem('cp_terminal_layout', JSON.stringify(l)); } catch { /* ignore */ } };

  const start = (id, e, mode) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let base;
    setLayout((l) => { base = l[id]; return l; });
    const o = { ...base };
    setDragging(true);
    const move = (ev) => {
      setLayout((l) => {
        const next = mode === 'move'
          ? { ...l[id], x: Math.max(0, o.x + (ev.clientX - sx)), y: Math.max(0, o.y + (ev.clientY - sy)) }
          : { ...l[id], w: Math.max(MIN_W, o.w + (ev.clientX - sx)), h: Math.max(MIN_H, o.h + (ev.clientY - sy)) };
        return { ...l, [id]: next };
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDragging(false);
      setLayout((l) => { persist(l); return l; });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const reset = () => { const l = defaultLayout(ref.current?.clientWidth); setLayout(l); persist(l); };

  if (!layout) return <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading workspace…</div>;

  // Mobile: stack the panels, no dragging.
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PANELS.map((def) => (
          <div key={def.id} style={{ position: 'relative', height: def.id === 'chart' ? 420 : 320 }}>
            <PanelCard def={def} draggable={false} />
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
              <PanelCard def={def} draggable onMoveStart={(e) => start(def.id, e, 'move')} onResizeStart={(e) => start(def.id, e, 'resize')} />
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
      <Footer />
    </div>
  );
}
