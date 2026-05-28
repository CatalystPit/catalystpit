'use client';

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  C, TAG, CARD_COLORS,
  fetchKey, toArr, minsSince, timeAgo,
  BrandStyles, Skel, Dot, TagBadge,
  TopNav, TickerTape, Footer, MarketSnapshotCard, CatalystBriefCard, NewsPhotoCard,
} from "../lib/cp-shared";

const FREE_ROW_COUNT = 5; // hero (1) + 5 rows = 6 free items total

const fetchNews = async () => {
  const [stories, tape] = await Promise.all([
    fetchKey("top_stories"),
    fetchKey("ticker_tape"),
  ]);

  const tapeArr = toArr(tape, 'tickers', 'ticker_tape', 'data');
  const tickers = tapeArr.length > 0
    ? tapeArr.map(t => ({
        sym: t.symbol || t.sym || t.ticker || '?',
        price: parseFloat(t.price ?? t.last ?? t.close ?? t.current_price ?? t.regularMarketPrice) || 0,
        chg: parseFloat(t.changePct ?? t.change_pct ?? t.pct_change ?? t.chg ?? t.changePercent ?? t.percentChange) || 0,
      }))
    : null;

  const storiesArr = toArr(stories, 'stories', 'top_stories', 'articles', 'items', 'data');
  const articles = storiesArr.map(s => ({
    headline: s.title || s.headline || s.summary || s.description || '',
    source:   s.source || s.outlet || s.publisher || 'Market News',
    mins:     minsSince(s.published || s.published_at || s.date || s.pubDate),
    tag:      (s.category || s.tag || s.sector || 'MARKETS').toUpperCase(),
    sym:      (s.ticker && s.ticker !== 'N/A' && s.ticker !== 'null') ? s.ticker : (s.symbol || s.sym || null),
    summary:  s.summary || s.description || '',
    imageUrl: s.image_url || s.imageUrl || s.image || s.thumbnail || s.photo_url || null,
    url:      s.url || null,
  })).filter(a => a.headline);

  return { articles, tickers };
};

function NewsRowCard({n, idx}) {
  const [bg1, bg2] = CARD_COLORS[idx % CARD_COLORS.length];
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = n.imageUrl && !imgFailed;
  const hasValidTicker = n.sym && n.sym !== 'N/A' && n.sym !== 'null' && n.sym !== '?';

  const inner = (
    <div className="card-hov" style={{display:"flex", gap:14, padding:12,
      background:C.white, border:`1px solid ${C.border}`, borderRadius:6,
      transition:"all 0.2s", cursor:"pointer"}}>
      <div style={{width:120, height:80, borderRadius:5, overflow:"hidden", flexShrink:0,
        position:"relative", background:`linear-gradient(135deg,${bg1},${bg2})`}}>
        {showImg && (
          <img src={n.imageUrl} alt=""
            onError={() => setImgFailed(true)}
            style={{position:"absolute", inset:0, width:"100%", height:"100%",
              objectFit:"cover", objectPosition:"center top", display:"block"}}/>
        )}
      </div>
      <div style={{flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:5}}>
        <div style={{display:"flex", alignItems:"center", gap:7, flexWrap:"wrap"}}>
          <TagBadge tag={n.tag}/>
          {hasValidTicker && (
            <span className="cp-tkr" style={{fontFamily:"'DM Mono',monospace", fontSize:10, fontWeight:600,
              color:C.green, background:C.greenLight, padding:"2px 7px", borderRadius:3}}>
              {n.sym}
            </span>
          )}
          <span style={{marginLeft:"auto", fontFamily:"'DM Mono',monospace",
            fontSize:10, color:C.dim, whiteSpace:"nowrap"}}>
            {n.source}
            {n.mins != null && <span className="cp-num"> · {timeAgo(n.mins)}</span>}
          </span>
        </div>
        <div style={{fontSize:14, fontWeight:600, color:C.ink, lineHeight:1.35,
          fontFamily:"'DM Sans',sans-serif",
          display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden"}}>
          {n.headline}
        </div>
        {n.summary && (
          <div style={{fontSize:12, color:C.muted, fontWeight:300, lineHeight:1.45,
            fontFamily:"'DM Sans',sans-serif",
            display:"-webkit-box", WebkitLineClamp:1, WebkitBoxOrient:"vertical", overflow:"hidden"}}>
            {n.summary}
          </div>
        )}
      </div>
    </div>
  );

  if (n.url) {
    return (
      <a href={n.url} target="_blank" rel="noopener noreferrer"
        style={{textDecoration:"none", color:"inherit", display:"block"}}>
        {inner}
      </a>
    );
  }
  return inner;
}

function TickerSearchCard({query, onQueryChange, trending}) {
  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, padding:14}}>
      <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:10}}>
        <Dot/>
        <span style={{fontSize:12, fontWeight:600, color:C.ink}}>TICKER SEARCH</span>
      </div>
      <input
        value={query}
        onChange={e => onQueryChange(e.target.value.toUpperCase())}
        placeholder="Filter by ticker — e.g. NVDA"
        className="cp-tkr"
        style={{width:"100%", background:C.white, border:`1px solid ${C.border2}`,
          color:C.text, padding:"9px 12px", borderRadius:6, fontSize:12,
          fontFamily:"'DM Mono',monospace", outline:"none", fontWeight:500,
          letterSpacing:"0.5px", marginBottom:12}}/>
      {trending.length > 0 && (
        <>
          <div style={{fontFamily:"'DM Mono',monospace", fontSize:9, color:C.dim,
            letterSpacing:"1px", marginBottom:6}}>TRENDING</div>
          <div style={{display:"flex", gap:5, flexWrap:"wrap"}}>
            {trending.map(sym => {
              const active = query === sym;
              return (
                <button key={sym} onClick={() => onQueryChange(active ? '' : sym)}
                  className="chip-hov cp-tkr"
                  style={{fontFamily:"'DM Mono',monospace", fontSize:11, fontWeight:600,
                    color: active ? "#fff" : C.green,
                    background: active ? C.green : C.greenLight,
                    border:"none", padding:"4px 9px", borderRadius:4, cursor:"pointer",
                    transition:"all 0.15s"}}>
                  {sym}
                </button>
              );
            })}
          </div>
        </>
      )}
      {query && (
        <button onClick={() => onQueryChange('')}
          style={{marginTop:10, background:"transparent", border:`1px solid ${C.border}`,
            color:C.muted, padding:"5px 10px", borderRadius:4, fontSize:11,
            fontFamily:"'DM Sans',sans-serif", cursor:"pointer", width:"100%"}}>
          Clear filter
        </button>
      )}
    </div>
  );
}

export default function NewsFeed() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUp, setLastUp] = useState(null);
  const [activeCategory, setActiveCategory] = useState('ALL');
  const [tickerQuery, setTickerQuery] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchNews();
      setData(d);
      setLastUp(new Date());
    } catch (e) {
      console.error('[NewsFeed] fetch error:', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadData]);

  const articles = data?.articles || [];

  // Categories present in the unfiltered data
  const availableCategories = useMemo(() => {
    const seen = new Set();
    for (const a of articles) seen.add(a.tag);
    return Array.from(seen);
  }, [articles]);

  // Filter pipeline
  const filtered = useMemo(() => {
    return articles.filter(a => {
      if (activeCategory !== 'ALL' && a.tag !== activeCategory) return false;
      if (tickerQuery && (!a.sym || !a.sym.toUpperCase().includes(tickerQuery))) return false;
      return true;
    });
  }, [articles, activeCategory, tickerQuery]);

  // Trending tickers — unique syms from the unfiltered set (so chips don't disappear when filtering)
  const trendingTickers = useMemo(() => {
    const seen = new Set();
    for (const a of articles) {
      if (a.sym && a.sym !== '?' && a.sym !== 'N/A') seen.add(a.sym);
    }
    return Array.from(seen).slice(0, 10);
  }, [articles]);

  const hero = filtered[0];
  const restRows = filtered.slice(1);
  const freeRows = restRows.slice(0, FREE_ROW_COUNT);
  const lockedRows = restRows.slice(FREE_ROW_COUNT);

  const timeStr = lastUp
    ? lastUp.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit"})
    : "--:--";

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif", background:C.bg, color:C.text, minHeight:"100vh"}}>
      <BrandStyles/>
      <TopNav/>
      <TickerTape tickers={data?.tickers}/>

      {/* PAGE HEADER STRIP */}
      <div style={{background:C.white, borderBottom:`1px solid ${C.border}`, padding:"14px 24px"}}>
        <div style={{maxWidth:1380, margin:"0 auto", display:"flex",
          alignItems:"center", gap:16, flexWrap:"wrap"}}>
          <h1 style={{fontFamily:"'DM Sans',sans-serif", fontSize:22, fontWeight:700,
            color:C.ink, margin:0, letterSpacing:"-0.3px", lineHeight:1.2}}>
            News
          </h1>
          <span className="cp-num" style={{fontFamily:"'DM Mono',monospace", fontSize:11, color:C.muted}}>
            {loading ? '— loading —' : `${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}`}
            {filtered.length !== articles.length && articles.length > 0 && (
              <span style={{color:C.dim}}> of {articles.length}</span>
            )}
          </span>
          <div className="cp-num" style={{display:"flex", alignItems:"center", gap:8, marginLeft:"auto",
            fontFamily:"'DM Mono',monospace", fontSize:10, color:C.dim}}>
            <Dot/>AI LIVE · {timeStr}
            <button onClick={loadData} style={{background:"transparent", border:`1px solid ${C.border}`,
              color:C.muted, cursor:"pointer", fontSize:12, padding:"4px 10px",
              borderRadius:5, fontFamily:"'DM Mono',monospace"}}
              onMouseEnter={e => { e.currentTarget.style.color = C.green; e.currentTarget.style.borderColor = C.greenBorder; }}
              onMouseLeave={e => { e.currentTarget.style.color = C.muted; e.currentTarget.style.borderColor = C.border; }}>
              ↻ Refresh
            </button>
          </div>
        </div>
      </div>

      {/* CATEGORY FILTER CHIPS */}
      <div style={{background:C.white, borderBottom:`1px solid ${C.border}`, padding:"10px 24px"}}>
        <div style={{maxWidth:1380, margin:"0 auto", display:"flex", gap:6, flexWrap:"wrap"}}>
          {['ALL', ...availableCategories].map(cat => {
            const active = activeCategory === cat;
            const tc = TAG[cat] || {bg:C.surface, c:C.muted};
            return (
              <button key={cat} onClick={() => setActiveCategory(cat)}
                style={{fontSize:11, fontFamily:"'DM Mono',monospace", fontWeight:600,
                  letterSpacing:"0.5px", padding:"6px 12px", borderRadius:14,
                  border: active ? `1px solid ${C.ink}` : `1px solid ${C.border}`,
                  background: active ? C.ink : (cat === 'ALL' ? C.white : tc.bg),
                  color: active ? "#fff" : (cat === 'ALL' ? C.ink : tc.c),
                  cursor:"pointer", transition:"all 0.15s"}}>
                {cat}
              </button>
            );
          })}
          {(activeCategory !== 'ALL' || tickerQuery) && (
            <button onClick={() => { setActiveCategory('ALL'); setTickerQuery(''); }}
              style={{fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:400,
                padding:"6px 12px", borderRadius:14, border:"none",
                background:"transparent", color:C.muted, cursor:"pointer",
                textDecoration:"underline", marginLeft:4}}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* MAIN BODY */}
      <div className="cp-body-grid">

        {/* LEFT — FEED */}
        <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>
          {loading ? (
            <>
              <div style={{background:C.surface, borderRadius:8, overflow:"hidden"}}>
                <Skel h={340} mb={0}/>
              </div>
              {Array(6).fill(0).map((_, i) => (
                <div key={i} style={{display:"flex", gap:14, padding:12, background:C.white,
                  border:`1px solid ${C.border}`, borderRadius:6}}>
                  <Skel w={120} h={80} mb={0}/>
                  <div style={{flex:1}}>
                    <Skel w={80} h={10} mb={6}/>
                    <Skel h={14} mb={5}/>
                    <Skel w="65%" h={12} mb={0}/>
                  </div>
                </div>
              ))}
            </>
          ) : filtered.length === 0 ? (
            <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8,
              padding:"48px 24px", textAlign:"center"}}>
              <div style={{fontSize:15, fontWeight:600, color:C.ink, marginBottom:6}}>
                No stories match those filters.
              </div>
              <div style={{fontSize:13, color:C.muted, fontWeight:300, marginBottom:14}}>
                Try a different category or clear the ticker search.
              </div>
              <button onClick={() => { setActiveCategory('ALL'); setTickerQuery(''); }}
                style={{background:C.green, border:"none", color:"#fff",
                  padding:"9px 20px", borderRadius:6, fontSize:12, fontWeight:500,
                  cursor:"pointer", fontFamily:"'DM Sans',sans-serif"}}>
                Clear filters
              </button>
            </div>
          ) : (
            <>
              {/* HERO CARD */}
              {hero && <NewsPhotoCard n={hero} idx={0} hero showSummary/>}

              {/* FREE ROWS */}
              {freeRows.map((n, i) => (
                <NewsRowCard key={`free-${i}`} n={n} idx={i + 1}/>
              ))}

              {/* PRO BLUR GATE */}
              {lockedRows.length > 0 && (
                <div style={{position:"relative", overflow:"hidden", borderRadius:8,
                  marginTop:4}}>
                  <div style={{display:"flex", flexDirection:"column", gap:14,
                    filter:"blur(5px)", userSelect:"none", pointerEvents:"none", opacity:0.65}}>
                    {lockedRows.slice(0, 4).map((n, i) => (
                      <NewsRowCard key={`locked-${i}`} n={n} idx={FREE_ROW_COUNT + 1 + i}/>
                    ))}
                  </div>
                  <div style={{position:"absolute", inset:0, display:"flex",
                    alignItems:"center", justifyContent:"center",
                    background:"linear-gradient(to bottom, rgba(245,246,243,0.4) 0%, rgba(245,246,243,0.92) 60%)"}}>
                    <div style={{background:C.white, border:`1px solid ${C.greenBorder}`,
                      borderRadius:10, padding:"18px 24px", display:"flex", alignItems:"center", gap:16,
                      boxShadow:"0 8px 32px rgba(0,0,0,0.10)", maxWidth:520}}>
                      <span style={{fontSize:22}}>🔒</span>
                      <div style={{flex:1}}>
                        <div style={{fontSize:14, fontWeight:600, color:C.ink, marginBottom:3}}>
                          {lockedRows.length} more stor{lockedRows.length === 1 ? 'y' : 'ies'} behind Pro
                        </div>
                        <div style={{fontSize:12, color:C.muted, fontWeight:300}}>
                          Full real-time feed · updated every minute · $29/mo
                        </div>
                      </div>
                      <button style={{background:C.green, border:"none", color:"#fff",
                        padding:"10px 18px", borderRadius:6, fontSize:13, fontWeight:600,
                        cursor:"pointer", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}
                        onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
                        onMouseLeave={e => e.currentTarget.style.background = C.green}>
                        Unlock Pro
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* RIGHT SIDEBAR */}
        <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>
          <TickerSearchCard
            query={tickerQuery}
            onQueryChange={setTickerQuery}
            trending={trendingTickers}
          />
          <MarketSnapshotCard tickers={data?.tickers} loading={loading}/>
          <CatalystBriefCard/>
        </div>
      </div>

      <Footer/>
    </div>
  );
}
