'use client'

import { useState, useEffect, useCallback } from "react";
import {
  C, CARD_COLORS, TICKS,
  chgC, chgBg, fmt2, safeN, minsSince,
  fetchKey, toArr,
  BrandStyles, Skel, Dot, MiniLineChart, NewsPhotoCard,
  TopNav, TickerTape, Footer, MarketSnapshotCard, CatalystBriefCard,
} from "../lib/cp-shared";

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

    const tapeArr = toArr(tape, 'tickers', 'ticker_tape', 'data');
    const tickers = tapeArr.length > 0
      ? tapeArr.map(t => ({
          sym: t.symbol || t.sym || t.ticker || '?',
          price: safeN(t.price ?? t.last ?? t.close ?? t.current_price ?? t.regularMarketPrice),
          chg: safeN(t.changePct ?? t.change_pct ?? t.pct_change ?? t.chg ?? t.changePercent ?? t.percentChange),
        }))
      : TICKS;

    const storiesArr = toArr(stories, 'stories', 'top_stories', 'articles', 'items', 'data');
    const news = storiesArr.map(s => ({
      headline: s.title || s.headline || s.summary || s.description || '',
      source:   s.source || s.outlet || s.publisher || 'Market News',
      mins:     minsSince(s.published || s.published_at || s.date || s.pubDate),
      tag:      (s.category || s.tag || s.sector || 'MARKETS').toUpperCase(),
      sym:      (s.ticker && s.ticker !== 'N/A' && s.ticker !== 'null') ? s.ticker : (s.symbol || s.sym || null),
      summary:  s.summary || s.description || '',
      imageUrl: s.image_url || s.imageUrl || s.image || s.thumbnail || s.photo_url || null,
      url:      s.url || null,
    }));

    const moversArr = toArr(movingData, 'movers', 'why_moving', 'stocks', 'moves', 'data');
    const movers = moversArr.map(m => ({
      sym:  m.ticker  || m.symbol || m.sym  || '?',
      name: m.company || m.name   || m.company_name || m.sym || m.ticker || '',
      price: safeN(m.price ?? m.last ?? m.current_price),
      chg: safeN(m.changePct ?? m.change_pct ?? m.pct_change ?? m.chg ?? m.changePercent ?? m.percentChange),
      why: m.reason || m.why || m.explanation || m.catalyst || m.summary || '',
    }));

    const insidersArr = toArr(insiderData, 'trades', 'insider_trades', 'insiders', 'filings', 'data');
    const BUY_WORDS = new Set(['buy','buys','bought','purchase','purchased','acquisition','acquire']);
    const insiders = insidersArr.map(i => ({
      sym:  i.ticker   || i.symbol || i.sym  || '?',
      name: i.executive || i.name  || i.insider || i.filer || '',
      role: i.title    || i.role   || i.position || i.relationship || '',
      type: BUY_WORDS.has((i.action || i.transaction_type || '').toLowerCase()) ? 'BUY' : 'SELL',
      value: typeof i.value === 'number'
        ? `$${(i.value / 1e6).toFixed(1)}M`
        : (i.value || i.amount || i.transaction_value || ''),
      filed: i.date || i.filed || i.filing_date || i.reported || '',
    }));

    const polArr = toArr(politicianData, 'trades', 'politician_trades', 'politicians', 'disclosures', 'data');
    const politicians = polArr.map(p => {
      const party   = p.party   || p.affiliation || '';
      const chamber = p.chamber || p.title       || p.position || '';
      return {
        name: p.politician || p.name || p.senator || p.representative || p.member || '',
        title: [party, chamber].filter(Boolean).join(' · '),
        sym: p.ticker || p.symbol || p.sym || p.stock || '?',
        action: BUY_WORDS.has((p.action || p.transaction_type || p.type || '').toLowerCase()) ? 'BUY' : 'SELL',
        value: p.amount || p.value || p.range || p.transaction_amount || '',
        filed: p.date || p.filed || p.disclosure_date || p.reported || p.transaction_date || '',
      };
    });

    const spy_chg = safeN(snapshot?.SPY?.changePct ?? snapshot?.SPY?.chg ?? snapshot?.SPY?.change_pct ?? 1.2);
    const vix     = safeN(snapshot?.VIX?.price ?? snapshot?.VIX?.last ?? 18.3);
    const chart_points = [420,422,418,425,430,428,435,440,438,445,450,448,455,460,458,465,470,468,472,475];

    return { tickers, news, movers, insiders, politicians, chart_points, spy_chg, vix };
  } catch (e) {
    console.error('[CatalystPit] fetchAll error:', e);
    return null;
  }
};

export default function CatalystPit() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [toasted, setToasted] = useState(false);
  const [lastUp, setLastUp] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const d = await fetchAll();
    if (d) { setData(d); setLastUp(new Date()); }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadData]);

  const signup = () => {
    if (!email || !email.includes("@")) return;
    setEmail(""); setToasted(true); setTimeout(() => setToasted(false), 4000);
  };

  const news = data?.news || [];
  const movers = data?.movers || [];
  const insiders = data?.insiders || [];
  const politicians = data?.politicians || [];
  const chartPts = data?.chart_points || [420,422,418,425,430,428,435,440,438,445,450,448,455,460];
  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit"}) : "--:--";

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif", background:C.bg, color:C.text, minHeight:"100vh"}}>
      <BrandStyles/>

      {/* Hero signup toast */}
      <div style={{position:"fixed", bottom:24, left:"50%",
        transform:`translateX(-50%) translateY(${toasted?0:80}px)`,
        background:C.white, border:`1px solid ${C.greenBorder}`, padding:"13px 24px",
        borderRadius:10, fontSize:13, zIndex:999, transition:"transform 0.4s ease",
        boxShadow:"0 8px 40px rgba(0,0,0,0.12)", whiteSpace:"nowrap"}}>
        <span style={{color:C.green, fontWeight:600}}>You're in.</span> First brief arrives at 6 AM.
      </div>

      <TopNav/>
      <TickerTape tickers={data?.tickers}/>

      {/* HERO STRIP */}
      <div style={{background:C.white, borderBottom:`1px solid ${C.border}`, padding:"14px 24px"}}>
        <div style={{maxWidth:1380, margin:"0 auto", display:"flex",
          justifyContent:"space-between", alignItems:"center", gap:16, flexWrap:"wrap"}}>
          <div>
            <h1 style={{fontFamily:"'DM Sans',sans-serif", fontSize:22, fontWeight:700,
              color:C.ink, margin:"0 0 3px", letterSpacing:"-0.3px", lineHeight:1.2}}>
              Every catalyst. <span style={{color:C.green}}>Before the bell.</span>
            </h1>
            <p style={{fontSize:13, color:C.muted, margin:0, fontWeight:300}}>
              Live intelligence — insider trades, politician buys, breaking news, real-time charts.
            </p>
          </div>
          <div style={{display:"flex", gap:8, alignItems:"center"}}>
            <div style={{display:"flex", background:C.white, border:`1px solid ${C.border2}`,
              borderRadius:7, overflow:"hidden"}}>
              <input value={email} onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === "Enter" && signup()}
                placeholder="Email — free 6 AM brief"
                style={{background:"transparent", border:"none", color:C.text,
                  padding:"9px 14px", fontSize:13, fontFamily:"'DM Sans',sans-serif",
                  outline:"none", fontWeight:300, width:220}}/>
              <button onClick={signup} style={{background:C.green, border:"none", color:"#fff",
                padding:"9px 16px", fontSize:12, fontWeight:500,
                fontFamily:"'DM Sans',sans-serif", cursor:"pointer", whiteSpace:"nowrap"}}
                onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
                onMouseLeave={e => e.currentTarget.style.background = C.green}>
                Get Free Access →
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MAIN BODY */}
      <div style={{maxWidth:1380, margin:"0 auto", padding:"16px 24px",
        display:"grid", gridTemplateColumns:"1fr 300px", gap:16}}>

        {/* LEFT */}
        <div style={{display:"flex", flexDirection:"column", gap:16}}>

          {/* TOP STORIES */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <div style={{display:"flex", alignItems:"center", gap:7}}>
                <Dot/>
                <span style={{fontSize:13, fontWeight:600, color:C.ink, letterSpacing:"-0.2px"}}>TOP STORIES</span>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6,
                fontFamily:"'DM Mono',monospace", fontSize:10, color:C.dim}}>
                <Dot/>AI LIVE · {timeStr}
                <button onClick={loadData} style={{background:"transparent", border:"none",
                  color:C.muted, cursor:"pointer", fontSize:11, padding:"2px 6px",
                  borderRadius:4, fontFamily:"'DM Mono',monospace"}}
                  onMouseEnter={e => { e.currentTarget.style.color = C.green; }}
                  onMouseLeave={e => { e.currentTarget.style.color = C.muted; }}>↻</button>
              </div>
            </div>
            <div style={{padding:14}}>
              {loading ? (
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10}}>
                  {Array(4).fill(0).map((_, i) => (
                    <div key={i} style={{background:C.surface, borderRadius:8, overflow:"hidden"}}>
                      <Skel h={110} mb={0}/>
                      <div style={{padding:10}}>
                        <Skel w={60} h={9} mb={5}/>
                        <Skel h={13} mb={3}/>
                        <Skel w="75%" h={13} mb={0}/>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div style={{marginBottom:12}}>
                    {news.slice(0, 1).map((n, i) => (
                      <NewsPhotoCard key={i} n={n} idx={0} hero/>
                    ))}
                  </div>
                  <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12}}>
                    {Array.from({length:4}, (_, i) => news[1 + i] || news[i % Math.min(1, news.length)])
                      .filter(Boolean).map((n, i) => (
                      <NewsPhotoCard key={i} n={n} idx={i + 1}/>
                    ))}
                  </div>
                </>
              )}
              {!loading && news.length > 0 && (
                <div style={{marginTop:12, background:C.greenLight,
                  border:`1px solid ${C.greenBorder}`, borderRadius:7,
                  padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <div>
                    <a href="/news" style={{fontSize:13, fontWeight:600, color:C.green, textDecoration:"none"}}>
                      See all breaking news in real-time →
                    </a>
                    <span style={{fontSize:12, color:C.muted, fontWeight:300, marginLeft:8}}>
                      Pro unlocks the full feed, updated every minute
                    </span>
                  </div>
                  <button style={{background:C.green, border:"none", color:"#fff",
                    padding:"8px 18px", borderRadius:6, fontSize:12, fontWeight:500,
                    cursor:"pointer", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}
                    onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
                    onMouseLeave={e => e.currentTarget.style.background = C.green}>
                    Unlock Pro — $29/mo
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* MARKETS PULSE */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", alignItems:"center", gap:7}}>
              <Dot/>
              <span style={{fontSize:13, fontWeight:600, color:C.ink}}>MARKETS PULSE</span>
            </div>
            <div style={{padding:16}}>
              <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:16}}>
                {(data?.tickers || TICKS).slice(0, 4).map((t, i) => (
                  <div key={i} className="hov" style={{background:C.surface, borderRadius:7,
                    padding:"14px 14px", border:`1px solid ${C.border}`, cursor:"pointer",
                    transition:"background 0.15s"}}>
                    <div className="cp-tkr" style={{fontFamily:"'DM Mono',monospace", fontSize:11, color:C.muted, marginBottom:5}}>{t.sym}</div>
                    {loading ? <Skel h={26} mb={4}/> : <>
                      <div className="cp-num" style={{fontFamily:"'DM Mono',monospace", fontSize:22, fontWeight:600,
                        color:C.ink, marginBottom:4}}>
                        {t.sym === "BTC" || (+t.price > 10000)
                          ? (+t.price).toLocaleString("en-US", {maximumFractionDigits:2})
                          : fmt2(+t.price)}
                      </div>
                      <span className="cp-num" style={{fontSize:11, fontFamily:"'DM Mono',monospace", fontWeight:600,
                        color:chgC(t.chg), background:chgBg(t.chg),
                        padding:"2px 7px", borderRadius:3}}>
                        {t.chg > 0 ? "▲" : "▼"} {Math.abs(safeN(t.chg)).toFixed(2)}%
                      </span>
                    </>}
                  </div>
                ))}
              </div>
              <div style={{background:C.surface, borderRadius:8, padding:"16px", border:`1px solid ${C.border}`}}>
                <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
                  <span style={{fontFamily:"'DM Mono',monospace", fontSize:10, color:C.muted, letterSpacing:"1px"}}>SPY · TODAY</span>
                  <div style={{display:"flex", gap:4}}>
                    {["Day","Week","Month","Year"].map(t => (
                      <button key={t} style={{background:t === "Day" ? C.green : "transparent",
                        border:`1px solid ${t === "Day" ? C.green : C.border}`,
                        color:t === "Day" ? "#fff" : C.muted, padding:"4px 10px", borderRadius:4,
                        fontSize:11, cursor:"pointer", fontFamily:"'DM Sans',sans-serif",
                        fontWeight:t === "Day" ? 500 : 300, transition:"all 0.15s"}}>{t}</button>
                    ))}
                  </div>
                </div>
                <MiniLineChart points={chartPts} color={C.green}/>
              </div>
            </div>
          </div>

          {/* WHY IS IT MOVING */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", alignItems:"center", gap:7}}>
              <Dot/>
              <span style={{fontSize:13, fontWeight:600, color:C.ink}}>WHY IS IT MOVING?</span>
            </div>
            <div>
              {loading ? Array(4).fill(0).map((_, i) => (
                <div key={i} style={{padding:"13px 16px", borderBottom:`1px solid ${C.surface}`,
                  display:"flex", gap:14, alignItems:"center"}}>
                  <Skel w={40} h={32} mb={0}/>
                  <div style={{flex:1}}><Skel h={14} mb={4}/><Skel w="60%" h={12} mb={0}/></div>
                </div>
              )) : movers.map((m, i) => {
                const isUp = safeN(m.chg) >= 0;
                const [bg1, bg2] = CARD_COLORS[i % CARD_COLORS.length];
                return (
                  <div key={i} className="hov" style={{padding:"12px 16px",
                    borderBottom:i < movers.length - 1 ? `1px solid ${C.surface}` : "none",
                    display:"flex", gap:14, alignItems:"center", transition:"background 0.15s", cursor:"pointer"}}>
                    <div style={{width:44, height:44, borderRadius:8, flexShrink:0,
                      background:`linear-gradient(135deg,${bg1},${bg2})`,
                      display:"flex", alignItems:"center", justifyContent:"center"}}>
                      <span className="cp-tkr" style={{fontFamily:"'DM Mono',monospace", fontSize:11,
                        fontWeight:600, color:"rgba(255,255,255,0.9)"}}>{m.sym}</span>
                    </div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:13, fontWeight:600, color:C.ink, marginBottom:3,
                        fontFamily:"'DM Sans',sans-serif"}}>
                        Why Is {m.name} {isUp ? "Surging" : "Falling"} Today?
                      </div>
                      <div style={{fontSize:12, color:C.muted, fontWeight:300,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{m.why}</div>
                    </div>
                    <div style={{textAlign:"right", flexShrink:0}}>
                      <div className="cp-num" style={{fontFamily:"'DM Mono',monospace", fontSize:14, fontWeight:600,
                        color:chgC(m.chg), background:chgBg(m.chg), padding:"3px 8px", borderRadius:4}}>
                        {safeN(m.chg) > 0 ? "▲" : "▼"} {Math.abs(safeN(m.chg)).toFixed(1)}%
                      </div>
                      <div className="cp-num" style={{fontFamily:"'DM Mono',monospace", fontSize:11, color:C.dim, marginTop:3}}>{fmt2(m.price)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* INSIDER TRADES */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <div style={{display:"flex", alignItems:"center", gap:7}}>
                <Dot/>
                <span style={{fontSize:13, fontWeight:600, color:C.ink}}>INSIDER TRADES</span>
                <span style={{fontSize:9, background:"#FFF6E8", color:"#7A5018",
                  padding:"2px 7px", borderRadius:3, fontFamily:"'DM Mono',monospace", fontWeight:500}}>FORM 4 · SEC</span>
              </div>
            </div>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr style={{background:C.surface, borderBottom:`1px solid ${C.border}`}}>
                  {["Company","Executive","Role","Action","Value","Filed"].map(h => (
                    <th key={h} style={{padding:"8px 16px", textAlign:h === "Value" ? "right" : "left",
                      fontFamily:"'DM Mono',monospace", fontSize:9, color:C.dim,
                      letterSpacing:"0.8px", fontWeight:400}}>{h.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? Array(3).fill(0).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{padding:"12px 16px"}}><Skel h={14} mb={0}/></td></tr>
                )) : insiders.map((ins, i) => (
                  <tr key={i} className="hov" style={{borderBottom:i < insiders.length - 1 ? `1px solid ${C.surface}` : "none",
                    transition:"background 0.15s", cursor:"pointer",
                    borderLeft:`3px solid ${ins.type === "BUY" ? C.green : C.red}`}}>
                    <td style={{padding:"11px 16px", fontFamily:"'DM Mono',monospace",
                      fontSize:13, fontWeight:600, color:C.green}} className="sym-lnk cp-tkr">{ins.sym}</td>
                    <td style={{padding:"11px 16px", fontSize:13, color:C.text, fontWeight:400}}>{ins.name}</td>
                    <td style={{padding:"11px 16px", fontSize:12, color:C.muted, fontWeight:300}}>{ins.role}</td>
                    <td style={{padding:"11px 16px"}}>
                      <span style={{fontSize:10, padding:"3px 9px", borderRadius:3,
                        fontFamily:"'DM Mono',monospace", fontWeight:600,
                        background:ins.type === "BUY" ? C.greenLight : C.redLight,
                        color:ins.type === "BUY" ? C.green : C.red}}>{ins.type}</span>
                    </td>
                    <td className="cp-num" style={{padding:"11px 16px", textAlign:"right", fontFamily:"'DM Mono',monospace",
                      fontSize:14, fontWeight:700, color:ins.type === "BUY" ? C.green : C.red}}>{ins.value}</td>
                    <td className="cp-num" style={{padding:"11px 16px", fontFamily:"'DM Mono',monospace", fontSize:11, color:C.dim}}>{ins.filed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{position:"relative", overflow:"hidden"}}>
              {[1,2,3].map(i => (
                <div key={i} style={{padding:"11px 16px", borderTop:`1px solid ${C.surface}`,
                  display:"flex", gap:16, filter:"blur(4px)", userSelect:"none",
                  pointerEvents:"none", opacity:0.6}}>
                  <div style={{fontFamily:"'DM Mono',monospace", fontSize:13, fontWeight:600, color:C.green, width:60}}>████</div>
                  <div style={{fontSize:13, color:C.text, flex:1}}>████████ ██████</div>
                  <div style={{fontSize:12, color:C.muted, width:80}}>███ ██████</div>
                  <div style={{width:60}}>
                    <span style={{background:C.greenLight, padding:"3px 9px", borderRadius:3,
                      fontSize:10, color:C.green, fontFamily:"'DM Mono',monospace", fontWeight:600}}>BUY</span>
                  </div>
                  <div style={{fontFamily:"'DM Mono',monospace", fontSize:14, fontWeight:700,
                    color:C.green, width:70, textAlign:"right"}}>$██.█M</div>
                  <div style={{fontFamily:"'DM Mono',monospace", fontSize:11, color:C.dim, width:60}}>██h ago</div>
                </div>
              ))}
              <div style={{position:"absolute", inset:0, display:"flex", alignItems:"center",
                justifyContent:"center", background:"rgba(248,250,247,0.7)"}}>
                <div style={{background:C.white, border:`1px solid ${C.greenBorder}`,
                  borderRadius:8, padding:"12px 20px", display:"flex", alignItems:"center", gap:12,
                  boxShadow:"0 4px 16px rgba(0,0,0,0.08)"}}>
                  <span style={{fontSize:16}}>🔒</span>
                  <div>
                    <div style={{fontSize:13, fontWeight:600, color:C.ink, marginBottom:2}}>Unlock All Insider Trades</div>
                    <div style={{fontSize:12, color:C.muted, fontWeight:300}}>Real-time Form 4 filings · Pro $29/mo</div>
                  </div>
                  <button style={{background:C.green, border:"none", color:"#fff",
                    padding:"8px 16px", borderRadius:6, fontSize:12, fontWeight:500,
                    cursor:"pointer", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}
                    onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
                    onMouseLeave={e => e.currentTarget.style.background = C.green}>
                    Get Access
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* POLITICIAN TRADES */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <div style={{display:"flex", alignItems:"center", gap:7}}>
                <Dot/>
                <span style={{fontSize:13, fontWeight:600, color:C.ink}}>POLITICIAN TRADES</span>
                <span style={{fontSize:9, background:"#E8F0FF", color:"#1A3A78",
                  padding:"2px 7px", borderRadius:3, fontFamily:"'DM Mono',monospace", fontWeight:500}}>STOCK ACT · LIVE</span>
              </div>
            </div>
            <div>
              {loading ? Array(2).fill(0).map((_, i) => (
                <div key={i} style={{padding:"13px 16px", borderBottom:`1px solid ${C.surface}`}}>
                  <Skel h={14} mb={5}/><Skel w="50%" h={12} mb={0}/>
                </div>
              )) : politicians.map((p, i) => (
                <div key={i} className="hov" style={{padding:"13px 16px",
                  borderBottom:i < politicians.length - 1 ? `1px solid ${C.surface}` : "none",
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  transition:"background 0.15s", cursor:"pointer",
                  borderLeft:`3px solid ${p.action === "BUY" ? C.green : C.red}`}}>
                  <div>
                    <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:4}}>
                      <span style={{fontSize:14, fontWeight:600, color:C.ink}}>{p.name}</span>
                      <span style={{fontSize:11, color:C.muted, fontWeight:300}}>{p.title}</span>
                      <span style={{fontSize:10, padding:"2px 8px", borderRadius:3,
                        fontFamily:"'DM Mono',monospace", fontWeight:600,
                        background:p.action === "BUY" ? C.greenLight : C.redLight,
                        color:p.action === "BUY" ? C.green : C.red}}>{p.action}</span>
                    </div>
                    <div style={{fontSize:12, color:C.muted, fontWeight:300}}>
                      <span className="cp-tkr" style={{fontFamily:"'DM Mono',monospace", color:C.green,
                        fontWeight:600, marginRight:8}}>{p.sym}</span>
                      <span className="cp-num">{p.value}</span>
                    </div>
                  </div>
                  <span className="cp-num" style={{fontFamily:"'DM Mono',monospace", fontSize:11,
                    color:C.dim, whiteSpace:"nowrap"}}>{p.filed}</span>
                </div>
              ))}
            </div>
            <div style={{position:"relative", overflow:"hidden"}}>
              {[1,2].map(i => (
                <div key={i} style={{padding:"13px 16px", borderTop:`1px solid ${C.surface}`,
                  display:"flex", justifyContent:"space-between",
                  filter:"blur(4px)", userSelect:"none", pointerEvents:"none", opacity:0.6}}>
                  <div>
                    <div style={{display:"flex", gap:8, marginBottom:4}}>
                      <span style={{fontSize:14, fontWeight:600}}>████████ ██████</span>
                      <span style={{fontSize:11, color:C.muted}}>Sen.</span>
                      <span style={{background:C.greenLight, padding:"2px 8px", borderRadius:3,
                        fontSize:10, color:C.green, fontWeight:600,
                        fontFamily:"'DM Mono',monospace"}}>BUY</span>
                    </div>
                    <div style={{fontSize:12, color:C.muted}}>████ · $██K-$███K</div>
                  </div>
                  <span style={{fontFamily:"'DM Mono',monospace", fontSize:11, color:C.dim}}>█d ago</span>
                </div>
              ))}
              <div style={{position:"absolute", inset:0, display:"flex", alignItems:"center",
                justifyContent:"center", background:"rgba(248,250,247,0.7)"}}>
                <div style={{background:C.white, border:`1px solid ${C.greenBorder}`,
                  borderRadius:8, padding:"12px 20px", display:"flex", alignItems:"center", gap:12,
                  boxShadow:"0 4px 16px rgba(0,0,0,0.08)"}}>
                  <span style={{fontSize:16}}>🏛</span>
                  <div>
                    <div style={{fontSize:13, fontWeight:600, color:C.ink, marginBottom:2}}>Track Every Politician Trade</div>
                    <div style={{fontSize:12, color:C.muted, fontWeight:300}}>The edge they don't want you to have</div>
                  </div>
                  <button style={{background:C.green, border:"none", color:"#fff",
                    padding:"8px 16px", borderRadius:6, fontSize:12, fontWeight:500,
                    cursor:"pointer", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}
                    onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
                    onMouseLeave={e => e.currentTarget.style.background = C.green}>
                    Unlock Pro
                  </button>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* RIGHT SIDEBAR */}
        <div style={{display:"flex", flexDirection:"column", gap:14}}>

          <CatalystBriefCard/>

          <MarketSnapshotCard tickers={data?.tickers} loading={loading}/>

          {/* PRO UPSELL */}
          <div style={{background:C.greenLight, border:`1px solid ${C.greenBorder}`,
            borderRadius:8, padding:"16px"}}>
            <div style={{fontFamily:"'DM Mono',monospace", fontSize:9, color:C.green,
              letterSpacing:"1.5px", marginBottom:8}}>UNLOCK PRO — $29/MO</div>
            <ul style={{listStyle:"none", display:"flex", flexDirection:"column", gap:6, marginBottom:12}}>
              {["Full real-time news feed","All insider filings · live","Every politician trade",
                "Full screener · 12 filters","Live charts · all timeframes","Options flow & dark pool",
                "Daily 6 AM catalyst brief"].map(f => (
                <li key={f} style={{fontSize:12, color:C.green, display:"flex", gap:7,
                  alignItems:"center", fontWeight:400}}>
                  <span style={{fontWeight:700, fontSize:10, color:C.green}}>✓</span>{f}
                </li>
              ))}
            </ul>
            <button style={{width:"100%", background:C.green, border:"none", color:"#fff",
              padding:"11px", borderRadius:6, fontSize:13, fontWeight:600, cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif"}}
              onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
              onMouseLeave={e => e.currentTarget.style.background = C.green}>
              Start Pro — $29/mo
            </button>
            <p style={{fontSize:10, color:C.muted, textAlign:"center", marginTop:7, fontWeight:300}}>
              Cancel anytime · No contracts
            </p>
          </div>

          {/* INSIDER ACTIVITY (compact) */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 14px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <span style={{fontSize:12, fontWeight:600, color:C.ink}}>INSIDER ACTIVITY</span>
              <a href="/insiders" style={{fontSize:11, color:C.green, cursor:"pointer",
                fontWeight:400, textDecoration:"none"}}>View All →</a>
            </div>
            {loading ? Array(3).fill(0).map((_, i) => (
              <div key={i} style={{padding:"10px 14px", borderBottom:`1px solid ${C.surface}`}}>
                <Skel w="70%" h={12} mb={4}/><Skel w="50%" h={10} mb={0}/>
              </div>
            )) : insiders.map((ins, i) => (
              <div key={i} className="hov" style={{padding:"10px 14px",
                borderBottom:`1px solid ${C.surface}`, transition:"background 0.15s", cursor:"pointer"}}>
                <div style={{display:"flex", justifyContent:"space-between", marginBottom:3}}>
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <span className="cp-tkr" style={{fontFamily:"'DM Mono',monospace", fontSize:12,
                      fontWeight:600, color:C.ink}}>{ins.sym}</span>
                    <span style={{fontSize:9, padding:"2px 6px", borderRadius:3,
                      fontFamily:"'DM Mono',monospace", fontWeight:600,
                      background:ins.type === "BUY" ? C.greenLight : C.redLight,
                      color:ins.type === "BUY" ? C.green : C.red}}>{ins.type}</span>
                  </div>
                  <span style={{fontFamily:"'DM Mono',monospace", fontSize:12, fontWeight:700,
                    color:ins.type === "BUY" ? C.green : C.red}}>{ins.value}</span>
                </div>
                <div style={{fontSize:11, color:C.muted, fontWeight:300}}>{ins.name} · {ins.filed}</div>
              </div>
            ))}
          </div>

        </div>
      </div>

      <Footer/>
    </div>
  );
}
