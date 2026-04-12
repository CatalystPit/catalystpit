'use client'

import { useState, useEffect, useCallback, useRef } from "react";

const fl = document.createElement("link");
fl.rel = "stylesheet";
fl.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,600&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600;700&display=swap";
document.head.appendChild(fl);

const C = {
  bg:"#F5F6F3",white:"#FFFFFF",surface:"#F0F2EE",surface2:"#E8EAE5",
  border:"#E0E2DC",border2:"#C4C8BE",
  ink:"#0C1410",text:"#1A2018",muted:"#5A6458",dim:"#8A9088",hint:"#C0C4BC",
  green:"#1E5C38",greenMid:"#2A7848",greenLight:"#E8F5EE",greenBorder:"#A8CEB8",
  red:"#A83030",redLight:"#FAEAEA",gold:"#7A5818",
  blue:"#1A3A78",blueLight:"#E8F0FF",
  navBg:"#1E5C38",
};

const chgC  = (v) => (+v)>0 ? C.green : C.red;
const chgBg = (v) => (+v)>0 ? C.greenLight : C.redLight;
const fmt2  = n => typeof n==="number"?n.toFixed(2):String(n??"-");
const fmtP  = n => typeof n==="number"?`${n>0?"+":""}${n.toFixed(2)}%`:"-";
const timeAgo = m => typeof m==="number"?(m<60?`${m}m ago`:`${Math.floor(m/60)}h ago`):m||"Just now";

const TICKS = [
  {sym:"SPY",price:524.38,chg:1.2},{sym:"QQQ",price:441.90,chg:0.8},
  {sym:"NVDA",price:882.50,chg:2.4},{sym:"TSLA",price:174.20,chg:-0.6},
  {sym:"AAPL",price:192.10,chg:0.3},{sym:"META",price:503.10,chg:1.1},
  {sym:"BTC",price:68442,chg:3.1},{sym:"GLD",price:215.40,chg:0.5},
  {sym:"ES=F",price:5241.25,chg:0.9},{sym:"CL=F",price:83.20,chg:-0.4},
  {sym:"DJI",price:38547,chg:0.6},{sym:"VIX",price:18.30,chg:4.1},
];

const TAG={
  EARNINGS:{bg:"#E8F0FF",c:"#1A3A78"},FED:{bg:"#FFF6E8",c:"#7A5018"},
  MARKETS:{bg:C.greenLight,c:C.green},TECH:{bg:"#F0EAFF",c:"#4A2A90"},
  CRYPTO:{bg:C.redLight,c:C.red},"M&A":{bg:"#EAFFF2",c:"#1A5A30"},
  MACRO:{bg:"#E8F4FF",c:"#1A4060"},SEC:{bg:"#FFF8E8",c:"#7A5010"},
};

const CARD_COLORS = [
  ["#0C2A1A","#1A5A38"],["#1A0C2A","#5A1A88"],["#2A1A0C","#885A1A"],
  ["#0C1A2A","#1A5A88"],["#2A0C0C","#882A1A"],["#0C2A2A","#1A7A7A"],
];

// ── Fetch from KV cache ────────────────────────────────────────────────────
const fetchKey = async (key) => {
  try {
    const r = await fetch(`/api/claude?key=${key}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.data) return null;
    let val = d.data;
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch { return null; }
    }
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch { return null; }
    }
    return val;
  } catch { return null; }
};
// ── Map cache data to the shape the UI expects ─────────────────────────────
const fetchAll = async () => {
  try {
    const [stories, snapshot, tape, insiderData, politicianData, movingData] = await Promise.all([
      fetchKey("top_stories"),
      fetchKey("market_snapshot"),
      fetchKey("ticker_tape"),
      fetchKey("insider_trades"),
      fetchKey("politician_trades"),
      fetchKey("why_moving"),
    ]);

    // Map ticker_tape → {sym, price, chg}
    const tickers = Array.isArray(tape)
      ? tape.map(t => ({ sym: t.symbol, price: t.price, chg: t.changePct }))
      : TICKS;

    // Map top_stories → {headline, source, mins, tag, sym, chg, hot}
    const news = Array.isArray(stories)
      ? stories.map(s => ({
          headline: s.headline,
          source: s.source,
          mins: Math.floor(Math.random() * 45) + 1,
          tag: s.category || "MARKETS",
          sym: s.ticker || "SPY",
          chg: (Math.random() * 4 - 1).toFixed(2),
          hot: Math.random() > 0.7,
        }))
      : [];

    // Map why_moving → {sym, name, price, chg, why}
    const movers = Array.isArray(movingData)
      ? movingData.map(m => ({
          sym: m.ticker,
          name: m.company,
          price: m.price,
          chg: m.changePct,
          why: m.reason,
        }))
      : [];

    // Map insider_trades → {sym, name, role, type, value, filed}
    const insiders = Array.isArray(insiderData)
      ? insiderData.map(i => ({
          sym: i.ticker,
          name: i.executive,
          role: i.title,
          type: i.action === "Buy" ? "BUY" : "SELL",
          value: `$${(i.value / 1e6).toFixed(1)}M`,
          filed: i.date,
        }))
      : [];

    // Map politician_trades → {name, title, sym, action, value, filed}
    const politicians = Array.isArray(politicianData)
      ? politicianData.map(p => ({
          name: p.politician,
          title: `${p.party} · ${p.chamber}`,
          sym: p.ticker,
          action: p.action === "Purchase" ? "BUY" : "SELL",
          value: p.amount,
          filed: p.date,
        }))
      : [];

    // Market snapshot for spy_chg and vix
    const spy_chg = snapshot?.SPY?.changePct ?? 1.2;
    const vix = snapshot?.VIX?.price ?? 18.3;

    const chart_points = [420,422,418,425,430,428,435,440,438,445,450,448,455,460,458,465,470,468,472,475];

    return { tickers, news, movers, insiders, politicians, chart_points, spy_chg, vix };
  } catch {
    return null;
  }
};

// ── Live Chart ────────────────────────────────────────────────────────────────
function MiniLineChart({points=[], color=C.green}) {
  const ref=useRef(null);
  useEffect(()=>{
    if(!ref.current||!points.length)return;
    const canvas=ref.current;
    const ctx=canvas.getContext("2d");
    const w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);
    const min=Math.min(...points),max=Math.max(...points);
    const range=max-min||1;
    const px=(i)=>i*(w/(points.length-1));
    const py=(v)=>h-((v-min)/range)*(h-20)-10;
    ctx.beginPath();
    ctx.moveTo(px(0),py(points[0]));
    for(let i=1;i<points.length;i++) ctx.lineTo(px(i),py(points[i]));
    ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();
    ctx.lineTo(px(points.length-1),h);ctx.lineTo(0,h);ctx.closePath();
    ctx.fillStyle=color==="red"?"rgba(168,48,48,0.08)":"rgba(30,92,56,0.08)";
    ctx.fill();
    const lx=px(points.length-1),ly=py(points[points.length-1]);
    ctx.beginPath();ctx.arc(lx,ly,4,0,Math.PI*2);
    ctx.fillStyle=color;ctx.fill();
  },[points,color]);
  return <canvas ref={ref} width={280} height={80} style={{display:"block",width:"100%",height:80}}/>;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
const Skel=({w="100%",h=14,mb=6})=>(
  <div style={{width:w,height:h,borderRadius:3,marginBottom:mb,
    background:"linear-gradient(90deg,#E8EAE5 25%,#F0F2EE 50%,#E8EAE5 75%)",
    backgroundSize:"200% 100%",animation:"cp-shimmer 1.4s infinite"}}/>
);

const Dot=()=>(
  <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",
    background:C.green,animation:"cp-pulse 2s infinite",flexShrink:0}}/>
);

const Logo=({dark=false,size=1})=>(
  <div style={{lineHeight:1.05,cursor:"pointer"}}>
    <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:20*size,
      fontWeight:300,color:dark?"#FFFFFF":C.ink,letterSpacing:"0.04em"}}>Catalyst</span>
    <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:20*size,
      fontWeight:600,fontStyle:"italic",color:dark?"#5AB87A":C.green,letterSpacing:"0.02em"}}>Pit</span>
  </div>
);

const TagBadge=({tag,size="sm"})=>{
  const tc=TAG[tag]||{bg:C.greenLight,c:C.green};
  return <span style={{fontSize:size==="sm"?9:10,background:tc.bg,color:tc.c,
    padding:"2px 7px",borderRadius:3,letterSpacing:"0.5px",
    fontFamily:"'DM Mono',monospace",fontWeight:500,whiteSpace:"nowrap"}}>{tag}</span>;
};

function NewsPhotoCard({n, idx, large=false}) {
  const [bg1,bg2]=CARD_COLORS[idx%CARD_COLORS.length];
  const isUp=(+n.chg)>=0;
  return (
    <div className="card-hov" style={{background:C.white,border:`1px solid ${C.border}`,
      borderRadius:8,overflow:"hidden",cursor:"pointer",transition:"all 0.2s",height:"100%"}}>
      <div style={{height:large?160:120,background:`linear-gradient(135deg,${bg1},${bg2})`,
        position:"relative",overflow:"hidden",flexShrink:0}}>
        <svg width="100%" height="100%" style={{position:"absolute",inset:0,opacity:0.3}}>
          <polyline points="0,80 30,60 60,70 90,40 120,50 150,30 180,35 210,20 240,25 280,10"
            fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5"/>
          <polyline points="0,100 40,90 80,95 120,75 160,80 200,65 240,70 280,55"
            fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1"/>
        </svg>
        <div style={{position:"absolute",top:10,left:10,display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,fontWeight:500,
            color:"rgba(255,255,255,0.9)",background:"rgba(0,0,0,0.3)",
            padding:"3px 8px",borderRadius:4}}>{n.sym}</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,fontWeight:500,
            color:isUp?"#5AD87A":"#E87A7A",background:"rgba(0,0,0,0.3)",
            padding:"3px 8px",borderRadius:4}}>{fmtP(+n.chg)}</span>
        </div>
        <div style={{position:"absolute",bottom:10,right:10}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.6)",
            letterSpacing:"0.5px"}}>{n.source}</span>
        </div>
      </div>
      <div style={{padding:"12px 14px 14px"}}>
        <div style={{display:"flex",gap:6,marginBottom:7,alignItems:"center"}}>
          <TagBadge tag={n.tag}/>
          {n.hot&&<span style={{fontSize:9,background:"#FFF0EE",color:C.red,
            padding:"2px 6px",borderRadius:3,fontFamily:"'DM Mono',monospace",fontWeight:500}}>HOT</span>}
          <span style={{fontSize:10,color:C.dim,marginLeft:"auto",
            fontFamily:"'DM Mono',monospace"}}>{timeAgo(n.mins)}</span>
        </div>
        <div style={{fontSize:large?15:13,color:C.ink,lineHeight:1.5,
          fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>{n.headline}</div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
export default function CatalystPit() {
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [tickPos,setTickPos]=useState(0);
  const [email,setEmail]=useState("");
  const [toasted,setToasted]=useState(false);
  const [lastUp,setLastUp]=useState(null);
  const tickW=TICKS.length*158;
  const tickers=data?.tickers||TICKS;

  useEffect(()=>{
    const id=setInterval(()=>setTickPos(p=>p-1),26);
    return()=>clearInterval(id);
  },[]);

  const loadData=useCallback(async()=>{
    setLoading(true);
    const d=await fetchAll();
    if(d){setData(d);setLastUp(new Date());}
    setLoading(false);
  },[]);

  useEffect(()=>{
    loadData();
    const id=setInterval(loadData,15*60*1000);
    return()=>clearInterval(id);
  },[loadData]);

  const signup=()=>{
    if(!email||!email.includes("@"))return;
    setEmail("");setToasted(true);setTimeout(()=>setToasted(false),4000);
  };

  const news=data?.news||[];
  const movers=data?.movers||[];
  const insiders=data?.insiders||[];
  const politicians=data?.politicians||[];
  const chartPts=data?.chart_points||[420,422,418,425,430,428,435,440,438,445,450,448,455,460];
  const timeStr=lastUp?lastUp.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}):"--:--";

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif",background:C.bg,color:C.text,minHeight:"100vh"}}>
      <style>{`
        @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes cp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        @keyframes cp-fadeup{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .card-hov:hover{box-shadow:0 4px 20px rgba(0,0,0,0.1)!important;transform:translateY(-2px)!important;}
        .hov:hover{background:${C.surface}!important;cursor:pointer}
        .sym-lnk:hover{color:${C.green}!important;cursor:pointer}
        .nbtn:hover{color:#FFFFFF!important}
        input:focus{outline:none;border-color:${C.green}!important;box-shadow:0 0 0 3px ${C.greenLight}!important}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:${C.surface}}
        ::-webkit-scrollbar-thumb{background:${C.border2};border-radius:2px}
        *{box-sizing:border-box}
      `}</style>

      {/* TOAST */}
      <div style={{position:"fixed",bottom:24,left:"50%",
        transform:`translateX(-50%) translateY(${toasted?0:80}px)`,
        background:C.white,border:`1px solid ${C.greenBorder}`,padding:"13px 24px",
        borderRadius:10,fontSize:13,zIndex:999,transition:"transform 0.4s ease",
        boxShadow:"0 8px 40px rgba(0,0,0,0.12)",whiteSpace:"nowrap"}}>
        <span style={{color:C.green,fontWeight:600}}>You're in.</span> First brief arrives at 6 AM.
      </div>

      {/* ── TOP NAV ── */}
      <div style={{background:C.navBg,height:50,display:"flex",alignItems:"center",
        justifyContent:"space-between",padding:"0 24px",position:"sticky",top:0,zIndex:100,
        borderBottom:"1px solid rgba(255,255,255,0.15)"}}>
        <Logo dark/>
        <div style={{display:"flex",gap:20,alignItems:"center",marginLeft:40,borderLeft:`1px solid rgba(255,255,255,0.2)`,paddingLeft:40}}>
          {["Markets","News","Screener","Insiders","Politicians","Charts","Crypto"].map(l=>(
            <span key={l} className="nbtn" style={{fontSize:12,color:"rgba(255,255,255,0.75)",cursor:"pointer",
              transition:"color 0.2s",fontWeight:400,letterSpacing:"0.02em"}}>{l}</span>
          ))}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button style={{background:"transparent",border:"1px solid rgba(255,255,255,0.4)",color:"rgba(255,255,255,0.9)",
            padding:"6px 14px",borderRadius:5,fontSize:12,cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif",fontWeight:300}}
            onMouseEnter={e=>{e.currentTarget.style.color="#FFFFFF";}}
            onMouseLeave={e=>{e.currentTarget.style.color="rgba(255,255,255,0.75)";}}>
            Log In
          </button>
          <button style={{background:C.green,border:"none",color:"#fff",
            padding:"7px 18px",borderRadius:5,fontSize:12,fontWeight:500,
            cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}
            onMouseEnter={e=>e.currentTarget.style.background=C.greenMid}
            onMouseLeave={e=>e.currentTarget.style.background=C.green}>
            Start Free
          </button>
        </div>
      </div>

      {/* ── TICKER TAPE ── */}
      <div style={{background:C.white,borderBottom:`1px solid ${C.border}`,
        overflow:"hidden",padding:"7px 0",position:"sticky",top:50,zIndex:99}}>
        <div style={{display:"flex",transform:`translateX(${tickPos%tickW}px)`,
          whiteSpace:"nowrap",willChange:"transform"}}>
          {[...tickers,...tickers,...tickers].map((t,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:6,
              padding:"0 16px",borderRight:`1px solid ${C.border}`}}>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,
                color:C.muted,fontWeight:400}}>{t.sym}</span>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,
                color:C.ink,fontWeight:500}}>
                {t.sym==="BTC"||(t.price>1000)?(+t.price).toLocaleString():fmt2(+t.price)}</span>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,
                color:chgC(t.chg),background:chgBg(t.chg),
                padding:"1px 5px",borderRadius:3,fontWeight:600}}>
                {t.chg>0?"+":""}{fmt2(t.chg)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── HERO STRIP ── */}
      <div style={{background:C.white,borderBottom:`1px solid ${C.border}`,
        padding:"14px 24px"}}>
        <div style={{maxWidth:1380,margin:"0 auto",display:"flex",
          justifyContent:"space-between",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <div>
            <h1 style={{fontFamily:"'DM Sans',sans-serif",fontSize:22,fontWeight:700,
              color:C.ink,margin:"0 0 3px",letterSpacing:"-0.3px",lineHeight:1.2}}>
              Every catalyst. <span style={{color:C.green}}>Before the bell.</span>
            </h1>
            <p style={{fontSize:13,color:C.muted,margin:0,fontWeight:300}}>
              Live intelligence — insider trades, politician buys, breaking news, real-time charts.
            </p>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <div style={{display:"flex",background:C.white,border:`1px solid ${C.border2}`,
              borderRadius:7,overflow:"hidden"}}>
              <input value={email} onChange={e=>setEmail(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&signup()}
                placeholder="Email — free 6 AM brief"
                style={{background:"transparent",border:"none",color:C.text,
                  padding:"9px 14px",fontSize:13,fontFamily:"'DM Sans',sans-serif",
                  outline:"none",fontWeight:300,width:220}}/>
              <button onClick={signup} style={{background:C.green,border:"none",color:"#fff",
                padding:"9px 16px",fontSize:12,fontWeight:500,
                fontFamily:"'DM Sans',sans-serif",cursor:"pointer",whiteSpace:"nowrap"}}
                onMouseEnter={e=>e.currentTarget.style.background=C.greenMid}
                onMouseLeave={e=>e.currentTarget.style.background=C.green}>
                Get Free Access →
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── MAIN BODY ── */}
      <div style={{maxWidth:1380,margin:"0 auto",padding:"16px 24px",
        display:"grid",gridTemplateColumns:"1fr 300px",gap:16}}>

        {/* ── LEFT MAIN ── */}
        <div style={{display:"flex",flexDirection:"column",gap:16}}>

          {/* ── TOP STORIES ── */}
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,
              background:C.surface,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}>
                <Dot/>
                <span style={{fontSize:13,fontWeight:600,color:C.ink,letterSpacing:"-0.2px"}}>TOP STORIES</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,fontFamily:"'DM Mono',monospace",fontSize:10,color:C.dim}}>
                <Dot/>AI LIVE · {timeStr}
                <button onClick={loadData} style={{background:"transparent",border:"none",
                  color:C.muted,cursor:"pointer",fontSize:11,padding:"2px 6px",
                  borderRadius:4,fontFamily:"'DM Mono',monospace"}}
                  onMouseEnter={e=>{e.currentTarget.style.color=C.green;}}
                  onMouseLeave={e=>{e.currentTarget.style.color=C.muted;}}>↻</button>
              </div>
            </div>
            <div style={{padding:14}}>
              {loading ? (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  {Array(3).fill(0).map((_,i)=>(
                    <div key={i} style={{background:C.surface,borderRadius:8,overflow:"hidden"}}>
                      <Skel h={120} mb={0}/>
                      <div style={{padding:12}}><Skel w={60} h={9} mb={6}/><Skel h={14} mb={4}/><Skel w="80%" h={14} mb={0}/></div>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 1fr",gap:12,marginBottom:12}}>
                    {news.slice(0,3).map((n,i)=>(
                      <NewsPhotoCard key={i} n={n} idx={i} large={i===0}/>
                    ))}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                    {news.slice(3,6).map((n,i)=>(
                      <NewsPhotoCard key={i} n={n} idx={i+3}/>
                    ))}
                  </div>
                </>
              )}
              {!loading&&news.length>0&&(
                <div style={{marginTop:12,background:C.greenLight,
                  border:`1px solid ${C.greenBorder}`,borderRadius:7,
                  padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <span style={{fontSize:13,fontWeight:600,color:C.green}}>See all breaking news in real-time</span>
                    <span style={{fontSize:12,color:C.muted,fontWeight:300,marginLeft:8}}>Pro unlocks the full feed, updated every minute</span>
                  </div>
                  <button style={{background:C.green,border:"none",color:"#fff",
                    padding:"8px 18px",borderRadius:6,fontSize:12,fontWeight:500,
                    cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.greenMid}
                    onMouseLeave={e=>e.currentTarget.style.background=C.green}>
                    Unlock Pro — $29/mo
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── MARKETS PULSE ── */}
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,
              background:C.surface,display:"flex",alignItems:"center",gap:7}}>
              <Dot/>
              <span style={{fontSize:13,fontWeight:600,color:C.ink}}>MARKETS PULSE</span>
            </div>
            <div style={{padding:16}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
                {(data?.tickers||TICKS).slice(0,4).map((t,i)=>(
                  <div key={i} className="hov" style={{background:C.surface,borderRadius:7,
                    padding:"14px 14px",border:`1px solid ${C.border}`,cursor:"pointer",transition:"background 0.15s"}}>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:C.muted,marginBottom:5}}>{t.sym}</div>
                    {loading?<Skel h={26} mb={4}/>:<>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:22,fontWeight:600,
                        color:C.ink,marginBottom:4}}>
                        {t.sym==="BTC"||(+t.price>10000)?(+t.price).toLocaleString("en-US",{maximumFractionDigits:2}):fmt2(+t.price)}
                      </div>
                      <span style={{fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:600,
                        color:chgC(t.chg),background:chgBg(t.chg),padding:"2px 7px",borderRadius:3}}>
                        {t.chg>0?"▲":"▼"} {Math.abs(t.chg).toFixed(2)}%
                      </span>
                    </>}
                  </div>
                ))}
              </div>
              <div style={{background:C.surface,borderRadius:8,padding:"16px",
                border:`1px solid ${C.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:C.muted,letterSpacing:"1px"}}>SPY · TODAY</span>
                  <div style={{display:"flex",gap:4}}>
                    {["Day","Week","Month","Year"].map(t=>(
                      <button key={t} style={{background:t==="Day"?C.green:"transparent",
                        border:`1px solid ${t==="Day"?C.green:C.border}`,
                        color:t==="Day"?"#fff":C.muted,padding:"4px 10px",borderRadius:4,
                        fontSize:11,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",
                        fontWeight:t==="Day"?500:300,transition:"all 0.15s"}}>{t}</button>
                    ))}
                  </div>
                </div>
                <MiniLineChart points={chartPts} color={C.green}/>
              </div>
            </div>
          </div>

          {/* ── WHY IS IT MOVING ── */}
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,
              background:C.surface,display:"flex",alignItems:"center",gap:7}}>
              <Dot/>
              <span style={{fontSize:13,fontWeight:600,color:C.ink}}>WHY IS IT MOVING?</span>
            </div>
            <div>
              {loading?Array(4).fill(0).map((_,i)=>(
                <div key={i} style={{padding:"13px 16px",borderBottom:`1px solid ${C.surface}`,
                  display:"flex",gap:14,alignItems:"center"}}>
                  <Skel w={40} h={32} mb={0}/><div style={{flex:1}}><Skel h={14} mb={4}/><Skel w="60%" h={12} mb={0}/></div>
                </div>
              )):(movers).map((m,i)=>{
                const isUp=(+m.chg)>=0;
                const [bg1,bg2]=CARD_COLORS[i%CARD_COLORS.length];
                return(
                  <div key={i} className="hov" style={{padding:"12px 16px",
                    borderBottom:i<movers.length-1?`1px solid ${C.surface}`:"none",
                    display:"flex",gap:14,alignItems:"center",transition:"background 0.15s",cursor:"pointer"}}>
                    <div style={{width:44,height:44,borderRadius:8,flexShrink:0,
                      background:`linear-gradient(135deg,${bg1},${bg2})`,
                      display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,
                        fontWeight:600,color:"rgba(255,255,255,0.9)"}}>{m.sym}</span>
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:3,
                        fontFamily:"'DM Sans',sans-serif"}}>
                        Why Is {m.name} {isUp?"Surging":"Falling"} Today?
                      </div>
                      <div style={{fontSize:12,color:C.muted,fontWeight:300,
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.why}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:14,fontWeight:600,
                        color:chgC(m.chg),background:chgBg(m.chg),padding:"3px 8px",
                        borderRadius:4}}>{m.chg>0?"▲":"▼"} {Math.abs(+m.chg).toFixed(1)}%</div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,
                        color:C.dim,marginTop:3}}>{fmt2(+m.price)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── INSIDER TRADES ── */}
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,
              background:C.surface,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}>
                <Dot/>
                <span style={{fontSize:13,fontWeight:600,color:C.ink}}>INSIDER TRADES</span>
                <span style={{fontSize:9,background:"#FFF6E8",color:"#7A5018",
                  padding:"2px 7px",borderRadius:3,fontFamily:"'DM Mono',monospace",fontWeight:500}}>FORM 4 · SEC</span>
              </div>
            </div>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead>
                <tr style={{background:C.surface,borderBottom:`1px solid ${C.border}`}}>
                  {["Company","Executive","Role","Action","Value","Filed"].map(h=>(
                    <th key={h} style={{padding:"8px 16px",textAlign:h==="Value"?"right":"left",
                      fontFamily:"'DM Mono',monospace",fontSize:9,color:C.dim,
                      letterSpacing:"0.8px",fontWeight:400}}>{h.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading?Array(3).fill(0).map((_,i)=>(
                  <tr key={i}><td colSpan={6} style={{padding:"12px 16px"}}><Skel h={14} mb={0}/></td></tr>
                )):insiders.map((ins,i)=>(
                  <tr key={i} className="hov" style={{borderBottom:i<insiders.length-1?`1px solid ${C.surface}`:"none",
                    transition:"background 0.15s",cursor:"pointer",
                    borderLeft:`3px solid ${ins.type==="BUY"?C.green:C.red}`}}>
                    <td style={{padding:"11px 16px",fontFamily:"'DM Mono',monospace",
                      fontSize:13,fontWeight:600,color:C.green}} className="sym-lnk">{ins.sym}</td>
                    <td style={{padding:"11px 16px",fontSize:13,color:C.text,fontWeight:400}}>{ins.name}</td>
                    <td style={{padding:"11px 16px",fontSize:12,color:C.muted,fontWeight:300}}>{ins.role}</td>
                    <td style={{padding:"11px 16px"}}>
                      <span style={{fontSize:10,padding:"3px 9px",borderRadius:3,
                        fontFamily:"'DM Mono',monospace",fontWeight:600,
                        background:ins.type==="BUY"?C.greenLight:C.redLight,
                        color:ins.type==="BUY"?C.green:C.red}}>{ins.type}</span>
                    </td>
                    <td style={{padding:"11px 16px",textAlign:"right",fontFamily:"'DM Mono',monospace",
                      fontSize:14,fontWeight:700,color:ins.type==="BUY"?C.green:C.red}}>{ins.value}</td>
                    <td style={{padding:"11px 16px",fontFamily:"'DM Mono',monospace",fontSize:11,color:C.dim}}>{ins.filed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{position:"relative",overflow:"hidden"}}>
              {[1,2,3].map(i=>(
                <div key={i} style={{padding:"11px 16px",borderTop:`1px solid ${C.surface}`,
                  display:"flex",gap:16,filter:"blur(4px)",userSelect:"none",pointerEvents:"none",opacity:0.6}}>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:600,color:C.green,width:60}}>████</div>
                  <div style={{fontSize:13,color:C.text,flex:1}}>████████ ██████</div>
                  <div style={{fontSize:12,color:C.muted,width:80}}>███ ██████</div>
                  <div style={{width:60}}><span style={{background:C.greenLight,padding:"3px 9px",borderRadius:3,fontSize:10,color:C.green,fontFamily:"'DM Mono',monospace",fontWeight:600}}>BUY</span></div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:14,fontWeight:700,color:C.green,width:70,textAlign:"right"}}>$██.█M</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:C.dim,width:60}}>██h ago</div>
                </div>
              ))}
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
                justifyContent:"center",background:"rgba(248,250,247,0.7)"}}>
                <div style={{background:C.white,border:`1px solid ${C.greenBorder}`,
                  borderRadius:8,padding:"12px 20px",display:"flex",alignItems:"center",gap:12,
                  boxShadow:"0 4px 16px rgba(0,0,0,0.08)"}}>
                  <span style={{fontSize:16}}>🔒</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:2}}>Unlock All Insider Trades</div>
                    <div style={{fontSize:12,color:C.muted,fontWeight:300}}>Real-time Form 4 filings · Pro $29/mo</div>
                  </div>
                  <button style={{background:C.green,border:"none",color:"#fff",
                    padding:"8px 16px",borderRadius:6,fontSize:12,fontWeight:500,
                    cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.greenMid}
                    onMouseLeave={e=>e.currentTarget.style.background=C.green}>
                    Get Access
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── POLITICIAN TRADES ── */}
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,
              background:C.surface,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}>
                <Dot/>
                <span style={{fontSize:13,fontWeight:600,color:C.ink}}>POLITICIAN TRADES</span>
                <span style={{fontSize:9,background:"#E8F0FF",color:"#1A3A78",
                  padding:"2px 7px",borderRadius:3,fontFamily:"'DM Mono',monospace",fontWeight:500}}>STOCK ACT · LIVE</span>
              </div>
            </div>
            <div>
              {loading?Array(2).fill(0).map((_,i)=>(
                <div key={i} style={{padding:"13px 16px",borderBottom:`1px solid ${C.surface}`}}>
                  <Skel h={14} mb={5}/><Skel w="50%" h={12} mb={0}/>
                </div>
              )):politicians.map((p,i)=>(
                <div key={i} className="hov" style={{padding:"13px 16px",
                  borderBottom:i<politicians.length-1?`1px solid ${C.surface}`:"none",
                  display:"flex",justifyContent:"space-between",alignItems:"center",
                  transition:"background 0.15s",cursor:"pointer",
                  borderLeft:`3px solid ${p.action==="BUY"?C.green:C.red}`}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                      <span style={{fontSize:14,fontWeight:600,color:C.ink}}>{p.name}</span>
                      <span style={{fontSize:11,color:C.muted,fontWeight:300}}>{p.title}</span>
                      <span style={{fontSize:10,padding:"2px 8px",borderRadius:3,
                        fontFamily:"'DM Mono',monospace",fontWeight:600,
                        background:p.action==="BUY"?C.greenLight:C.redLight,
                        color:p.action==="BUY"?C.green:C.red}}>{p.action}</span>
                    </div>
                    <div style={{fontSize:12,color:C.muted,fontWeight:300}}>
                      <span style={{fontFamily:"'DM Mono',monospace",color:C.green,
                        fontWeight:600,marginRight:8}}>{p.sym}</span>{p.value}
                    </div>
                  </div>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,
                    color:C.dim,whiteSpace:"nowrap"}}>{p.filed}</span>
                </div>
              ))}
            </div>
            <div style={{position:"relative",overflow:"hidden"}}>
              {[1,2].map(i=>(
                <div key={i} style={{padding:"13px 16px",borderTop:`1px solid ${C.surface}`,
                  display:"flex",justifyContent:"space-between",
                  filter:"blur(4px)",userSelect:"none",pointerEvents:"none",opacity:0.6}}>
                  <div>
                    <div style={{display:"flex",gap:8,marginBottom:4}}>
                      <span style={{fontSize:14,fontWeight:600}}>████████ ██████</span>
                      <span style={{fontSize:11,color:C.muted}}>Sen.</span>
                      <span style={{background:C.greenLight,padding:"2px 8px",borderRadius:3,fontSize:10,color:C.green,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>BUY</span>
                    </div>
                    <div style={{fontSize:12,color:C.muted}}>████ · $██K-$███K</div>
                  </div>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:C.dim}}>█d ago</span>
                </div>
              ))}
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
                justifyContent:"center",background:"rgba(248,250,247,0.7)"}}>
                <div style={{background:C.white,border:`1px solid ${C.greenBorder}`,
                  borderRadius:8,padding:"12px 20px",display:"flex",alignItems:"center",gap:12,
                  boxShadow:"0 4px 16px rgba(0,0,0,0.08)"}}>
                  <span style={{fontSize:16}}>🏛</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:2}}>Track Every Politician Trade</div>
                    <div style={{fontSize:12,color:C.muted,fontWeight:300}}>The edge they don't want you to have</div>
                  </div>
                  <button style={{background:C.green,border:"none",color:"#fff",
                    padding:"8px 16px",borderRadius:6,fontSize:12,fontWeight:500,
                    cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.greenMid}
                    onMouseLeave={e=>e.currentTarget.style.background=C.green}>
                    Unlock Pro
                  </button>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* ── RIGHT SIDEBAR ── */}
        <div style={{display:"flex",flexDirection:"column",gap:14}}>

          <div style={{background:"#0C1410",borderRadius:8,padding:"18px",
            position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"#5AB87A"}}/>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#3A6A48",
              letterSpacing:"1.5px",marginBottom:8}}>THE CATALYST BRIEF</div>
            <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:19,fontWeight:300,
              color:"#FFFFFF",lineHeight:1.3,marginBottom:6}}>
              Your morning edge.<br/><em style={{color:"#5AB87A"}}>Delivered at 6 AM.</em>
            </div>
            <p style={{fontSize:12,color:"#3A5A42",fontWeight:300,lineHeight:1.7,marginBottom:12}}>
              Top movers, insider trades, politician buys, and one high-conviction idea.
            </p>
            <input value={email} onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&signup()}
              placeholder="Your email address"
              style={{width:"100%",background:"#1A2820",border:"1px solid #2A3A2E",
                color:"#FFFFFF",padding:"9px 12px",borderRadius:6,fontSize:12,
                fontFamily:"'DM Sans',sans-serif",outline:"none",fontWeight:300,marginBottom:6}}/>
            <button onClick={signup} style={{width:"100%",background:"#5AB87A",border:"none",
              color:"#fff",padding:"10px",borderRadius:6,fontSize:12,fontWeight:500,
              cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}
              onMouseEnter={e=>e.currentTarget.style.background="#4AA868"}
              onMouseLeave={e=>e.currentTarget.style.background="#5AB87A"}>
              Get Free Access →
            </button>
            <p style={{fontSize:10,color:"rgba(255,255,255,0.5)",marginTop:6,
              fontFamily:"'DM Mono',monospace",textAlign:"center"}}>Free forever · No credit card</p>
          </div>

          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}`,background:C.surface,
              display:"flex",alignItems:"center",gap:6}}>
              <Dot/>
              <span style={{fontSize:12,fontWeight:600,color:C.ink}}>MARKET SNAPSHOT</span>
            </div>
            {(data?.tickers||TICKS).map((t,i)=>(
              <div key={i} className="hov" style={{display:"flex",justifyContent:"space-between",
                alignItems:"center",padding:"9px 14px",
                borderBottom:i<(data?.tickers||TICKS).length-1?`1px solid ${C.surface}`:"none",
                transition:"background 0.15s",cursor:"pointer"}}>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,
                  fontWeight:600,color:C.ink}}>{t.sym}</span>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:C.text}}>
                    {t.sym==="BTC"||(+t.price>10000)?(+t.price).toLocaleString("en-US",{maximumFractionDigits:0}):fmt2(+t.price)}</span>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,fontWeight:600,
                    color:chgC(t.chg),background:chgBg(t.chg),
                    padding:"1px 5px",borderRadius:3}}>
                    {t.chg>0?"+":""}{fmt2(t.chg)}%</span>
                </div>
              </div>
            ))}
          </div>

          <div style={{background:C.greenLight,border:`1px solid ${C.greenBorder}`,
            borderRadius:8,padding:"16px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:C.green,
              letterSpacing:"1.5px",marginBottom:8}}>UNLOCK PRO — $29/MO</div>
            <ul style={{listStyle:"none",display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
              {["Full real-time news feed","All insider filings · live","Every politician trade","Full screener · 12 filters","Live charts · all timeframes","Options flow & dark pool","Daily 6 AM catalyst brief"].map(f=>(
                <li key={f} style={{fontSize:12,color:C.green,display:"flex",
                  gap:7,alignItems:"center",fontWeight:400}}>
                  <span style={{fontWeight:700,fontSize:10,color:C.green}}>✓</span>{f}
                </li>
              ))}
            </ul>
            <button style={{width:"100%",background:C.green,border:"none",color:"#fff",
              padding:"11px",borderRadius:6,fontSize:13,fontWeight:600,cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif"}}
              onMouseEnter={e=>e.currentTarget.style.background=C.greenMid}
              onMouseLeave={e=>e.currentTarget.style.background=C.green}>
              Start Pro — $29/mo
            </button>
            <p style={{fontSize:10,color:C.muted,textAlign:"center",marginTop:7,fontWeight:300}}>
              Cancel anytime · No contracts
            </p>
          </div>

          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
            <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}`,background:C.surface,
              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:12,fontWeight:600,color:C.ink}}>INSIDER ACTIVITY</span>
              <span style={{fontSize:11,color:C.green,cursor:"pointer",fontWeight:400}}>View All →</span>
            </div>
            {loading?Array(3).fill(0).map((_,i)=>(
              <div key={i} style={{padding:"10px 14px",borderBottom:`1px solid ${C.surface}`}}>
                <Skel w="70%" h={12} mb={4}/><Skel w="50%" h={10} mb={0}/>
              </div>
            )):insiders.map((ins,i)=>(
              <div key={i} className="hov" style={{padding:"10px 14px",
                borderBottom:`1px solid ${C.surface}`,transition:"background 0.15s",cursor:"pointer"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,
                      fontWeight:600,color:C.ink}}>{ins.sym}</span>
                    <span style={{fontSize:9,padding:"2px 6px",borderRadius:3,
                      fontFamily:"'DM Mono',monospace",fontWeight:600,
                      background:ins.type==="BUY"?C.greenLight:C.redLight,
                      color:ins.type==="BUY"?C.green:C.red}}>{ins.type}</span>
                  </div>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,fontWeight:700,
                    color:ins.type==="BUY"?C.green:C.red}}>{ins.value}</span>
                </div>
                <div style={{fontSize:11,color:C.muted,fontWeight:300}}>{ins.name} · {ins.filed}</div>
              </div>
            ))}
          </div>

        </div>
      </div>

      {/* ── FOOTER ── */}
      <div style={{background:C.navBg,marginTop:20,padding:"24px",
        display:"flex",justifyContent:"space-between",alignItems:"center",
        flexWrap:"wrap",gap:12}}>
        <Logo dark scale={0.85}/>
        <div style={{display:"flex",gap:24}}>
          {["Features","Pricing","Privacy","Terms","Contact"].map(l=>(
            <span key={l} style={{fontSize:12,color:"rgba(255,255,255,0.6)",cursor:"pointer",fontWeight:300}}
              onMouseEnter={e=>e.target.style.color="#FFFFFF"}
              onMouseLeave={e=>e.target.style.color="rgba(255,255,255,0.5)"}>{l}</span>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,
          fontFamily:"'DM Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.5)"}}>
          <Dot/>LIVE · AI POWERED · © 2025 CATALYSTPIT · NOT FINANCIAL ADVICE
        </div>
      </div>
    </div>
  );
}
