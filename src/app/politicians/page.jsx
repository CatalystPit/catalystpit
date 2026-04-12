'use client'
import { useState, useEffect, useCallback } from "react";

const C = {
  bg:"#F5F6F3",white:"#FFFFFF",surface:"#F0F2EE",border:"#E0E2DC",border2:"#C4C8BE",
  ink:"#0C1410",text:"#1A2018",muted:"#5A6458",dim:"#8A9088",
  green:"#1E5C38",greenMid:"#2A7848",greenLight:"#E8F5EE",greenBorder:"#A8CEB8",
  red:"#A83030",redLight:"#FAEAEA",navBg:"#1E5C38",
  blue:"#1A3A78",blueLight:"#E8F0FF",
};

const Dot = () => <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:C.green,animation:"cp-pulse 2s infinite",flexShrink:0}}/>;
const Skel = ({w="100%",h=14,mb=6}) => <div style={{width:w,height:h,borderRadius:3,marginBottom:mb,background:"linear-gradient(90deg,#E8EAE5 25%,#F0F2EE 50%,#E8EAE5 75%)",backgroundSize:"200% 100%",animation:"cp-shimmer 1.4s infinite"}}/>;

const Logo = ({dark=false}) => (
  <a href="/" style={{lineHeight:1.05,cursor:"pointer",textDecoration:"none"}}>
    <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:20,fontWeight:300,color:dark?"#FFFFFF":C.ink,letterSpacing:"0.04em"}}>Catalyst</span>
    <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:20,fontWeight:600,fontStyle:"italic",color:dark?"#5AB87A":C.green,letterSpacing:"0.02em"}}>Pit</span>
  </a>
);

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

export default function PoliticiansPage() {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [partyFilter, setPartyFilter] = useState('ALL');
  const [lastUp, setLastUp] = useState(null);
  const NAV = ["Markets","News","Screener","Insiders","Politicians","Charts","Crypto"];
  const BUY_WORDS = new Set(['buy','buys','bought','purchase','purchased']);

  const loadData = useCallback(async () => {
    if (!document.querySelector('link[data-cpfonts]')) {
      const fl = document.createElement("link");
      fl.rel = "stylesheet"; fl.setAttribute('data-cpfonts','1');
      fl.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,600&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600;700&display=swap";
      document.head.appendChild(fl);
    }
    setLoading(true);
    const raw = await fetchKey("politician_trades");
    const arr = toArr(raw, 'trades','politician_trades','politicians','disclosures','data');
    const mapped = arr.map(p => ({
      name:    p.politician||p.name||p.senator||p.representative||p.member||'',
      party:   p.party||p.affiliation||'',
      chamber: p.chamber||p.title||p.position||'',
      sym:     p.ticker||p.symbol||p.sym||p.stock||'?',
      company: p.company||'',
      action:  BUY_WORDS.has((p.action||p.transaction_type||p.type||'').toLowerCase()) ? 'BUY' : 'SELL',
      amount:  p.amount||p.value||p.range||p.transaction_amount||'',
      filed:   p.date||p.filed||p.disclosure_date||p.reported||p.transaction_date||'',
    }));
    setTrades(mapped);
    setLastUp(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  let filtered = trades;
  if (filter !== 'ALL') filtered = filtered.filter(t=>t.action===filter);
  if (partyFilter !== "ALL") filtered = filtered.filter(t=>t.party===partyFilter);
  filtered = filtered.slice(0,10);

  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}) : "--:--";
  const buys  = trades.filter(t=>t.action==='BUY').length;
  const sells = trades.filter(t=>t.action==='SELL').length;
  const dems  = trades.filter(t=>t.party==='D').length;
  const reps  = trades.filter(t=>t.party==='R').length;

  const partyColor = p => p==='D'?{bg:"#E8F0FF",c:C.blue}:p==='R'?{bg:C.redLight,c:C.red}:{bg:C.surface,c:C.muted};

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif",background:C.bg,color:C.text,minHeight:"100vh"}}>
      <style>{`
        @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes cp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .row-hov:hover{background:${C.surface}!important;cursor:pointer}
        .nbtn{text-decoration:none}
        .nbtn:hover{color:#FFFFFF!important}
        *{box-sizing:border-box}
      `}</style>

      {/* NAV */}
      <div style={{background:C.navBg,height:50,display:"flex",alignItems:"center",
        justifyContent:"space-between",padding:"0 24px",position:"sticky",top:0,zIndex:100,
        borderBottom:"1px solid rgba(255,255,255,0.15)"}}>
        <Logo dark/>
        <div style={{display:"flex",gap:20,alignItems:"center",marginLeft:40,borderLeft:"1px solid rgba(255,255,255,0.2)",paddingLeft:40}}>
          {NAV.map(l=>(
            <a key={l} href={`/${l.toLowerCase()}`} className="nbtn" style={{fontSize:12,
              color:l==="Politicians"?"#FFFFFF":"rgba(255,255,255,0.75)",
              fontWeight:l==="Politicians"?600:400,letterSpacing:"0.02em",
              borderBottom:l==="Politicians"?"2px solid #5AB87A":"none",paddingBottom:l==="Politicians"?2:0,
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
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:C.muted,letterSpacing:"1px"}}>STOCK ACT · CONGRESSIONAL DISCLOSURES · LIVE</span>
              </div>
              <h1 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:32,fontWeight:600,color:C.ink,margin:"0 0 4px",letterSpacing:"-0.5px"}}>
                Politician Trades
              </h1>
              <p style={{fontSize:13,color:C.muted,margin:0,fontWeight:300}}>
                Congressional stock trades disclosed under the STOCK Act — see what your representatives are buying.
              </p>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
              <div style={{background:C.greenLight,border:`1px solid ${C.greenBorder}`,borderRadius:8,padding:"10px 16px",textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.green}}>{loading?'—':buys}</div>
                <div style={{fontSize:11,color:C.green,fontWeight:500}}>PURCHASES</div>
              </div>
              <div style={{background:C.redLight,border:"1px solid #E0AAAA",borderRadius:8,padding:"10px 16px",textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.red}}>{loading?'—':sells}</div>
                <div style={{fontSize:11,color:C.red,fontWeight:500}}>SALES</div>
              </div>
              <div style={{background:C.blueLight,border:"1px solid #AABCE0",borderRadius:8,padding:"10px 16px",textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.blue}}>{loading?'—':dems}</div>
                <div style={{fontSize:11,color:C.blue,fontWeight:500}}>DEMS</div>
              </div>
              <div style={{background:C.redLight,border:"1px solid #E0AAAA",borderRadius:8,padding:"10px 16px",textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:20,fontWeight:600,color:C.red}}>{loading?'—':reps}</div>
                <div style={{fontSize:11,color:C.red,fontWeight:500}}>REPS</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* FILTERS */}
      <div style={{maxWidth:1380,margin:"0 auto",padding:"16px 24px 0",display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{display:"flex",gap:6}}>
          <span style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace",alignSelf:"center",marginRight:4}}>ACTION</span>
          {['ALL','BUY','SELL'].map(f=>(
            <button key={f} onClick={()=>setFilter(f)} style={{
              background:filter===f?C.green:"transparent",border:`1px solid ${filter===f?C.green:C.border}`,
              color:filter===f?"#fff":C.muted,padding:"5px 14px",borderRadius:5,fontSize:11,cursor:"pointer",
              fontFamily:"'DM Mono',monospace",transition:"all 0.15s"}}>{f}
            </button>
          ))}
        </div>
        <div style={{display:"flex",gap:6}}>
          <span style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace",alignSelf:"center",marginRight:4}}>PARTY</span>
          {[{v:'ALL',l:'ALL'},{v:'D',l:'DEM'},{v:'R',l:'REP'}].map(({v,l})=>(
            <button key={v} onClick={()=>setPartyFilter(v)} style={{
              background:partyFilter===v?(v==='D'?C.blue:v==='R'?C.red:C.green):"transparent",
              border:`1px solid ${partyFilter===v?(v==='D'?C.blue:v==='R'?C.red:C.green):C.border}`,
              color:partyFilter===v?"#fff":C.muted,padding:"5px 14px",borderRadius:5,fontSize:11,cursor:"pointer",
              fontFamily:"'DM Mono',monospace",transition:"all 0.15s"}}>{l}
            </button>
          ))}
        </div>
        <span style={{fontSize:12,color:C.dim,fontFamily:"'DM Mono',monospace",marginLeft:"auto"}}>
          {loading?'Loading…':`${filtered.length} trades · Updated ${timeStr}`}
          <button onClick={loadData} style={{background:"transparent",border:"none",color:C.green,cursor:"pointer",fontSize:12,marginLeft:8}}>↻</button>
        </span>
      </div>

      {/* MAIN TABLE */}
      <div style={{maxWidth:1380,margin:"16px auto",padding:"0 24px 40px"}}>
        <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead>
              <tr style={{background:C.surface,borderBottom:`1px solid ${C.border}`}}>
                {["Politician","Party","Chamber","Ticker","Company","Action","Amount","Disclosed"].map(h=>(
                  <th key={h} style={{padding:"10px 16px",textAlign:"left",fontFamily:"'DM Mono',monospace",
                    fontSize:9,color:C.dim,letterSpacing:"0.8px",fontWeight:400}}>{h.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(6).fill(0).map((_,i)=>(
                  <tr key={i}><td colSpan={8} style={{padding:"12px 16px"}}><Skel h={16} mb={0}/></td></tr>
                ))
              ) : filtered.length===0 ? (
                <tr><td colSpan={8} style={{padding:"40px 16px",textAlign:"center",color:C.muted,fontSize:13}}>
                  No politician trades found. Check back after the next data refresh.
                </td></tr>
              ) : (
                filtered.map((t,i)=>{
                  const pc = partyColor(t.party);
                  return (
                    <tr key={i} className="row-hov" style={{
                      borderBottom:i<filtered.length-1?`1px solid ${C.surface}`:"none",
                      transition:"background 0.15s",
                      borderLeft:`3px solid ${t.action==="BUY"?C.green:C.red}`}}>
                      <td style={{padding:"13px 16px",fontSize:13,fontWeight:600,color:C.ink}}>{t.name}</td>
                      <td style={{padding:"13px 16px"}}>
                        <span style={{fontSize:10,padding:"3px 8px",borderRadius:3,
                          fontFamily:"'DM Mono',monospace",fontWeight:600,background:pc.bg,color:pc.c}}>
                          {t.party||'?'}
                        </span>
                      </td>
                      <td style={{padding:"13px 16px",fontSize:12,color:C.muted,fontWeight:300}}>{t.chamber}</td>
                      <td style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:C.green}}>{t.sym}</td>
                      <td style={{padding:"13px 16px",fontSize:12,color:C.text,fontWeight:300,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.company}</td>
                      <td style={{padding:"13px 16px"}}>
                        <span style={{fontSize:11,padding:"4px 10px",borderRadius:4,
                          fontFamily:"'DM Mono',monospace",fontWeight:600,
                          background:t.action==="BUY"?C.greenLight:C.redLight,
                          color:t.action==="BUY"?C.green:C.red}}>{t.action}</span>
                      </td>
                      <td style={{padding:"13px 16px",fontSize:13,color:C.text,fontFamily:"'DM Mono',monospace"}}>{t.amount}</td>
                      <td style={{padding:"13px 16px",fontFamily:"'DM Mono',monospace",fontSize:11,color:C.dim,whiteSpace:"nowrap"}}>{t.filed}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* INFO BOX */}
        <div style={{marginTop:16,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 20px",
          display:"flex",gap:16,alignItems:"flex-start"}}>
          <span style={{fontSize:18,flexShrink:0}}>🏛</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:4}}>About the STOCK Act</div>
            <div style={{fontSize:12,color:C.muted,fontWeight:300,lineHeight:1.6}}>
              The Stop Trading on Congressional Knowledge (STOCK) Act requires members of Congress, their staff, and executive branch officials 
              to disclose stock trades within 45 days. This data is derived from official congressional disclosure filings. 
              Trading on material non-public information obtained through official duties is prohibited. This is not financial advice.
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div style={{background:C.navBg,padding:"24px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <Logo dark/>
        <div style={{display:"flex",gap:24}}>
          {["Features","Pricing","Privacy","Terms","Contact"].map(l=>(
            <span key={l} style={{fontSize:12,color:"rgba(255,255,255,0.6)",cursor:"pointer",fontWeight:300}}>{l}</span>
          ))}
        </div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.5)",display:"flex",gap:6,alignItems:"center"}}>
          <Dot/>LIVE · 2026 CATALYSTPIT · NOT FINANCIAL ADVICE
        </div>
      </div>
    </div>
  );
}
