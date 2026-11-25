'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import EightKWire from "./EightKWire";
import TickerLink from "./TickerLink";
import TopCatalysts from "./TopCatalysts";
import { impactOf, IMPACT_STYLE } from "../lib/impact";
import {
  C, TAG, CARD_COLORS,
  fetchKey, toArr, maybeN, StoryAge,
  BrandStyles, Skel, Dot, TagBadge, TickerLogo,
  TopNav, TickerTape, Footer, MarketSnapshotCard, CatalystBriefCard, NewsPhotoCard,
  useRealtimeQuotes, quotesFreshness,
} from "../lib/cp-shared";
import { useTickerHover, TickerHoverPreview } from "./TickerHoverChart";
import { isRenderableTicker } from "../lib/security-identity.mjs";
import { filterArticles, splitHeroAndRows, lockedCtaText, normalizeArticles } from "../lib/news-feed-view.mjs";

// How many faint placeholder rows to tease. The CTA beside them quotes the feed-wide count only
// when the feed-wide view is on screen — see lockedCtaText.
const LOCKED_PREVIEW_ROWS = 3;

const fetchNews = async () => {
  // Articles now come from the dedicated, AUTH-gated /api/news (server truncates
  // for signed-OUT visitors and sends lockedCount). ticker_tape stays on the public
  // /api/claude passthrough — it isn't gated. Article shape is identical; signed-out
  // visitors simply receive fewer elements, and locked stories never ship.
  const [newsRes, tape] = await Promise.all([
    fetch('/api/news').then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetchKey("ticker_tape"),
  ]);

  const tapeArr = toArr(tape, 'tickers', 'ticker_tape', 'data');
  // ⚠️ `|| 0` IS THE 0.00% BUG, AND THIS IS WHERE IT SURVIVED. The homepage was repaired to use
  // maybeN; this copy was not, so the News page's tape and Market Snapshot turned every missing
  // percentage into a hard, flat, red 0.00% — indistinguishable from a stock that genuinely did not
  // move. `parseFloat(null) || 0` is the same trap as `Number(null)`: NaN falls through `||` to a
  // zero that then passes every finiteness check downstream.
  //
  // maybeN keeps unknown as null, which both the tape and the snapshot card now render as a dash.
  const tickers = tapeArr.length > 0
    ? tapeArr.map(t => ({
        sym: t.symbol || t.sym || t.ticker || '?',
        price: maybeN(t.price ?? t.last ?? t.close ?? t.current_price ?? t.regularMarketPrice),
        chg: maybeN(t.changePct ?? t.change_pct ?? t.pct_change ?? t.chg ?? t.changePercent ?? t.percentChange),
      }))
    : null;

  const storiesArr = toArr(newsRes?.data, 'stories', 'top_stories', 'articles', 'items', 'data');
  // ⚠️ THE SHAPE MOVED TO lib/news-feed-view.mjs BECAUSE THE SERVER NOW BUILDS IT TOO.
  // app/news/page.jsx renders this river at generation time, and React hydrates the server's HTML
  // against the browser's first render of these exact objects — so a second copy of the mapping
  // here is a hydration mismatch waiting to be written. One function, two callers.
  const articles = normalizeArticles(storiesArr);

  return { articles, tickers, lockedCount: newsRes?.lockedCount || 0 };
};

function NewsRowCard({n, idx, bindTicker}) {
  const [bg1, bg2] = CARD_COLORS[idx % CARD_COLORS.length];
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = n.imageUrl && !imgFailed;
  const hasValidTicker = n.sym && n.sym !== 'N/A' && n.sym !== 'null' && n.sym !== '?';

  const inner = (
    <div className="card-hov" style={{display:"flex", gap:14, padding:12,
      background:C.white, border:`1px solid ${C.border}`, borderRadius:6,
      transition:"all 0.2s", cursor:"pointer"}}>
      <div style={{width:120, height:80, borderRadius:5, overflow:"hidden", flexShrink:0,
        position:"relative", background:`linear-gradient(135deg,${bg1},${bg2})`,
        display:"flex", alignItems:"center", justifyContent:"center"}}>
        {showImg ? (
          <img src={n.imageUrl} alt=""
            onError={() => setImgFailed(true)}
            style={{position:"absolute", inset:0, width:"100%", height:"100%",
              objectFit:"cover", objectPosition:"center top", display:"block"}}/>
        ) : hasValidTicker ? (
          // No article image (e.g. press-release wires) but we have the company → show its logo.
          <span style={{background:"#fff", borderRadius:8, padding:6, display:"inline-flex"}}>
            <TickerLogo symbol={n.sym} size={44}/>
          </span>
        ) : null}
      </div>
      <div style={{flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:5}}>
        <div style={{display:"flex", alignItems:"center", gap:7, flexWrap:"wrap"}}>
          {(() => { /* ticker included: HIGH IMPACT now requires a resolved issuer, so the badge must see it */
            const st = IMPACT_STYLE[impactOf({ title: n.headline, category: n.tag, source: n.source, ticker: n.sym })]; return st ? (
            <span style={{fontSize:9, fontWeight:700, color:st.fg, background:st.bg, borderRadius:3, padding:"2px 7px", letterSpacing:"0.3px"}}>{st.label}</span>
          ) : null; })()}
          <TagBadge tag={n.tag}/>
          {hasValidTicker && (
            <span className="cp-tkr" {...(bindTicker ? bindTicker(n.sym) : {})}
              style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, fontWeight:600,
              color:C.green, background:C.greenLight, padding:"2px 7px", borderRadius:3}}>
              {n.sym}
            </span>
          )}
          <span style={{marginLeft:"auto", fontFamily:"'DM Sans',sans-serif",
            fontSize:10, color:C.muted, whiteSpace:"nowrap"}}>
            {n.source}
            {/* ⚠️ AN AGE IS UNREADABLE TO ANYTHING THAT DID NOT FETCH THE PAGE AT THAT MOMENT.
                "4m ago" is right for a reader and tells a crawler, an AI fetcher or a cached copy
                nothing at all — this room was measured with ZERO <time> elements against the
                homepage's twenty. StoryAge is the existing answer to exactly this, and it already
                handles the case that matters: it emits the attribute ONLY when the publisher gave
                us a date, because an invented timestamp is worse than no timestamp. This first
                carried a hand-written <time> that duplicated it, which is the one thing this
                change has been refusing to do everywhere else. */}
            {n.mins != null && <> · <StoryAge n={n} className="cp-num" /></>}
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

  // ⚠️ THE SYMBOL BADGE CANNOT BE THE LINK, AND THAT IS WHY THIS ROW EXISTS.
  //
  // The whole card is wrapped in an anchor to the publisher's article, so turning the badge inside
  // it into a second anchor is nested <a> — invalid HTML, and browsers resolve it by discarding one
  // of them. So the research link is a SIBLING of the card rather than a child of it.
  //
  // ⚠️ AND IT IS WORTH THE ROW. Measured on production, /news served a crawler 129 words and ZERO
  // links to /ticker/ — a room full of company news with no path to the research we hold on those
  // companies, for a reader or for a crawler. Every story with a RESOLVED issuer now offers one.
  // ⚠️ TickerLink, NOT A HAND-BUILT href. It is the product's existing crawlable ticker reference,
  // written for exactly these rooms, and it RESOLVES the symbol instead of concatenating it: a
  // headline carrying "NYSE: VTEX" or "GEF, GEF-B" would otherwise emit a link the route answers
  // 404, and a page full of links to 404s is worse for crawling than a page with no links at all.
  // An unresolvable symbol renders no anchor, which is why this is gated on it returning one.
  const research = isRenderableTicker(n.sym) ? (
    <TickerLink symbol={n.sym} stopPropagation={false}
      style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, fontWeight:600, color:C.green,
        display:"inline-block", marginTop:4}}>
      {String(n.sym).toUpperCase()} research ·{' '}insider trades, filings and holdings →
    </TickerLink>
  ) : null;

  if (n.url) {
    return (
      <div>
        <a href={n.url} target="_blank" rel="noopener noreferrer"
          style={{textDecoration:"none", color:"inherit", display:"block"}}>
          {inner}
        </a>
        {research}
      </div>
    );
  }
  return research ? <div>{inner}{research}</div> : inner;
}

// Locked placeholder row — the server sent NO data for locked stories (free tier),
// so there is nothing to blur; this represents absence. Faint muted bars matching
// NewsRowCard's footprint + a lock glyph. Zero real article content in the data path.
function LockedNewsRow() {
  return (
    <div aria-hidden="true" style={{display:"flex", gap:14, padding:12, background:C.white,
      border:`1px solid ${C.border}`, borderRadius:6}}>
      <div style={{width:120, height:80, borderRadius:5, flexShrink:0, background:C.surface2,
        display:"flex", alignItems:"center", justifyContent:"center"}}>
        <span style={{fontSize:18, color:C.hint}}>🔒</span>
      </div>
      <div style={{flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:9, justifyContent:"center"}}>
        <div style={{height:9, width:"38%", borderRadius:4, background:C.surface2}}/>
        <div style={{height:13, width:"88%", borderRadius:4, background:C.surface2}}/>
        <div style={{height:13, width:"55%", borderRadius:4, background:C.surface2}}/>
      </div>
    </div>
  );
}

function TickerSearchCard({query, onQueryChange, trending, bindTicker}) {
  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, padding:14}}>
      <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:10}}>
        <Dot/>
        <span style={{fontSize:12, fontWeight:600, color:C.ink}}>TICKER SEARCH</span>
      </div>
      <input
        value={query}
        onChange={e => onQueryChange(e.target.value.toUpperCase())}
        placeholder="Filter by ticker, e.g. NVDA"
        className="cp-tkr"
        style={{width:"100%", background:C.white, border:`1px solid ${C.border2}`,
          color:C.text, padding:"9px 12px", borderRadius:6, fontSize:12,
          fontFamily:"'DM Sans',sans-serif", outline:"none", fontWeight:500,
          letterSpacing:"0.5px", marginBottom:12}}/>
      {trending.length > 0 && (
        <>
          <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.muted,
            letterSpacing:"1px", marginBottom:6}}>TRENDING</div>
          <div style={{display:"flex", gap:5, flexWrap:"wrap"}}>
            {trending.map(sym => {
              const active = query === sym;
              return (
                <button key={sym} onClick={() => onQueryChange(active ? '' : sym)}
                  {...(bindTicker ? bindTicker(sym) : {})}
                  className="chip-hov cp-tkr"
                  style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, fontWeight:600,
                    // White on C.green is 2.95:1 once C.green lightens for dark mode. C.bg is the
                    // page ground in each theme, so it lands near-white on dark green in light and
                    // near-black on light green in dark. The chip stays green either way.
                    color: active ? C.bg : C.green,
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

// ⚠️ initialData IS THE SERVER'S RENDER OF THIS PAGE, NOT A HINT. app/news/page.jsx composes the
// SAME river /api/news composes — same three pools, same lib/news-river.mjs, same
// normalizeArticles — at generation time, so the headlines, sources, tickers and dates are in the
// HTML before any JavaScript runs. A crawler measured 129 words and zero ticker links here.
//
// ⚠️ NOTHING IS GATED AND THAT IS WHY ONE SHARED COPY IS CORRECT. /api/news says it in its own
// words — "Market news is free without an account", data = raw, lockedCount = 0. The auth() call
// still in that route sets a reporting flag and gates nothing.
//
// ⚠️ AND NO PRICES. initialData carries `tickers: null` deliberately: the tape and the Market
// Snapshot card are licensed market data, resolved per viewer after hydration exactly as before.
// See lib/rooms-server.mjs for the three rules this render is held to.
export default function NewsFeed({ initialData = null }) {
  // ⚠️ ONE HOVER OWNER FOR EVERY TICKER ON THE PAGE — the feed rows, Top Catalysts, the 8-K Wire
  // and the Trending chips. Each surface gets the SAME binder, so there is one open timer, one
  // popup and one implementation, exactly as the Screener and Dividend Calendar use.
  const { hover, bind } = useTickerHover();

  // ⚠️ IDENTITY SAFETY: NO CHART WITHOUT A RESOLVED SECURITY. A news row can carry '?', 'N/A',
  // 'null', a company name a filer typed into a symbol field, or nothing at all — charting any of
  // those would invent a security. isRenderableTicker() is the product's existing answer to "may
  // this string be shown as a ticker on a card", so the chart reuses that judgement rather than
  // inventing a looser one. Returning {} leaves the element with no handlers, so a macro story or
  // an unresolved row simply has no hover behaviour.
  const bindTicker = useCallback(
    (sym) => (isRenderableTicker(sym) ? bind(String(sym).toUpperCase()) : {}),
    [bind],
  );

  const [data, setData] = useState(initialData);
  // ⚠️ NOT `useState(true)` WHEN THE SERVER ALREADY ANSWERED. Starting in the loading state with a
  // full river in hand renders skeletons over headlines that are already on screen.
  const [loading, setLoading] = useState(!initialData);
  const [lastUp, setLastUp] = useState(null);
  const [activeCategory, setActiveCategory] = useState('ALL');
  const [tickerQuery, setTickerQuery] = useState('');
  const [impactOnly, setImpactOnly] = useState(false);   // show only HIGH/NOTABLE catalysts
  // Sources the user has chosen to hide (press-release wires + outlets). Persisted so it sticks.
  const [hiddenSources, setHiddenSources] = useState(() => new Set());

  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem('cp_news_hidden_sources') || '[]'); if (Array.isArray(s)) setHiddenSources(new Set(s)); } catch { /* ignore */ }
  }, []);
  const toggleSource = (src) => setHiddenSources(prev => {
    const next = new Set(prev);
    if (next.has(src)) next.delete(src); else next.add(src);
    try { localStorage.setItem('cp_news_hidden_sources', JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });

  // ⚠️ THE FIRST RUN MUST NOT RE-ENTER THE LOADING STATE, OR THE SERVER RENDER FLASHES AWAY.
  // This runs on mount and then every 15 minutes, and it announced itself by setting loading
  // unconditionally. With server-rendered headlines on screen that replaces a full feed with
  // skeletons for the length of one fetch — the reader watches the news disappear and come back,
  // and the measurable gain becomes a visible regression. Only the first run is special-cased;
  // every later refresh still shows that it is working.
  const serverRendered = useRef(!!initialData);
  const loadData = useCallback(async () => {
    if (serverRendered.current) serverRendered.current = false;
    else setLoading(true);
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
  // Server is the single source of truth for the gate: free → N>0 (locked stories
  // were never sent), pro/elite → 0/absent. Defensive: undefined → 0.
  const lockedCount = data?.lockedCount || 0;

  // Categories present in the unfiltered data
  const availableCategories = useMemo(() => {
    const seen = new Set();
    for (const a of articles) seen.add(a.tag);
    return Array.from(seen);
  }, [articles]);

  // Sources present in the unfiltered data (for the source toggle row)
  const availableSources = useMemo(() => {
    const seen = new Set();
    for (const a of articles) if (a.source) seen.add(a.source);
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [articles]);

  // Filter pipeline
  // ONE filter implementation, shared by the typed search and the Trending chips — see
  // news-feed-view.mjs. Both set `tickerQuery`, so they cannot disagree.
  const filtered = useMemo(() => filterArticles(articles, {
    category: activeCategory, ticker: tickerQuery, hiddenSources, impactOnly, impactOf,
  }), [articles, activeCategory, tickerQuery, hiddenSources, impactOnly]);

  // Trending tickers — unique syms from the unfiltered set (so chips don't disappear when filtering)
  const trendingTickers = useMemo(() => {
    const seen = new Set();
    for (const a of articles) {
      if (a.sym && a.sym !== '?' && a.sym !== 'N/A') seen.add(a.sym);
    }
    return Array.from(seen).slice(0, 10);
  }, [articles]);

  // ⚠️ THE HERO IS A PHOTO CARD, so only a story with a photo may occupy it. Promoting
  // `filtered[0]` unconditionally is what made ticker filtering look broken: every SEC 8-K row
  // has imageUrl null, so filtering to a ticker whose only story is an 8-K rendered a 340px empty
  // gradient panel instead of the event. See splitHeroAndRows — order is unchanged; a photo-less
  // first story simply becomes the first ROW, which already handles a missing image.
  const { hero, rows: restRows } = useMemo(() => splitHeroAndRows(filtered), [filtered]);

  const timeStr = lastUp
    ? lastUp.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit", timeZone:"America/New_York"})
    : "--:--";

  // ⚠️ THE SAME ENTITLED PRICES THE HOMEPAGE NOW SHOWS. This page's tape and Market Snapshot read
  // only the public end-of-day `ticker_tape` cache, so a Pro subscriber on the News page saw the
  // previous session's closes under a hardcoded "DELAYED" — the identical defect as the front door,
  // in a second component. /api/quotes decides the entitlement server-side; this only displays it.
  const tapeSyms = useMemo(
    () => (data?.tickers || []).map((t) => t.sym).filter((s) => s && s !== '?'),
    [data?.tickers],
  );
  const { quotes: servedQuotes } = useRealtimeQuotes(tapeSyms);
  const { freshness: priceFreshness, delayMinutes: priceDelayMinutes } = quotesFreshness(servedQuotes);
  const tickersPriced = useMemo(() => (data?.tickers || []).map((t) => {
    const q = servedQuotes?.[t.sym];
    const price = Number(q?.price);
    if (!q || !Number.isFinite(price)) return t;
    const chg = maybeN(q.changePct);
    // A quote whose live print was unavailable has no move to report — keep the stored figure
    // rather than blanking it. The basis travels with the percentage, because a settled close now
    // reports its OWN session return and the tooltip has to name the right session. Same rule as
    // the homepage; see the note there.
    if (chg == null) return { ...t, price };
    return { ...t, price, chg, chgBasis: q.changeBasis ?? null, freshness: q.freshness ?? null };
  }), [data?.tickers, servedQuotes]);

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif", background:C.bg, color:C.text, minHeight:"100vh"}}>
      <BrandStyles/>
      <TopNav/>
      {/* ⚠️ ONE PREVIEW FOR THE WHOLE PAGE, rendered outside every card. The news rows, the 8-K
          Wire and the catalyst list each sit inside their own bordered container; a popup rendered
          within one of them would be clipped by it. Fixed-positioned here, it floats above all
          three and the existing flip/clamp logic keeps the right-hand column on screen. */}
      <TickerHoverPreview hover={hover}/>
      <TickerTape tickers={tickersPriced} freshness={priceFreshness} delayMinutes={priceDelayMinutes}/>

      {/* PAGE HEADER STRIP */}
      <div style={{background:C.white, borderBottom:`1px solid ${C.border}`, padding:"14px 24px"}}>
        <div style={{maxWidth:1380, margin:"0 auto", display:"flex",
          alignItems:"center", gap:16, flexWrap:"wrap"}}>
          <h1 style={{fontFamily:"'DM Sans',sans-serif", fontSize:22, fontWeight:700,
            color:C.ink, margin:0, letterSpacing:"-0.3px", lineHeight:1.2}}>
            News
          </h1>
          <span className="cp-num" style={{fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.muted}}>
            {loading ? 'loading…' : `${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}`}
            {filtered.length !== articles.length && articles.length > 0 && (
              <span style={{color:C.muted}}> of {articles.length}</span>
            )}
          </span>
          <div className="cp-num" style={{display:"flex", alignItems:"center", gap:8, marginLeft:"auto",
            fontFamily:"'DM Sans',sans-serif", fontSize:10, color:C.muted}}>
            <Dot/>Updated {timeStr} ET
            <button onClick={loadData} style={{background:"transparent", border:`1px solid ${C.border}`,
              color:C.muted, cursor:"pointer", fontSize:12, padding:"4px 10px",
              borderRadius:5, fontFamily:"'DM Sans',sans-serif"}}
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
          <button onClick={() => setImpactOnly(v => !v)}
            style={{fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:700, letterSpacing:"0.3px",
              padding:"6px 12px", borderRadius:14, cursor:"pointer", transition:"all 0.15s",
              border:`1px solid ${impactOnly ? '#B23B2E' : C.border}`,
              background: impactOnly ? '#B23B2E' : C.white,
              // Unselected, this literal red sat at 2.86:1 on the dark card. C.red themes: 5.21:1
              // in dark, unchanged in light. Selected stays white on solid red, which reads in both.
              color: impactOnly ? '#fff' : C.red}}>
            ⚡ High impact
          </button>
          {['ALL', ...availableCategories].map(cat => {
            const active = activeCategory === cat;
            const tc = TAG[cat] || {bg:C.surface, c:C.muted};
            return (
              <button key={cat} onClick={() => setActiveCategory(cat)}
                style={{fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:600,
                  letterSpacing:"0.5px", padding:"6px 12px", borderRadius:14,
                  border: active ? `1px solid ${C.ink}` : `1px solid ${C.border}`,
                  background: active ? C.ink : (cat === 'ALL' ? C.white : tc.bg),
                  // C.ink is near-BLACK in light and near-WHITE in dark, so a literal #fff here
                  // rendered white-on-white at 1.12:1 in dark mode. C.bg is ink's opposite in both
                  // themes: 18.7:1 in light, 16.5:1 in dark, and the pill keeps its look either way.
                  color: active ? C.bg : (cat === 'ALL' ? C.ink : tc.c),
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

      {/* SOURCE TOGGLES — click to hide/show a source (wires + outlets). Persisted per user. */}
      {availableSources.length > 1 && (
        <div style={{background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"8px 24px"}}>
          <div style={{maxWidth:1380, margin:"0 auto", display:"flex", gap:6, flexWrap:"wrap", alignItems:"center"}}>
            <span style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, color:C.muted, letterSpacing:"0.5px", marginRight:4}}>SOURCES</span>
            {availableSources.map(src => {
              const hidden = hiddenSources.has(src);
              return (
                <button key={src} onClick={() => toggleSource(src)} title={hidden ? `Show ${src}` : `Hide ${src}`}
                  style={{fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:500,
                    padding:"4px 10px", borderRadius:12, cursor:"pointer", transition:"all 0.15s",
                    border:`1px solid ${hidden ? C.border : C.greenBorder}`,
                    background: hidden ? "transparent" : C.greenLight,
                    color: hidden ? C.dim : C.green,
                    textDecoration: hidden ? "line-through" : "none"}}>
                  {src}
                </button>
              );
            })}
            {hiddenSources.size > 0 && (
              <button onClick={() => { setHiddenSources(new Set()); try { localStorage.setItem('cp_news_hidden_sources', '[]'); } catch { /* ignore */ } }}
                style={{fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:400,
                  padding:"4px 10px", borderRadius:12, border:"none",
                  background:"transparent", color:C.muted, cursor:"pointer", textDecoration:"underline"}}>
                Show all
              </button>
            )}
          </div>
        </div>
      )}

      {/* MAIN BODY */}
      <div className="cp-body-grid">

        {/* LEFT — FEED */}
        {/* ⚠️ <TopCatalysts/> USED TO BE THE FIRST THING IN THIS COLUMN, ABOVE THE HERO, AND THAT
            IS THE REPORTED DEFECT IN ITS LITERAL FORM: "the News page shows dozens of SEC 8-K
            filings before visitors reach actual financial news articles."

            Measured in a real browser against production, signed out, by absolute document Y —
            because DOM order is not visual order and the API ordering alone proved nothing:

              mobile  (390px)   8 filing cards above the first article (y=613..1089 vs y=1211)
              desktop (1440px)  4 filing cards above the first newsroom row

            Six of those were this module. It has moved to the right sidebar beside the 8-K Wire,
            where the filings already have a clearly identified area of their own: on desktop it
            sits at the same height and loses no prominence, and on a phone the sidebar stacks
            BELOW the feed, so the column a reader meets first is the reporting. The module is
            unchanged apart from its ranking — nothing was removed from the product. */}
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
              {/* Names the ticker when one is filtering, because "no stories match those filters"
                  reads as a fault when the reader has filtered to exactly one symbol. */}
              <div style={{fontSize:15, fontWeight:600, color:C.ink, marginBottom:6}}>
                {tickerQuery ? `No recent news found for ${tickerQuery}.` : 'No stories match those filters.'}
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

              {/* ROWS RECEIVED — free: hero + up to 5; pro/elite: all. Already gated server-side. */}
              {restRows.map((n, i) => (
                <NewsRowCard key={`row-${i}`} n={n} idx={i + 1} bindTicker={bindTicker}/>
              ))}

              {/* LOCKED — the server sent NO data for these; render absence placeholders + ONE CTA */}
              {lockedCount > 0 && (
                <>
                  {Array.from({ length: Math.min(lockedCount, LOCKED_PREVIEW_ROWS) }).map((_, i) => (
                    <LockedNewsRow key={`lock-${i}`}/>
                  ))}
                  <div style={{marginTop:4, padding:"14px 18px", display:"flex", alignItems:"center", gap:14,
                    flexWrap:"wrap", background:C.greenLight, border:`1px solid ${C.greenBorder}`, borderRadius:8}}>
                    {/* ⚠️ The count belongs to the WHOLE feed, so it is only quoted when the whole
                        feed is on screen — see lockedCtaText. Under a ticker filter it would read
                        as a promise of that many stories for that one symbol. */}
                    <span style={{flex:1, minWidth:0, fontFamily:"'DM Sans',sans-serif", fontSize:13, color:C.ink}}>
                      🔒 {lockedCtaText(lockedCount, { tickerFiltered: Boolean(tickerQuery) })}
                    </span>
                    {/* Free login gate (not Pro) — matches the app's existing /sign-in entry (TopNav, watchlist) */}
                    <a href="/sign-in" style={{background:C.green, color:"#fff", textDecoration:"none", whiteSpace:"nowrap",
                      padding:"10px 18px", borderRadius:6, fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif"}}>
                      Sign in
                    </a>
                  </div>
                </>
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
            bindTicker={bindTicker}
          />
          <TopCatalysts bindTicker={bindTicker}/>
          <EightKWire limit={30} bindTicker={bindTicker}/>
          <MarketSnapshotCard tickers={tickersPriced} loading={loading}
            freshness={priceFreshness} delayMinutes={priceDelayMinutes}/>
          <CatalystBriefCard/>
        </div>
      </div>

      <Footer/>
    </div>
  );
}
