'use client'
import { useState, useEffect, useCallback } from "react";
import { Logo, Footer } from '../../lib/cp-shared';

const C = {
  bg:"#F5F6F3",white:"#FFFFFF",surface:"#F0F2EE",border:"#E0E2DC",border2:"#C4C8BE",
  ink:"#0C1410",text:"#1A2018",muted:"#5A6458",dim:"#8A9088",
  green:"#1E5C38",greenMid:"#2A7848",greenLight:"#E8F5EE",greenBorder:"#A8CEB8",
  red:"#A83030",redLight:"#FAEAEA",navBg:"#1E5C38",
};

const safeN = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const Dot = () => <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:C.green,animation:"cp-pulse 2s infinite",flexShrink:0}}/>;
const Skel = ({w="100%",h=14,mb=6}) => <div style={{width:w,height:h,borderRadius:3,marginBottom:mb,background:"linear-gradient(90deg,#E8EAE5 25%,#F0F2EE 50%,#E8EAE5 75%)",backgroundSize:"200% 100%",animation:"cp-shimmer 1.4s infinite"}}/>;

const fmtMoney = (n) => {
  if (!n || isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toLocaleString('en-US')}`;
};

const actionStyles = (type) => {
  if (type === 'BUY')  return { fg: C.green, bg: C.greenLight };
  if (type === 'SELL') return { fg: C.red,   bg: C.redLight };
  return                      { fg: C.dim,   bg: C.surface };
};

const decodeEntities = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
};

const fetchKey = async (key) => {
  try {
    const r = await fetch(`/api/claude?key=${key}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.data) return null;
    let val = d.data;
    if (typeof val==='string') { try { val=JSON.parse(val); } catch { return null; } }
    if (typeof val==='string') { try { val=JSON.parse(val); } catch { return null; } }
    return val;
  } catch { return null; }
};

const toArr = (val, ...keys) => {
  if (Array.isArray(val)) return val;
  if (val && typeof val==='object') {
    for (const k of keys) if (Array.isArray(val[k])) return val[k];
    for (const k of Object.keys(val)) if (Array.isArray(val[k])) return val[k];
  }
  return [];
};

export default function InsidersPage() {
  const [insiders, setInsiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [search,  setSearch]  = useState('');
  const [sortBy,  setSortBy]  = useState(null);   // 'TICKER' | 'VALUE' | 'FILED' | null
  const [sortDir, setSortDir] = useState('asc');  // 'asc' | 'desc'
  const [lastUp, setLastUp] = useState(null);
  const NAV = ["Markets","News","Screener","Insiders","Politicians","Charts","Crypto"];
  const BUY_WORDS = new Set(['buy','buys','bought','purchase','purchased','acquisition','acquire']);

  const loadData = useCallback(async () => {
    setLoading(true);
    const raw = await fetchKey("insider_trades");
    const arr = toArr(raw, 'trades','insider_trades','insiders','filings','data');
    const mapped = arr.map(i => ({
      sym:   i.ticker   || i.symbol || i.sym  || '?',
      name:  decodeEntities(i.executive || i.name || i.insider || i.filer || ''),
      role:  decodeEntities(i.title || i.role || i.position || ''),
      type:  (() => {
        const a = (i.action || '').toUpperCase();
        if (a === 'BUY')  return 'BUY';
        if (a === 'SELL') return 'SELL';
        if (BUY_WORDS.has(a.toLowerCase())) return 'BUY';   // legacy Claude-data fallback
        return 'OTHER';
      })(),
      value:    fmtMoney(typeof i.totalValue === 'number' ? i.totalValue : (typeof i.value === 'number' ? i.value : 0)),
      valueNum: typeof i.totalValue === 'number' ? i.totalValue : (typeof i.value === 'number' ? i.value : 0),
      company: decodeEntities(i.company || i.name || ''),
      filed:    i.filingDate || i.date || i.filed || i.filing_date || '',
    }));
    setInsiders(mapped);
    setLastUp(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  // Filter (search → pill) then sort
  let filtered = insiders;
  const q = search.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(r =>
      (r.sym  || '').toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q)
    );
  }
  if (filter !== 'ALL') filtered = filtered.filter(r => r.type === filter);

  if (sortBy === 'TICKER') {
    filtered = [...filtered].sort((a, b) => {
      const cmp = (a.sym || '').localeCompare(b.sym || '');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  } else if (sortBy === 'FILED') {
    filtered = [...filtered].sort((a, b) => {
      const cmp = (a.filed || '').localeCompare(b.filed || '');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  } else if (sortBy === 'VALUE') {
    const nonZero = filtered.filter(r => r.valueNum > 0);
    const zero    = filtered.filter(r => !(r.valueNum > 0));
    nonZero.sort((a, b) =>
      sortDir === 'asc' ? a.valueNum - b.valueNum : b.valueNum - a.valueNum);
    filtered = [...nonZero, ...zero];
  }

  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}) : "--:--";
  const buys = insiders.filter(i=>i.type==='BUY').length;
  const sells = insiders.filter(i=>i.type==='SELL').length;

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif",background:C.bg,color:C.text,minHeight:"100vh"}}>
      <style>{`
        @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes cp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .hov:hover{background:${C.surface}!important}
        .nbtn{text-decoration:none}
        .nbtn:hover{color:#FFFFFF!important}
        .row-hov:hover{background:${C.surface}!important;cursor:pointer}
        *{box-sizing:border-box}
      `}</style>

      {/* NAV */}
      <div style={{background:C.navBg,height:50,display:"flex",alignItems:"center",
        justifyContent:"space-between",padding:"0 24px",position:"sticky",top:0,zIndex:100,
        borderBottom:"1px solid rgba(255,255,255,0.15)"}}>
        <a href="/" style={{textDecoration:"none"}}><Logo dark/></a>
        <div style={{display:"flex",gap:20,alignItems:"center",marginLeft:40,borderLeft:"1px solid rgba(255,255,255,0.2)",paddingLeft:40}}>
          {NAV.map(l=>(
            <a key={l} href={`/${l.toLowerCase()}`} className="nbtn" style={{fontSize:12,
              color:l==="Insiders"?"#FFFFFF":"rgba(255,255,255,0.75)",
              fontWeight:l==="Insiders"?600:400,letterSpacing:"0.02em",
              borderBottom:l==="Insiders"?"2px solid #5AB87A":"none",paddingBottom:l==="Insiders"?2:0,
              transition:"color 0.2s"}}>{l}</a>
          ))}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button style={{background:"transparent",border:"1px solid rgba(255,255,255,0.4)",color:"rgba(255,255,255,0.9)",
            padding:"6px 14px",borderRadius:5,fontSize:12,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:300}}>
            Log In
          </button>
          <button style={{background:C.green,border:"none",color:"#fff",padding:"7px 18px",borderRadius:5,
            fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
            Start Free
          </button>
        </div>
      </div>

      {/* PAGE HEADER */}
      <div style={{background:C.white,borderBottom:`1px solid ${C.border}`,padding:"20px 24px"}}>
        <div style={{maxWidth:1380,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:12}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <Dot/>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:C.muted,letterSpacing:"1px"}}>FORM 4 · SEC EDGAR · LIVE</span>
              </div>
              <h1 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:32,fontWeight:600,color:C.ink,margin:"0 0 4px",letterSpacing:"-0.5px"}}>
                Insider Trades
              </h1>
              <p style={{fontSize:13,color:C.muted,margin:0,fontWeight:300}}>
                Real-time Form 4 filings — when executives buy or sell their own company stock.
              </p>
            </div>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              {/* Stats */}
              <div style={{background:C.greenLight,border:`1px solid ${C.greenBorder}`,borderRadius:8,padding:"10px 18px",textAlign:"center"}}>
                <div className="cp-num" style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.green}}>{loading?'—':buys}</div>
                <div style={{fontSize:11,color:C.green,fontWeight:500}}>BUYS</div>
              </div>
              <div style={{background:C.redLight,border:`1px solid #E0AAAA`,borderRadius:8,padding:"10px 18px",textAlign:"center"}}>
                <div className="cp-num" style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.red}}>{loading?'—':sells}</div>
                <div style={{fontSize:11,color:C.red,fontWeight:500}}>SELLS</div>
              </div>
              <div className="cp-num" style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:C.dim}}>
                Updated {timeStr}
                <button onClick={loadData} style={{background:"transparent",border:"none",color:C.green,
                  cursor:"pointer",fontSize:12,marginLeft:8,fontFamily:"'DM Mono',monospace"}}>↻</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* FILTERS */}
      <div style={{maxWidth:1380,margin:"0 auto",padding:"16px 24px 0",
        display:"flex",flexDirection:"column",gap:12}}>
        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker or executive"
          style={{
            width:"100%", maxWidth:320,
            background:C.white, border:`1px solid ${C.border}`,
            color:C.text, padding:"8px 12px", borderRadius:5,
            fontSize:12, fontFamily:"'DM Sans',sans-serif", fontWeight:400,
            outline:"none",
          }}
        />
        {/* Pills + count */}
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {['ALL','BUY','SELL','OTHER'].map(f=>{
            const accent = f === 'OTHER' ? C.dim : C.green;
            return (
              <button key={f} onClick={()=>setFilter(f)} style={{
                background: filter===f ? accent : "transparent",
                border:`1px solid ${filter===f ? accent : C.border}`,
                color: filter===f ? "#fff" : C.muted,
                padding:"6px 16px",borderRadius:5,fontSize:12,cursor:"pointer",
                fontFamily:"'DM Mono',monospace",fontWeight:filter===f?500:400,
                transition:"all 0.15s"}}>
                {f}
              </button>
            );
          })}
          <span style={{fontSize:12,color:C.dim,fontFamily:"'DM Mono',monospace",marginLeft:8}}>
            {loading?'Loading…':`${filtered.length} filings`}
          </span>
        </div>
      </div>

      {/* MAIN TABLE */}
      <div style={{maxWidth:1380,margin:"16px auto",padding:"0 24px 40px"}}>
        <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead>
              <tr style={{background:C.surface,borderBottom:`1px solid ${C.border}`}}>
                {[
                  {label:"Ticker",    sortKey:"TICKER"},
                  {label:"Company",   sortKey:null},
                  {label:"Executive", sortKey:null},
                  {label:"Role",      sortKey:null},
                  {label:"Action",    sortKey:null},
                  {label:"Value",     sortKey:"VALUE", align:"right"},
                  {label:"Filed",     sortKey:"FILED"},
                ].map(h => {
                  const active = h.sortKey && sortBy === h.sortKey;
                  const arrow  = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
                  return (
                    <th key={h.label}
                      onClick={h.sortKey ? () => handleSort(h.sortKey) : undefined}
                      style={{
                        padding:"10px 16px", textAlign:h.align||"left",
                        fontFamily:"'DM Mono',monospace", fontSize:9,
                        color: active ? C.green : C.dim,
                        letterSpacing:"0.8px", fontWeight:400,
                        cursor: h.sortKey ? "pointer" : "default",
                        userSelect:"none",
                      }}>
                      {h.label.toUpperCase()}{arrow}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(8).fill(0).map((_,i)=>(
                  <tr key={i}><td colSpan={7} style={{padding:"12px 16px"}}><Skel h={16} mb={0}/></td></tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} style={{padding:"40px 16px",textAlign:"center",color:C.muted,fontSize:13}}>
                  No insider trades found. The cron may still be running — check back in a minute.
                </td></tr>
              ) : (
                filtered.map((ins,i)=>(
                  <tr key={i} className="row-hov" style={{
                    borderBottom:i<filtered.length-1?`1px solid ${C.surface}`:"none",
                    transition:"background 0.15s",
                    borderLeft:`3px solid ${actionStyles(ins.type).fg}`}}>
                    <td className="cp-tkr" style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:C.green}}>{ins.sym}</td>
                    <td style={{padding:"13px 16px",fontSize:13,color:C.text,fontWeight:400,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ins.company||ins.name}</td>
                    <td style={{padding:"13px 16px",fontSize:13,color:C.text,fontWeight:400}}>{ins.name}</td>
                    <td style={{padding:"13px 16px",fontSize:12,color:C.muted,fontWeight:300}}>{ins.role}</td>
                    <td style={{padding:"13px 16px"}}>
                      <span style={{fontSize:11,padding:"4px 10px",borderRadius:4,
                        fontFamily:"'DM Mono',monospace",fontWeight:600,letterSpacing:"0.5px",
                        background:actionStyles(ins.type).bg,
                        color:actionStyles(ins.type).fg}}>{ins.type}</span>
                    </td>
                    <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",
                      fontSize:14,fontWeight:700,color:actionStyles(ins.type).fg}}>{ins.value}</td>
                    <td className="cp-num" style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:11,color:C.dim,whiteSpace:"nowrap"}}>{ins.filed}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* INFO BOX */}
        <div style={{marginTop:16,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 20px",
          display:"flex",gap:16,alignItems:"flex-start"}}>
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
