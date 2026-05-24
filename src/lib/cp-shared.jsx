'use client';

import { useState, useEffect, useRef } from 'react';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';

// ─── PALETTE ────────────────────────────────────────────────────────────────
export const C = {
  bg:"#F5F6F3", white:"#FFFFFF", surface:"#F0F2EE", surface2:"#E8EAE5",
  border:"#E0E2DC", border2:"#C4C8BE",
  ink:"#0C1410", text:"#1A2018", muted:"#5A6458", dim:"#8A9088", hint:"#C0C4BC",
  green:"#1E5C38", greenMid:"#2A7848", greenLight:"#E8F5EE", greenBorder:"#A8CEB8",
  red:"#A83030", redLight:"#FAEAEA", gold:"#7A5818",
  blue:"#1A3A78", blueLight:"#E8F0FF",
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

export const TICKS = [
  {sym:"SPY",price:524.38,chg:1.2}, {sym:"QQQ",price:441.90,chg:0.8},
  {sym:"NVDA",price:882.50,chg:2.4}, {sym:"TSLA",price:174.20,chg:-0.6},
  {sym:"AAPL",price:192.10,chg:0.3}, {sym:"META",price:503.10,chg:1.1},
  {sym:"BTC",price:68442,chg:3.1}, {sym:"GLD",price:215.40,chg:0.5},
  {sym:"ES=F",price:5241.25,chg:0.9}, {sym:"CL=F",price:83.20,chg:-0.4},
  {sym:"DJI",price:38547,chg:0.6}, {sym:"VIX",price:18.30,chg:4.1},
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
    const r = await fetch(`/api/claude?key=${key}`);
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

// ─── GLOBAL STYLES + FONTS ──────────────────────────────────────────────────
export function BrandStyles() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.querySelector('link[data-cp-fonts]')) return;
    const fl = document.createElement('link');
    fl.rel = 'stylesheet';
    fl.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,600&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600;700&display=swap';
    fl.setAttribute('data-cp-fonts', '1');
    document.head.appendChild(fl);
  }, []);
  return (
    <style>{`
      @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
      @keyframes cp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
      @keyframes cp-fadeup{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .card-hov:hover{box-shadow:0 4px 20px rgba(0,0,0,0.1)!important;transform:translateY(-2px)!important;}
      .hov:hover{background:${C.surface}!important;cursor:pointer}
      .sym-lnk:hover{color:${C.green}!important;cursor:pointer}
      .nbtn:hover{color:#FFFFFF!important}
      .chip-hov:hover{background:${C.surface2}!important;cursor:pointer}
      input:focus{outline:none;border-color:${C.green}!important;box-shadow:0 0 0 3px ${C.greenLight}!important}
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
    background:"linear-gradient(90deg,#E8EAE5 25%,#F0F2EE 50%,#E8EAE5 75%)",
    backgroundSize:"200% 100%", animation:"cp-shimmer 1.4s infinite"}}/>
);

export const Dot = () => (
  <span style={{display:"inline-block", width:6, height:6, borderRadius:"50%",
    background:C.green, animation:"cp-pulse 2s infinite", flexShrink:0}}/>
);

export const Logo = ({dark=false, size=1}) => (
  <div style={{lineHeight:1.05, cursor:"pointer"}}>
    <span style={{fontFamily:"'Cormorant Garamond',serif", fontSize:20*size,
      fontWeight:300, color:dark?"#FFFFFF":C.ink, letterSpacing:"0.04em"}}>Catalyst</span>
    <span style={{fontFamily:"'Cormorant Garamond',serif", fontSize:20*size,
      fontWeight:600, fontStyle:"italic", color:dark?"#5AB87A":C.green, letterSpacing:"0.02em"}}>Pit</span>
  </div>
);

export const TagBadge = ({tag, size="sm"}) => {
  const tc = TAG[tag] || {bg:C.greenLight, c:C.green};
  return (
    <span style={{fontSize:size==="sm"?9:10, background:tc.bg, color:tc.c,
      padding:"2px 7px", borderRadius:3, letterSpacing:"0.5px",
      fontFamily:"'DM Mono',monospace", fontWeight:500, whiteSpace:"nowrap"}}>{tag}</span>
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
            <span style={{fontFamily:"'DM Mono',monospace", fontSize:10, fontWeight:600, color:"#fff",
              background:"rgba(0,0,0,0.52)", backdropFilter:"blur(6px)",
              padding:"2px 8px", borderRadius:4}}>{n.sym}</span>
            {hasChg && (
              <span style={{fontFamily:"'DM Mono',monospace", fontSize:10, fontWeight:600,
                color:isUp?"#5AE87A":"#FF8080", background:"rgba(0,0,0,0.52)", backdropFilter:"blur(6px)",
                padding:"2px 8px", borderRadius:4}}>{fmtP(chgNum)}</span>
            )}
          </div>
        )}

        <div style={{position:"absolute", bottom:hero?72:8, right:10, zIndex:2}}>
          <span style={{fontFamily:"'DM Mono',monospace", fontSize:9,
            color:"rgba(255,255,255,0.82)", textShadow:"0 1px 4px rgba(0,0,0,0.7)"}}>{n.source}</span>
        </div>

        {hero && (
          <div style={{position:"absolute", bottom:0, left:0, right:0,
            padding:"16px 16px 14px", zIndex:2}}>
            <div style={{display:"flex", gap:5, marginBottom:7, alignItems:"center"}}>
              <TagBadge tag={n.tag}/>
              {n.mins != null && (
                <span style={{fontSize:10, color:"rgba(255,255,255,0.65)", marginLeft:"auto",
                  fontFamily:"'DM Mono',monospace"}}>{timeAgo(n.mins)}</span>
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
              <span style={{fontSize:10, color:C.dim, marginLeft:"auto",
                fontFamily:"'DM Mono',monospace"}}>{timeAgo(n.mins)}</span>
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

// ─── TOP NAV (sticky) ───────────────────────────────────────────────────────
export function TopNav() {
  const links = ["Markets", "News", "Screener", "Insiders", "Politicians", "Charts", "Crypto"];
  return (
    <div style={{background:C.navBg, height:50, display:"flex", alignItems:"center",
      justifyContent:"space-between", padding:"0 24px", position:"sticky", top:0, zIndex:100,
      borderBottom:"1px solid rgba(255,255,255,0.15)"}}>
      <a href="/" style={{textDecoration:"none"}}><Logo dark/></a>
      <div style={{display:"flex", gap:20, alignItems:"center", marginLeft:40,
        borderLeft:`1px solid rgba(255,255,255,0.2)`, paddingLeft:40}}>
        {links.map(l => (
          <a key={l} href={`/${l.toLowerCase()}`} className="nbtn"
            style={{fontSize:12, color:"rgba(255,255,255,0.75)", cursor:"pointer",
              transition:"color 0.2s", fontWeight:400, letterSpacing:"0.02em", textDecoration:"none"}}>
            {l}
          </a>
        ))}
      </div>
      <div style={{display:"flex", gap:8, alignItems:"center"}}>
        <SignedOut>
          <a href="/sign-in" style={{background:"transparent", border:"1px solid rgba(255,255,255,0.4)",
            color:"rgba(255,255,255,0.9)", padding:"6px 14px", borderRadius:5, fontSize:12,
            cursor:"pointer", textDecoration:"none", display:"inline-block",
            fontFamily:"'DM Sans',sans-serif", fontWeight:300}}
            onMouseEnter={e => { e.currentTarget.style.color = "#FFFFFF"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "rgba(255,255,255,0.75)"; }}>
            Log In
          </a>
          <a href="/sign-up" style={{background:C.green, border:"none", color:"#fff",
            padding:"7px 18px", borderRadius:5, fontSize:12, fontWeight:500,
            textDecoration:"none", display:"inline-block", cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif"}}
            onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
            onMouseLeave={e => e.currentTarget.style.background = C.green}>
            Start Free
          </a>
        </SignedOut>
        <SignedIn>
          <UserButton afterSignOutUrl="/" appearance={{elements:{avatarBox:{width:32, height:32}}}}/>
        </SignedIn>
      </div>
    </div>
  );
}

// ─── TICKER TAPE (sticky, animated) ─────────────────────────────────────────
export function TickerTape({tickers}) {
  const data = tickers && tickers.length ? tickers : TICKS;
  const [pos, setPos] = useState(0);
  const w = data.length * 158;
  useEffect(() => {
    const id = setInterval(() => setPos(p => p - 1), 26);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{background:C.white, borderBottom:`1px solid ${C.border}`,
      overflow:"hidden", padding:"7px 0", position:"sticky", top:50, zIndex:99}}>
      <div style={{display:"flex", transform:`translateX(${pos%w}px)`,
        whiteSpace:"nowrap", willChange:"transform"}}>
        {[...data, ...data, ...data].map((t, i) => (
          <div key={i} style={{display:"flex", alignItems:"center", gap:6,
            padding:"0 16px", borderRight:`1px solid ${C.border}`}}>
            <span style={{fontFamily:"'DM Mono',monospace", fontSize:11, color:C.muted, fontWeight:400}}>{t.sym}</span>
            <span style={{fontFamily:"'DM Mono',monospace", fontSize:11, color:C.ink, fontWeight:500}}>
              {t.sym === "BTC" || (t.price > 1000) ? (+t.price).toLocaleString() : fmt2(+t.price)}
            </span>
            <span style={{fontFamily:"'DM Mono',monospace", fontSize:10,
              color:chgC(t.chg), background:chgBg(t.chg),
              padding:"1px 5px", borderRadius:3, fontWeight:600}}>
              {t.chg > 0 ? "+" : ""}{fmt2(t.chg)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MARKET SNAPSHOT SIDEBAR CARD ───────────────────────────────────────────
export function MarketSnapshotCard({tickers, loading=false}) {
  const data = tickers && tickers.length ? tickers : TICKS;
  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
      <div style={{padding:"10px 14px", borderBottom:`1px solid ${C.border}`, background:C.surface,
        display:"flex", alignItems:"center", gap:6}}>
        <Dot/>
        <span style={{fontSize:12, fontWeight:600, color:C.ink}}>MARKET SNAPSHOT</span>
      </div>
      {loading ? Array(6).fill(0).map((_, i) => (
        <div key={i} style={{padding:"9px 14px", borderBottom:`1px solid ${C.surface}`}}>
          <Skel h={12} mb={0}/>
        </div>
      )) : data.map((t, i) => (
        <div key={i} className="hov" style={{display:"flex", justifyContent:"space-between",
          alignItems:"center", padding:"9px 14px",
          borderBottom:i < data.length - 1 ? `1px solid ${C.surface}` : "none",
          transition:"background 0.15s", cursor:"pointer"}}>
          <span style={{fontFamily:"'DM Mono',monospace", fontSize:12, fontWeight:600, color:C.ink}}>{t.sym}</span>
          <div style={{display:"flex", alignItems:"center", gap:7}}>
            <span style={{fontFamily:"'DM Mono',monospace", fontSize:12, color:C.text}}>
              {t.sym === "BTC" || (safeN(t.price) > 10000)
                ? safeN(t.price).toLocaleString("en-US", {maximumFractionDigits:0})
                : fmt2(t.price)}
            </span>
            <span style={{fontFamily:"'DM Mono',monospace", fontSize:10, fontWeight:600,
              color:chgC(t.chg), background:chgBg(t.chg), padding:"1px 5px", borderRadius:3}}>
              {safeN(t.chg) > 0 ? "+" : ""}{fmt2(t.chg)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── CATALYST BRIEF SIGNUP CARD (self-contained: own state + toast) ─────────
export function CatalystBriefCard() {
  const [email, setEmail] = useState("");
  const [toasted, setToasted] = useState(false);
  const submit = () => {
    if (!email || !email.includes("@")) return;
    setEmail("");
    setToasted(true);
    setTimeout(() => setToasted(false), 4000);
  };
  return (
    <>
      <div style={{background:"#0C1410", borderRadius:8, padding:"18px",
        position:"relative", overflow:"hidden"}}>
        <div style={{position:"absolute", top:0, left:0, right:0, height:3, background:"#5AB87A"}}/>
        <div style={{fontFamily:"'DM Mono',monospace", fontSize:9, color:"#3A6A48",
          letterSpacing:"1.5px", marginBottom:8}}>THE CATALYST BRIEF</div>
        <div style={{fontFamily:"'Cormorant Garamond',serif", fontSize:19, fontWeight:300,
          color:"#FFFFFF", lineHeight:1.3, marginBottom:6}}>
          Your morning edge.<br/><em style={{color:"#5AB87A"}}>Delivered at 6 AM.</em>
        </div>
        <p style={{fontSize:12, color:"#3A5A42", fontWeight:300, lineHeight:1.7, marginBottom:12}}>
          Top movers, insider trades, politician buys, and one high-conviction idea.
        </p>
        <input value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="Your email address"
          style={{width:"100%", background:"#1A2820", border:"1px solid #2A3A2E",
            color:"#FFFFFF", padding:"9px 12px", borderRadius:6, fontSize:12,
            fontFamily:"'DM Sans',sans-serif", outline:"none", fontWeight:300, marginBottom:6}}/>
        <button onClick={submit} style={{width:"100%", background:"#5AB87A", border:"none",
          color:"#fff", padding:"10px", borderRadius:6, fontSize:12, fontWeight:500,
          cursor:"pointer", fontFamily:"'DM Sans',sans-serif"}}
          onMouseEnter={e => e.currentTarget.style.background = "#4AA868"}
          onMouseLeave={e => e.currentTarget.style.background = "#5AB87A"}>
          Get Free Access →
        </button>
        <p style={{fontSize:10, color:"rgba(255,255,255,0.5)", marginTop:6,
          fontFamily:"'DM Mono',monospace", textAlign:"center"}}>Free forever · No credit card</p>
      </div>

      <div style={{position:"fixed", bottom:24, left:"50%",
        transform:`translateX(-50%) translateY(${toasted?0:80}px)`,
        background:C.white, border:`1px solid ${C.greenBorder}`, padding:"13px 24px",
        borderRadius:10, fontSize:13, zIndex:999, transition:"transform 0.4s ease",
        boxShadow:"0 8px 40px rgba(0,0,0,0.12)", whiteSpace:"nowrap"}}>
        <span style={{color:C.green, fontWeight:600}}>You're in.</span> First brief arrives at 6 AM.
      </div>
    </>
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
      <Logo dark/>
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
        fontFamily:"'DM Mono',monospace", fontSize:10, color:"rgba(255,255,255,0.5)"}}>
        <Dot/>LIVE · 2026 CATALYSTPIT · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}
