'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { SignedIn, SignedOut, UserButton, useAuth } from '@clerk/nextjs';
import { selectTerminalSymbol, onTerminalRoute } from './terminalSymbolBus';

// ─── PALETTE ────────────────────────────────────────────────────────────────
// Colors are CSS variables (defined in BrandStyles for light + [data-theme="dark"]) so the whole app
// themes from one place — every `C.x` inline style resolves to the active theme. navBg/greenOnDark
// stay constant (brand). Fallbacks match the light theme so SSR/no-JS still renders correctly.
export const C = {
  bg:"var(--cp-bg,#F5F6F3)", white:"var(--cp-white,#FFFFFF)", surface:"var(--cp-surface,#F0F2EE)", surface2:"var(--cp-surface2,#E8EAE5)",
  border:"var(--cp-border,#E0E2DC)", border2:"var(--cp-border2,#C4C8BE)",
  ink:"var(--cp-ink,#0C1410)", text:"var(--cp-text,#1A2018)", muted:"var(--cp-muted,#5A6458)", dim:"var(--cp-dim,#8A9088)", hint:"var(--cp-hint,#C0C4BC)",
  green:"var(--cp-green,#1E5C38)", greenMid:"var(--cp-greenMid,#2A7848)", greenLight:"var(--cp-greenLight,#E8F5EE)", greenBorder:"var(--cp-greenBorder,#A8CEB8)",
  greenOnDark:"#4FB37C", // brand-green sibling, brightened for readability on dark surfaces — constant
  red:"var(--cp-red,#A83030)", redLight:"var(--cp-redLight,#FAEAEA)", gold:"var(--cp-gold,#7A5818)",
  blue:"var(--cp-blue,#1A3A78)", blueLight:"var(--cp-blueLight,#E8F0FF)",
  navBg:"#1E5C38",
};

// ─── CATEGORY TAGS (all 16 from enrichment prompt) ──────────────────────────
export const TAG = {
  EARNINGS:    {bg:"#E8F0FF", c:"#1A3A78"},
  FED:         {bg:"#FFF6E8", c:"#7A5018"},
  MARKETS:     {bg:C.greenLight, c:C.green},
  TECH:        {bg:"#F0EAFF", c:"#4A2A90"},
  CRYPTO:      {bg:C.redLight, c:C.red},
  "M&A":       {bg:"#EAFFF2", c:"#1A5A30"},
  MACRO:       {bg:"#E8F4FF", c:"#1A4060"},
  SEC:         {bg:"#FFF8E8", c:"#7A5010"},
  POLITICS:    {bg:"#EEF2FA", c:"#2A4A70"},
  GEOPOLITICS: {bg:"#EAEEF5", c:"#3A4858"},
  IPO:         {bg:"#E8F8EE", c:"#1A6038"},
  ENERGY:      {bg:"#FFF0E0", c:"#8A4810"},
  AI:          {bg:"#F4EBFE", c:"#5A2A98"},
  AUTO:        {bg:"#EEEEEC", c:"#3A3A38"},
  PHARMA:      {bg:"#FDEBEE", c:"#8A2A40"},
  RETAIL:      {bg:"#E6F4F1", c:"#1A5A58"},
};

export const CARD_COLORS = [
  ["#0C2A1A","#1A5A38"], ["#1A0C2A","#5A1A88"], ["#2A1A0C","#885A1A"],
  ["#0C1A2A","#1A5A88"], ["#2A0C0C","#882A1A"], ["#0C2A2A","#1A7A7A"],
];

// ─── PHOTO POOLS ────────────────────────────────────────────────────────────
export const TICKER_PHOTOS = {
  AAPL:["photo-1611532736597-de2d4265fba3","photo-1517336714731-489689fd1ca8","photo-1496181133206-80ce9b88a853"],
  MSFT:["photo-1633419461186-7d40a38105ec","photo-1568952433726-3896e3881c65","photo-1551288049-bebda4e38f71"],
  GOOGL:["photo-1573804633927-bfcbcd909acd","photo-1498050108023-c5249f4df085","photo-1583508805133-8fd03b5a6b94"],
  GOOG:["photo-1573804633927-bfcbcd909acd","photo-1498050108023-c5249f4df085","photo-1583508805133-8fd03b5a6b94"],
  AMZN:["photo-1523474253046-8cd2748b5fd2","photo-1586528116311-ad8dd3c8310d","photo-1607082348824-0a96f2a4b9da"],
  META:["photo-1611605698335-8b1569810432","photo-1432888498266-38ffec3eaf0a","photo-1579869847557-1f67382cc158"],
  NVDA:["photo-1518770660439-4636190af475","photo-1591488320449-011701bb6704","photo-1601132359864-c974e79890ac"],
  TSLA:["photo-1560958089-b8a1929cea89","photo-1593941707882-a5bba14938c7","photo-1617704548623-340376564e68"],
  JPM:["photo-1486406146926-c627a92ad1ab","photo-1444653614773-995cb1ef9efa","photo-1604594849809-dfedbc827105"],
  BAC:["photo-1486406146926-c627a92ad1ab","photo-1604594849809-dfedbc827105","photo-1444653614773-995cb1ef9efa"],
  GS:["photo-1486406146926-c627a92ad1ab","photo-1542744173-8e7e53415bb0","photo-1507003211169-0a1dd7228f2d"],
  MS:["photo-1542744173-8e7e53415bb0","photo-1486406146926-c627a92ad1ab","photo-1444653614773-995cb1ef9efa"],
  WFC:["photo-1604594849809-dfedbc827105","photo-1486406146926-c627a92ad1ab","photo-1444653614773-995cb1ef9efa"],
  SPY:["photo-1611974789855-9c2a0a7236a3","photo-1590283603385-17ffb3a7f29f","photo-1535320903710-d993d3d77d29"],
  QQQ:["photo-1518770660439-4636190af475","photo-1611974789855-9c2a0a7236a3","photo-1590283603385-17ffb3a7f29f"],
  DJI:["photo-1611974789855-9c2a0a7236a3","photo-1518546305927-5a555bb7020d","photo-1460925895917-afdab827c52f"],
  VIX:["photo-1642790551116-18e4f4c38c86","photo-1590283603385-17ffb3a7f29f","photo-1563986768494-4dee2763ff3f"],
  GLD:["photo-1610375461246-83df859d849d","photo-1559526324-4b87b5e36e44","photo-1623227866882-f72b4e2c5e73"],
  BTC:["photo-1639762681057-408e52192e55","photo-1621504450181-5d356f61d307","photo-1622630998477-20aa696ecb05"],
  "BTC-USD":["photo-1639762681057-408e52192e55","photo-1621504450181-5d356f61d307","photo-1622630998477-20aa696ecb05"],
  ETH:["photo-1622630998477-20aa696ecb05","photo-1639762681057-408e52192e55","photo-1634704784915-aacf363b021f"],
  "ETH-USD":["photo-1622630998477-20aa696ecb05","photo-1639762681057-408e52192e55","photo-1634704784915-aacf363b021f"],
  AMD:["photo-1518770660439-4636190af475","photo-1591488320449-011701bb6704","photo-1551288049-bebda4e38f71"],
  INTC:["photo-1518770660439-4636190af475","photo-1451187580459-43490279c0fa","photo-1591488320449-011701bb6704"],
  CRM:["photo-1460925895917-afdab827c52f","photo-1551288049-bebda4e38f71","photo-1498050108023-c5249f4df085"],
  ORCL:["photo-1460925895917-afdab827c52f","photo-1568952433726-3896e3881c65","photo-1451187580459-43490279c0fa"],
  NFLX:["photo-1522869635100-9f4c5e86aa37","photo-1611532736597-de2d4265fba3","photo-1585184394271-4c0a47dc59c9"],
  DIS:["photo-1534430480872-3498386e7856","photo-1609842947418-a7c26a7b5827","photo-1524985069026-dd778a71c7b4"],
  XOM:["photo-1611244419377-b0a760c19719","photo-1473341304170-971dccb5ac1e","photo-1466611653911-95081537e5b7"],
  CVX:["photo-1611244419377-b0a760c19719","photo-1473341304170-971dccb5ac1e","photo-1466611653911-95081537e5b7"],
  "CL=F":["photo-1611244419377-b0a760c19719","photo-1473341304170-971dccb5ac1e","photo-1466611653911-95081537e5b7"],
  RIVN:["photo-1593941707882-a5bba14938c7","photo-1560958089-b8a1929cea89","photo-1617704548623-340376564e68"],
  F:["photo-1552519507-da3b142c6e3d","photo-1492144534655-ae79c964c9d7","photo-1494976388531-d1058494cdd8"],
  GM:["photo-1552519507-da3b142c6e3d","photo-1494976388531-d1058494cdd8","photo-1492144534655-ae79c964c9d7"],
  JNJ:["photo-1576091160550-2173dba999ef","photo-1584308666744-24d5c474f2ae","photo-1532187863486-abf9dbad1b69"],
  PFE:["photo-1559757175-0eb30cd8c063","photo-1576091160550-2173dba999ef","photo-1584308666744-24d5c474f2ae"],
  GME:["photo-1612287230202-1ff1d85d1bdf","photo-1511512578047-dfb367046420","photo-1593305841991-05c297ba4575"],
  AMC:["photo-1489599849927-2ee91cede3ba","photo-1536440136628-849c177e76a1","photo-1524985069026-dd778a71c7b4"],
};

export const TAG_PHOTOS = {
  EARNINGS:["photo-1611974789855-9c2a0a7236a3","photo-1590283603385-17ffb3a7f29f","photo-1460925895917-afdab827c52f","photo-1543286386-713bdd548da4"],
  MARKETS:["photo-1611974789855-9c2a0a7236a3","photo-1518546305927-5a555bb7020d","photo-1590283603385-17ffb3a7f29f","photo-1642790551116-18e4f4c38c86"],
  FED:["photo-1554774853-aae0a22c8aa4","photo-1542744173-8e7e53415bb0","photo-1604594849809-dfedbc827105","photo-1526304640581-d334cdbbf45e"],
  TECH:["photo-1518770660439-4636190af475","photo-1451187580459-43490279c0fa","photo-1498050108023-c5249f4df085","photo-1550751827-4bd374c3f58b"],
  CRYPTO:["photo-1639762681057-408e52192e55","photo-1621504450181-5d356f61d307","photo-1622630998477-20aa696ecb05","photo-1634704784915-aacf363b021f"],
  "M&A":["photo-1521791136064-7986c2920216","photo-1560472354-b33ff0c44a43","photo-1454165804606-c3d57bc86b40","photo-1600880292203-757bb62b4baf"],
  MACRO:["photo-1526304640581-d334cdbbf45e","photo-1554774853-aae0a22c8aa4","photo-1543286386-713bdd548da4","photo-1460925895917-afdab827c52f"],
  SEC:["photo-1589829545856-d10d557cf95f","photo-1542744173-8e7e53415bb0","photo-1450101499163-c8848c66ca85","photo-1507003211169-0a1dd7228f2d"],
  OPTIONS:["photo-1590283603385-17ffb3a7f29f","photo-1642790551116-18e4f4c38c86","photo-1535320903710-d993d3d77d29","photo-1460925895917-afdab827c52f"],
  SQUEEZE:["photo-1611974789855-9c2a0a7236a3","photo-1642790551116-18e4f4c38c86","photo-1590283603385-17ffb3a7f29f","photo-1563986768494-4dee2763ff3f"],
  INSIDER:["photo-1560250097-0b93528c311a","photo-1573496359142-b8d87734a5a2","photo-1573167243872-43c6433b9d40","photo-1507003211169-0a1dd7228f2d"],
};

// ─── PURE HELPERS ───────────────────────────────────────────────────────────
export const chgC  = (v) => (+v) > 0 ? C.green : C.red;
export const chgBg = (v) => (+v) > 0 ? C.greenLight : C.redLight;
export const fmt2  = n => { const x = parseFloat(n); return isNaN(x) ? "-" : x.toFixed(2); };
export const fmtP  = n => { const x = parseFloat(n); return isNaN(x) ? "-" : `${x>0?"+":""}${x.toFixed(2)}%`; };
export const safeN = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
export const timeAgo = m => typeof m === "number" ? (m < 60 ? `${m}m ago` : `${Math.floor(m/60)}h ago`) : m || "Just now";

export const minsSince = (publishedStr) => {
  if (!publishedStr) return null;
  const d = new Date(publishedStr);
  if (isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / 60000);
};

export const storyPhoto = (sym, tag, slot) => {
  const tickerPool = TICKER_PHOTOS[sym?.toUpperCase()];
  if (tickerPool) return `https://images.unsplash.com/${tickerPool[slot % tickerPool.length]}?w=900&h=560&fit=crop&q=85&auto=format`;
  const tagPool = TAG_PHOTOS[tag] || TAG_PHOTOS.MARKETS;
  return `https://images.unsplash.com/${tagPool[slot % tagPool.length]}?w=900&h=560&fit=crop&q=85&auto=format`;
};

// ─── DATA FETCHING ──────────────────────────────────────────────────────────
export const fetchKey = async (key) => {
  try {
    const r = await fetch(`/api/market?key=${key}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.data) return null;
    let val = d.data;
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { return null; } }
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { return null; } }
    return val;
  } catch { return null; }
};

export const toArr = (val, ...wrapperKeys) => {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') {
    for (const k of wrapperKeys) if (Array.isArray(val[k])) return val[k];
    for (const k of Object.keys(val)) if (Array.isArray(val[k])) return val[k];
  }
  return [];
};

// Kick off Stripe Pro checkout (C5): POST /api/stripe/checkout → redirect to Stripe.
// Signed-out → /sign-in; not-configured / error → friendly alert (no dead button).
export async function startCheckout(interval) {
  try {
    const r = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: interval === 'annual' ? 'annual' : 'monthly' }),
    });
    if (r.status === 401) { window.location.href = '/sign-in'; return; }
    const j = await r.json().catch(() => ({}));
    if (j.url) { window.location.href = j.url; return; }
    alert(j.error === 'not_configured' ? 'Pro isn’t available just yet — check back soon.' : 'Could not start checkout. Please try again.');
  } catch {
    alert('Could not start checkout. Please try again.');
  }
}

// ─── GLOBAL STYLES + FONTS ──────────────────────────────────────────────────
export function BrandStyles() {
  return (
    <style>{`
      :root{
        --cp-bg:#F5F6F3;--cp-white:#FFFFFF;--cp-surface:#F0F2EE;--cp-surface2:#E8EAE5;
        --cp-border:#E0E2DC;--cp-border2:#C4C8BE;
        --cp-ink:#0C1410;--cp-text:#1A2018;--cp-muted:#5A6458;--cp-dim:#8A9088;--cp-hint:#C0C4BC;
        --cp-green:#1E5C38;--cp-greenMid:#2A7848;--cp-greenLight:#E8F5EE;--cp-greenBorder:#A8CEB8;
        --cp-red:#A83030;--cp-redLight:#FAEAEA;--cp-gold:#7A5818;--cp-blue:#1A3A78;--cp-blueLight:#E8F0FF;
      }
      :root[data-theme="dark"]{
        color-scheme:dark;
        --cp-bg:#0E1512;--cp-white:#161F1A;--cp-surface:#1B241F;--cp-surface2:#232E28;
        --cp-border:#2A342E;--cp-border2:#3A453E;
        --cp-ink:#EEF3EF;--cp-text:#D8DED8;--cp-muted:#98A49B;--cp-dim:#78847B;--cp-hint:#48524C;
        --cp-green:#46A874;--cp-greenMid:#58BE86;--cp-greenLight:#16301F;--cp-greenBorder:#2E5A40;
        --cp-red:#E06B6B;--cp-redLight:#3A1E1E;--cp-gold:#C79A3C;--cp-blue:#6B8FE0;--cp-blueLight:#1A2540;
      }
      html,body{background:var(--cp-bg);}
      @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
      @keyframes cp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
      @keyframes cp-fadeup{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .card-hov:hover{box-shadow:0 4px 20px rgba(0,0,0,0.1)!important;transform:translateY(-2px)!important;}
      .hov:hover{background:${C.surface}!important;cursor:pointer}
      .sym-lnk:hover{color:${C.green}!important;cursor:pointer}
      .nbtn:hover{color:#FFFFFF!important}
      .chip-hov:hover{background:${C.surface2}!important;cursor:pointer}
      input:focus{outline:none;border-color:${C.green}!important;box-shadow:0 0 0 3px ${C.greenLight}!important}
      .cp-brief-email::placeholder{color:rgba(255,255,255,0.55)}
      ::-webkit-scrollbar{width:4px;height:4px}
      ::-webkit-scrollbar-track{background:${C.surface}}
      ::-webkit-scrollbar-thumb{background:${C.border2};border-radius:2px}
      *{box-sizing:border-box}
    `}</style>
  );
}

// ─── PRIMITIVES ─────────────────────────────────────────────────────────────
export const Skel = ({w="100%", h=14, mb=6}) => (
  <div style={{width:w, height:h, borderRadius:3, marginBottom:mb,
    background:"linear-gradient(90deg,var(--cp-surface2,#E8EAE5) 25%,var(--cp-surface,#F0F2EE) 50%,var(--cp-surface2,#E8EAE5) 75%)",
    backgroundSize:"200% 100%", animation:"cp-shimmer 1.4s infinite"}}/>
);

// Live theme value ('light'|'dark') — updates when the toggle flips data-theme (via MutationObserver).
// Use in components that must react to theme changes at runtime (e.g. TradingView embeds).
export function useTheme() {
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

// Light/dark theme toggle. Sets data-theme on <html> (CSS variables in BrandStyles do the rest) and
// persists to localStorage. A no-flash script in the root layout applies the saved theme before paint.
export function ThemeToggle({ style }) {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark((typeof document !== "undefined" && document.documentElement.dataset.theme === "dark")); }, []);
  const toggle = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    if (next === "dark") document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("cp_theme", next); } catch { /* ignore */ }
    setDark(next === "dark");
  };
  return (
    <button onClick={toggle} title={dark ? "Light mode" : "Dark mode"} aria-label="Toggle theme"
      style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", background:"none", border:"none", cursor:"pointer", color:C.muted, padding:4, ...style }}>
      {dark
        ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>}
    </button>
  );
}

export const Dot = () => (
  <span style={{display:"inline-block", width:6, height:6, borderRadius:"50%",
    background:C.green, animation:"cp-pulse 2s infinite", flexShrink:0}}/>
);

export const Logo = ({dark=false, size=1}) => (
  <div style={{lineHeight:1.05, cursor:"pointer"}}>
    <span style={{fontFamily:"'Cormorant Garamond',serif", fontSize:30*size,
      fontWeight:500, color:dark?"#FFFFFF":C.ink, letterSpacing:"-0.02em"}}>Catalyst</span>
    <span style={{fontFamily:"'Cormorant Garamond',serif", fontSize:30*size,
      fontWeight:700, fontStyle:"italic", color:dark?"#5AB87A":C.green, letterSpacing:"-0.02em"}}>Pit</span>
  </div>
);

export const TagBadge = ({tag, size="sm"}) => {
  const tc = TAG[tag] || {bg:C.greenLight, c:C.green};
  return (
    <span style={{fontSize:size==="sm"?9:10, background:tc.bg, color:tc.c,
      padding:"2px 7px", borderRadius:3, letterSpacing:"0.5px",
      fontFamily:"'DM Sans',sans-serif", fontWeight:500, whiteSpace:"nowrap"}}>{tag}</span>
  );
};

export function MiniLineChart({points=[], color=C.green}) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !points.length) return;
    const canvas = ref.current;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const min = Math.min(...points), max = Math.max(...points);
    const range = max - min || 1;
    const px = (i) => i * (w / (points.length - 1));
    const py = (v) => h - ((v - min) / range) * (h - 20) - 10;
    ctx.beginPath();
    ctx.moveTo(px(0), py(points[0]));
    for (let i = 1; i < points.length; i++) ctx.lineTo(px(i), py(points[i]));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    ctx.lineTo(px(points.length - 1), h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = color === "red" ? "rgba(168,48,48,0.08)" : "rgba(30,92,56,0.08)";
    ctx.fill();
    const lx = px(points.length - 1), ly = py(points[points.length - 1]);
    ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }, [points, color]);
  return <canvas ref={ref} width={280} height={80} style={{display:"block", width:"100%", height:80}}/>;
}

// ─── NEWS PHOTO CARD (hero / large / stacked / default) ─────────────────────
export function NewsPhotoCard({n, idx, large=false, hero=false, stacked=false, showSummary=false}) {
  const [bg1, bg2] = CARD_COLORS[idx % CARD_COLORS.length];
  const [imgFailed, setImgFailed] = useState(false);
  const primarySrc = !imgFailed && n.imageUrl ? n.imageUrl : null;
  const photoSrc = null;
  const photoH = hero ? 340 : stacked ? 110 : large ? 200 : 150;
  const hasValidTicker = n.sym && n.sym !== 'N/A' && n.sym !== 'null' && n.sym !== '?';
  const hasChg = n.chg !== null && n.chg !== undefined && !isNaN(parseFloat(n.chg));
  const chgNum = hasChg ? parseFloat(n.chg) : 0;
  const isUp = chgNum >= 0;

  const cardInner = (
    <div className="card-hov" style={{background:C.white, border:`1px solid ${C.border}`,
      borderRadius:8, overflow:"hidden", cursor:"pointer", transition:"all 0.2s",
      height: hero ? "auto" : "100%", display:"flex", flexDirection:"column"}}>

      <div style={{height:photoH, position:"relative", overflow:"hidden",
        flexShrink:0, background:`linear-gradient(135deg,${bg1},${bg2})`}}>
        <img
          src={primarySrc || photoSrc}
          alt=""
          onError={e => {
            if (primarySrc && photoSrc) { setImgFailed(true); e.currentTarget.src = photoSrc; }
            else e.currentTarget.style.display = "none";
          }}
          style={{position:"absolute", inset:0, width:"100%", height:"100%",
            objectFit:"cover", objectPosition:"center top", display:"block"}}
        />
        <div style={{position:"absolute", inset:0, pointerEvents:"none",
          background:hero
            ? "linear-gradient(to bottom,rgba(0,0,0,0.1) 0%,rgba(0,0,0,0.02) 35%,rgba(0,0,0,0.78) 100%)"
            : "linear-gradient(to bottom,rgba(0,0,0,0.38) 0%,rgba(0,0,0,0.04) 45%,rgba(0,0,0,0.48) 100%)"}}/>

        {hasValidTicker && (
          <div style={{position:"absolute", top:9, left:9, display:"flex", gap:5, zIndex:2}}>
            <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, fontWeight:600, color:"#fff",
              background:"rgba(0,0,0,0.52)", backdropFilter:"blur(6px)",
              padding:"2px 8px", borderRadius:4}}>{n.sym}</span>
            {hasChg && (
              <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, fontWeight:600,
                color:isUp?"#5AE87A":"#FF8080", background:"rgba(0,0,0,0.52)", backdropFilter:"blur(6px)",
                padding:"2px 8px", borderRadius:4}}>{fmtP(chgNum)}</span>
            )}
          </div>
        )}

        <div style={{position:"absolute", bottom:hero?72:8, right:10, zIndex:2}}>
          <span style={{fontFamily:"'DM Sans',sans-serif", fontSize:9,
            color:"rgba(255,255,255,0.82)", textShadow:"0 1px 4px rgba(0,0,0,0.7)"}}>{n.source}</span>
        </div>

        {hero && (
          <div style={{position:"absolute", bottom:0, left:0, right:0,
            padding:"16px 16px 14px", zIndex:2}}>
            <div style={{display:"flex", gap:5, marginBottom:7, alignItems:"center"}}>
              <TagBadge tag={n.tag}/>
              {n.mins != null && (
                <span className="cp-num" style={{fontSize:10, color:"rgba(255,255,255,0.65)", marginLeft:"auto",
                  fontFamily:"'DM Sans',sans-serif"}}>{timeAgo(n.mins)}</span>
              )}
            </div>
            <div style={{fontSize:19, color:"#fff", lineHeight:1.35, fontWeight:700,
              fontFamily:"'DM Sans',sans-serif", textShadow:"0 2px 10px rgba(0,0,0,0.55)",
              letterSpacing:"-0.3px"}}>{n.headline}</div>
            {showSummary && n.summary && (
              <div style={{fontSize:13, color:"rgba(255,255,255,0.85)", marginTop:8, lineHeight:1.5,
                fontFamily:"'DM Sans',sans-serif", textShadow:"0 1px 6px rgba(0,0,0,0.5)", fontWeight:300,
                display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden"}}>
                {n.summary}
              </div>
            )}
          </div>
        )}
      </div>

      {!hero && (
        <div style={{padding:stacked?"9px 12px 10px":"11px 13px 13px", flex:1}}>
          <div style={{display:"flex", gap:5, marginBottom:5, alignItems:"center"}}>
            <TagBadge tag={n.tag}/>
            {n.mins != null && (
              <span className="cp-num" style={{fontSize:10, color:C.dim, marginLeft:"auto",
                fontFamily:"'DM Sans',sans-serif"}}>{timeAgo(n.mins)}</span>
            )}
          </div>
          <div style={{fontSize:stacked?12:large?15:13, color:C.ink, lineHeight:1.42,
            fontWeight:600, fontFamily:"'DM Sans',sans-serif",
            display:"-webkit-box", WebkitLineClamp:stacked?2:3,
            WebkitBoxOrient:"vertical", overflow:"hidden"}}>{n.headline}</div>
        </div>
      )}
    </div>
  );

  if (n.url) {
    return (
      <a href={n.url} target="_blank" rel="noopener noreferrer"
        style={{textDecoration:"none", color:"inherit", display:"block", height: hero ? "auto" : "100%"}}>
        {cardInner}
      </a>
    );
  }
  return cardInner;
}

// ─── SYMBOL SEARCH (nav) ─────────────────────────────────────────────────────
// Submits to /ticker/{SYMBOL}; the ticker page's own validation cascade handles
// junk via its not-found UX (no client-side validation / autocomplete in v1).
export function SymbolSearch({ mobile = false, onNavigate }) {
  const router = useRouter();
  const [v, setV] = useState('');
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(-1);          // highlighted suggestion index
  const timer = useRef(null);
  const blurT = useRef(null);

  const go = (raw) => {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return;
    setV(''); setResults([]); setActive(-1);
    if (onNavigate) onNavigate();
    // Futures convention "/ES" → URL-safe "FUT.ES" (avoids an encoded slash in the path).
    const target = s.startsWith('/') ? `FUT.${s.slice(1)}` : s;
    router.push(`/ticker/${encodeURIComponent(target)}`);
  };
  const submit = (e) => {
    if (e) e.preventDefault();
    if (active >= 0 && results[active]) return go(results[active].ticker);
    go(v);
  };

  // Debounced autocomplete against /api/symbol-search (skips futures "/…" queries).
  const onChange = (val) => {
    const up = val.toUpperCase();
    setV(up); setActive(-1);
    if (timer.current) clearTimeout(timer.current);
    if (up.trim().length < 1 || up.startsWith('/')) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/symbol-search?q=${encodeURIComponent(up.trim())}`);
        const j = r.ok ? await r.json() : null;
        setResults(Array.isArray(j?.results) ? j.results : []);
      } catch { setResults([]); }
    }, 130);
  };

  const onKeyDown = (e) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
    else if (e.key === 'Escape') { setResults([]); setActive(-1); }
  };

  const showDrop = focused && results.length > 0 && !v.startsWith('/');

  return (
    <form onSubmit={submit} style={{ position: "relative", display: "flex", alignItems: "center",
      height: 32, width: mobile ? "100%" : 210,
      background: "#FFFFFF", borderRadius: 999,
      border: `1px solid ${focused ? "#1E5C38" : "rgba(0,0,0,0.08)"}` }}>
      <button type="submit" aria-label="Search ticker symbol" tabIndex={-1}
        style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
          background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer",
          display: "flex", alignItems: "center" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1E5C38"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      <input type="text" value={v} onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
        onFocus={() => { setFocused(true); if (blurT.current) clearTimeout(blurT.current); }}
        onBlur={() => { blurT.current = setTimeout(() => setFocused(false), 160); }}
        aria-label="Search ticker symbol" placeholder={mobile ? "Ticker, company, or /ES…" : "Search ticker…"}
        className="cp-nav-search-input"
        style={{ width: "100%", height: "100%", background: "transparent", border: "none", outline: "none",
          color: "#1A1A1A", fontFamily: "'DM Sans',sans-serif", fontSize: 14, letterSpacing: "0.5px",
          padding: "0 14px 0 36px", borderRadius: 999, minWidth: 0 }} />

      {showDrop && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 200,
          background: "#FFFFFF", border: "1px solid rgba(0,0,0,0.10)", borderRadius: 10,
          boxShadow: "0 10px 28px rgba(0,0,0,0.16)", overflow: "hidden", maxHeight: 320, overflowY: "auto" }}>
          {results.map((r, i) => (
            <button key={r.ticker + i} type="button"
              onMouseDown={(e) => { e.preventDefault(); go(r.ticker); }}
              onMouseEnter={() => setActive(i)}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
                padding: "8px 12px", background: i === active ? "#F0F5F1" : "#FFFFFF", border: "none",
                borderBottom: i < results.length - 1 ? "1px solid #F0F0EC" : "none", cursor: "pointer" }}>
              <TickerLogo symbol={r.ticker} size={20} />
              <span className="cp-tkr" style={{ fontSize: 13, fontWeight: 700, color: "#1E5C38", flexShrink: 0 }}>{r.ticker}</span>
              <span style={{ fontSize: 12, color: "#6B7280", fontWeight: 300, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

// ─── ENTITY SEARCH (reusable typeahead — politicians, institutions, …) ───────
// Debounced autocomplete: hits `${endpoint}<q>` expecting { results: [...] }, shows a
// dropdown, keyboard-navigable, routes to hrefFor(item) on pick. The caller supplies
// renderRow(item, isActive) so each page styles its own rows. Mirrors SymbolSearch.
export function EntitySearch({ endpoint, placeholder = 'Search…', hrefFor, onSelect, renderRow, minChars = 2, width = 340, autoFocus = false }) {
  const router = useRouter();
  const [v, setV] = useState('');
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const blurT = useRef(null);

  const pick = (item) => {
    if (!item) return;
    setV(''); setResults([]); setActive(-1);
    if (onSelect) onSelect(item); else router.push(hrefFor(item));   // onSelect = filter in place; else navigate
  };

  const onChange = (val) => {
    setV(val); setActive(-1);
    if (timer.current) clearTimeout(timer.current);
    if (val.trim().length < minChars) { setResults([]); setLoading(false); return; }
    setLoading(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`${endpoint}${encodeURIComponent(val.trim())}`);
        const j = r.ok ? await r.json() : null;
        setResults(Array.isArray(j?.results) ? j.results : []);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 140);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
    else if (e.key === 'Enter') { if (active >= 0 && results[active]) { e.preventDefault(); pick(results[active]); } }
    else if (e.key === 'Escape') { setResults([]); setActive(-1); }
  };

  const showDrop = focused && v.trim().length >= minChars;

  return (
    <div style={{ position: 'relative', width, maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 40, background: C.white,
        borderRadius: 999, border: `1px solid ${focused ? C.green : C.border}`, transition: 'border-color 0.15s' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 14, flexShrink: 0 }} aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input value={v} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); if (blurT.current) clearTimeout(blurT.current); }}
          onBlur={() => { blurT.current = setTimeout(() => setFocused(false), 160); }}
          placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus}
          style={{ width: '100%', height: '100%', background: 'transparent', border: 'none', outline: 'none',
            color: C.text, fontFamily: "'DM Sans',sans-serif", fontSize: 14, padding: '0 14px 0 10px', borderRadius: 999, minWidth: 0 }} />
      </div>
      {showDrop && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 200,
          background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
          boxShadow: '0 10px 28px rgba(0,0,0,0.16)', overflow: 'hidden', maxHeight: 380, overflowY: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 13, color: C.muted, fontFamily: "'DM Sans',sans-serif" }}>
              {loading ? 'Searching…' : 'No matches'}
            </div>
          ) : results.map((item, i) => (
            <button key={(item.slug || '') + i} type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
              onMouseEnter={() => setActive(i)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                padding: '9px 12px', background: i === active ? C.surface : C.white, border: 'none',
                borderBottom: i < results.length - 1 ? `1px solid ${C.surface}` : 'none', cursor: 'pointer' }}>
              {renderRow(item, i === active)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TOP NAV (sticky) ───────────────────────────────────────────────────────
// Notification bell for the nav (signed-in). Polls unread count; opening marks all read.
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState([]);
  const [unread, setUnread] = useState(0);

  const load = async () => {
    try {
      const r = await fetch('/api/notifications', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j) { setList(j.notifications || []); setUnread(j.unread || 0); }
    } catch { /* ignore */ }
  };
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) { setUnread(0); try { await fetch('/api/notifications', { method: 'POST' }); } catch { /* ignore */ } }
  };

  const verb = (n) => n.type === 'follow' ? 'followed you'
    : n.type === 'like' ? 'liked your post'
    : n.type === 'comment' ? 'commented on your post'
    : n.type === 'alert' ? 'triggered an alert' : 'sent you an update';
  const href = (n) => (n.type === 'follow' && n.actorHandle) ? `/u/${n.actorHandle}` : n.type === 'alert' ? '/terminal' : '/feed';

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button onClick={toggle} aria-label="Notifications"
        style={{ position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer', color: '#fff', padding: '4px 6px', lineHeight: 0, display: 'inline-flex' }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="cp-num" style={{ position: 'absolute', top: -3, right: -3, background: '#E5484D', color: '#fff',
            borderRadius: 10, fontSize: 9, minWidth: 15, height: 15, padding: '0 3px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
          <div style={{ position: 'absolute', top: '135%', right: 0, width: 320, maxHeight: 420, overflowY: 'auto',
            background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', zIndex: 201 }}>
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.ink, fontFamily: "'DM Sans',sans-serif" }}>
              Notifications
            </div>
            {list.length === 0 ? (
              <div style={{ padding: '24px 14px', textAlign: 'center', color: C.dim, fontSize: 12, fontFamily: "'DM Sans',sans-serif" }}>Nothing yet.</div>
            ) : list.map((n) => (
              <a key={n.id} href={href(n)}
                style={{ display: 'flex', gap: 9, padding: '10px 14px', borderBottom: `1px solid ${C.surface}`,
                  textDecoration: 'none', background: n.read ? C.white : C.greenLight, fontFamily: "'DM Sans',sans-serif" }}>
                {n.actorAvatar
                  ? <img src={n.actorAvatar} alt="" width={30} height={30} style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <span style={{ width: 30, height: 30, borderRadius: '50%', background: C.green, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{(n.actorName || 'T').slice(0, 1).toUpperCase()}</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: C.ink, lineHeight: 1.4 }}><b>{n.actorName}</b> {verb(n)}</div>
                  {n.excerpt && <div style={{ fontSize: 11, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>“{n.excerpt}”</div>}
                  <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{timeAgo(minsSince(n.createdAt))}</div>
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TopNav({ active }) {
  // Nav lists only dense rooms (A5). Screener restored in C3; Crypto/Charts still out.
  // Logo is the home link. Watchlist (signed-in), Log In/Start Free render separately below.
  const links = ["Terminal", "Pit Consensus", "Feed", "News", "Screener", "Insiders", "Politicians", "Institutions"];
  const [menuOpen, setMenuOpen] = useState(false);
  const linkColor = (l) => active === l ? "#FFFFFF" : "rgba(255,255,255,0.75)";
  // Most links map to /<lowercased>; multi-word names get an explicit path.
  const hrefFor = (l) => l === "Pit Consensus" ? "/consensus" : `/${l.toLowerCase()}`;
  return (
    <div style={{background:C.navBg, height:50, display:"flex", alignItems:"center",
      justifyContent:"space-between", padding:"0 24px", position:"sticky", top:0, zIndex:100,
      borderBottom:"1px solid rgba(255,255,255,0.15)"}}>
      <a href="/" style={{textDecoration:"none"}}><Logo dark/></a>

      {/* Desktop links — hidden ≤860px via .cp-nav-links */}
      <div className="cp-nav-links" style={{gap:16, alignItems:"center", marginLeft:24,
        paddingLeft:24, flex:"1 1 auto", minWidth:0, overflow:"hidden"}}>
        {links.map(l => (
          <a key={l} href={hrefFor(l)} className="nbtn"
            style={{fontSize:15, color:linkColor(l), cursor:"pointer", transition:"color 0.2s",
              fontWeight: active === l ? 600 : 400, letterSpacing:"0.02em", textDecoration:"none",
              borderBottom: active === l ? "2px solid #5AB87A" : "none", paddingBottom: active === l ? 2 : 0}}>
            {l}
          </a>
        ))}
      </div>

      <div style={{display:"flex", gap:8, alignItems:"center", marginLeft:20, flexShrink:0}}>
        <span className="cp-nav-search"><SymbolSearch /></span>
        <ThemeToggle style={{color:"rgba(255,255,255,0.85)"}} />
        <SignedOut>
          <a href="/sign-in" style={{background:"transparent", border:"1px solid rgba(255,255,255,0.4)",
            color:"rgba(255,255,255,0.9)", height:32, padding:"0 16px", borderRadius:5, fontSize:13,
            cursor:"pointer", textDecoration:"none", display:"inline-flex", alignItems:"center",
            fontFamily:"'DM Sans',sans-serif", fontWeight:300}}
            onMouseEnter={e => { e.currentTarget.style.color = "#FFFFFF"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "rgba(255,255,255,0.75)"; }}>
            Log In
          </a>
          <a href="/sign-up" style={{background:"#FFFFFF", border:"none", color:"#1E5C38",
            height:32, padding:"0 18px", borderRadius:5, fontSize:13, fontWeight:600,
            textDecoration:"none", display:"inline-flex", alignItems:"center", cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif"}}
            onMouseEnter={e => e.currentTarget.style.background = "#F5F6F3"}
            onMouseLeave={e => e.currentTarget.style.background = "#FFFFFF"}>
            Start Free
          </a>
        </SignedOut>
        <SignedIn>
          {/* Watchlist lives in the right-edge WatchlistDock now (desktop); still in the mobile menu. */}
          <NotificationBell/>
          <UserButton afterSignOutUrl="/" userProfileMode="navigation" userProfileUrl="/account" appearance={{elements:{avatarBox:{width:32, height:32}}}}/>
        </SignedIn>

        {/* Hamburger — shown ≤860px via .cp-nav-burger */}
        <button className="cp-nav-burger" onClick={() => setMenuOpen(o => !o)} aria-label="Menu"
          style={{background:"transparent", border:"1px solid rgba(255,255,255,0.4)", color:"#fff",
            borderRadius:5, width:36, height:30, alignItems:"center", justifyContent:"center",
            fontSize:16, cursor:"pointer", padding:0}}>
          {menuOpen ? "✕" : "☰"}
        </button>
      </div>

      {/* Mobile dropdown — overlays below the bar, shown ≤860px when open */}
      {menuOpen && (
        <div className="cp-nav-menu" style={{position:"absolute", top:50, left:0, right:0,
          flexDirection:"column", background:C.navBg, borderBottom:"1px solid rgba(255,255,255,0.15)",
          boxShadow:"0 8px 16px rgba(0,0,0,0.25)"}}>
          <div style={{padding:"11px 24px", borderBottom:"1px solid rgba(255,255,255,0.1)"}}>
            <SymbolSearch mobile onNavigate={() => setMenuOpen(false)} />
          </div>
          {links.map(l => (
            <a key={l} href={hrefFor(l)} onClick={() => setMenuOpen(false)}
              style={{fontSize:14, color:linkColor(l), fontWeight: active === l ? 600 : 400,
                textDecoration:"none", padding:"11px 24px",
                borderLeft: active === l ? "3px solid #5AB87A" : "3px solid transparent"}}>
              {l}
            </a>
          ))}
          <SignedIn>
            <a href="/watchlist" onClick={() => setMenuOpen(false)}
              style={{fontSize:14, color:linkColor("Watchlist"), fontWeight: active === "Watchlist" ? 600 : 400,
                textDecoration:"none", padding:"11px 24px",
                borderLeft: active === "Watchlist" ? "3px solid #5AB87A" : "3px solid transparent"}}>
              Watchlist
            </a>
          </SignedIn>
        </div>
      )}
    </div>
  );
}

// ─── TICKER TAPE (sticky, animated) ─────────────────────────────────────────
export function TickerTape({tickers}) {
  const hasData = tickers && tickers.length > 0;
  const [pos, setPos] = useState(0);
  const w = hasData ? tickers.length * 158 : 0;
  useEffect(() => {
    if (!hasData) return;
    const id = setInterval(() => setPos(p => p - 1), 26);
    return () => clearInterval(id);
  }, [hasData]);
  return (
    <div style={{background:C.white, borderBottom:`1px solid ${C.border}`,
      overflow:"hidden", padding:"7px 0", position:"sticky", top:50, zIndex:99}}>
      {hasData ? (
        <div style={{display:"flex", transform:`translateX(${pos%w}px)`,
          whiteSpace:"nowrap", willChange:"transform"}}>
          {[...tickers, ...tickers, ...tickers].map((t, i) => {
            const valid = t.sym && t.sym !== '?';
            const cell = (
              <>
                <TickerLogo symbol={t.sym} size={16}/>
                <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.muted, fontWeight:400}}>{t.sym}</span>
                <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.ink, fontWeight:500}}>
                  {t.sym === "BTC" || (t.price > 1000) ? (+t.price).toLocaleString() : fmt2(+t.price)}
                </span>
                <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:10,
                  color:chgC(t.chg), background:chgBg(t.chg),
                  padding:"1px 5px", borderRadius:3, fontWeight:600}}>
                  {t.chg > 0 ? "+" : ""}{fmt2(t.chg)}%
                </span>
              </>
            );
            return valid ? (
              <a key={i} href={`/ticker/${encodeURIComponent(t.sym)}`} className="hov"
                onClick={(e) => { if (onTerminalRoute()) { e.preventDefault(); selectTerminalSymbol(t.sym); } }}
                style={{display:"flex", alignItems:"center", gap:6, padding:"0 16px",
                  borderRight:`1px solid ${C.border}`, textDecoration:"none", color:"inherit", cursor:"pointer"}}>
                {cell}
              </a>
            ) : (
              <div key={i} style={{display:"flex", alignItems:"center", gap:6,
                padding:"0 16px", borderRight:`1px solid ${C.border}`}}>
                {cell}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{padding:"0 16px", fontFamily:"'DM Sans',sans-serif",
          fontSize:11, color:C.dim, letterSpacing:"0.5px"}}>Loading market data…</div>
      )}
      <div style={{position:"absolute", right:0, top:0, bottom:0, display:"flex",
        alignItems:"center", padding:"0 12px 0 32px",
        background:"linear-gradient(to right, rgba(255,255,255,0) 0%, #FFFFFF 35%)",
        fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.dim,
        letterSpacing:"0.8px", pointerEvents:"none"}}>DELAYED</div>
    </div>
  );
}

// ─── TICKER LOGO (img via /api/logo, initials-badge fallback) ────────────────
// Logos come through our SAME-ORIGIN /api/logo proxy, so we can read their pixels on a
// canvas (no CORS taint) and give the tile a CONTRASTING backdrop when needed: a transparent
// logo whose content is light/near-white (e.g. Seagate) would vanish on a white tile, so it
// gets a dark tile instead; dark or colored logos keep the default light tile. The decision
// depends ONLY on the logo (never the page theme), so each tile is self-contained and stays
// correct in BOTH light and dark mode. No invert(), no recolor — object-fit:contain preserved.
// If the canvas can't be read (blocked/tainted), we fall back to the current light tile.
const LOGO_PALETTE = ['#1E5C38', '#1A3A78', '#7A5818', '#5A2A98', '#8A2A40', '#1A5A58', '#8A4810'];
export const LOGO_DARK_BG = '#242B36';          // backdrop that makes light/white logos pop
const _logoBg = new Map();                      // ticker → 'light' | 'dark' (in-session cache)

function readLogoBg(sym) {
  if (_logoBg.has(sym)) return _logoBg.get(sym);
  try { const v = localStorage.getItem(`cp:logobg:v1:${sym}`); if (v === 'light' || v === 'dark') { _logoBg.set(sym, v); return v; } } catch { /* SSR / privacy mode */ }
  return null;
}
function writeLogoBg(sym, mode) {
  _logoBg.set(sym, mode);
  try { localStorage.setItem(`cp:logobg:v1:${sym}`, mode); } catch { /* ignore */ }
}
// Loaded same-origin logo → 'dark' (needs a dark backdrop) | 'light'. null if unreadable → caller keeps default.
function analyzeLogo(img) {
  try {
    const N = 32;
    const c = document.createElement('canvas'); c.width = N; c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, N, N);
    ctx.drawImage(img, 0, 0, N, N);
    const { data } = ctx.getImageData(0, 0, N, N);
    let aSum = 0, lumSum = 0, transparent = 0; const total = N * N;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      if (a < 0.1) { transparent++; continue; }
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      lumSum += lum * a; aSum += a;
    }
    if (aSum < 1) return null;                              // effectively empty
    const contentLum = lumSum / aSum;                      // brightness of the drawn content
    const transparentFrac = transparent / total;           // transparent PNG vs baked-in background
    // Fix target: a transparent logo whose content is light/near-white (invisible on white).
    return (transparentFrac > 0.12 && contentLum > 0.68) ? 'dark' : 'light';
  } catch { return null; }                                 // tainted/blocked → graceful fallback
}

// Shared hook: contrast-detection for a same-origin logo. Returns { bgMode, ref, onLoad }.
// Attach `ref`+`onLoad` to the <img> and use `bgMode` ('dark'|'light'|null) to pick the tile
// background (LOGO_DARK_BG when 'dark', else your light default). Reuse this in ANY bespoke
// logo renderer so the fix is consistent everywhere — not just the TickerLogo chip.
export function useLogoBg(symbol) {
  const sym = (symbol || '').toUpperCase();
  const [bgMode, setBgMode] = useState(null);              // set post-mount → no SSR hydration mismatch
  const ref = useRef(null);
  const decide = () => {
    const cached = readLogoBg(sym);
    if (cached) { setBgMode(cached); return; }
    if (ref.current && ref.current.complete && ref.current.naturalWidth) {
      const m = analyzeLogo(ref.current);
      if (m) { writeLogoBg(sym, m); setBgMode(m); }
    }
  };
  useEffect(() => { if (sym) decide(); }, [sym]);          // eslint-disable-line react-hooks/exhaustive-deps
  return { bgMode, ref, onLoad: () => { if (sym) decide(); } };
}

export function TickerLogo({ symbol, size = 18 }) {
  const [failed, setFailed] = useState(false);
  const sym = (symbol || '').toUpperCase();
  const { bgMode, ref, onLoad } = useLogoBg(sym);
  const initials = sym.replace(/[^A-Z0-9]/g, '').slice(0, 2) || '?';
  let h = 0; for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
  const bg = LOGO_PALETTE[h % LOGO_PALETTE.length];

  if (sym && sym !== '?' && !failed) {
    return (
      <img ref={ref} src={`/api/logo?ticker=${encodeURIComponent(sym)}&v=3`} alt="" width={size} height={size}
        onLoad={onLoad} onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: 4, objectFit: 'contain',
          background: bgMode === 'dark' ? LOGO_DARK_BG : '#fff', border: `1px solid ${C.border}`,
          flexShrink: 0, display: 'block' }} />
    );
  }
  return (
    <span style={{ width: size, height: size, borderRadius: 4, background: bg, color: '#fff', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.42), fontWeight: 700, fontFamily: "'DM Sans',sans-serif", letterSpacing: '-0.02em' }}>
      {initials}
    </span>
  );
}

// ─── MARKET SNAPSHOT SIDEBAR CARD ───────────────────────────────────────────
export function MarketSnapshotCard({tickers, loading=false}) {
  const hasData = tickers && tickers.length > 0;
  const router = useRouter();
  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
      <div style={{padding:"10px 14px", borderBottom:`1px solid ${C.border}`, background:C.surface,
        display:"flex", alignItems:"center", gap:6}}>
        <Dot/>
        <span style={{fontSize:12, fontWeight:600, color:C.ink}}>MARKET SNAPSHOT</span>
        <span style={{marginLeft:"auto", fontFamily:"'DM Sans',sans-serif", fontSize:9,
          color:C.dim, letterSpacing:"0.8px"}}>DELAYED</span>
      </div>
      {loading || !hasData ? Array(6).fill(0).map((_, i) => (
        <div key={i} style={{padding:"9px 14px", borderBottom:`1px solid ${C.surface}`}}>
          <Skel h={12} mb={0}/>
        </div>
      )) : tickers.map((t, i) => (
        <div key={i} className="hov" onClick={() => { if (t.sym && t.sym !== "?") router.push(`/ticker/${encodeURIComponent(t.sym)}`); }}
          style={{display:"flex", justifyContent:"space-between",
          alignItems:"center", padding:"9px 14px",
          borderBottom:i < tickers.length - 1 ? `1px solid ${C.surface}` : "none",
          transition:"background 0.15s", cursor:"pointer"}}>
          <span style={{display:"flex", alignItems:"center", gap:8, minWidth:0}}>
            <TickerLogo symbol={t.sym} size={18}/>
            <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight:600, color:C.ink}}>{t.sym}</span>
          </span>
          <div style={{display:"flex", alignItems:"center", gap:7}}>
            <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:12, color:C.text}}>
              {t.sym === "BTC" || (safeN(t.price) > 10000)
                ? safeN(t.price).toLocaleString("en-US", {maximumFractionDigits:0})
                : fmt2(t.price)}
            </span>
            <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, fontWeight:600,
              color:chgC(t.chg), background:chgBg(t.chg), padding:"1px 5px", borderRadius:3}}>
              {safeN(t.chg) > 0 ? "+" : ""}{fmt2(t.chg)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── WATCHLIST HOMEPAGE CARD ────────────────────────────────────────────────
// Homepage-sized presentation of the user's watchlist — same card chrome as
// MarketSnapshotCard. Three states: signed-out (conversion prompt), signed-in
// with tickers (capped rows + "View all →"), signed-in empty (instructive).
// Signed-in users also get an inline "Add ticker" control that POSTs to
// /api/watchlist without leaving the homepage. Reuses GET /api/watchlist?prices=1
// (and POST) — static cached prices, no live polling, no new endpoints.
const WL_HOME_CAP = 6;
const wlPrice = (n) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}`;

export function WatchlistHomeCard() {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const [list, setList] = useState(null);   // null = loading; [] = empty; [...] = has tickers
  const [adding, setAdding] = useState(false);
  const [entry, setEntry] = useState('');
  const [err, setErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Load the priced list. Used on mount and after a successful add.
  async function refresh() {
    try {
      const r = await fetch('/api/watchlist?prices=1');
      const j = r.ok ? await r.json() : [];
      setList(Array.isArray(j) ? j : []);
    } catch { setList(prev => prev ?? []); }
  }

  // Two-phase load: bare list first (fast — symbols render immediately with the
  // price column in a loading state), then ?prices=1 to resolve each price. A
  // row's price is `undefined` while pending, then number | null once resolved,
  // so cold-cache latency reads as "loading prices" instead of a blank slot.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let alive = true;
    (async () => {
      let proceed = false;
      try {
        const r = await fetch('/api/watchlist');           // phase 1: bare {ticker, added_at}
        const bare = r.ok ? await r.json() : [];
        if (alive) { setList(Array.isArray(bare) ? bare : []); proceed = Array.isArray(bare) && bare.length > 0; }
      } catch { if (alive) setList([]); }
      if (!alive || !proceed) return;
      try {
        const r2 = await fetch('/api/watchlist?prices=1');  // phase 2: resolve prices
        const priced = r2.ok ? await r2.json() : null;
        if (alive && Array.isArray(priced)) setList(priced);
        else if (alive) setList(prev => (prev || []).map(x => x.price === undefined ? { ...x, price: null } : x));
      } catch {
        // Phase-2 failure → resolve pending rows to "—" so they don't shimmer forever.
        if (alive) setList(prev => (prev || []).map(x => x.price === undefined ? { ...x, price: null } : x));
      }
    })();
    return () => { alive = false; };
  }, [isLoaded, isSignedIn]);

  async function submitAdd(e) {
    if (e) e.preventDefault();
    const t = entry.trim().toUpperCase();
    if (!t || submitting) return;
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t }),
      });
      if (r.ok) {
        const updated = await r.json();   // bare {ticker, added_at}[] — most-recent-first
        setEntry('');
        // Show immediately (new ticker price "—"), preserving known prices…
        if (Array.isArray(updated)) {
          setList(prev => {
            const priceBy = new Map((prev || []).map(x => [x.ticker, x]));
            return updated.map(u => priceBy.get(u.ticker) ?? u);
          });
        }
        refresh();   // …then fill the new ticker's cached price.
      } else {
        const j = await r.json().catch(() => ({}));
        setErr(j.error === 'invalid ticker' ? 'Not a valid symbol' : (j.error || 'Could not add ticker'));
      }
    } catch {
      setErr('Could not add ticker');
    } finally {
      setSubmitting(false);
    }
  }

  function toggleAdd() {
    setErr(null); setEntry('');
    setAdding(a => !a);
  }

  const shown = Array.isArray(list) ? list.slice(0, WL_HOME_CAP) : [];
  const hasMore = Array.isArray(list) && list.length > WL_HOME_CAP;

  let body;
  if (!isLoaded || (isSignedIn && list === null)) {
    // Auth resolving, or signed-in list still loading → skeleton rows.
    body = Array(4).fill(0).map((_, i) => (
      <div key={i} style={{padding:"9px 14px", borderBottom:`1px solid ${C.surface}`}}>
        <Skel h={12} mb={0}/>
      </div>
    ));
  } else if (!isSignedIn) {
    // Conversion hook — inviting, not naggy.
    body = (
      <div style={{padding:"22px 16px", textAlign:"center", fontFamily:"'DM Sans',sans-serif"}}>
        <div style={{fontSize:20, marginBottom:8, color:C.dim}}>☆</div>
        <div style={{fontSize:13, color:C.ink, fontWeight:600, marginBottom:10}}>Sign in to track your watchlist</div>
        <a href="/sign-in" style={{display:"inline-block", background:C.green, color:"#fff",
          padding:"8px 18px", borderRadius:6, fontSize:13, fontWeight:600, textDecoration:"none",
          fontFamily:"'DM Sans',sans-serif"}}
          onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
          onMouseLeave={e => e.currentTarget.style.background = C.green}>
          Sign in
        </a>
      </div>
    );
  } else if (list.length === 0) {
    // Signed-in, empty — instructive with a clear next action.
    body = (
      <div style={{padding:"22px 16px", textAlign:"center", fontFamily:"'DM Sans',sans-serif"}}>
        <div style={{fontSize:20, marginBottom:8, color:C.dim}}>☆</div>
        <div style={{fontSize:13, color:C.ink, fontWeight:600, marginBottom:4}}>No tickers yet</div>
        <div style={{fontSize:12, color:C.muted, fontWeight:300}}>Add one above, or use the ☆ on any ticker page.</div>
      </div>
    );
  } else {
    body = shown.map((t, i) => (
      <div key={t.ticker} className="hov" onClick={() => router.push(`/ticker/${encodeURIComponent(t.ticker)}`)}
        style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 14px",
          borderBottom: i < shown.length - 1 ? `1px solid ${C.surface}` : "none",
          transition:"background 0.15s", cursor:"pointer"}}>
        <span style={{display:"flex", alignItems:"center", gap:8, minWidth:0}}>
          <TickerLogo symbol={t.ticker} size={18}/>
          <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight:600, color:C.ink}}>{t.ticker}</span>
        </span>
        <div style={{display:"flex", alignItems:"center", gap:7}}>
          {t.price === undefined ? (
            <Skel w={54} h={12} mb={0}/>     /* price still loading */
          ) : (
            <>
              <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:12, color:C.text}}>{wlPrice(t.price)}</span>
              {t.changePct != null && (
                <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, fontWeight:600,
                  color:chgC(t.changePct), background:chgBg(t.changePct), padding:"1px 5px", borderRadius:3}}>
                  {safeN(t.changePct) > 0 ? "+" : ""}{fmt2(t.changePct)}%
                </span>
              )}
            </>
          )}
        </div>
      </div>
    ));
  }

  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
      <div style={{padding:"10px 14px", borderBottom:`1px solid ${C.border}`, background:C.surface,
        display:"flex", alignItems:"center", gap:6}}>
        <Dot/>
        <span style={{fontSize:12, fontWeight:600, color:C.ink}}>WATCHLIST</span>
        {isSignedIn && (
          <div style={{marginLeft:"auto", display:"flex", alignItems:"center", gap:12}}>
            {hasMore && (
              <a href="/watchlist" style={{fontFamily:"'DM Sans',sans-serif",
                fontSize:11, color:C.green, textDecoration:"none", fontWeight:400}}>View all →</a>
            )}
            <button onClick={toggleAdd}
              style={{background:"transparent", border:"none", padding:0, cursor:"pointer",
                fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.green, fontWeight:400}}>
              {adding ? 'Cancel' : '+ Add ticker'}
            </button>
          </div>
        )}
      </div>

      {/* Inline add — type a symbol, hit enter; API validates + rejects junk. */}
      {isSignedIn && adding && (
        <form onSubmit={submitAdd} style={{padding:"10px 14px", borderBottom:`1px solid ${C.surface}`}}>
          <input
            autoFocus
            value={entry}
            onChange={e => { setEntry(e.target.value.toUpperCase()); if (err) setErr(null); }}
            onKeyDown={e => { if (e.key === 'Escape') toggleAdd(); }}
            disabled={submitting}
            placeholder="Add symbol — e.g. AAPL"
            aria-label="Add a ticker to your watchlist"
            maxLength={10}
            style={{width:"100%", boxSizing:"border-box", height:32, background:C.white,
              border:`1px solid ${C.border}`, borderRadius:5, padding:"0 10px",
              fontFamily:"'DM Sans',sans-serif", fontSize:12, color:C.text, outline:"none"}}
            onFocus={e => e.currentTarget.style.borderColor = C.green}
            onBlur={e => e.currentTarget.style.borderColor = C.border}
          />
          {err && <div style={{marginTop:6, fontSize:11, color:C.red, fontFamily:"'DM Sans',sans-serif"}}>{err}</div>}
        </form>
      )}

      {body}
    </div>
  );
}

// ─── CATALYST BRIEF SIGNUP CARD (self-contained: own state + Beehiiv POST) ────
// Real signup via /api/subscribe → Beehiiv (server holds the API key). No 6 AM
// promise until the newsletter actually ships (B5 / Rule 0).
export function CatalystBriefCard() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle");   // idle | submitting | success | error
  const [msg, setMsg] = useState("");
  const submit = async () => {
    const e = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || status === "submitting") return;
    setStatus("submitting"); setMsg("");
    try {
      const r = await fetch("/api/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { setEmail(""); setStatus("success"); setMsg("You're on the list — we'll send the first brief soon."); }
      else if (j.error === "not_configured") { setStatus("error"); setMsg("Signups open soon — check back shortly."); }
      else if (j.error === "invalid email") { setStatus("error"); setMsg("That email doesn't look right."); }
      else { setStatus("error"); setMsg("Couldn't sign you up — try again in a moment."); }
    } catch {
      setStatus("error"); setMsg("Couldn't sign you up — try again in a moment.");
    }
  };
  const busy = status === "submitting";
  return (
    <div style={{background:"#0C1410", borderRadius:8, padding:"18px",
      position:"relative", overflow:"hidden"}}>
      <div style={{position:"absolute", top:0, left:0, right:0, height:3, background:"#5AB87A"}}/>
      <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:"#3A6A48",
        fontWeight:600, letterSpacing:"1.5px", marginBottom:8}}>THE CATALYST BRIEF</div>
      <div style={{fontFamily:"'Cormorant Garamond',serif", fontSize:19, fontWeight:300,
        color:"#FFFFFF", lineHeight:1.3, marginBottom:6}}>
        Your morning edge.<br/><em style={{color:C.greenOnDark, fontWeight:600, fontSize:22}}>Straight to your inbox.</em>
      </div>
      <p style={{fontSize:12, color:"#3A5A42", fontWeight:600, lineHeight:1.7, marginBottom:12}}>
        Top movers, insider trades, politician buys, and one high-conviction idea.
      </p>
      <input value={email} onChange={e => { setEmail(e.target.value); if (status === "error") { setStatus("idle"); setMsg(""); } }}
        onKeyDown={e => e.key === "Enter" && submit()}
        placeholder="Your email address"
        className="cp-brief-email"
        disabled={busy}
        style={{width:"100%", background:"#1A2820", border:"1px solid #2A3A2E",
          color:"#FFFFFF", padding:"9px 12px", borderRadius:6, fontSize:12,
          fontFamily:"'DM Sans',sans-serif", outline:"none", fontWeight:300, marginBottom:6}}/>
      <button onClick={submit} disabled={busy} style={{width:"100%", background:"#5AB87A", border:"none",
        color:"#fff", padding:"10px", borderRadius:6, fontSize:12, fontWeight:500,
        cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1, fontFamily:"'DM Sans',sans-serif"}}
        onMouseEnter={e => { if (!busy) e.currentTarget.style.background = "#4AA868"; }}
        onMouseLeave={e => e.currentTarget.style.background = "#5AB87A"}>
        {busy ? "Adding…" : "Get the Brief →"}
      </button>
      {msg
        ? <p style={{fontSize:11, marginTop:8, marginBottom:0, textAlign:"center", fontFamily:"'DM Sans',sans-serif",
            color: status === "success" ? "#5AB87A" : "#E0A0A0"}}>{msg}</p>
        : <p style={{fontSize:10, color:"rgba(255,255,255,0.5)", marginTop:6,
            fontFamily:"'DM Sans',sans-serif", textAlign:"center"}}>Free forever · No credit card</p>}
    </div>
  );
}

// ─── FOOTER ─────────────────────────────────────────────────────────────────
export function Footer() {
  const links = [
    {label:"Features", href:null},
    {label:"Pricing",  href:null},
    {label:"Privacy",  href:"/privacy"},
    {label:"Terms",    href:"/terms"},
    {label:"Disclaimer", href:"/disclaimer"},
    {label:"Contact",  href:"/contact"},
  ];
  return (
    <div style={{background:C.navBg, marginTop:20, padding:"24px",
      display:"flex", justifyContent:"space-between", alignItems:"center",
      flexWrap:"wrap", gap:12}}>
      <Logo dark size={0.9}/>
      <div style={{display:"flex", gap:24, flexWrap:"wrap"}}>
        {links.map(l => l.href ? (
          <a key={l.label} href={l.href} style={{fontSize:12, color:"rgba(255,255,255,0.6)",
            cursor:"pointer", fontWeight:300, textDecoration:"none"}}
            onMouseEnter={e => e.currentTarget.style.color = "#FFFFFF"}
            onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.6)"}>
            {l.label}
          </a>
        ) : (
          <span key={l.label} style={{fontSize:12, color:"rgba(255,255,255,0.6)",
            cursor:"pointer", fontWeight:300}}
            onMouseEnter={e => e.currentTarget.style.color = "#FFFFFF"}
            onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.6)"}>
            {l.label}
          </span>
        ))}
      </div>
      <div style={{display:"flex", alignItems:"center", gap:6,
        fontFamily:"'DM Sans',sans-serif", fontSize:10, color:"rgba(255,255,255,0.5)"}}>
        2026 CATALYSTPIT · NOT FINANCIAL ADVICE · DELAYED FILINGS · <a href="https://logo.dev" target="_blank" rel="noopener noreferrer" style={{color:"rgba(255,255,255,0.5)", textDecoration:"none"}}>LOGOS BY LOGO.DEV</a>
      </div>
    </div>
  );
}
