'use client'
import { useState, useEffect, useCallback } from "react";
import { Footer, TopNav } from '../../lib/cp-shared';
import { useRouter } from 'next/navigation';

const C = {
  bg:"#F5F6F3",white:"#FFFFFF",surface:"#F0F2EE",border:"#E0E2DC",border2:"#C4C8BE",
  ink:"#0C1410",text:"#1A2018",muted:"#5A6458",dim:"#8A9088",
  green:"#1E5C38",greenMid:"#2A7848",greenLight:"#E8F5EE",greenBorder:"#A8CEB8",
  red:"#A83030",redLight:"#FAEAEA",navBg:"#1E5C38",
};

const Dot = () => <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:C.green,animation:"cp-pulse 2s infinite",flexShrink:0}}/>;
const Skel = ({w="100%",h=14,mb=6}) => <div style={{width:w,height:h,borderRadius:3,marginBottom:mb,background:"linear-gradient(90deg,#E8EAE5 25%,#F0F2EE 50%,#E8EAE5 75%)",backgroundSize:"200% 100%",animation:"cp-shimmer 1.4s infinite"}}/>;

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
const mapRow = (r) => ({
  sym:      r.ticker || '?',
  name:     decodeEntities(r.executive || ''),
  role:     decodeEntities(r.title || ''),
  type:     r.action === 'BUY' ? 'BUY' : r.action === 'SELL' ? 'SELL' : 'OTHER',
  value:    fmtMoney(r.totalValue),
  valueNum: typeof r.totalValue === 'number' ? r.totalValue : 0,
  shares:   typeof r.shares === 'number' ? r.shares : 0,
  avgPrice: typeof r.pricePerShare === 'number' ? r.pricePerShare : 0,
  company:  decodeEntities(r.company || ''),
  filed:    r.filingDate || '',
});

const CATEGORIES = [
  { key:'buying',       label:'INSIDER BUYING',  sub:'open-market buys' },
  { key:'selling',      label:'INSIDER SELLING', sub:'open-market sells' },
  { key:'ceo',          label:'CEO PURCHASES',   sub:'chief-exec buys' },
  { key:'cluster_buys', label:'CLUSTER BUYS',    sub:'3+ insiders · 30d' },
  { key:'top',          label:'TOP TRADES',      sub:'largest by value' },
  { key:'significant',  label:'SIGNIFICANT',     sub:'$1M+ · recent' },
  { key:'latest',       label:'LATEST FILINGS',  sub:'most recent' },
  { key:'trends',       label:'TRENDS',          sub:'90d sentiment' },
];
const VIEW_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

// Diverging sentiment bars — buys up/green, sells down/red. No charting lib.
function SentimentChart({ data }) {
  const days = data || [];
  if (!days.length) return <div style={{fontSize:12,color:C.dim,fontFamily:"'DM Mono',monospace"}}>No sentiment data.</div>;
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

export default function InsidersPage() {
  const [data, setData] = useState(null);          // raw API payload (view-shaped)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeView, setActiveView] = useState('latest');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy,  setSortBy]  = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [lastUp, setLastUp] = useState(null);
  const router = useRouter();
  const goTicker = (sym) => { if (sym && sym !== '?') router.push(`/ticker/${encodeURIComponent(sym)}`); };

  const loadData = useCallback(async ({ view, ticker }) => {
    setLoading(true);
    setError(null);
    try {
      const url = ticker
        ? `/api/insiders?ticker=${encodeURIComponent(ticker)}&limit=200`
        : `/api/insiders?view=${view}&limit=200`;
      const res = await fetch(url);
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
  }, []);

  // Debounce raw search → debouncedSearch
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toUpperCase()), 400);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch: ticker search overrides the active category view
  useEffect(() => {
    if (debouncedSearch) loadData({ ticker: debouncedSearch });
    else                 loadData({ view: activeView });
  }, [debouncedSearch, activeView, loadData]);

  const selectView = (key) => { setSearch(''); setDebouncedSearch(''); setActiveView(key); };
  const clearSearch = () => { setSearch(''); setDebouncedSearch(''); };
  const refresh = () => { debouncedSearch ? loadData({ ticker: debouncedSearch }) : loadData({ view: activeView }); };
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

  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}) : "--:--";
  const buys  = isTradeView ? rows.filter(i=>i.type==='BUY').length  : 0;
  const sells = isTradeView ? rows.filter(i=>i.type==='SELL').length : 0;

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif",background:C.bg,color:C.text,minHeight:"100vh"}}>
      <style>{`
        @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes cp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .nbtn{text-decoration:none}.nbtn:hover{color:#FFFFFF!important}
        .row-hov:hover{background:${C.surface}!important;cursor:pointer}
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
              <Dot/><span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:C.muted,letterSpacing:"1px"}}>FORM 4 · SEC EDGAR · LIVE</span>
            </div>
            <h1 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:32,fontWeight:600,color:C.ink,margin:"0 0 4px",letterSpacing:"-0.5px"}}>Insider Trades</h1>
            <p style={{fontSize:13,color:C.muted,margin:0,fontWeight:300}}>Real-time Form 4 filings — when executives buy or sell their own company stock.</p>
          </div>
          <div style={{display:"flex",gap:12,alignItems:"center"}}>
            {isTradeView && (
              <>
                <div style={{background:C.greenLight,border:`1px solid ${C.greenBorder}`,borderRadius:8,padding:"10px 18px",textAlign:"center"}}>
                  <div className="cp-num" style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.green}}>{loading?'—':buys}</div>
                  <div style={{fontSize:11,color:C.green,fontWeight:500}}>BUYS</div>
                </div>
                <div style={{background:C.redLight,border:`1px solid #E0AAAA`,borderRadius:8,padding:"10px 18px",textAlign:"center"}}>
                  <div className="cp-num" style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.red}}>{loading?'—':sells}</div>
                  <div style={{fontSize:11,color:C.red,fontWeight:500}}>SELLS</div>
                </div>
              </>
            )}
            <div className="cp-num" style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:C.dim}}>
              Updated {timeStr}
              <button onClick={refresh} style={{background:"transparent",border:"none",color:C.green,cursor:"pointer",fontSize:12,marginLeft:8,fontFamily:"'DM Mono',monospace"}}>↻</button>
            </div>
          </div>
        </div>
      </div>

      {/* CONTROLS: search + category grid */}
      <div style={{maxWidth:1380,margin:"0 auto",padding:"16px 24px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <input value={search} onChange={(e)=>setSearch(e.target.value)} onKeyDown={onSearchKeyDown}
            placeholder="Search ticker (e.g., AAPL)"
            style={{width:"100%",maxWidth:320,background:C.white,border:`1px solid ${C.border}`,color:C.text,padding:"8px 12px",borderRadius:5,fontSize:12,fontFamily:"'DM Sans',sans-serif",outline:"none"}}/>
          {searching && (
            <span style={{display:"inline-flex",alignItems:"center",gap:8,background:C.greenLight,border:`1px solid ${C.greenBorder}`,borderRadius:5,padding:"6px 12px",fontFamily:"'DM Mono',monospace",fontSize:12,color:C.green}}>
              {debouncedSearch}
              <button onClick={clearSearch} style={{background:"transparent",border:"none",color:C.green,cursor:"pointer",fontWeight:700}}>✕</button>
              <span style={{color:C.muted,fontWeight:400}}>back to {VIEW_LABEL[activeView]}</span>
            </span>
          )}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10}}>
          {CATEGORIES.map(cat => {
            const active = !searching && activeView === cat.key;
            return (
              <button key={cat.key} className="cat" onClick={()=>selectView(cat.key)}
                style={{textAlign:"left",background:active?C.green:C.white,border:`1px solid ${active?C.green:C.border}`,borderRadius:8,padding:"12px 14px",cursor:"pointer",transition:"all 0.15s"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:12,fontWeight:600,letterSpacing:"0.5px",color:active?"#fff":C.ink}}>{cat.label}</div>
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
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:C.dim}}>
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
                    <span className="cp-tkr" style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:C.green,minWidth:64}}>{t.ticker}</span>
                    <span style={{fontSize:12,color:C.muted,maxWidth:320,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{decodeEntities(t.company||'')}</span>
                  </div>
                  <div className="cp-num" style={{fontFamily:"'DM Mono',monospace",fontSize:12}}>
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
                  <th key={h} style={{padding:"10px 16px",textAlign:i>=2&&i<=4?"right":"left",fontFamily:"'DM Mono',monospace",fontSize:9,color:C.dim,letterSpacing:"0.8px",fontWeight:400}}>{h.toUpperCase()}</th>
                ))}
              </tr></thead>
              <tbody>
                {(data.clusters||[]).length===0 ? (
                  <tr><td colSpan={6} style={{padding:"40px 16px",textAlign:"center",color:C.muted,fontSize:13}}>No clusters (3+ insiders buying the same ticker within 30 days) right now.</td></tr>
                ) : data.clusters.map((c,i)=>(
                  <tr key={i} className="row-hov" onClick={()=>goTicker(c.ticker)} style={{borderBottom:i<data.clusters.length-1?`1px solid ${C.surface}`:"none",borderLeft:`3px solid ${C.green}`}}>
                    <td className="cp-tkr" style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:C.green}}>{c.ticker}</td>
                    <td style={{padding:"13px 16px",fontSize:13,color:C.text,maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{decodeEntities(c.company||'')}</td>
                    <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontSize:14,fontWeight:700,color:C.green}}>{c.buyers}</td>
                    <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontSize:13,color:C.text}}>{c.trades}</td>
                    <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:600,color:C.text}}>{fmtMoney(c.totalValue)}</td>
                    <td className="cp-num" style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:11,color:C.dim,whiteSpace:"nowrap"}}>{c.firstBuy} → {c.lastBuy}</td>
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
                    {label:"Date",sortKey:"DATE"},{label:"Ticker",sortKey:"TICKER"},{label:"Company",sortKey:null},
                    {label:"Insider",sortKey:null},{label:"Type",sortKey:null},{label:"Shares",sortKey:"SHARES",align:"right"},
                    {label:"Avg Price",sortKey:null,align:"right"},{label:"Value",sortKey:"VALUE",align:"right"},
                  ].map(h=>{
                    const active=h.sortKey&&sortBy===h.sortKey;const arrow=active?(sortDir==='asc'?' ↑':' ↓'):'';
                    return <th key={h.label} onClick={h.sortKey?()=>handleSort(h.sortKey):undefined} style={{padding:"10px 16px",textAlign:h.align||"left",fontFamily:"'DM Mono',monospace",fontSize:9,color:active?C.green:C.dim,letterSpacing:"0.8px",fontWeight:400,cursor:h.sortKey?"pointer":"default",userSelect:"none"}}>{h.label.toUpperCase()}{arrow}</th>;
                  })}
                </tr></thead>
                <tbody>
                  {rows.length===0 ? (
                    <tr><td colSpan={8} style={{padding:"40px 16px",textAlign:"center",color:C.muted,fontSize:13}}>{searching?`No insider trades found for ${debouncedSearch}.`:'No insider trades in this view.'}</td></tr>
                  ) : rows.map((ins,i)=>(
                    <tr key={i} className="row-hov" onClick={()=>goTicker(ins.sym)} style={{borderBottom:i<rows.length-1?`1px solid ${C.surface}`:"none",borderLeft:`3px solid ${actionStyles(ins.type).fg}`}}>
                      <td className="cp-num" style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:11,color:C.dim,whiteSpace:"nowrap"}}>{ins.filed}</td>
                      <td className="cp-tkr" style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:C.green}}>{ins.sym}</td>
                      <td style={{padding:"13px 16px",fontSize:13,color:C.text,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ins.company}</td>
                      <td style={{padding:"13px 16px",fontSize:13,color:C.text}}>
                        <div>{ins.name}</div>
                        {ins.role && <div style={{fontSize:11,color:C.muted,fontWeight:300,marginTop:2}}>{ins.role}</div>}
                      </td>
                      <td style={{padding:"13px 16px"}}>
                        <span style={{fontSize:11,padding:"4px 10px",borderRadius:4,fontFamily:"'DM Mono',monospace",fontWeight:600,letterSpacing:"0.5px",background:actionStyles(ins.type).bg,color:actionStyles(ins.type).fg}}>{ins.type}</span>
                      </td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:500,color:C.text,whiteSpace:"nowrap"}}>{ins.shares>0?ins.shares.toLocaleString('en-US'):'—'}</td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:500,color:C.muted,whiteSpace:"nowrap"}}>{fmtPrice(ins.avgPrice)}</td>
                      <td className="cp-num" style={{padding:"13px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontSize:14,fontWeight:700,color:actionStyles(ins.type).fg}}>{ins.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
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
