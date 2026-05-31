'use client'

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  C, CARD_COLORS,
  chgC, chgBg, fmt2, safeN, minsSince,
  fetchKey, toArr,
  BrandStyles, Skel, Dot, NewsPhotoCard,
  TopNav, TickerTape, Footer, MarketSnapshotCard, CatalystBriefCard,
} from "../lib/cp-shared";

// Insider trades come from Postgres via /api/insiders (not KV). Homepage shows
// only real BUY/SELL transactions (view=transactions), excluding OTHER grants.
const fetchInsiders = async () => {
  try {
    const r = await fetch('/api/insiders?view=transactions&limit=25');
    if (!r.ok) return null;
    return await r.json();            // { view, count, trades:[...] }
  } catch { return null; }
};

// Politician trades: flat recent-trades feed from Postgres (view=feed), parallel
// to fetchInsiders. Not the grouped per-member list view.
const fetchPoliticians = async () => {
  try {
    const r = await fetch('/api/politicians?view=feed&limit=10');
    if (!r.ok) return null;
    return await r.json();            // { view:'feed', count, trades:[...] }
  } catch { return null; }
};

const fmtInsiderValue = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString('en-US')}`;
};

const insStyle = (type) =>
  type === 'BUY'  ? { fg: C.green, bg: C.greenLight } :
  type === 'SELL' ? { fg: C.red,   bg: C.redLight }  :
                    { fg: C.dim,   bg: C.surface };

// Local party styling (mirrors the politicians-app helper; kept local to avoid
// cross-importing app code into the homepage component).
const partyStyle = (party) => {
  const p = (party || '').toLowerCase();
  if (p.startsWith('democrat'))   return { fg: C.blue,  bg: C.blueLight, abbr: 'DEM' };
  if (p.startsWith('republican')) return { fg: C.red,   bg: C.redLight,  abbr: 'REP' };
  if (!party)                     return { fg: C.dim,   bg: C.surface,   abbr: '—'   };
  return { fg: C.muted, bg: C.surface, abbr: 'IND' };
};

const fetchAll = async () => {
  try {
    const [stories, snapshot, tape, insiderData, politicianData] = await Promise.all([
      fetchKey("top_stories"),
      fetchKey("market_snapshot"),
      fetchKey("ticker_tape"),
      fetchInsiders(),
      fetchPoliticians(),
    ]);

    const tapeArr = toArr(tape, 'tickers', 'ticker_tape', 'data');
    const tickers = tapeArr.map(t => ({
      sym: t.symbol || t.sym || t.ticker || '?',
      price: safeN(t.price ?? t.last ?? t.close ?? t.current_price ?? t.regularMarketPrice),
      chg: safeN(t.changePct ?? t.change_pct ?? t.pct_change ?? t.chg ?? t.changePercent ?? t.percentChange),
    }));

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

    const insidersArr = toArr(insiderData, 'trades');
    const insiders = insidersArr.map(i => ({
      sym:   i.ticker || '?',
      name:  i.executive || '',
      role:  i.title || '',
      type:  i.action === 'BUY' ? 'BUY' : i.action === 'SELL' ? 'SELL' : 'OTHER',
      value: fmtInsiderValue(i.totalValue),
      filed: i.filingDate || '',
    }));

    const politiciansArr = toArr(politicianData, 'trades');
    const politicians = politiciansArr.map(p => ({
      sym:    p.ticker || '?',
      name:   p.representative || '',
      party:  p.party || '',
      state:  p.state || '',
      slug:   p.memberSlug || '',
      type:   p.action === 'BUY' ? 'BUY' : p.action === 'SELL' ? 'SELL' : 'OTHER',
      amount: p.amountRange || '—',
      traded: p.transactionDate || '',
    }));

    const spy_chg = safeN(snapshot?.SPY?.changePct ?? snapshot?.SPY?.chg ?? snapshot?.SPY?.change_pct ?? 1.2);
    const vix     = safeN(snapshot?.VIX?.price ?? snapshot?.VIX?.last ?? 18.3);

    return { tickers, news, insiders, politicians, spy_chg, vix };
  } catch (e) {
    console.error('[CatalystPit] fetchAll error:', e);
    return null;
  }
};

export default function CatalystPit() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
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

  const news = data?.news || [];
  const insiders = data?.insiders || [];
  const insidersShown = insiders.slice(0, 12);
  const politicians = data?.politicians || [];
  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit"}) : "--:--";

  const router = useRouter();
  const goTicker = (sym) => { if (sym && sym !== '?') router.push(`/ticker/${encodeURIComponent(sym)}`); };
  const goPolitician = (slug) => { if (slug) router.push(`/politicians/${encodeURIComponent(slug)}`); };

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif", background:C.bg, color:C.text, minHeight:"100vh"}}>
      <BrandStyles/>

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
              Insider trades, market data, and breaking news — every catalyst, before the bell.
            </p>
          </div>
        </div>
      </div>

      {/* MAIN BODY */}
      <div className="cp-body-grid">

        {/* LEFT */}
        <div style={{display:"flex", flexDirection:"column", gap:16, minWidth:0}}>

          {/* TOP STORIES */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <div style={{display:"flex", alignItems:"center", gap:7}}>
                <Dot/>
                <span style={{fontSize:13, fontWeight:600, color:C.ink, letterSpacing:"-0.2px"}}>TOP STORIES</span>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6,
                fontFamily:"'DM Sans',sans-serif", fontSize:10, color:C.dim}}>
                {timeStr}
                <button onClick={loadData} style={{background:"transparent", border:"none",
                  color:C.muted, cursor:"pointer", fontSize:11, padding:"2px 6px",
                  borderRadius:4, fontFamily:"'DM Sans',sans-serif"}}
                  onMouseEnter={e => { e.currentTarget.style.color = C.green; }}
                  onMouseLeave={e => { e.currentTarget.style.color = C.muted; }}>↻</button>
              </div>
            </div>
            <div style={{padding:14}}>
              {loading ? (
                <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:10}}>
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
                  <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:12}}>
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
              <span style={{marginLeft:"auto", fontFamily:"'DM Sans',sans-serif", fontSize:9,
                color:C.dim, letterSpacing:"0.8px"}}>LIVE</span>
            </div>
            <div style={{padding:16}}>
              <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))", gap:12}}>
                {loading || !data?.tickers?.length ? (
                  Array(4).fill(0).map((_, i) => (
                    <div key={i} style={{background:C.surface, borderRadius:7,
                      padding:"14px 14px", border:`1px solid ${C.border}`}}>
                      <Skel w="50%" h={11} mb={6}/>
                      <Skel h={22} mb={5}/>
                      <Skel w="40%" h={11} mb={0}/>
                    </div>
                  ))
                ) : (
                  data.tickers.slice(0, 4).map((t, i) => (
                    <div key={i} className="hov" onClick={() => goTicker(t.sym)} style={{background:C.surface, borderRadius:7,
                      padding:"14px 14px", border:`1px solid ${C.border}`, cursor:"pointer",
                      transition:"background 0.15s"}}>
                      <div className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.muted, marginBottom:5}}>{t.sym}</div>
                      <div className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:22, fontWeight:600,
                        color:C.ink, marginBottom:4}}>
                        {t.sym === "BTC" || (+t.price > 10000)
                          ? (+t.price).toLocaleString("en-US", {maximumFractionDigits:2})
                          : fmt2(+t.price)}
                      </div>
                      <span className="cp-num" style={{fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:600,
                        color:chgC(t.chg), background:chgBg(t.chg),
                        padding:"2px 7px", borderRadius:3}}>
                        {t.chg > 0 ? "▲" : "▼"} {Math.abs(safeN(t.chg)).toFixed(2)}%
                      </span>
                    </div>
                  ))
                )}
              </div>
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
                  padding:"2px 7px", borderRadius:3, fontFamily:"'DM Sans',sans-serif", fontWeight:500}}>FORM 4 · SEC</span>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr style={{background:C.surface, borderBottom:`1px solid ${C.border}`}}>
                  {["Company","Executive","Role","Action","Value","Filed"].map(h => (
                    <th key={h} style={{padding:"8px 16px", textAlign:h === "Value" ? "right" : "left",
                      fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.dim,
                      letterSpacing:"0.8px", fontWeight:400}}>{h.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? Array(3).fill(0).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{padding:"12px 16px"}}><Skel h={14} mb={0}/></td></tr>
                )) : insidersShown.map((ins, i) => (
                  <tr key={i} className="hov" onClick={() => goTicker(ins.sym)} style={{borderBottom:i < insidersShown.length - 1 ? `1px solid ${C.surface}` : "none",
                    transition:"background 0.15s", cursor:"pointer",
                    borderLeft:`3px solid ${insStyle(ins.type).fg}`}}>
                    <td style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif",
                      fontSize:13, fontWeight:600, color:C.green}} className="sym-lnk cp-tkr">{ins.sym}</td>
                    <td style={{padding:"11px 16px", fontSize:13, color:C.text, fontWeight:400}}>{ins.name}</td>
                    <td style={{padding:"11px 16px", fontSize:12, color:C.muted, fontWeight:300}}>{ins.role}</td>
                    <td style={{padding:"11px 16px"}}>
                      <span style={{fontSize:10, padding:"3px 9px", borderRadius:3,
                        fontFamily:"'DM Sans',sans-serif", fontWeight:600,
                        background:insStyle(ins.type).bg,
                        color:insStyle(ins.type).fg}}>{ins.type}</span>
                    </td>
                    <td className="cp-num" style={{padding:"11px 16px", textAlign:"right", fontFamily:"'DM Sans',sans-serif",
                      fontSize:14, fontWeight:700, color:insStyle(ins.type).fg}}>{ins.value}</td>
                    <td className="cp-num" style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim}}>{ins.filed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{position:"relative", overflow:"hidden"}}>
              {[1,2,3].map(i => (
                <div key={i} style={{padding:"11px 16px", borderTop:`1px solid ${C.surface}`,
                  display:"flex", gap:16, filter:"blur(4px)", userSelect:"none",
                  pointerEvents:"none", opacity:0.6}}>
                  <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:600, color:C.green, width:60}}>████</div>
                  <div style={{fontSize:13, color:C.text, flex:1}}>████████ ██████</div>
                  <div style={{fontSize:12, color:C.muted, width:80}}>███ ██████</div>
                  <div style={{width:60}}>
                    <span style={{background:C.greenLight, padding:"3px 9px", borderRadius:3,
                      fontSize:10, color:C.green, fontFamily:"'DM Sans',sans-serif", fontWeight:600}}>BUY</span>
                  </div>
                  <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:700,
                    color:C.green, width:70, textAlign:"right"}}>$██.█M</div>
                  <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim, width:60}}>██h ago</div>
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
                <span style={{fontSize:9, background:"#EEF2FA", color:"#2A4A70",
                  padding:"2px 7px", borderRadius:3, fontFamily:"'DM Sans',sans-serif", fontWeight:500}}>STOCK ACT · CONGRESS</span>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr style={{background:C.surface, borderBottom:`1px solid ${C.border}`}}>
                  {["Ticker","Politician","Party","Action","Amount","Traded"].map(h => (
                    <th key={h} style={{padding:"8px 16px", textAlign:h === "Amount" ? "right" : "left",
                      fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.dim,
                      letterSpacing:"0.8px", fontWeight:400}}>{h.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? Array(3).fill(0).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{padding:"12px 16px"}}><Skel h={14} mb={0}/></td></tr>
                )) : politicians.slice(0, 10).map((p, i, arr) => (
                  <tr key={i} className={p.slug ? "hov" : undefined} onClick={p.slug ? () => goPolitician(p.slug) : undefined}
                    style={{borderBottom:i < arr.length - 1 ? `1px solid ${C.surface}` : "none",
                    transition:"background 0.15s", cursor:p.slug ? "pointer" : "default",
                    borderLeft:`3px solid ${insStyle(p.type).fg}`}}>
                    <td style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif",
                      fontSize:13, fontWeight:600, color:C.green}} className="sym-lnk cp-tkr">{p.sym}</td>
                    <td style={{padding:"11px 16px", fontSize:13, color:C.text, fontWeight:400}}>{p.name}</td>
                    <td style={{padding:"11px 16px"}}>
                      <span style={{fontSize:10, padding:"3px 9px", borderRadius:3,
                        fontFamily:"'DM Sans',sans-serif", fontWeight:600,
                        background:partyStyle(p.party).bg, color:partyStyle(p.party).fg}}>
                        {partyStyle(p.party).abbr}{p.state ? ` · ${p.state}` : ""}</span>
                    </td>
                    <td style={{padding:"11px 16px"}}>
                      <span style={{fontSize:10, padding:"3px 9px", borderRadius:3,
                        fontFamily:"'DM Sans',sans-serif", fontWeight:600,
                        background:insStyle(p.type).bg, color:insStyle(p.type).fg}}>{p.type}</span>
                    </td>
                    <td className="cp-num" style={{padding:"11px 16px", textAlign:"right", fontFamily:"'DM Sans',sans-serif",
                      fontSize:14, fontWeight:700, color:insStyle(p.type).fg, whiteSpace:"nowrap"}}>{p.amount}</td>
                    <td className="cp-num" style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim, whiteSpace:"nowrap"}}>{p.traded}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{position:"relative", overflow:"hidden"}}>
              {[1,2,3].map(i => (
                <div key={i} style={{padding:"11px 16px", borderTop:`1px solid ${C.surface}`,
                  display:"flex", gap:16, filter:"blur(4px)", userSelect:"none",
                  pointerEvents:"none", opacity:0.6}}>
                  <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:600, color:C.green, width:60}}>████</div>
                  <div style={{fontSize:13, color:C.text, flex:1}}>████████ ██████</div>
                  <div style={{width:74}}>
                    <span style={{background:C.blueLight, padding:"3px 9px", borderRadius:3,
                      fontSize:10, color:C.blue, fontFamily:"'DM Sans',sans-serif", fontWeight:600}}>DEM · ██</span>
                  </div>
                  <div style={{width:50}}>
                    <span style={{background:C.greenLight, padding:"3px 9px", borderRadius:3,
                      fontSize:10, color:C.green, fontFamily:"'DM Sans',sans-serif", fontWeight:600}}>BUY</span>
                  </div>
                  <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:700,
                    color:C.green, width:110, textAlign:"right"}}>$██K - $███K</div>
                  <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim, width:64}}>██████</div>
                </div>
              ))}
              <div style={{position:"absolute", inset:0, display:"flex", alignItems:"center",
                justifyContent:"center", background:"rgba(248,250,247,0.7)"}}>
                <div style={{background:C.white, border:`1px solid ${C.greenBorder}`,
                  borderRadius:8, padding:"12px 20px", display:"flex", alignItems:"center", gap:12,
                  boxShadow:"0 4px 16px rgba(0,0,0,0.08)"}}>
                  <span style={{fontSize:16}}>🔒</span>
                  <div>
                    <div style={{fontSize:13, fontWeight:600, color:C.ink, marginBottom:2}}>Unlock All Politician Trades</div>
                    <div style={{fontSize:12, color:C.muted, fontWeight:300}}>Congressional disclosures · Pro $29/mo</div>
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

        </div>

        {/* RIGHT SIDEBAR */}
        <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>

          <CatalystBriefCard/>

          <MarketSnapshotCard tickers={data?.tickers} loading={loading}/>

          {/* PRO UPSELL */}
          <div style={{background:C.greenLight, border:`1px solid ${C.greenBorder}`,
            borderRadius:8, padding:"16px"}}>
            <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.green,
              letterSpacing:"1.5px", marginBottom:8}}>UNLOCK PRO — $29/MO</div>
            <ul style={{listStyle:"none", display:"flex", flexDirection:"column", gap:6, marginBottom:12}}>
              {["Full real-time news feed","All insider filings · live",
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
            )) : insidersShown.map((ins, i) => (
              <div key={i} className="hov" onClick={() => goTicker(ins.sym)} style={{padding:"10px 14px",
                borderBottom:`1px solid ${C.surface}`, transition:"background 0.15s", cursor:"pointer"}}>
                <div style={{display:"flex", justifyContent:"space-between", marginBottom:3}}>
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:12,
                      fontWeight:600, color:C.ink}}>{ins.sym}</span>
                    <span style={{fontSize:9, padding:"2px 6px", borderRadius:3,
                      fontFamily:"'DM Sans',sans-serif", fontWeight:600,
                      background:insStyle(ins.type).bg,
                      color:insStyle(ins.type).fg}}>{ins.type}</span>
                  </div>
                  <span style={{fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight:700,
                    color:insStyle(ins.type).fg}}>{ins.value}</span>
                </div>
                <div style={{fontSize:11, color:C.muted, fontWeight:300}}>{ins.name} · {ins.filed}</div>
              </div>
            ))}
          </div>

          {/* POLITICIAN ACTIVITY (compact) */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 14px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <span style={{fontSize:12, fontWeight:600, color:C.ink}}>POLITICIAN ACTIVITY</span>
              <a href="/politicians" style={{fontSize:11, color:C.green, cursor:"pointer",
                fontWeight:400, textDecoration:"none"}}>View All →</a>
            </div>
            {loading ? Array(3).fill(0).map((_, i) => (
              <div key={i} style={{padding:"10px 14px", borderBottom:`1px solid ${C.surface}`}}>
                <Skel w="70%" h={12} mb={4}/><Skel w="50%" h={10} mb={0}/>
              </div>
            )) : politicians.slice(0, 8).map((p, i) => (
              <div key={i} className={p.slug ? "hov" : undefined} onClick={p.slug ? () => goPolitician(p.slug) : undefined}
                style={{padding:"10px 14px",
                borderBottom:`1px solid ${C.surface}`, transition:"background 0.15s", cursor:p.slug ? "pointer" : "default"}}>
                <div style={{display:"flex", justifyContent:"space-between", marginBottom:3}}>
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:12,
                      fontWeight:600, color:C.ink}}>{p.sym}</span>
                    <span style={{fontSize:9, padding:"2px 6px", borderRadius:3,
                      fontFamily:"'DM Sans',sans-serif", fontWeight:600,
                      background:insStyle(p.type).bg, color:insStyle(p.type).fg}}>{p.type}</span>
                  </div>
                  <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, fontWeight:700,
                    color:insStyle(p.type).fg, whiteSpace:"nowrap"}}>{p.amount}</span>
                </div>
                <div style={{fontSize:11, color:C.muted, fontWeight:300}}>{p.name} · {p.traded}</div>
              </div>
            ))}
          </div>

        </div>
      </div>

      <Footer/>
    </div>
  );
}
