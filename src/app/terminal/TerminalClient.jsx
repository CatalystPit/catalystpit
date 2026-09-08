'use client';

import { useEffect, useRef, useState } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
import { C, BrandStyles, TopNav, Footer, TickerLogo, startCheckout } from '../../lib/cp-shared';

const Grid = WidthProvider(Responsive);

// ── Benzinga-style movable workspace: drag panels by their header, resize from the corner,
// layout persists per browser. Chart center, halt scanner + movers around it. ──
const COLS = { lg: 12, md: 12, sm: 6, xs: 6, xxs: 6 };
const BREAKPOINTS = { lg: 1200, md: 900, sm: 600, xs: 480, xxs: 0 };
const wide = [
  { i: 'halts',  x: 0, y: 0, w: 3, h: 18, minW: 2, minH: 6 },
  { i: 'chart',  x: 3, y: 0, w: 6, h: 18, minW: 3, minH: 8 },
  { i: 'movers', x: 9, y: 0, w: 3, h: 18, minW: 2, minH: 6 },
];
const stacked = [
  { i: 'chart',  x: 0, y: 0,  w: 6, h: 14, minW: 2, minH: 8 },
  { i: 'halts',  x: 0, y: 14, w: 6, h: 12, minW: 2, minH: 6 },
  { i: 'movers', x: 0, y: 26, w: 6, h: 10, minW: 2, minH: 6 },
];
const DEFAULT_LAYOUTS = { lg: wide, md: wide, sm: stacked, xs: stacked, xxs: stacked };

const fmtHalt = (t) => (t ? `${String(t).slice(0, 5)} ET` : '—');

// ── Panel chrome (drag handle = the header) ──
function Panel({ title, dot, tag, right, children }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div className="panel-head" style={{ cursor: 'move', padding: '9px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
        {dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />}
        <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{title}</span>
        {tag && <span style={{ fontSize: 9, color: C.dim, letterSpacing: 0.5 }}>{tag}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {right}
          <span style={{ color: C.hint, fontSize: 13, letterSpacing: -1 }}>⠿</span>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  );
}

// ── Chart panel — TradingView advanced chart, fills the panel, symbol changeable in-widget ──
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
      style: '1', locale: 'en', hide_side_toolbar: true, allow_symbol_change: true,
      support_host: 'https://www.tradingview.com',
    });
    c.appendChild(s); h.appendChild(c);
    return () => { h.innerHTML = ''; };
  }, [symbol]);
  return <div ref={host} style={{ flex: 1, minHeight: 0 }} />;
}

// ── Halt scanner body ──
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
                  <TickerLogo symbol={h.symbol} size={16} />
                  <span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{h.symbol}</span>
                </a>
              </td>
              <td style={{ padding: '8px 12px', color: C.text }}>{h.reason}</td>
              <td className="cp-num" style={{ padding: '8px 12px', color: C.muted, whiteSpace: 'nowrap' }}>{fmtHalt(h.haltTime)}</td>
              <td style={{ padding: '8px 12px' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4, color: h.resumed ? C.green : C.red, background: h.resumed ? C.greenLight : C.redLight }}>
                  {h.resumed ? 'Resumed' : 'Halted'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoversBody() {
  return <div style={{ padding: '28px 18px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>Top gainers, losers & unusual volume — landing here next.</div>;
}

function Workspace() {
  const [layouts, setLayouts] = useState(DEFAULT_LAYOUTS);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    try { const s = localStorage.getItem('cp_terminal_layout'); if (s) setLayouts(JSON.parse(s)); } catch { /* ignore */ }
  }, []);
  const onLayoutChange = (_cur, all) => { try { localStorage.setItem('cp_terminal_layout', JSON.stringify(all)); } catch { /* ignore */ } };
  const reset = () => { setLayouts(DEFAULT_LAYOUTS); try { localStorage.removeItem('cp_terminal_layout'); } catch { /* ignore */ } };

  if (!mounted) return <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading workspace…</div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button onClick={reset} style={{ background: C.white, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
          Reset layout
        </button>
      </div>
      <Grid className="layout" layouts={layouts} breakpoints={BREAKPOINTS} cols={COLS}
        rowHeight={26} margin={[12, 12]} draggableHandle=".panel-head" onLayoutChange={onLayoutChange} isBounded>
        <div key="halts"><Panel title="Halt Scanner" dot={C.red} tag="US · LIVE"><HaltBody /></Panel></div>
        <div key="chart"><Panel title="Chart" dot={C.green} tag="TRADINGVIEW"><ChartBody symbol="SPY" /></Panel></div>
        <div key="movers"><Panel title="Movers" dot={C.green} tag="SOON"><MoversBody /></Panel></div>
      </Grid>
      <style>{`
        .react-grid-layout { position: relative; }
        .react-grid-item { transition: all 150ms ease; transition-property: left, top, width, height; }
        .react-grid-item.cssTransforms { transition-property: transform, width, height; }
        .react-grid-item.resizing, .react-grid-item.react-draggable-dragging { z-index: 3; }
        .react-grid-item.react-grid-placeholder { background: ${C.greenBorder}; opacity: 0.45; border-radius: 10px; z-index: 2; }
        .react-grid-item > .react-resizable-handle { position: absolute; width: 20px; height: 20px; bottom: 0; right: 0; cursor: se-resize; }
        .react-grid-item > .react-resizable-handle::after { content: ""; position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px; border-right: 2px solid rgba(0,0,0,0.25); border-bottom: 2px solid rgba(0,0,0,0.25); }
      `}</style>
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 28, fontWeight: 600, color: C.ink, margin: 0 }}>Terminal</h1>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: '#B8860B', borderRadius: 3, padding: '2px 6px', letterSpacing: 0.5 }}>PRO</span>
          <span style={{ fontSize: 12, color: C.dim }}>drag panels by their header · resize from the corner</span>
        </div>

        {tier === null ? (
          <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading…</div>
        ) : !isPro ? (
          <div style={{ background: C.white, border: `1px solid ${C.greenBorder}`, borderRadius: 10, padding: '40px 24px', textAlign: 'center', marginTop: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, marginBottom: 8 }}>The Terminal is a Pro feature</div>
            <div style={{ fontSize: 14, color: C.muted, maxWidth: 440, margin: '0 auto 18px' }}>
              A movable trading workspace — live halt scanner, chart, movers and catalysts, arranged your way. Upgrade to unlock it.
            </div>
            <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '12px 26px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
              Start Pro — $12/mo
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}><Workspace /></div>
        )}
      </div>
      <Footer />
    </div>
  );
}
