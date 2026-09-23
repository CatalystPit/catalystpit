'use client'

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import ConsensusTeaser from "./ConsensusTeaser";
import { isRenderableTicker, firstRenderable } from "../lib/security-identity.mjs";
import { deskSelection } from "../lib/impact";
import HeatMap from "./HeatMap";
import CompactChart from "./chart/CompactChart";
import {
  C, CARD_COLORS,
  chgC, chgBg, fmt2, safeN, minsSince,
  fetchKey, toArr, startCheckout,
  BrandStyles, Skel, Dot, NewsPhotoCard, TickerLogo,
  TopNav, TickerTape, Footer, MarketSnapshotCard, CatalystBriefCard, WatchlistHomeCard,
} from "../lib/cp-shared";

/**
 * THE HOMEPAGE TEASER GATE — one component, because the bug was that there were none.
 *
 * ⚠️ WHAT THIS REPLACED: two hand-written, UNCONDITIONAL lock overlays. Not a broken auth check —
 * no auth check at all. This file never imported Clerk, never read a session, and never looked at
 * the `loggedIn` / `lockedCount` fields its own APIs were already returning. A signed-out visitor,
 * a signed-in Free user and a Pro subscriber all got the same "Sign in to explore…" overlay, and
 * making someone Pro changed nothing. The markup reads as a copy of the /insiders teaser
 * (InsidersClient.jsx:1117) with its `{lockedCount > 0 && (` wrapper stripped off.
 *
 * ⚠️ AUTHENTICATION AND ENTITLEMENT ARE TWO QUESTIONS, AND THE BUG WAS ANSWERING ONE WITH THE
 * OTHER. "Not Pro" is not "not signed in". A signed-in Free user is a customer we have already
 * converted; telling them to sign in is both wrong and insulting. So:
 *
 *   signed out            → the sign-in gate (unchanged copy — it was right for this case)
 *   signed in, not Pro    → the Pro treatment, pointing at the page that owns the real upgrade
 *   signed in, Pro        → nothing. Nothing is locked, so nothing pretends to be.
 *   still resolving       → nothing. NEVER the signed-out gate; a flash of "sign in" at someone
 *                           who is signed in is the same lie, just briefer.
 *
 * ⚠️ WHY THE PRO BRANCH LINKS OUT RATHER THAN SELLING HERE. The homepage rows come from
 * pit_snapshot, a session-less cron blob — every visitor gets the identical rows, so there is no
 * per-user withheld data on THIS surface to unlock. The genuinely gated history lives on
 * /insiders and /politicians, which already carry the canonical Pro lock and checkout. Pointing
 * there reuses that surface instead of growing a second checkout on the front door.
 */
function HomeTeaserGate({ children, anonTitle, anonSub, proTitle, proSub, href, proCta }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [tier, setTier] = useState(null);          // null = not yet known

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let alive = true;
    (async () => {
      // The canonical per-user plan read, same endpoint the Terminal, ticker page and billing
      // card use. Never CDN-cached, so it cannot serve one user's plan to another.
      try {
        const r = await fetch('/api/me/plan', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setTier(j?.tier || 'free');
      } catch { if (alive) setTier('free'); }
    })();
    return () => { alive = false; };
  }, [isLoaded, isSignedIn]);

  if (!isLoaded) return null;                                    // session resolving
  if (isSignedIn && tier === null) return null;                  // plan resolving
  if (isSignedIn && (tier === 'pro' || tier === 'elite')) return null;   // nothing is locked

  const anon = !isSignedIn;
  const title = anon ? anonTitle : proTitle;
  const sub   = anon ? anonSub   : proSub;
  const to    = anon ? '/sign-in' : href;
  const cta   = anon ? 'Sign in'  : proCta;

  return (
    <div style={{position:"relative", overflow:"hidden"}}>
      {children}
      <div style={{position:"absolute", inset:0, display:"flex", alignItems:"center",
        justifyContent:"center", background:"rgba(248,250,247,0.7)"}}>
        <div style={{background:C.white, border:`1px solid ${C.greenBorder}`,
          borderRadius:8, padding:"12px 20px", display:"flex", alignItems:"center", gap:12,
          boxShadow:"0 4px 16px rgba(0,0,0,0.08)"}}>
          <span style={{fontSize:16}}>🔒</span>
          <div>
            <div style={{fontSize:13, fontWeight:600, color:C.ink, marginBottom:2}}>{title}</div>
            <div style={{fontSize:12, color:C.muted, fontWeight:300}}>{sub}</div>
          </div>
          <a href={to} style={{background:C.green, border:"none", color:"#fff",
            padding:"8px 16px", borderRadius:6, fontSize:12, fontWeight:500, textDecoration:"none",
            cursor:"pointer", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}
            onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
            onMouseLeave={e => e.currentTarget.style.background = C.green}>
            {cta}
          </a>
        </div>
      </div>
    </div>
  );
}

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

// Canonical 8-K filings, shaped exactly like a story card so the Top Stories module can render
// them without a second layout.
//
// ⚠️ THIS IS THE FRONT DOOR'S FLOOR, NOT AN EXTRA FEATURE. When nothing in the news pool is worth
// a hero — every item routine, which is the normal state of a weekend — the module shows filings
// instead of promoting the least-bad magazine feature. A ticker, an item type, an age and a link
// to the filing is a smaller claim than a photo hero, and it is one a trader can verify.
const fetchFilings = async () => {
  try {
    const r = await fetch('/api/eightk?limit=12');
    const j = r.ok ? await r.json() : null;
    return Array.isArray(j?.list) ? j.list : [];
  } catch { return []; }
};

// Top Stories now come from the dedicated /api/news route (real news, auth-gated),
// not the KV-backed /api/claude reader. Returns the article array or null.
const fetchNews = async () => {
  try {
    const r = await fetch('/api/news');
    if (!r.ok) return null;
    const j = await r.json();            // { data:[...], lockedCount, loggedIn, ... }
    return Array.isArray(j?.data) ? j.data : null;
  } catch { return null; }
};

// Cluster buys (≥3 distinct insiders, same ticker, 30d) — ungated aggregate view.
const fetchClusters = async () => {
  try {
    const r = await fetch('/api/insiders?view=cluster_buys');
    if (!r.ok) return null;
    const j = await r.json();            // { view:'cluster_buys', clusters:[...] }
    return Array.isArray(j?.clusters) ? j.clusters : null;
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
    // Tape + market-snapshot prices stay on the market-cache reader. pit_snapshot (B1)
    // drives stories/catalysts/insiders/congress in ONE read; the per-API fetches below
    // are the fallback for the deploy→first-cron gap or a cron failure.
    const [tape, marketSnap, snap, filings] = await Promise.all([
      fetchKey("ticker_tape"),
      fetchKey("market_snapshot"),
      fetchKey("pit_snapshot"),
      fetchFilings(),
    ]);

    const usingSnapshot = !!snap && (Array.isArray(snap.insiders) || Array.isArray(snap.stories));
    let stories, insiderData, politicianData, clusterData;
    if (usingSnapshot) {
      stories = snap.stories || [];
      insiderData = { trades: snap.insiders || [] };
      politicianData = { trades: snap.congress || [] };
      clusterData = null;                          // catalysts arrive pre-built in the snapshot
    } else {
      [stories, insiderData, politicianData, clusterData] = await Promise.all([
        fetchNews(), fetchInsiders(), fetchPoliticians(), fetchClusters(),
      ]);
    }

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
      // ⚠️ NO PUBLISHER PHOTOGRAPHS ON THE FRONT DOOR. A desk is not a magazine: these cards
      // carry a ticker, a type and an age, and the gradient card already renders a null image.
      // Dropping the field also means no WSJ/MW/Benzinga artwork is ever requested from, or
      // cached on, our origin — which is a licensing question we do not need to have.
      imageUrl: null,
      url:      s.url || null,
    }));

    const insidersArr = toArr(insiderData, 'trades');
    const insidersAll = insidersArr.map(i => ({
      sym:   i.ticker || '?',
      name:  i.executive || '',
      role:  i.title || '',
      type:  i.action === 'BUY' ? 'BUY' : i.action === 'SELL' ? 'SELL' : 'OTHER',
      value: fmtInsiderValue(i.totalValue),
      valueNum: safeN(i.totalValue),          // numeric, for the value floor
      filed: i.filingDate || '',
    }));
    // A1 filter: P/S only (already via view=transactions) + value ≥ $100k.
    // Relax to $25k when a hard floor would leave too few rows to fill the tape.
    const MIN_HI = 100000, MIN_LO = 25000;
    const hiRows = insidersAll.filter(i => i.valueNum >= MIN_HI);
    const insiders = hiRows.length >= 5 ? hiRows : insidersAll.filter(i => i.valueNum >= MIN_LO);

    const politiciansArr = toArr(politicianData, 'trades');
    const politicians = politiciansArr.map(p => ({
      sym:    p.ticker || '?',
      name:   p.representative || '',
      party:  p.party || '',
      state:  p.state || '',
      slug:   p.memberSlug || '',
      type:   p.action === 'BUY' ? 'BUY' : p.action === 'SELL' ? 'SELL' : 'OTHER',
      amount: p.amountRange || '—',
      // ⚠️ BOTH DATES, EACH UNDER ITS OWN NAME. `traded` is when the member dealt; `disclosed` is
      // when the filing made it public, and that is the date the homepage shows and sorts by — the
      // transaction date is not actionable information until it has been disclosed. Collapsing the
      // two into one field is what let a transaction date ten months in the future render as though
      // it were news. /api/politicians?view=feed already refuses rows where the two contradict.
      traded: p.transactionDate || '',
      disclosed: p.disclosureDate || '',
    }));

    const spy_chg = safeN(marketSnap?.SPY?.changePct ?? marketSnap?.SPY?.chg ?? marketSnap?.SPY?.change_pct ?? 1.2);
    // The VIX value that used to be derived here is gone with the VIX card. It was computed, carried
    // through the return object, and consumed by nothing — and its fallback was the literal 18.3, a
    // fabricated index level that would have been displayed as real had anything ever rendered it.

    // NEVER WHITE (Rule 0): if the news feed is empty, synthesize up to 5 headlines
    // from the real insider filings we already fetched — no invented content.
    const newsFinal = news.length ? news : insiders
      .filter(i => i.type === 'BUY' || i.type === 'SELL')
      .slice(0, 5)
      .map(i => ({
        headline: `${i.sym}: ${i.name || 'Insider'} ${i.type === 'BUY' ? 'bought' : 'sold'} ${i.value}`,
        source: 'SEC Form 4', mins: null, tag: 'SEC',
        sym: i.sym, summary: '', imageUrl: null, url: `/ticker/${i.sym}`,
      }));

    // TODAY IN THE PIT — pre-built in the snapshot; otherwise build locally from fetched data.
    // Same eligibility rule as the snapshot builder, applied to the local fallback path so the two
    // cannot disagree about what counts as a ticker. A snapshot built before this shipped may still
    // carry an ineligible card, so the cached array is filtered too — the fix must not wait for the
    // next cron run to take effect.
    let catalysts;
    if (usingSnapshot) {
      catalysts = (Array.isArray(snap.catalysts) ? snap.catalysts : []).filter((c) => isRenderableTicker(c?.sym));
    } else {
      const topBuys = insiders.filter(i => i.type === 'BUY' && isRenderableTicker(i.sym)).sort((a, b) => b.valueNum - a.valueNum);
      const clusters = toArr(clusterData);
      catalysts = [];
      if (topBuys[0]) catalysts.push({ kind:'BUY', label:'LARGEST OPEN-MARKET BUY',
        sym: topBuys[0].sym, line: `${topBuys[0].name || 'Insider'} bought`, value: topBuys[0].value, date: topBuys[0].filed });
      const cluster = firstRenderable(clusters);
      if (cluster) catalysts.push({ kind:'BUY', label:'CLUSTER BUY · 30D',
        sym: cluster.ticker, line: `${cluster.buyers} insiders bought`,
        value: fmtInsiderValue(cluster.totalValue), date: cluster.lastBuy });
      // Dated by disclosure, and only if we have one — a hero card with no date beats a hero card
      // with the wrong date. Matches buildCatalysts() in api/cron/pit-snapshot.
      const pol = firstRenderable(politicians, (p) => p?.sym && p?.disclosed);
      if (pol) catalysts.push({ kind: pol.type, label:'LATEST CONGRESS TRADE',
        sym: pol.sym, line: `${pol.name} ${pol.type === 'BUY' ? 'bought' : 'sold'}`,
        value: pol.amount, date: pol.disclosed });
      if (topBuys[1]) catalysts.push({ kind:'BUY', label:'OPEN-MARKET BUY',
        sym: topBuys[1].sym, line: `${topBuys[1].name || 'Insider'} bought`, value: topBuys[1].value, date: topBuys[1].filed });
    }

    // Canonical filings in the story-card shape. No image, deliberately: the gradient card
    // already handles a null photo, and there is no publisher artwork for an SEC filing to
    // borrow — a ticker, a type and an age is the whole card.
    const filingCards = (filings || [])
      .filter((f) => isRenderableTicker(f?.ticker))
      .map((f) => ({
        headline: `${f.ticker} · ${f.primaryLabel || 'Filing'}`,
        source: 'SEC 8-K',
        mins: minsSince(f.filedAt),
        tag: 'SEC',
        sym: f.ticker,
        summary: '',
        imageUrl: null,
        url: f.url || `/ticker/${f.ticker}`,
        material: f.material,
      }));

    return { tickers, news: newsFinal, insiders, politicians, catalysts, spy_chg, filingCards };
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

  // Live index quotes for the MARKETS card (last session — so weekends show the prior trading day).
  const [idxQuotes, setIdxQuotes] = useState({});
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/quotes?symbols=SPY,QQQ,DIA,UVXY', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setIdxQuotes(j); }).catch(() => {});
    load(); const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── WHAT THE FRONT DOOR LEADS WITH ────────────────────────────────────────
  //
  // ⚠️ THE HOMEPAGE AND THE NEWS PAGE MUST RANK BY THE SAME RULE. They did not: /api/news ranked
  // with impactOf while the homepage rendered pit_snapshot.stories in whatever order the cron
  // sliced them. The News page led with FOMC minutes; the front door led with "I have $125,000
  // in credit-card debt… affect my bankruptcy?".
  //
  // The cron now ranks before it slices, so a fresh snapshot arrives ordered. This re-ranks
  // anyway — a snapshot has a 24h TTL, so one written before that deploy outlives it, and the
  // front door should not show yesterday's ordering for a day. rankByImpact is stable, so
  // re-ranking an already-ranked list changes nothing.
  const rawNews = data?.news || [];
  const filingCards = data?.filingCards || [];

  // ⚠️ A FOUR-UP IS FOUR CLAIMS, NOT ONE CLAIM AND THREE SPACERS. Ranking alone left the tiles to
  // be filled in order, so the hero was a WSJ Fed feature and the supporting cards were
  // credit-card and crypto-advice columns. deskSelection FILTERS to HIGH and never pads — see
  // lib/impact.js. It may return fewer than four, and that is the correct page.
  const { items: news, leadingWithFilings } = deskSelection(rawNews, filingCards);
  const insiders = data?.insiders || [];
  // The feed is ticker-facing too: each row renders its symbol and links to /ticker/<sym>. The same
  // Liberty Mutual filing that reached the card sits in this list, so without the gate the feed would
  // print "NONE" and link to a page that cannot exist. Filtered BEFORE the slice, so excluding a row
  // promotes the next real filing rather than leaving a short list.
  const insidersShown = insiders.filter((i) => isRenderableTicker(i?.sym)).slice(0, 10);
  const politicians = data?.politicians || [];
  const catalysts = data?.catalysts || [];
  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit", timeZone:"America/New_York"}) : "--:--";
  // Index quotes for the MARKETS card: prefer /api/quotes, fall back to the already-loaded ticker tape.
  const tapeMap = {};
  (data?.tickers || []).forEach((t) => { if (t.sym) tapeMap[t.sym] = { price: t.price, changePct: t.chg }; });
  const idxQ = (sym) => idxQuotes[sym] || tapeMap[sym] || null;

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
              Insider trades, market data, and breaking news. Every catalyst, before the bell.
            </p>
          </div>
        </div>
      </div>

      {/* MAIN BODY */}
      <div className="cp-body-grid">

        {/* LEFT */}
        <div style={{display:"flex", flexDirection:"column", gap:16, minWidth:0}}>

          {/* MARKETS — index candlestick charts (daily) */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface,
              display:"flex", alignItems:"center", gap:7}}>
              <Dot/>
              <span style={{fontSize:13, fontWeight:600, color:C.ink}}>MARKETS</span>
              <span style={{marginLeft:"auto", fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.dim, letterSpacing:"0.8px"}}>DAILY</span>
            </div>
            {/* Two columns give each chart ~180px at 390px and ~145px at 320px, which is below what
                the widget can draw: the right column was visibly clipped at 390 and the S&P 500
                cell rendered EMPTY at 320. `.cp-mkt-grid` collapses to one column ≤430px, where a
                full-width chart has room. Unchanged above that. */}
            <div className="cp-mkt-grid" style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:1, background:C.border}}>
              {/* UVXY REPLACES VIX DELIBERATELY. VIX is an index, not a security, and a future
                  market-data provider may not carry index data at all — the card would go blank
                  with nothing to fall back to. UVXY is a listed ETF that arrives through the same
                  equity pipeline as the other three, so this tile has no special case anywhere:
                  same quote source, same bars endpoint, same chart. No VIX value is sourced,
                  synthesised, proxied or retained for it. */}
              {[["SPY","S&P 500"],["QQQ","Nasdaq"],["DIA","Dow"],["UVXY","UVXY"]].map(([sym,label]) => { const q = idxQ(sym); return (
                <div key={sym} style={{background:C.white, padding:"8px 10px"}}>
                  <div style={{display:"flex", alignItems:"baseline", gap:6, marginBottom:4, flexWrap:"wrap"}}>
                    <span style={{fontSize:10.5, fontWeight:700, color:C.muted, letterSpacing:"0.3px"}}>{label}</span>
                    {q?.price != null && <span className="cp-num" style={{fontSize:11, fontWeight:600, color:C.ink}}>{q.price >= 1000 ? (+q.price).toLocaleString(undefined,{maximumFractionDigits:2}) : (+q.price).toFixed(2)}</span>}
                    {q?.changePct != null && <span className="cp-num" style={{fontSize:10.5, fontWeight:600, color:q.changePct >= 0 ? C.green : C.red}}>{q.changePct > 0 ? "+" : ""}{q.changePct.toFixed(2)}%</span>}
                  </div>
                  <CompactChart symbol={sym} height={150}/>
                </div>
              ); })}
            </div>
          </div>

          {/* TODAY IN THE PIT */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface,
              display:"flex", alignItems:"center", gap:7}}>
              <Dot/>
              <span style={{fontSize:13, fontWeight:600, color:C.ink}}>TODAY IN THE PIT</span>
              <span style={{marginLeft:"auto", fontFamily:"'DM Sans',sans-serif", fontSize:9,
                color:C.dim, letterSpacing:"0.8px"}}>FILINGS · CONGRESS</span>
            </div>
            <div style={{padding:14}}>
              {loading ? (
                <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))", gap:12}}>
                  {Array(4).fill(0).map((_, i) => (
                    <div key={i} style={{background:C.surface, borderRadius:7, padding:14, border:`1px solid ${C.border}`}}>
                      <Skel w="60%" h={10} mb={8}/><Skel h={18} mb={6}/><Skel w="70%" h={11} mb={0}/>
                    </div>
                  ))}
                </div>
              ) : catalysts.length === 0 ? (
                <div style={{padding:"20px 8px", textAlign:"center", fontSize:12, color:C.muted, fontWeight:300}}>
                  No catalysts to show yet. Filings land here through the session.
                </div>
              ) : (
                <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))", gap:12}}>
                  {/* Last line of defence. Selection already rejects an unrenderable symbol, but a
                      card here is a claim that a listed security did something, and the cost of that
                      claim being false is a homepage reading "NONE". */}
                  {catalysts.filter((c) => isRenderableTicker(c?.sym)).map((c, i) => (
                    <div key={i} className="hov" onClick={() => goTicker(c.sym)}
                      style={{background:C.surface, borderRadius:7, padding:14, border:`1px solid ${C.border}`,
                        borderLeft:`3px solid ${insStyle(c.kind).fg}`, cursor:"pointer", transition:"background 0.15s"}}>
                      <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.dim,
                        letterSpacing:"0.8px", marginBottom:7}}>{c.label}</div>
                      <div style={{display:"flex", alignItems:"center", gap:7, marginBottom:5}}>
                        <TickerLogo symbol={c.sym} size={20}/>
                      <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:15, fontWeight:700, color:C.green}}>{c.sym}</span>
                        <span style={{fontSize:9, padding:"2px 7px", borderRadius:3, fontFamily:"'DM Sans',sans-serif",
                          fontWeight:600, background:insStyle(c.kind).bg, color:insStyle(c.kind).fg}}>{c.value}</span>
                      </div>
                      <div style={{fontSize:12, color:C.muted, fontWeight:300}}>{c.line}{c.date ? ` · ${c.date}` : ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* TOP STORIES */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <div style={{display:"flex", alignItems:"center", gap:7}}>
                <Dot/>
                <span style={{fontSize:13, fontWeight:600, color:C.ink, letterSpacing:"-0.2px"}}>TOP STORIES</span>
                {/* Said out loud rather than swapped silently: when nothing in the news pool
                    earns a hero, the module is showing filings and the reader should know which
                    of the two they are looking at. */}
                {leadingWithFilings && (
                  <span style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, fontWeight:700,
                    letterSpacing:"0.5px", color:C.muted, border:`1px solid ${C.border2}`,
                    borderRadius:3, padding:"1px 6px"}}>8-K FILINGS</span>
                )}
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6,
                fontFamily:"'DM Sans',sans-serif", fontSize:10, color:C.dim}}>
                Updated {timeStr} ET
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
              ) : news.length === 0 ? (
                <div style={{padding:"28px 8px", textAlign:"center"}}>
                  <div style={{fontSize:14, fontWeight:600, color:C.ink, marginBottom:4}}>Markets are quiet right now</div>
                  <div style={{fontSize:12, color:C.muted, fontWeight:300}}>New filings and headlines land here before the bell.</div>
                </div>
              ) : (
                <>
                  <div style={{marginBottom:12}}>
                    {news.slice(0, 1).map((n, i) => (
                      <NewsPhotoCard key={i} n={n} idx={0} hero/>
                    ))}
                  </div>
                  {/* ⚠️ NO PADDING. This was `news[1 + i] || news[i % …]`, which repeated the
                      hero to fill the grid — one story rendered as four photographs of itself.
                      Up to three supporting tiles, and fewer when there are fewer. */}
                  {news.length > 1 && (
                    <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:12}}>
                      {news.slice(1, 4).map((n, i) => (
                        <NewsPhotoCard key={i} n={n} idx={i + 1}/>
                      ))}
                    </div>
                  )}
                </>
              )}
              {!loading && news.length > 0 && (
                <div style={{marginTop:12, background:C.greenLight,
                  border:`1px solid ${C.greenBorder}`, borderRadius:7,
                  padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <div>
                    <a href="/news" style={{fontSize:13, fontWeight:600, color:C.green, textDecoration:"none"}}>
                      See all breaking news →
                    </a>
                    <span style={{fontSize:12, color:C.muted, fontWeight:300, marginLeft:8}}>
                      Pro unlocks the full feed, updated every minute
                    </span>
                  </div>
                  <button onClick={() => startCheckout()} style={{background:C.green, border:"none", color:"#fff",
                    padding:"8px 18px", borderRadius:6, fontSize:12, fontWeight:500,
                    cursor:"pointer", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}
                    onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
                    onMouseLeave={e => e.currentTarget.style.background = C.green}>
                    Unlock Pro · $20/month
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* PIT CONSENSUS — flagship cross-signal teaser (under Top Stories) */}
          <ConsensusTeaser />

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
                      fontSize:13, fontWeight:600, color:C.green}} className="sym-lnk cp-tkr"><span style={{display:"flex", alignItems:"center", gap:8}}><TickerLogo symbol={ins.sym} size={18}/>{ins.sym}</span></td>
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
            <HomeTeaserGate
              anonTitle="Sign in to explore all insider trades"
              anonSub="Free account · SEC Form 4 filings"
              proTitle="More insider trades with Pro"
              proSub="Full Form 4 history, filters and pagination"
              href="/insiders" proCta="Open Insiders">
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
            </HomeTeaserGate>
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
                  {/* "Disclosed", not "Traded": the column carries the disclosure date, which is
                      when this became public and the only date a reader can have acted on. */}
                  {["Ticker","Politician","Party","Action","Amount","Disclosed"].map(h => (
                    <th key={h} style={{padding:"8px 16px", textAlign:h === "Amount" ? "right" : "left",
                      fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.dim,
                      letterSpacing:"0.8px", fontWeight:400}}>{h.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? Array(3).fill(0).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{padding:"12px 16px"}}><Skel h={14} mb={0}/></td></tr>
                )) : politicians.filter((p) => isRenderableTicker(p?.sym)).slice(0, 3).map((p, i, arr) => (
                  <tr key={i} className={p.slug ? "hov" : undefined} onClick={p.slug ? () => goPolitician(p.slug) : undefined}
                    style={{borderBottom:i < arr.length - 1 ? `1px solid ${C.surface}` : "none",
                    transition:"background 0.15s", cursor:p.slug ? "pointer" : "default",
                    borderLeft:`3px solid ${insStyle(p.type).fg}`}}>
                    <td style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif",
                      fontSize:13, fontWeight:600, color:C.green}} className="sym-lnk cp-tkr"><span style={{display:"flex", alignItems:"center", gap:8}}><TickerLogo symbol={p.sym} size={18}/>{p.sym}</span></td>
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
                    <td className="cp-num" style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim, whiteSpace:"nowrap"}}>{p.disclosed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{padding:"8px 16px", fontSize:10, color:C.dim, fontWeight:300, borderTop:`1px solid ${C.surface}`}}>
              Disclosed under the STOCK Act. Trades may be reported up to ~45 days after execution.
            </div>
            <HomeTeaserGate
              anonTitle="Sign in to explore all politician trades"
              anonSub="Free account · STOCK Act disclosures"
              proTitle="More politician trades with Pro"
              proSub="Full STOCK Act history, by member and by ticker"
              href="/politicians" proCta="Open Politicians">
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
            </HomeTeaserGate>
          </div>

        </div>

        {/* RIGHT SIDEBAR */}
        <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>

          <CatalystBriefCard/>

          <MarketSnapshotCard tickers={data?.tickers} loading={loading}/>

          <WatchlistHomeCard/>

          {/* PRO UPSELL */}
          <div style={{background:C.greenLight, border:`1px solid ${C.greenBorder}`,
            borderRadius:8, padding:"16px"}}>
            <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.green,
              letterSpacing:"1.5px", marginBottom:8}}>UNLOCK PRO · $20/MO</div>
            <ul style={{listStyle:"none", display:"flex", flexDirection:"column", gap:6, marginBottom:12}}>
              {/* ⚠️ THIS LIST IS A PROMISE, AND TWO OF ITS ITEMS WERE NOT TRUE.
                  "Options flow & dark pool" is a product we do not have and have no feed for.
                  "Live charts · all timeframes" and "real-time"/"live" on the first two items
                  claimed a realtime entitlement that is switched off — charts are end-of-day and
                  every quote surface says LAST CLOSE or DELAYED. Selling a feed we are not
                  licensed for is the one marketing mistake that is also a contract problem.
                  Each line below is now something a paying user actually receives today. */}
              {["Full market news feed","Every insider filing, minutes after it lands",
                "Full screener · 12 filters","Charts · all timeframes, end-of-day",
                "Evidence alerts on your watchlist",
                "Daily 6 AM catalyst brief"].map(f => (
                <li key={f} style={{fontSize:12, color:C.green, display:"flex", gap:7,
                  alignItems:"center", fontWeight:400}}>
                  <span style={{fontWeight:700, fontSize:10, color:C.green}}>✓</span>{f}
                </li>
              ))}
            </ul>
            <button onClick={() => startCheckout()} style={{width:"100%", background:C.green, border:"none", color:"#fff",
              padding:"11px", borderRadius:6, fontSize:13, fontWeight:600, cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif"}}
              onMouseEnter={e => e.currentTarget.style.background = C.greenMid}
              onMouseLeave={e => e.currentTarget.style.background = C.green}>
              Start Pro · $20/month
            </button>
            <button onClick={() => startCheckout('annual')} style={{width:"100%", background:"transparent",
              border:"none", color:C.green, marginTop:8, cursor:"pointer", fontSize:12, fontWeight:600,
              fontFamily:"'DM Sans',sans-serif"}}>
              or save with $199/year →
            </button>
            <p style={{fontSize:10, color:C.muted, textAlign:"center", marginTop:6, fontWeight:300}}>
              Cancel anytime · No contracts
            </p>
          </div>

          {/* MARKET HEAT MAP — full-market treemap. Replaces the old compact insider/politician
              rails (which duplicated the main tables on the homepage). */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 14px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <span style={{fontSize:12, fontWeight:600, color:C.ink}}>MARKET HEAT MAP</span>
              <a href="/terminal" style={{fontSize:11, color:C.green, cursor:"pointer", fontWeight:400, textDecoration:"none"}}>Terminal →</a>
            </div>
            <div style={{height:340}}><HeatMap limit={120} shared/></div>
          </div>

        </div>
      </div>

      <Footer/>
    </div>
  );
}
