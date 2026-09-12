'use client'
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { C, BrandStyles, Footer, TopNav, TickerLogo, startCheckout, EntitySearch } from '../../lib/cp-shared';
import { meaningFor } from '../../lib/insider-meaning';
import { treemap } from '../../lib/treemap';
import { useRouter } from 'next/navigation';

const Dot = () => <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:C.green,animation:"cp-pulse 2s infinite",flexShrink:0}}/>;
const Skel = ({w="100%",h=14,mb=6}) => <div style={{width:w,height:h,borderRadius:3,marginBottom:mb,background:"linear-gradient(90deg,var(--cp-surface2,#E8EAE5) 25%,var(--cp-surface,#F0F2EE) 50%,var(--cp-surface2,#E8EAE5) 75%)",backgroundSize:"200% 100%",animation:"cp-shimmer 1.4s infinite"}}/>;

const fmtMoney = (n) => {
  if (!n || isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toLocaleString('en-US')}`;
};
const fmtPrice = (n) => {
  if (!n || isNaN(Number(n))) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const actionStyles = (type) => {
  if (type === 'BUY')  return { fg: C.green, bg: C.greenLight };
  if (type === 'SELL') return { fg: C.red,   bg: C.redLight };
  return                      { fg: C.dim,   bg: C.surface };
};
const decodeEntities = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
};
// SEC Form-4 code → human label. Only P/S are open-market trades; the rest are non-trades
// (award, gift, tax-withholding, option exercise…) shown only in an insider name search.
const CODE_LABEL = { P: 'BUY', S: 'SELL', A: 'AWARD', G: 'GIFT', F: 'TAX', M: 'OPT EXERCISE', C: 'CONVERT', D: 'DISPOSED', X: 'EXERCISE', W: 'ACQUIRED', J: 'OTHER', U: 'OTHER', L: 'OTHER', I: 'OTHER' };
const OPEN_MARKET = new Set(['BUY', 'SELL']);
const ownChangePct = (r) => {
  const after = typeof r.sharesOwnedAfter === 'number' ? r.sharesOwnedAfter : null;
  const sh = typeof r.shares === 'number' ? r.shares : 0;
  if (after == null || !(sh > 0)) return null;
  const before = r.action === 'BUY' ? after - sh : after + sh;   // holdings just before this trade
  if (!(before > 0)) return r.action === 'BUY' ? 100 : null;     // bought a brand-new position → "new"
  const pct = (sh / before) * 100;
  return r.action === 'SELL' ? -pct : pct;
};
const mapRow = (r) => ({
  sym:      r.ticker || '?',
  name:     decodeEntities(r.executive || ''),
  role:     decodeEntities(r.title || ''),
  type:     r.action === 'BUY' ? 'BUY' : r.action === 'SELL' ? 'SELL' : 'OTHER',
  value:    fmtMoney(r.totalValue),
  valueNum: typeof r.totalValue === 'number' ? r.totalValue : 0,
  shares:   typeof r.shares === 'number' ? r.shares : 0,
  avgPrice: typeof r.pricePerShare === 'number' ? r.pricePerShare : 0,
  ownedAfter: typeof r.sharesOwnedAfter === 'number' ? r.sharesOwnedAfter : null,
  ownChange: ownChangePct(r),
  company:  decodeEntities(r.company || ''),
  filed:    r.filingDate || '',
  traded:   r.transactionDate || '',
  code:     r.transactionCode || '',
  typeLabel: CODE_LABEL[r.transactionCode] || (r.action === 'BUY' ? 'BUY' : r.action === 'SELL' ? 'SELL' : 'OTHER'),
  rule10b5_1: r.rule10b5_1 ?? null,          // true=plan, false=explicitly not, null=not disclosed
  ceoCfo:   !!r.ceoCfo,
  firstBuy: !!r.firstOpenMarketBuy,
  monthsSincePriorBuy: r.monthsSincePriorBuy ?? null,
  conviction: r.conviction ?? null,          // RESERVED — server-computed later; slot rendered when present
  filingUrl: r.filingUrl || null,
  perf1d:   typeof r.perf1d === 'number' ? r.perf1d : null,
  perf1w:   typeof r.perf1w === 'number' ? r.perf1w : null,
  perf1m:   typeof r.perf1m === 'number' ? r.perf1m : null,
  perf6m:   typeof r.perf6m === 'number' ? r.perf6m : null,
});

const CATEGORIES = [
  { key:'latest',       label:'LATEST FILINGS',  sub:'newest buys & sells' },
  { key:'all',          label:'ALL FILINGS',     sub:'every Form 4 · live' },
  { key:'buying',       label:'INSIDER BUYING',  sub:'open-market buys' },
  { key:'selling',      label:'INSIDER SELLING', sub:'open-market sells' },
  { key:'ceo',          label:'CEO PURCHASES',   sub:'chief-exec buys' },
  { key:'cluster_buys', label:'CLUSTER BUYS',    sub:'3+ insiders · 30d' },
  { key:'top',          label:'TOP TRADES',      sub:'largest by value' },
  { key:'significant',  label:'SIGNIFICANT',     sub:'$1M+ · recent' },
  { key:'trends',       label:'TRENDS',          sub:'90d sentiment' },
];
const VIEW_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

// Shared filter-control styles
const SEL_STYLE = { background: C.white, border: `1px solid ${C.border}`, color: C.text, padding: '7px 10px', borderRadius: 5, fontSize: 12, fontFamily: "'DM Sans',sans-serif", cursor: 'pointer' };
const LBL_STYLE = { fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, letterSpacing: '0.5px', marginLeft: 6 };
const bandBtn = (active) => ({ background: active ? C.green : C.white, color: active ? '#fff' : C.muted, border: `1px solid ${active ? C.green : C.border}`, borderRadius: 5, padding: '5px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" });
// Clean hover/click tooltip (themed, works light + dark). Not the browser default.
function InfoTip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.stopPropagation(); setShow((s) => !s); }}>
      <span style={{ fontSize: 9, color: C.dim, cursor: 'help', fontWeight: 700, border: `1px solid ${C.border}`, borderRadius: '50%', width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>i</span>
      {show && (
        <span onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', zIndex: 100, width: 270, background: C.white, border: `1px solid ${C.border}`, color: C.text, fontSize: 11, lineHeight: 1.5, padding: '9px 11px', borderRadius: 7, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', fontWeight: 400, whiteSpace: 'normal', textAlign: 'left' }}>{text}</span>
      )}
    </span>
  );
}

// Contextual intelligence badges — only shown when the data supports them. Honest wording:
// we don't claim a multi-year "first buy" until the historical backfill; only "first buy in N months".
function Badges({ ins }) {
  const b = [];
  if (ins.ceoCfo && ins.type === 'BUY') b.push({ t: /CFO|financial/i.test(ins.role) ? 'CFO BUY' : 'CEO BUY', on: true });
  if (ins.rule10b5_1 === true) b.push({ t: '10b5-1', on: false });
  if (ins.rule10b5_1 === false) b.push({ t: 'DISCRETIONARY', on: false });
  if (ins.type === 'BUY' && ins.monthsSincePriorBuy != null && ins.monthsSincePriorBuy >= 3) b.push({ t: `FIRST BUY IN ${ins.monthsSincePriorBuy}MO`, on: true });
  if (ins.type === 'BUY' && ins.ownChange != null && ins.ownChange >= 20) b.push({ t: `OWNERSHIP +${ins.ownChange}%`, on: true });
  if (ins.conviction != null) b.push({ t: `CONVICTION ${ins.conviction}`, on: true });   // reserved slot
  if (!b.length) return null;
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
      {b.map((x, i) => (
        <span key={i} style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.3px', padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap', background: x.on ? C.greenLight : C.surface, color: x.on ? C.green : C.muted }}>{x.t}</span>
      ))}
    </span>
  );
}

// Subsequent-performance cell (green/red % since the trade; "—" when the horizon hasn't elapsed).
const perfTd = (v, key) => (
  <td key={key} className="cp-num" style={{ padding: '13px 10px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', color: v == null ? C.dim : v > 0 ? C.green : v < 0 ? C.red : C.muted }}>
    {v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`}
  </td>
);

// Diverging sentiment bars — buys up/green, sells down/red. No charting lib.
function SentimentChart({ data }) {
  const days = data || [];
  if (!days.length) return <div style={{fontSize:12,color:C.dim,fontFamily:"'DM Sans',sans-serif"}}>No sentiment data.</div>;
  const max = Math.max(1, ...days.map(d => Math.max(d.buys, d.sells)));
  const bw = 8, gap = 2, cap = 52, mid = 60, H = 124;
  const W = days.length * (bw + gap);
  return (
    <div style={{overflowX:"auto"}}>
      <svg width={W} height={H} style={{display:"block"}}>
        <line x1={0} y1={mid} x2={W} y2={mid} stroke={C.border2} strokeWidth={1}/>
        {days.map((d, i) => {
          const x = i * (bw + gap);
          return (
            <g key={i}>
              <rect x={x} y={mid - (d.buys/max)*cap}  width={bw} height={(d.buys/max)*cap}  fill={C.greenMid}/>
              <rect x={x} y={mid}                      width={bw} height={(d.sells/max)*cap} fill={C.red}/>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const fmtBig = (n) => { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n); if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`; if (a >= 1e6) return `$${(n / 1e6).toFixed(0)}M`; if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`; return `$${Math.round(n)}`; };

function WindowToggle({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {['7d', '30d', '90d'].map((w) => (
        <button key={w} onClick={() => onChange(w)} style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", border: `1px solid ${value === w ? C.green : C.border}`, background: value === w ? C.green : C.white, color: value === w ? '#fff' : C.muted }}>{w.toUpperCase()}</button>
      ))}
    </div>
  );
}

function MarketPulse({ data, window, onWindow }) {
  const cards = [
    { l: 'OPEN-MARKET BUYS', v: data && fmtBig(data.buyValue), s: data && `${data.buyCount.toLocaleString()} filings`, c: C.green },
    { l: 'OPEN-MARKET SALES', v: data && fmtBig(data.sellValue), s: data && `${data.sellCount.toLocaleString()} filings`, c: C.red },
    { l: 'BUY/SELL $ RATIO', v: data && (data.buySellRatio != null ? data.buySellRatio.toFixed(2) : '—'), s: data && (data.buySellRatio >= 1 ? 'net buying' : 'net selling'), c: data && data.buySellRatio >= 1 ? C.green : C.muted },
    { l: 'COMPANIES BUYING', v: data && data.companiesBuying.toLocaleString(), s: 'distinct tickers', c: C.ink },
    { l: 'CEO / CFO BUYS', v: data && data.ceoCfoBuys.toLocaleString(), s: 'open-market', c: C.ink },
    { l: 'CLUSTER BUYS', v: data && data.clusterBuys.toLocaleString(), s: '3+ insiders', c: C.ink },
  ];
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: '0.8px' }}>INSIDER MARKET PULSE <span style={{ fontWeight: 400, color: C.muted }}>· open-market only</span></div>
        <WindowToggle value={window} onChange={onWindow} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 10 }}>
        {cards.map((c, i) => (
          <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 9, color: C.dim, letterSpacing: '0.5px', marginBottom: 4 }}>{c.l}</div>
            <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 20, fontWeight: 700, color: c.c || C.ink }}>{data ? (c.v ?? '—') : '—'}</div>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 300, marginTop: 2 }}>{c.s || ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Insider tile color. Direction picks the hue family and never leaves it; MAGNITUDE drives lightness,
// pale → deep, so a huge sale reads as dark red and a small one as pink (same idea in green for buys).
// Four stops per family rather than two, so "light / normal / deep" are distinct bands, not one blur.
const RAMP_GREEN = [[221, 244, 226], [138, 212, 158], [45, 152, 82], [14, 82, 44]];   // pale → deep
const RAMP_RED   = [[252, 216, 216], [244, 150, 150], [212, 66, 66], [124, 20, 24]];  // pale → deep

const rampAt = (stops, t) => {
  const segs = stops.length - 1;
  const i = Math.min(segs - 1, Math.max(0, Math.floor(t * segs)));
  const f = Math.max(0, Math.min(1, t * segs - i));
  const a = stops[i], b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
};

// Share of the window/mode max, log-compressed. Insider $ is heavily outlier-driven — one nine-figure
// filing sets `max` and a linear (or even sqrt) ramp then crushes every other tile into the pale end.
// log1p spreads the small and mid filings across the ramp instead: 5% of max lands ~39% along it.
const LOG_K = 99;
const intensity = (mag, max) => {
  const x = max > 0 ? Math.max(0, Math.min(1, mag / max)) : 0;
  return Math.log1p(LOG_K * x) / Math.log1p(LOG_K);
};

function insiderTileColor(c, mode, max) {
  let dir, mag;
  if (mode === 'buys') { dir = 1; mag = c.buys; }            // Buys view → green family only
  else if (mode === 'sells') { dir = -1; mag = c.sells; }    // Sells view → red family only
  else { dir = c.net >= 0 ? 1 : -1; mag = Math.abs(c.net); } // Net view → never crosses the hue divide
  return rampAt(dir >= 0 ? RAMP_GREEN : RAMP_RED, intensity(mag, max));
}

// Tiles carry semantic colour in both themes, so a fixed white label stops working once the pale end of
// the ramp exists. Pick whichever ink actually contrasts better: sRGB relative luminance, flipping at the
// point where white-on-tile and ink-on-tile are equal (L ≈ 0.207). A brightness eyeball instead of this
// left white text on mid-green at 2.6:1.
const TILE_INK_DARK = '#14201C';
const srgbL = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const tileInk = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return (0.2126 * srgbL(r) + 0.7152 * srgbL(g) + 0.0722 * srgbL(b)) > 0.207 ? TILE_INK_DARK : '#FFFFFF';
};

// Heatmap hover card. Rendered through a portal to <body> at FIXED viewport coordinates so the treemap
// wrapper's overflow:hidden (it needs that for the rounded corners + tile clipping) can never cut the card
// off, and flipped above/below — and shifted horizontally — to whichever side actually has room.
function HeatmapTooltip({ hover, windowLabel, container }) {
  const box = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!hover) return;
    const place = () => {
      const node = box.current, tile = hover.el;
      if (!node || !tile || !tile.isConnected) return;
      const GAP = 10, EDGE = 8;                                 // gap to the tile / min margin to the viewport
      const { width: tw, height: th } = node.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const r = tile.getBoundingClientRect();
      const cr = container?.current?.getBoundingClientRect?.();
      const ceiling = Math.max(EDGE, cr ? cr.top : EDGE);         // never drift up over Market Pulse
      const above = r.top - GAP - th;                            // top if placed ABOVE the tile
      const below = r.bottom + GAP;                              // top if placed BELOW the tile
      let top;
      if (above >= ceiling) top = above;                         // clearly room above, inside the heatmap
      else if (below + th <= vh - EDGE) top = below;             // top-row tiles → open downward
      else top = (vh - r.bottom) > (r.top - ceiling) ? below : above;   // neither fits → roomier side
      top = Math.max(EDGE, Math.min(top, vh - th - EDGE));       // never past the top/bottom edge
      let left = r.left + r.width / 2 - tw / 2;                  // centred on the tile…
      left = Math.max(EDGE, Math.min(left, vw - tw - EDGE));     // …then shifted in at either side
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    place();                                                     // runs pre-paint, so no flicker on tile→tile
    globalThis.addEventListener('scroll', place, true);          // re-place (not dismiss) as the page moves
    globalThis.addEventListener('resize', place);
    return () => { globalThis.removeEventListener('scroll', place, true); globalThis.removeEventListener('resize', place); };
  }, [hover]);

  if (!hover || typeof document === 'undefined') return null;
  const c = hover.c;
  return createPortal(
    <div ref={box} style={{ position: 'fixed', left: pos ? pos.left : 0, top: pos ? pos.top : 0, visibility: pos ? 'visible' : 'hidden', zIndex: 2147483000, width: 222, fontFamily: "'DM Sans',sans-serif", background: C.white, border: `1px solid ${C.border}`, color: C.text, fontSize: 11, lineHeight: 1.55, padding: '9px 11px', borderRadius: 7, boxShadow: '0 10px 28px rgba(0,0,0,0.2)', pointerEvents: 'none' }}>
      <b>{c.ticker}</b> · {c.sector}<br />
      <span style={{ color: C.muted }}>{c.company || '—'}</span><br />
      Purchases: <b style={{ color: C.green }}>{fmtBig(c.buys)}</b><br />
      Sales: <b style={{ color: C.red }}>{fmtBig(c.sells)}</b><br />
      Net: <b style={{ color: c.net >= 0 ? C.green : C.red }}>{c.net >= 0 ? '+' : '−'}{fmtBig(Math.abs(c.net))}</b><br />
      {c.insiders} insider{c.insiders === 1 ? '' : 's'} · largest {fmtBig(c.largest)}<br />
      <span style={{ color: C.dim }}>Past {String(windowLabel || '').toUpperCase()}</span>
    </div>,
    document.body,
  );
}

// Tile label fit. Same responsive font curve as before (so big tiles are unchanged) — what moved is the
// VISIBILITY test: instead of a flat w>30/h>18 cutoff that blanked plenty of tiles with room to spare, a
// ticker shows whenever it measurably fits at that size. ~0.64em per uppercase DM Sans char.
const tkSize = (t) => Math.min(15, Math.max(8, t.w / 5.5));
const fitsTicker = (t) => {
  const len = (t.ticker || '').length;
  if (!len) return false;
  const px = tkSize(t);
  return (t.w - 4) >= px * 0.64 * len && (t.h - 2) >= px;   // hide only when it genuinely can't fit
};

// Squarified treemap heatmap — same visual architecture as the homepage Market Heat Map
// (shared ../../lib/treemap), adapted for insider data.
function Heatmap({ data, window, onWindow, mode, onMode, onPick }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null);
  const wrap = useRef(null);
  useEffect(() => {
    const el = wrap.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => { for (const e of es) setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const cells = data?.cells || [];
  const val = (c) => (mode === 'buys' ? c.buys : mode === 'sells' ? c.sells : Math.abs(c.net));
  const { list, max } = useMemo(() => {
    const shown = cells.filter((c) => val(c) > 0);
    if (!shown.length || size.w < 40 || size.h < 40) return { list: [], max: 1 };
    const mx = Math.max(1, ...shown.map(val));
    const bySec = {};
    for (const c of shown) (bySec[c.sector || 'Other'] ||= []).push(c);
    const sectors = Object.entries(bySec).map(([name, items]) => ({ name, items, value: items.reduce((a, x) => a + val(x), 0) })).filter((s) => s.value > 0);
    const out = [];
    const HEADER = 13;
    for (const sr of treemap(sectors, 0, 0, size.w, size.h)) {
      out.push({ kind: 'sector', name: sr.name, x: sr.x, y: sr.y, w: sr.w });
      const innerY = sr.y + HEADER, innerH = sr.h - HEADER;
      if (innerH < 8 || sr.w < 8) continue;
      for (const tr of treemap(sr.items.map((it) => ({ ...it, value: val(it) })), sr.x, innerY, sr.w, innerH)) out.push({ kind: 'tile', ...tr });
    }
    return { list: out, max: mx };
  }, [cells, size, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHover(null); }, [list]);   // tiles moved → the hovered rect is stale
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: '0.8px' }}>INSIDER ACTIVITY HEATMAP <span style={{ fontWeight: 400, color: C.muted }}>· green = buying · red = selling · size = $</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', gap: 4 }}>
            {[['net', 'Net'], ['buys', 'Buys'], ['sells', 'Sells']].map(([k, l]) => (
              <button key={k} onClick={() => onMode(k)} style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", border: `1px solid ${mode === k ? C.green : C.border}`, background: mode === k ? C.green : C.white, color: mode === k ? '#fff' : C.muted }}>{l}</button>
            ))}
          </div>
          <WindowToggle value={window} onChange={onWindow} />
        </div>
      </div>
      <div ref={wrap} onMouseLeave={() => setHover(null)}
        style={{ position: 'relative', width: '100%', height: 460, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}`, background: C.bg }}>
        {cells.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No insider activity in this window.</div>}
        {list.map((t, i) => {
          if (t.kind === 'sector') return <div key={`s${i}`} style={{ position: 'absolute', left: t.x, top: t.y, width: t.w, height: 13, overflow: 'hidden', fontSize: 8.5, fontWeight: 800, letterSpacing: 0.4, color: C.dim, textTransform: 'uppercase', padding: '2px 4px', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{t.name}</div>;
          const bg = insiderTileColor(t, mode, max);
          const ink = tileInk(bg);                                  // white on deep shades, near-black on pale
          return (
            <button key={`t${i}`} onClick={() => onPick(t.ticker)} onMouseEnter={(e) => setHover({ c: t, el: e.currentTarget })}
              style={{ position: 'absolute', left: t.x, top: t.y, width: t.w, height: t.h, background: bg, border: `1px solid ${C.bg}`, boxSizing: 'border-box', cursor: 'pointer', color: ink, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 0, lineHeight: 1.05 }}>
              {fitsTicker(t) && <span className="cp-tkr" style={{ fontSize: tkSize(t), fontWeight: 700, whiteSpace: 'nowrap', textShadow: ink === '#FFFFFF' ? '0 1px 2px rgba(0,0,0,0.3)' : 'none' }}>{t.ticker}</span>}
              {t.w > 50 && t.h > 34 && <span className="cp-num" style={{ fontSize: Math.min(11, Math.max(7.5, t.w / 8)), opacity: 0.95 }}>{fmtBig(val(t))}</span>}
            </button>
          );
        })}
      </div>
      <HeatmapTooltip hover={hover} windowLabel={window} container={wrap} />
    </div>
  );
}

function NotableActivity({ data, window, onWindow, onPick }) {
  const items = data ? [
    { l: 'LARGEST OPEN-MARKET BUY', x: data.largestPurchase, sub: (x) => `${x.executive} · ${x.ticker}` },
    { l: 'LARGEST CEO BUY', x: data.largestCeoBuy, sub: (x) => `${x.executive} · ${x.ticker}` },
    { l: 'LARGEST CFO BUY', x: data.largestCfoBuy, sub: (x) => `${x.executive} · ${x.ticker}` },
    { l: 'MOST INSIDERS BUYING', x: data.mostInsidersBuying, sub: (x) => `${x.insiders} insiders · ${x.ticker}`, val: (x) => `${x.insiders}` },
    { l: 'LARGEST CLUSTER BUY', x: data.largestCluster, sub: (x) => `${x.insiders} insiders · ${x.ticker}` },
    { l: 'LARGEST OWNERSHIP INCREASE', x: data.largestOwnershipIncrease, sub: (x) => `${x.executive} · ${x.ticker}`, val: (x) => (x.pct != null ? `+${x.pct}%` : fmtBig(x.value)) },
  ].filter((i) => i.x) : [];
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: '0.8px' }}>NOTABLE INSIDER ACTIVITY</div>
        <WindowToggle value={window} onChange={onWindow} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
        {items.map((it, i) => (
          <button key={i} onClick={() => onPick(it.x.ticker)} className="card-hov" style={{ textAlign: 'left', background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', cursor: 'pointer' }}>
            <div style={{ fontSize: 9, color: C.dim, letterSpacing: '0.5px', marginBottom: 5 }}>{it.l}</div>
            <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 18, fontWeight: 700, color: C.green }}>{it.val ? it.val(it.x) : fmtBig(it.x.value)}</div>
            <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.sub(it.x)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function InsidersPage() {
  const [data, setData] = useState(null);          // raw API payload (view-shaped)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeView, setActiveView] = useState('latest');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy,  setSortBy]  = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [days, setDays] = useState(0);          // 0 = any window (folded-in screener filter)
  const [minValue, setMinValue] = useState(0);  // 0 = any size
  const [lastUp, setLastUp] = useState(null);
  const [searchMode, setSearchMode] = useState('ticker'); // 'ticker' (drill-down) | 'name' (filter view)
  const [insiderCo, setInsiderCo] = useState('');         // company ticker pinned from the insider autocomplete
  const [intelWindow, setIntelWindow] = useState('30d');  // shared window for Pulse/Heatmap/Notable
  const [pulse, setPulse] = useState(null);
  const [heatmap, setHeatmap] = useState(null);
  const [notable, setNotable] = useState(null);
  const [heatMode, setHeatMode] = useState('net');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [intel, setIntel] = useState({ openMarket: false, ceocfo: false, cluster: false, firstbuy: false, tenb51: false, discretionary: false });
  const [role, setRole] = useState('');         // title bucket
  const [txn, setTxn] = useState('');           // transaction-type bucket
  const [sector, setSector] = useState('');     // sector filter (via screener_meta)
  const [maxPrice, setMaxPrice] = useState(0);  // share-price ceiling (penny = 5)
  const [dateBasis, setDateBasis] = useState('trade'); // window applies to trade or filing date
  const [maxDelay, setMaxDelay] = useState(0);  // filing-delay ceiling (days)
  const router = useRouter();
  const goTicker = (sym) => { if (sym && sym !== '?') router.push(`/ticker/${encodeURIComponent(sym)}`); };
  // Click an insider's name → pull up that exact person's trades (name + their company).
  const openInsider = (ins) => {
    if (!ins?.name) return;
    setSearchMode('name'); setSearch(ins.name); setDebouncedSearch(ins.name); setInsiderCo(ins.sym || '');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loadData = useCallback(async ({ view, ticker, name }) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: '200' });
      if (ticker) { q.set('ticker', ticker); }
      else {
        q.set('view', view);
        if (name) q.set('name', name);
        if (name && insiderCo) q.set('co', insiderCo);   // pin to the exact person's company
        if (days > 0) q.set('days', String(days));
        if (minValue > 0) q.set('minValue', String(minValue));
        if (maxPrice > 0) q.set('maxPrice', String(maxPrice));
        if (maxDelay > 0) q.set('maxDelay', String(maxDelay));
        if (role) q.set('role', role);
        if (txn) q.set('txn', txn);
        if (sector) q.set('sector', sector);
        if (dateBasis === 'filing') q.set('dateField', 'filing');
        for (const k of Object.keys(intel)) if (intel[k]) q.set(k, '1');
        q.set('page', String(page));
        q.set('pageSize', String(pageSize));
      }
      const res = await fetch(`/api/insiders?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setLastUp(new Date());
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days, minValue, maxPrice, maxDelay, role, txn, sector, dateBasis, insiderCo, intel, page, pageSize]);

  // Reset to page 0 whenever the filter set / view / search changes (so we never land on a stale page).
  useEffect(() => { setPage(0); }, [activeView, days, minValue, maxPrice, maxDelay, role, txn, sector, dateBasis, debouncedSearch, intel, pageSize]);

  // Debounce raw search → debouncedSearch
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toUpperCase()), 400);
    return () => clearTimeout(t);
  }, [search]);

  // Discovery/intelligence sections (Pulse / Heatmap / Notable) — refetch on window change.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, h, n] = await Promise.all([
          fetch(`/api/insiders?view=pulse&window=${intelWindow}`).then((r) => r.ok ? r.json() : null),
          fetch(`/api/insiders?view=heatmap&window=${intelWindow}`).then((r) => r.ok ? r.json() : null),
          fetch(`/api/insiders?view=notable&window=${intelWindow}`).then((r) => r.ok ? r.json() : null),
        ]);
        if (alive) { setPulse(p); setHeatmap(h); setNotable(n); }
      } catch { /* non-fatal */ }
    })();
    return () => { alive = false; };
  }, [intelWindow]);

  // Fetch: a TICKER search drills into that symbol; a NAME search filters the active view; else the view.
  useEffect(() => {
    if (debouncedSearch && searchMode === 'ticker') loadData({ ticker: debouncedSearch });
    else if (debouncedSearch && searchMode === 'name') loadData({ view: 'latest', name: debouncedSearch });
    else loadData({ view: activeView });
  }, [debouncedSearch, searchMode, activeView, loadData]);

  const selectView = (key) => { setSearch(''); setDebouncedSearch(''); setInsiderCo(''); setActiveView(key); };
  const clearSearch = () => { setSearch(''); setDebouncedSearch(''); setInsiderCo(''); };
  const refresh = () => {
    if (debouncedSearch && searchMode === 'ticker') loadData({ ticker: debouncedSearch });
    else if (debouncedSearch && searchMode === 'name') loadData({ view: 'latest', name: debouncedSearch });
    else loadData({ view: activeView });
  };
  const onSearchKeyDown = (e) => { if (e.key === 'Enter') setDebouncedSearch(search.trim().toUpperCase()); };
  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  const isTradeView = data && Array.isArray(data.trades);
  const isCluster   = data?.view === 'cluster_buys';
  const isTrends    = data?.view === 'trends';
  const searching   = !!debouncedSearch;

  // Build + sort rows for trade views
  let rows = isTradeView ? data.trades.map(mapRow) : [];
  if (isTradeView && sortBy) {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'TICKER')      rows = [...rows].sort((a,b)=>dir*(a.sym||'').localeCompare(b.sym||''));
    else if (sortBy === 'DATE')   rows = [...rows].sort((a,b)=>dir*(a.filed||'').localeCompare(b.filed||''));
    else if (sortBy === 'VALUE')  { const nz=rows.filter(r=>r.valueNum>0),z=rows.filter(r=>!(r.valueNum>0)); nz.sort((a,b)=>dir*(a.valueNum-b.valueNum)); rows=[...nz,...z]; }
    else if (sortBy === 'SHARES') { const nz=rows.filter(r=>r.shares>0),z=rows.filter(r=>!(r.shares>0)); nz.sort((a,b)=>dir*(a.shares-b.shares)); rows=[...nz,...z]; }
  }

  // Server-side gate: signed-out → lockedCount>0 (preview rows only); signed-in → 0/absent.
  const lockedCount = data?.lockedCount || 0;

  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",timeZone:"America/New_York"}) : "--:--";
  const buys  = isTradeView ? rows.filter(i=>i.type==='BUY').length  : 0;
  const sells = isTradeView ? rows.filter(i=>i.type==='SELL').length : 0;

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif",background:C.bg,color:C.text,minHeight:"100vh"}}>
      <BrandStyles/>
      <style>{`
        @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes cp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .nbtn{text-decoration:none}.nbtn:hover{color:#FFFFFF!important}
        .row-hov:hover{background:${C.surface}!important;cursor:pointer}
        .ins-name:hover{color:${C.green}!important;text-decoration:underline}
        .cat:hover{border-color:${C.green}!important}
        *{box-sizing:border-box}
      `}</style>

      {/* NAV */}
      <TopNav active="Insiders"/>

      {/* PAGE HEADER */}
      <div style={{background:C.white,borderBottom:`1px solid ${C.border}`,padding:"20px 24px"}}>
        <div style={{maxWidth:1380,margin:"0 auto",display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <Dot/><span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,color:C.muted,letterSpacing:"1px"}}>FORM 4 · SEC EDGAR</span>
            </div>
            <h1 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:32,fontWeight:600,color:C.ink,margin:"0 0 4px",letterSpacing:"-0.5px"}}>Insider Trades</h1>
            <p style={{fontSize:13,color:C.muted,margin:0,fontWeight:300}}>Form 4 filings, as reported to the SEC. See when executives buy or sell their own company stock.</p>
          </div>
          <div style={{display:"flex",gap:12,alignItems:"center"}}>
            {isTradeView && (
              <>
                <div style={{background:C.greenLight,border:`1px solid ${C.greenBorder}`,borderRadius:8,padding:"10px 18px",textAlign:"center"}}>
                  <div className="cp-num" style={{fontFamily:"'DM Sans',sans-serif",fontSize:20,fontWeight:600,color:C.green}}>{loading?'—':buys}</div>
                  <div style={{fontSize:11,color:C.green,fontWeight:500}}>BUYS</div>
                </div>
                <div style={{background:C.redLight,border:`1px solid #E0AAAA`,borderRadius:8,padding:"10px 18px",textAlign:"center"}}>
                  <div className="cp-num" style={{fontFamily:"'DM Sans',sans-serif",fontSize:20,fontWeight:600,color:C.red}}>{loading?'—':sells}</div>
                  <div style={{fontSize:11,color:C.red,fontWeight:500}}>SELLS</div>
                </div>
              </>
            )}
            <div className="cp-num" style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,color:C.dim}}>
              Updated {timeStr} ET
              <button onClick={refresh} style={{background:"transparent",border:"none",color:C.green,cursor:"pointer",fontSize:12,marginLeft:8,fontFamily:"'DM Sans',sans-serif"}}>↻</button>
            </div>
          </div>
        </div>
      </div>

      {/* DISCOVERY → INTELLIGENCE (above the existing research layer) */}
      <div style={{maxWidth:1380,margin:"0 auto",padding:"18px 24px 0"}}>
        <MarketPulse data={pulse} window={intelWindow} onWindow={setIntelWindow} />
        <Heatmap data={heatmap} window={intelWindow} onWindow={setIntelWindow} mode={heatMode} onMode={setHeatMode} onPick={goTicker} />
        <NotableActivity data={notable} window={intelWindow} onWindow={setIntelWindow} onPick={goTicker} />
      </div>

      {/* CONTROLS: search + category grid */}
      <div style={{maxWidth:1380,margin:"0 auto",padding:"16px 24px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          {/* Ticker vs Insider-name search mode */}
          <div style={{display:"inline-flex",border:`1px solid ${C.border}`,borderRadius:5,overflow:"hidden"}}>
            {[{k:'ticker',l:'Ticker'},{k:'name',l:'Insider'}].map(o=>(
              <button key={o.k} onClick={()=>{ setSearchMode(o.k); setSearch(''); setDebouncedSearch(''); setInsiderCo(''); }}
                style={{background:searchMode===o.k?C.green:C.white,color:searchMode===o.k?'#fff':C.muted,border:"none",padding:"8px 12px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>{o.l}</button>
            ))}
          </div>
          {searchMode === 'name' ? (
            <EntitySearch
              endpoint="/api/insiders?ac="
              placeholder="Search insider name (e.g., Huang)…"
              width={320}
              onSelect={(m) => { setSearch(m.executive); setDebouncedSearch(m.executive); setInsiderCo(m.ticker || ''); }}
              renderRow={(m) => (
                <>
                  <TickerLogo symbol={m.ticker} size={22} />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.executive}</span>
                    <span style={{ fontSize: 11, color: C.muted, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.ticker} · {m.title || 'insider'}</span>
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dim, flexShrink: 0, whiteSpace: 'nowrap' }}>{m.trades} filings</span>
                </>
              )}
            />
          ) : (
            <input value={search} onChange={(e)=>setSearch(e.target.value)} onKeyDown={onSearchKeyDown}
              placeholder="Search ticker (e.g., AAPL)"
              style={{width:"100%",maxWidth:280,background:C.white,border:`1px solid ${C.border}`,color:C.text,padding:"8px 12px",borderRadius:5,fontSize:12,fontFamily:"'DM Sans',sans-serif",outline:"none"}}/>
          )}
          {searching && (
            <span style={{display:"inline-flex",alignItems:"center",gap:8,background:C.greenLight,border:`1px solid ${C.greenBorder}`,borderRadius:5,padding:"6px 12px",fontFamily:"'DM Sans',sans-serif",fontSize:12,color:C.green}}>
              {searchMode === 'name' ? `Insider: ${debouncedSearch}` : debouncedSearch}
              <button onClick={clearSearch} style={{background:"transparent",border:"none",color:C.green,cursor:"pointer",fontWeight:700}}>✕</button>
              <span style={{color:C.muted,fontWeight:400}}>{searchMode === 'name' ? 'all transactions' : `back to ${VIEW_LABEL[activeView]}`}</span>
            </span>
          )}
          {/* Folded-in screener filters: window + min transaction size (apply to trade views) */}
          <div style={{display:"flex",alignItems:"center",gap:6,marginLeft:"auto",flexWrap:"wrap"}}>
            <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,color:C.dim,letterSpacing:"0.5px"}}>WINDOW</span>
            {[{k:0,l:'Any'},{k:7,l:'7d'},{k:30,l:'30d'},{k:90,l:'90d'}].map(o=>{
              const active=days===o.k;
              return <button key={o.k} onClick={()=>setDays(o.k)} style={{background:active?C.green:C.white,color:active?'#fff':C.muted,border:`1px solid ${active?C.green:C.border}`,borderRadius:5,padding:"5px 9px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>{o.l}</button>;
            })}
            <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,color:C.dim,letterSpacing:"0.5px",marginLeft:6}}>SIZE</span>
            {[{k:0,l:'Any'},{k:25000,l:'$25K+'},{k:100000,l:'$100K+'},{k:1000000,l:'$1M+'}].map(o=>{
              const active=minValue===o.k;
              return <button key={o.k} onClick={()=>setMinValue(o.k)} style={{background:active?C.green:C.white,color:active?'#fff':C.muted,border:`1px solid ${active?C.green:C.border}`,borderRadius:5,padding:"5px 9px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>{o.l}</button>;
            })}
          </div>
        </div>

        {/* Advanced filters: role · transaction type · price · filing delay · date basis */}
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <select value={role} onChange={(e)=>setRole(e.target.value)} style={SEL_STYLE}>
            <option value="">All roles</option>
            <option value="ceo">CEO</option><option value="cfo">CFO</option><option value="coo">COO</option>
            <option value="president">President</option><option value="chairman">Chairman</option>
            <option value="director">Director</option><option value="vp">VP</option><option value="tenpct">10% Owner</option>
          </select>
          <select value={txn} onChange={(e)=>setTxn(e.target.value)} style={SEL_STYLE}>
            <option value="">All types</option>
            <option value="purchase">Purchase (P)</option><option value="sale">Sale (S)</option>
            <option value="grant">Grant / Award (A)</option><option value="gift">Gift (G)</option>
            <option value="tax">Tax (F)</option><option value="exercise">Option Exercise (M)</option>
            <option value="conversion">Conversion (C)</option>
          </select>
          <select value={sector} onChange={(e)=>setSector(e.target.value)} style={SEL_STYLE}>
            <option value="">All sectors</option>
            {["Technology","Healthcare","Financial Services","Consumer Cyclical","Consumer Defensive","Industrials","Energy","Basic Materials","Real Estate","Utilities","Communication Services"].map(s=>(
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <span style={LBL_STYLE}>PRICE</span>
          {[{k:0,l:'Any'},{k:5,l:'Penny <$5'},{k:20,l:'<$20'}].map(o=>(
            <button key={o.k} onClick={()=>setMaxPrice(o.k)} style={bandBtn(maxPrice===o.k)}>{o.l}</button>
          ))}
          <span style={LBL_STYLE}>DELAY</span>
          {[{k:0,l:'Any'},{k:2,l:'≤2d'},{k:45,l:'≤45d'}].map(o=>(
            <button key={o.k} onClick={()=>setMaxDelay(o.k)} style={bandBtn(maxDelay===o.k)}>{o.l}</button>
          ))}
          <span style={LBL_STYLE}>WINDOW BY</span>
          {[{k:'trade',l:'Traded'},{k:'filing',l:'Filed'}].map(o=>(
            <button key={o.k} onClick={()=>setDateBasis(o.k)} style={bandBtn(dateBasis===o.k)}>{o.l}</button>
          ))}
        </div>

        {/* Intelligence filters (additive toggles — existing controls above are untouched) */}
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{...LBL_STYLE,marginLeft:0}}>INTEL</span>
          {[{k:'openMarket',l:'Open Market'},{k:'ceocfo',l:'CEO / CFO'},{k:'cluster',l:'Cluster Buys'},{k:'firstbuy',l:'First Buy'},{k:'tenb51',l:'10b5-1'},{k:'discretionary',l:'Discretionary'}].map(o=>(
            <button key={o.k} onClick={()=>setIntel(s=>({...s,[o.k]:!s[o.k]}))} style={bandBtn(intel[o.k])}>{o.l}</button>
          ))}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10}}>
          {CATEGORIES.map(cat => {
            const active = !searching && activeView === cat.key;
            return (
              <button key={cat.key} className="cat" onClick={()=>selectView(cat.key)}
                style={{textAlign:"left",background:active?C.green:C.white,border:`1px solid ${active?C.green:C.border}`,borderRadius:8,padding:"12px 14px",cursor:"pointer",transition:"all 0.15s"}}>
                <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600,letterSpacing:"0.5px",color:active?"#fff":C.ink}}>{cat.label}</div>
                <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,marginTop:3,color:active?"rgba(255,255,255,0.8)":C.dim}}>{cat.sub}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* MAIN PANEL */}
      <div style={{maxWidth:1380,margin:"16px auto",padding:"0 24px 40px"}}>
        {error ? (
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,padding:"40px 16px",textAlign:"center",color:C.red,fontSize:13}}>Failed to load: {error}</div>
        ) : loading ? (
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,padding:16}}>
            {Array(8).fill(0).map((_,i)=><Skel key={i} h={16} mb={10}/>)}
          </div>
        ) : isTrends ? (
          /* ── TRENDS ── */
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 18px"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                <span style={{fontSize:13,fontWeight:600,color:C.ink}}>Buy / Sell sentiment · 90 days</span>
                <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,color:C.dim}}>
                  <span style={{color:C.greenMid}}>■</span> buys&nbsp;&nbsp;<span style={{color:C.red}}>■</span> sells
                </span>
              </div>
              <SentimentChart data={data.sentiment}/>
            </div>
            <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
              <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,background:C.surface,fontSize:12,fontWeight:600,color:C.ink}}>Trending tickers · last 7 days</div>
              {(data.trending||[]).map((t,i)=>(
                <div key={i} className="row-hov" onClick={()=>goTicker(t.ticker)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"11px 16px",borderBottom:i<data.trending.length-1?`1px solid ${C.surface}`:"none"}}>
                  <div style={{display:"flex",gap:12,alignItems:"baseline"}}>
                    <span style={{display:"inline-flex",alignItems:"center",gap:8,minWidth:64}}><TickerLogo symbol={t.ticker} size={18}/><span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,color:C.green}}>{t.ticker}</span></span>
                    <span style={{fontSize:12,color:C.muted,maxWidth:320,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{decodeEntities(t.company||'')}</span>
                  </div>
                  <div className="cp-num" style={{fontFamily:"'DM Sans',sans-serif",fontSize:12}}>
                    <span style={{color:C.text}}>{t.trades} filings</span>
                    <span style={{color:C.green,marginLeft:10}}>{t.buys}B</span>
                    <span style={{color:C.red,marginLeft:6}}>{t.sells}S</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : isCluster ? (
          /* ── CLUSTER BUYS ── */
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{background:C.surface,borderBottom:`1px solid ${C.border}`}}>
                {["Ticker","Company","Buyers","Trades","Total $","Window"].map((h,i)=>(
                  <th key={h} style={{padding:"10px 16px",textAlign:i>=2&&i<=4?"right":"left",fontFamily:"'DM Sans',sans-serif",fontSize:9,color:C.dim,letterSpacing:"0.8px",fontWeight:400}}>{h.toUpperCase()}</th>
                ))}
              </tr></thead>
              <tbody>
                {(data.clusters||[]).length===0 ? (
                  <tr><td colSpan={6} style={{padding:"40px 16px",textAlign:"center",color:C.muted,fontSize:13}}>No clusters (3+ insiders buying the same ticker within 30 days) right now.</td></tr>
                ) : data.clusters.map((c,i)=>(
                  <tr key={i} className="row-hov" onClick={()=>goTicker(c.ticker)} style={{borderBottom:i<data.clusters.length-1?`1px solid ${C.surface}`:"none",borderLeft:`3px solid ${C.green}`}}>
                    <td className="cp-tkr" style={{padding:"13px 16px",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,color:C.green}}><span style={{display:"flex",alignItems:"center",gap:8}}><TickerLogo symbol={c.ticker} size={18}/>{c.ticker}</span></td>
                    <td style={{padding:"13px 16px",fontSize:13,color:C.text,maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{decodeEntities(c.company||'')}</td>
                    <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700,color:C.green}}>{c.buyers}</td>
                    <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,color:C.text}}>{c.trades}</td>
                    <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:600,color:C.text}}>{fmtMoney(c.totalValue)}</td>
                    <td className="cp-num" style={{padding:"13px 16px",fontFamily:"'DM Sans',sans-serif",fontSize:11,color:C.dim,whiteSpace:"nowrap"}}>{c.firstBuy} → {c.lastBuy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : (
          /* ── TRADE ROWS (row views + ticker drill-down) ── */
          <>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,fontSize:12,color:C.dim,fontFamily:"'DM Sans',sans-serif"}}>
              {searching ? `${rows.length} filings for ${debouncedSearch}` : `${VIEW_LABEL[activeView]} · ${rows.length} filings`}
            </div>
            <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
              <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{background:C.surface,borderBottom:`1px solid ${C.border}`}}>
                  {[
                    {label:"Filed",sortKey:"DATE"},{label:"Traded",sortKey:null},{label:"Ticker",sortKey:"TICKER"},{label:"Company",sortKey:null},
                    {label:"Insider",sortKey:null},{label:"Type",sortKey:null},{label:"Code",sortKey:null},{label:"Shares",sortKey:"SHARES",align:"right"},
                    {label:"Owned",sortKey:null,align:"right"},{label:"ΔOwn",sortKey:null,align:"right"},
                    {label:"Avg Price",sortKey:null,align:"right"},{label:"Value",sortKey:"VALUE",align:"right"},
                  ].map(h=>{
                    const active=h.sortKey&&sortBy===h.sortKey;const arrow=active?(sortDir==='asc'?' ↑':' ↓'):'';
                    return <th key={h.label} onClick={h.sortKey?()=>handleSort(h.sortKey):undefined} style={{padding:"10px 16px",textAlign:h.align||"left",fontFamily:"'DM Sans',sans-serif",fontSize:9,color:active?C.green:C.dim,letterSpacing:"0.8px",fontWeight:400,cursor:h.sortKey?"pointer":"default",userSelect:"none"}}>{h.label.toUpperCase()}{arrow}</th>;
                  })}
                </tr></thead>
                <tbody>
                  {rows.length===0 ? (
                    <tr><td colSpan={12} style={{padding:"40px 16px",textAlign:"center",color:C.muted,fontSize:13}}>{searching?`No insider trades found for ${debouncedSearch}.`:'No insider trades in this view.'}</td></tr>
                  ) : rows.map((ins,i)=>(
                    <tr key={i} className="row-hov" onClick={()=>goTicker(ins.sym)} style={{borderBottom:i<rows.length-1?`1px solid ${C.surface}`:"none",borderLeft:`3px solid ${actionStyles(ins.type).fg}`}}>
                      <td className="cp-num" style={{padding:"13px 16px",fontFamily:"'DM Sans',sans-serif",fontSize:11,color:C.dim,whiteSpace:"nowrap"}}>
                        {ins.filingUrl
                          ? <a href={ins.filingUrl} target="_blank" rel="noopener noreferrer" onClick={(e)=>e.stopPropagation()} title="View SEC filing" style={{color:C.dim,textDecoration:"none"}}>{ins.filed} <span style={{color:C.green}}>↗</span></a>
                          : ins.filed}
                      </td>
                      <td className="cp-num" style={{padding:"13px 16px",fontFamily:"'DM Sans',sans-serif",fontSize:11,color:C.dim,whiteSpace:"nowrap"}}>{ins.traded || '—'}</td>
                      <td className="cp-tkr" style={{padding:"13px 16px",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,color:C.green}}><span style={{display:"flex",alignItems:"center",gap:8}}><TickerLogo symbol={ins.sym} size={18}/>{ins.sym}</span></td>
                      <td style={{padding:"13px 16px",fontSize:13,color:C.text,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ins.company}</td>
                      <td onClick={(e)=>{ e.stopPropagation(); openInsider(ins); }} style={{padding:"13px 16px",fontSize:13,color:C.text,cursor:"pointer"}}>
                        <div className="ins-name" style={{fontWeight:500,transition:"color 0.15s"}}>{ins.name || '—'}</div>
                        {ins.role && <div style={{fontSize:11,color:C.muted,fontWeight:300,marginTop:2}}>{ins.role}</div>}
                        <Badges ins={ins} />
                      </td>
                      <td style={{padding:"13px 16px"}}>
                        {(() => {
                          const m = meaningFor(ins.code);
                          let label = m.short, tip = m.tip;
                          if (ins.code === 'S' && ins.rule10b5_1 === true) { label = 'SELL · 10b5-1'; tip = 'Sale reported under a pre-arranged Rule 10b5-1 trading plan. Because the trading instructions may have been established earlier, this should not automatically be read as a new discretionary bearish decision.'; }
                          else if (ins.code === 'S' && ins.rule10b5_1 === false) { label = 'SELL · DISCRETIONARY'; tip = 'Sale reported as NOT made under a Rule 10b5-1 plan — a discretionary decision to sell in the open market.'; }
                          else if (ins.code === 'S') tip = m.tip + (ins.rule10b5_1 == null ? ' 10b5-1 status: not disclosed in this filing.' : '');
                          const om = m.openMarket, buy = ins.type === 'BUY';
                          const st = om ? { background: buy ? C.greenLight : C.redLight, color: buy ? C.green : C.red } : { background: C.surface, color: C.muted };
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.3px', padding: '3px 8px', borderRadius: 4, whiteSpace: 'nowrap', fontFamily: "'DM Sans',sans-serif", ...st }}>{label}</span>
                              <InfoTip text={tip} />
                            </span>
                          );
                        })()}
                      </td>
                      <td className="cp-num" style={{padding:"13px 16px",fontFamily:"'DM Sans',sans-serif",fontSize:11,color:C.muted,whiteSpace:"nowrap"}}>{ins.code || '—'}</td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:500,color:C.text,whiteSpace:"nowrap"}}>{ins.shares>0?ins.shares.toLocaleString('en-US'):'—'}</td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:12,color:C.muted,whiteSpace:"nowrap"}}>{ins.ownedAfter!=null?Math.round(ins.ownedAfter).toLocaleString('en-US'):'—'}</td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600,whiteSpace:"nowrap",color:ins.ownChange==null?C.dim:ins.ownChange>0?C.green:ins.ownChange<0?C.red:C.muted}}>{ins.ownChange==null?'—':`${ins.ownChange>0?'+':''}${Math.abs(ins.ownChange)>=999?'>999':ins.ownChange.toFixed(0)}%`}</td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:500,color:C.muted,whiteSpace:"nowrap"}}>{fmtPrice(ins.avgPrice)}</td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700,color:actionStyles(ins.type).fg}}>{ins.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {lockedCount > 0 && (
                <div style={{position:"relative", overflow:"hidden"}}>
                  {Array.from({length:6}).map((_, i) => (
                    <div key={i} style={{display:"flex", gap:16, alignItems:"center", padding:"13px 16px", borderTop:`1px solid ${C.surface}`, filter:"blur(4px)", userSelect:"none", pointerEvents:"none", opacity:0.55}}>
                      <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim, width:78}}>██████████</div>
                      <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:700, color:C.green, width:52}}>████</div>
                      <div style={{fontSize:13, color:C.text, flex:1}}>████████ ██████</div>
                      <span style={{fontSize:10, padding:"3px 9px", borderRadius:3, fontFamily:"'DM Sans',sans-serif", fontWeight:600, background:C.greenLight, color:C.green}}>BUY</span>
                      <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:700, color:C.green, width:72, textAlign:"right"}}>$██.█M</div>
                    </div>
                  ))}
                  <div style={{position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(245,246,243,0.6)", padding:16}}>
                    <div style={{background:C.white, border:`1px solid ${C.greenBorder}`, borderRadius:10, padding:"16px 22px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap", justifyContent:"center", boxShadow:"0 6px 24px rgba(0,0,0,0.12)", textAlign:"center"}}>
                      <span style={{fontSize:20}}>🔒</span>
                      <div>
                        <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:700, color:C.ink}}>{lockedCount.toLocaleString()} more insider trades</div>
                        <div style={{fontSize:12, color:C.muted, fontWeight:300}}>Unlock the full history with Pro</div>
                      </div>
                      <button onClick={() => startCheckout()} style={{background:C.green, color:"#fff", border:"none", whiteSpace:"nowrap", padding:"10px 18px", borderRadius:6, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif"}}>Unlock Pro — $12/mo</button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Server-side pagination (Pro; ticker drill-down + free preview excluded) */}
            {data.view !== 'ticker' && lockedCount === 0 && data.total != null && (
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:14,flexWrap:"wrap",gap:10}}>
                <div style={{fontSize:12,color:C.muted,fontFamily:"'DM Sans',sans-serif"}}>
                  {data.total===0?'No results':`Showing ${(page*pageSize+1).toLocaleString()}–${Math.min((page+1)*pageSize,data.total).toLocaleString()} of ${data.total.toLocaleString()}`}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  <span style={{fontSize:10,color:C.dim,letterSpacing:"0.5px"}}>ROWS</span>
                  {[25,50,100].map(n=>(<button key={n} onClick={()=>setPageSize(n)} style={bandBtn(pageSize===n)}>{n}</button>))}
                  <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} style={{...bandBtn(false),opacity:page===0?0.4:1,cursor:page===0?"default":"pointer"}}>← Prev</button>
                  <span style={{fontSize:12,color:C.muted,fontFamily:"'DM Sans',sans-serif"}}>Page {page+1} / {Math.max(1,Math.ceil(data.total/pageSize))}</span>
                  <button onClick={()=>setPage(p=>p+1)} disabled={(page+1)*pageSize>=data.total} style={{...bandBtn(false),opacity:(page+1)*pageSize>=data.total?0.4:1,cursor:(page+1)*pageSize>=data.total?"default":"pointer"}}>Next →</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* INFO BOX */}
        <div style={{marginTop:16,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 20px",display:"flex",gap:16,alignItems:"flex-start"}}>
          <span style={{fontSize:18,flexShrink:0}}>ℹ️</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:4}}>About Insider Trading Disclosures</div>
            <div style={{fontSize:12,color:C.muted,fontWeight:300,lineHeight:1.6}}>
              Corporate insiders (executives, directors, 10%+ shareholders) must report stock trades to the SEC within 2 business days via Form 4.
              This data is sourced directly from SEC EDGAR. Insider buying can signal management confidence; large sells may indicate distribution.
              This is not financial advice.
            </div>
          </div>
        </div>
      </div>

      <Footer/>
    </div>
  );
}
