'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import ConsensusTeaser from "./ConsensusTeaser";
import { isRenderableTicker } from "../lib/security-identity.mjs";
import { buildHomeModel, isEmptyModel } from "../lib/home-model.mjs";
import { deskSelection } from "../lib/impact";
import HeatMap from "./HeatMap";
import FearGreedCard from "./FearGreedCard";
import MarketBreadth from "./MarketBreadth";
import PlanChoice from "./PlanChoice";
import CompactChart from "./chart/CompactChart";
import {
  C, CARD_COLORS,
  chgC, chgBg, fmt2, maybeN, isoOrNull,
  fetchKey, startCheckout,
  BrandStyles, Skel, Dot, NewsPhotoCard, TickerLogo,
  TopNav, TickerTape, Footer, MarketSnapshotCard, CatalystBriefCard, WatchlistHomeCard,
  useRealtimeQuotes, quotesFreshness,
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
/**
 * DOES THIS VIEWER ALREADY HAVE PRO?
 *
 * ⚠️ ONE READ OF THE CANONICAL SOURCE, USED BY EVERY GATE ON THIS PAGE. /api/me/plan is
 * resolveUserTier() — the same resolution that protects the actual Pro features server-side — so the
 * UI cannot disagree with the authorisation. Nothing here infers entitlement from an email address,
 * an admin role or any client-side guess: admin-granted, complimentary and beta access all arrive
 * through that one endpoint already, and a surface that re-derives them would be a second, wrong
 * answer. Never CDN-cached, so one viewer's plan cannot be served to another.
 *
 * ⚠️ `resolved` IS A THIRD STATE, AND IT IS THE POINT. A boolean that starts false says "not Pro"
 * before anyone has asked, so a paying subscriber sees the upgrade card for a beat and then watches
 * it vanish. Signed out needs no request and resolves at once; signed in waits for the answer.
 *
 * @returns {{ resolved: boolean, pro: boolean, tier: string|null, isSignedIn: boolean }}
 */
function useProEntitlement() {
  const { isLoaded, isSignedIn } = useAuth();
  const [tier, setTier] = useState(null);          // null = not yet known

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/me/plan', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setTier(j?.tier || 'free');
      } catch { if (alive) setTier('free'); }
    })();
    return () => { alive = false; };
  }, [isLoaded, isSignedIn]);

  return {
    resolved: isLoaded && (!isSignedIn || tier !== null),
    pro: !!isSignedIn && (tier === 'pro' || tier === 'elite'),
    tier, isSignedIn: !!isSignedIn,
  };
}

/**
 * Renders its children only for a viewer who does NOT already have Pro.
 *
 * ⚠️ IT RENDERS NOTHING WHILE THE ANSWER IS UNKNOWN, rather than defaulting to showing the pitch.
 * Showing an upgrade card to somebody who already pays is worse than showing it 200ms late, and the
 * anonymous case — which is most visitors — resolves with no request at all.
 */
function FreeOnly({ children }) {
  const { resolved, pro } = useProEntitlement();
  if (!resolved || pro) return null;
  return children;
}

/**
 * THE HOMEPAGE TEASER, AND WHO SEES THE BLUR.
 *
 * ⚠️ IT WAS RETURNING ITS CHILDREN UNCONDITIONALLY. Every visitor got three hardcoded placeholder
 * rows blurred at 4px — including signed-in members, who were being shown an imitation of data they
 * are entitled to read in full. Both call sites were already passing the props for both states
 * (anonTitle, anonSub, proTitle, proSub, href, proCta) and nothing consumed any of them.
 *
 * ⚠️ THE TEST IS CLERK'S AUTH STATE, NOT ENTITLEMENT, AND THAT DISTINCTION IS THE POINT.
 *
 * This is a sign-up prompt, not a paywall. The research APIs are free and stay free, so
 * useProEntitlement is deliberately NOT used here: a paying Ad-Free subscriber and a free
 * registered member are the same viewer for this decision, and routing it through entitlement would
 * quietly turn a homepage presentation choice into a second research paywall.
 *
 * ⚠️ NOTHING RENDERS WHILE isLoaded IS FALSE. Both wrong guesses are worse than a blank strip for a
 * frame: defaulting to signed-out flashes a "sign in" pitch at somebody already signed in, and
 * defaulting to signed-in shows an anonymous visitor the member view and then takes it away.
 */
export function HomeTeaserGate({ children, href, anonTitle, anonSub, proTitle, proSub, proCta }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;

  // ⚠️ A SIGNED-IN MEMBER NEVER SEES A PLACEHOLDER. The table above already carries more real
  // filings for them, so what belongs here is the way through to the full history — not a blurred
  // imitation of it.
  if (isSignedIn) {
    return (
      <a href={href} style={{
        display:"flex", alignItems:"center", justifyContent:"space-between", gap:12,
        padding:"12px 16px", borderTop:`1px solid ${C.surface}`, textDecoration:"none",
        background:C.white,
      }}>
        <span style={{minWidth:0}}>
          <span style={{display:"block", fontFamily:"'DM Sans',sans-serif", fontSize:13,
            fontWeight:600, color:C.text}}>{proTitle}</span>
          <span style={{display:"block", fontSize:11, color:C.muted, marginTop:2}}>{proSub}</span>
        </span>
        <span style={{flexShrink:0, fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight:700,
          color:C.green, whiteSpace:"nowrap"}}>{proCta} →</span>
      </a>
    );
  }

  // ⚠️ SIGNED OUT: the blurred teaser stays, with the prompt centred OVER it.
  //
  // redirect_url is what brings them back to this section's own research page rather than to the
  // homepage — the whole reason each call site passes a different href.
  return (
    <div style={{position:"relative"}}>
      {children}
      {/* A scrim between the blur and the prompt. Without it the button competes with the blurred
          text behind it and "clearly visible" stops being true. pointerEvents:none so it cannot
          intercept the click it exists to make readable. */}
      <div style={{position:"absolute", inset:0, background:C.white, opacity:0.55,
        pointerEvents:"none"}} />
      <div style={{position:"absolute", inset:0, display:"flex", flexDirection:"column",
        alignItems:"center", justifyContent:"center", gap:6, padding:"8px 16px",
        textAlign:"center"}}>
        <a href={`/sign-in?redirect_url=${encodeURIComponent(href)}`} style={{
          display:"inline-block", padding:"9px 18px", borderRadius:6, background:C.green,
          color:C.white, textDecoration:"none", fontFamily:"'DM Sans',sans-serif",
          fontSize:13, fontWeight:700, whiteSpace:"nowrap",
          boxShadow:"0 1px 3px rgba(0,0,0,.18)",
        }}>
          Sign In to See More
        </a>
        <span style={{fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight:600,
          color:C.text}}>{anonTitle}</span>
        <span style={{fontSize:11, color:C.muted}}>{anonSub}</span>
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
    // ⚠️ THE FETCH IS WIDER THAN THE TABLE BECAUSE THE TABLE FILTERS. A congressional disclosure
    // may name a bond, a fund or an option with no renderable ticker, and isRenderableTicker drops
    // those before a row is drawn. On a recent sample the ten most recent disclosures carried four
    // renderable tickers; twenty-four carried thirteen. Asking for exactly what is displayed is
    // what left the section short. Order, filter and date semantics are untouched — this is the
    // size of the window, not the way it is sorted.
    const r = await fetch('/api/politicians?view=feed&limit=24');
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

    // ⚠️ THE SHAPING MOVED TO lib/home-model.mjs SO THE SERVER CAN RUN IT TOO.
    //
    // Everything from the raw blobs to the rendered view model used to live here, inside an async
    // function that only ever executed in an effect — which is why the server rendered headings and
    // nav and nothing else. app/page.jsx now calls the SAME buildHomeModel against the SAME cached
    // pit_snapshot and hands the result in as initialData, so the research is in the HTML before
    // any script runs. This call site is unchanged in behaviour: same inputs, same output, and the
    // default clock is Date.now() exactly as the inline version used.
    return buildHomeModel({
      tape, marketSnap, stories, insiderData, politicianData, clusterData,
      snapCatalysts: usingSnapshot ? snap?.catalysts : null, usingSnapshot, filings,
    });
  } catch (e) {
    console.error('[CatalystPit] fetchAll error:', e);
    return null;
  }
};

// The MARKETS card's indices. Module scope so the memo below has a stable dependency — rebuilt each
// render it would re-key the quote subscription on every paint.
const IDX_SYMS = ['SPY', 'QQQ', 'DIA', 'UVXY'];

/**
 * THE FRONT DOOR, NOW RENDERED TWICE FROM ONE MODEL.
 *
 * ⚠️ initialData IS THE SERVER'S RENDER OF THIS PAGE, NOT A HINT. app/page.jsx reads the cached
 * pit_snapshot, runs buildHomeModel against it and passes the result in, so the HTML a crawler
 * receives already contains the stories, the insider filings, the congressional disclosures and the
 * catalyst cards — symbols, values, dates and links — before any script executes. The effect below
 * still refetches on mount exactly as before, so a reader gets current data; the difference is that
 * the page is no longer BLANK until it lands.
 *
 * ⚠️ WHY THE FIRST CLIENT RENDER MUST USE THE PROP VERBATIM. React compares the server's HTML with
 * the browser's first render and throws the server copy away on any mismatch — which would silently
 * undo the whole point of this change. buildHomeModel is pure and every age in initialData was
 * computed against the server's clock, so reusing the prop as the initial state makes the two
 * renders identical by construction. Recomputing anything from Date.now() here would not.
 *
 * ⚠️ AND NO PRICES ARRIVE THIS WAY. page.jsx passes no tape and no market snapshot: quotes are
 * market-data-licensed and resolved per viewer by /api/quotes, so they stay exactly where they
 * were — in the effect, behind the entitlement. initialData carries public disclosure evidence only.
 */
export default function CatalystPit({ initialData = null, initialConsensus = null }) {
  const [data, setData] = useState(initialData);
  // ⚠️ SKELETONS ONLY WHEN THERE IS GENUINELY NOTHING TO SHOW. Starting this true with server data
  // already in hand would replace a rendered page with placeholder bars for one frame — a visible
  // flash of nothing, caused by the very change meant to fill the page.
  const [loading, setLoading] = useState(!initialData);
  const [lastUp, setLastUp] = useState(null);
  // Whether anything REAL is on screen yet, read inside loadData without making it a dependency.
  const hasData = useRef(!isEmptyModel(initialData));

  const loadData = useCallback(async ({ showSkeleton = false } = {}) => {
    // The ↻ button asks for the skeleton deliberately — it is the only feedback a manual refresh
    // has. The automatic refresh does not, because swapping present content for bars is worse than
    // letting it change in place.
    if (showSkeleton || !hasData.current) setLoading(true);
    const d = await fetchAll();
    // ⚠️ A FAILED REFRESH MUST NOT ERASE A RENDERED PAGE. fetchAll returns a well-formed EMPTY
    // model when its requests fail, so this used to be `if (d)` and that was safe only while the
    // first render had nothing in it to lose. With the server rendering the research, an empty
    // answer would wipe four catalyst cards, ten Form 4 rows and six disclosures off a page that
    // was already correct — and present it as a quiet market. Keeping what is on screen is the
    // honest outcome: we failed to refresh, the market did not go silent.
    if (d && !(hasData.current && isEmptyModel(d))) {
      setData(d);
      hasData.current = !isEmptyModel(d);
      setLastUp(new Date());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadData]);

  // ── ⚠️ THE FRONT DOOR ASKED FOR FOUR SYMBOLS AND DISPLAYED TWENTY ──────────
  //
  // This polled /api/quotes for SPY,QQQ,DIA,UVXY and handed them to the MARKETS card alone. The
  // ticker tape and the Market Snapshot — the two price surfaces a visitor actually sees first —
  // read `catalystpit:ticker_tape` instead: a PUBLIC, SHARED, END-OF-DAY cache written by the
  // refresh cron. So the entitlement-aware route was already here, already correct, and already
  // being consulted; it simply was not wired to the surfaces that were wrong.
  //
  // Measured on Monday 2026-11-23 at 15:35 ET, mid-session: the tape served Friday 2026-11-20
  // closes, NVDA at 125.53 against a live print of 166.55 and a delayed snapshot of 166.06. A
  // signed-in Pro subscriber and a signed-out visitor saw the identical three-day-old number under
  // the identical hardcoded word, DELAYED.
  //
  // ⚠️ ONE SUBSCRIPTION FOR EVERY PRICE ON THE PAGE. useRealtimeQuotes is the existing hook the
  // chart and the Terminal already use — it skips hidden tabs, keeps the last good quotes through a
  // dropped poll, and refreshes on tab focus. Asking for the tape's symbols as well as the indices
  // costs one request rather than two and means the tape, the snapshot and the MARKETS card cannot
  // disagree about the same symbol, which they previously did by construction.
  //
  // ⚠️ AND THE ENTITLEMENT IS NOT DECIDED HERE. /api/quotes resolves it server-side from the Clerk
  // session — real-time for an entitled subscriber, the shared 15-minute snapshot otherwise, and it
  // fails closed. Nothing in this component may widen what a reader receives; it only displays what
  // the server chose, and labels it from the freshness the server stamped.
  const tapeSyms = useMemo(
    () => (data?.tickers || []).map((t) => t.sym).filter((s) => s && s !== '?'),
    [data?.tickers],
  );
  const quoteSyms = useMemo(() => [...new Set([...IDX_SYMS, ...tapeSyms])], [tapeSyms]);
  const { quotes: idxQuotes } = useRealtimeQuotes(quoteSyms);
  const { freshness: priceFreshness, delayMinutes: priceDelayMinutes } = quotesFreshness(idxQuotes);

  // The tape and the snapshot, repriced from whatever the reader is entitled to receive. A symbol
  // the route could not answer for keeps its stored close rather than blanking — the page degrades
  // to the EOD cache it used to be instead of to nothing.
  //
  // ⚠️ maybeN, NOT safeN OR `|| 0`. A null percentage must stay null all the way to the badge, which
  // renders it as a dash. Number(null) is 0 and Number.isFinite(0) is true, which is exactly how a
  // missing change became a flat red 0.00% twice already in this codebase.
  const tickersPriced = useMemo(() => (data?.tickers || []).map((t) => {
    const q = idxQuotes?.[t.sym];
    const price = Number(q?.price);
    if (!q || !Number.isFinite(price)) return t;
    const chg = maybeN(q.changePct);
    // ⚠️ A SERVED QUOTE WITH NO PERCENTAGE MUST NOT ERASE THE ONE WE ALREADY HAVE. When the delayed
    // live print was unavailable degrades to a single close and genuinely has no move to report.
    // Overwriting the tape's real session return with that null would turn every percentage on the
    // front page into a dash, which is a worse page than the one being fixed. The price is still
    // worth taking: it is the same session the stored figure describes.
    if (chg == null) return { ...t, price };
    // ⚠️ THE BASIS TRAVELS WITH THE PERCENTAGE, IT IS NOT CLEARED. Hardcoding null here was safe
    // only while a served figure could only ever be intraday. A settled close now reports its own
    // session return, so dropping the basis would hide the "Last completed session" tooltip on
    // precisely the figure that needs it — and keeping a STALE basis would attribute today's move
    // to Friday. The server stamps which session its figure describes; this carries that through.
    return { ...t, price, chg, chgBasis: q.changeBasis ?? null, freshness: q.freshness ?? null };
  }), [data?.tickers, idxQuotes]);

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
  // Clerk's auth state, read once here for the member row count below. The teaser gate reads it
  // again through the same provider — Clerk's hooks share one context, so this is not a second
  // source of truth and costs no additional request.
  const { isLoaded: authLoaded, isSignedIn: authSignedIn } = useAuth();

  const rawNews = data?.news || [];
  const filingCards = data?.filingCards || [];

  // ⚠️ A FOUR-UP IS FOUR CLAIMS, NOT ONE CLAIM AND THREE SPACERS. Ranking alone left the tiles to
  // be filled in order, so the hero was a WSJ Fed feature and the supporting cards were
  // credit-card and crypto-advice columns. deskSelection FILTERS to HIGH and never pads — see
  // lib/impact.js. It may return fewer than four, and that is the correct page.
  // heroWorthy is false when nothing in the pool earned the big slot — no fresh high-impact story
  // and no filing — and the section then shows fresh notable stories as a compact list instead of
  // promoting one of them, or claiming the market is quiet when it plainly is not. See deskSelection.
  const { items: news, leadingWithFilings, heroWorthy } = deskSelection(rawNews, filingCards);
  const insiders = data?.insiders || [];
  // The feed is ticker-facing too: each row renders its symbol and links to /ticker/<sym>. The same
  // Liberty Mutual filing that reached the card sits in this list, so without the gate the feed would
  // print "NONE" and link to a page that cannot exist. Filtered BEFORE the slice, so excluding a row
  // promotes the next real filing rather than leaving a short list.
  // ⚠️ A SIGNED-IN MEMBER GETS THE ROWS THE BLUR WAS IMITATING, from data ALREADY FETCHED.
  //
  // /api/insiders is requested with limit=25 and /api/politicians with limit=24, and the homepage
  // renders 10 and 6 of them. The three blurred placeholder rows under each section were therefore
  // standing in front of real filings sitting unused in memory — so for a member the honest swap is
  // to draw them, not to describe them. No extra request, no fabricated record, and nothing here
  // invents a row that the filing feed did not return.
  //
  // Gated on authLoaded as well as isSignedIn so the widened slice lands in the SAME frame as the
  // teaser below it. Keyed off isSignedIn alone, the table would render 10 rows, then grow to 13 a
  // moment later — the flicker the gate itself is careful to avoid.
  const moreForMembers = authLoaded && authSignedIn;
  const insidersShown = insiders.filter((i) => isRenderableTicker(i?.sym))
    .slice(0, moreForMembers ? 13 : 10);
  const politicians = data?.politicians || [];
  const catalysts = data?.catalysts || [];
  const timeStr = lastUp ? lastUp.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit", timeZone:"America/New_York"}) : "--:--";
  // Index quotes for the MARKETS card: prefer /api/quotes, fall back to the already-loaded ticker tape.
  const tapeMap = {};
  tickersPriced.forEach((t) => { if (t.sym) tapeMap[t.sym] = { price: t.price, changePct: t.chg }; });
  const idxQ = (sym) => idxQuotes[sym] || tapeMap[sym] || null;

  const router = useRouter();
  const goTicker = (sym) => { if (sym && sym !== '?') router.push(`/ticker/${encodeURIComponent(sym)}`); };
  const goPolitician = (slug) => { if (slug) router.push(`/politicians/${encodeURIComponent(slug)}`); };

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif", background:C.bg, color:C.text, minHeight:"100vh"}}>
      <BrandStyles/>

      <TopNav/>
      <TickerTape tickers={tickersPriced} freshness={priceFreshness} delayMinutes={priceDelayMinutes}/>

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

          {/* MARKET BREADTH — directly beneath the four index charts. Reads one precomputed snapshot;
              the market-wide calculation happens in /api/cron/market-breadth, not here. */}
          <MarketBreadth />

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
                    /* ⚠️ AN ANCHOR, NOT A DIV WITH AN onClick. This card was reachable only by
                       running JavaScript and dispatching a click, so no crawler could follow it to
                       the ticker page it describes — the homepage advertised four catalysts and
                       linked to none of them. The destination and the behaviour are unchanged; it
                       is now expressed as a link, which is what it always was. */
                    <a key={i} className="hov" href={`/ticker/${encodeURIComponent(c.sym)}`}
                      style={{background:C.surface, borderRadius:7, padding:14, border:`1px solid ${C.border}`,
                        borderLeft:`3px solid ${insStyle(c.kind).fg}`, cursor:"pointer", transition:"background 0.15s",
                        display:"block", textDecoration:"none", color:"inherit"}}>
                      <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.dim,
                        letterSpacing:"0.8px", marginBottom:7}}>{c.label}</div>
                      <div style={{display:"flex", alignItems:"center", gap:7, marginBottom:5}}>
                        <TickerLogo symbol={c.sym} size={20}/>
                      <span className="cp-tkr" style={{fontFamily:"'DM Sans',sans-serif", fontSize:15, fontWeight:700, color:C.green}}>{c.sym}</span>
                        <span style={{fontSize:9, padding:"2px 7px", borderRadius:3, fontFamily:"'DM Sans',sans-serif",
                          fontWeight:600, background:insStyle(c.kind).bg, color:insStyle(c.kind).fg}}>{c.value}</span>
                      </div>
                      <div style={{fontSize:12, color:C.muted, fontWeight:300}}>{c.line}{c.date ? ` · ${c.date}` : ''}</div>
                    </a>
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
                {/* ⚠️ "SECTION UPDATED", NOT "UPDATED". This clock is when the MODULE last refreshed,
                    and beside a card it reads as the story's own time — which was actively
                    misleading while a 74-hour-old article held the hero under a timestamp from
                    minutes ago. Each card carries its own age; this one is labelled as the
                    section's. */}
                Section updated {timeStr} ET
                <button onClick={() => loadData({ showSkeleton: true })} style={{background:"transparent", border:"none",
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
                  {/* ⚠️ THE BIG SLOT IS EARNED, NOT FILLED. heroWorthy is false when nothing in the
                      pool is both high-impact and recent, and in that case these stories are drawn
                      as equals — a compact list, no 21px lead, nothing promoted. A 74-hour-old
                      banking story held this slot for three days precisely because the slot always
                      had to contain something. */}
                  {heroWorthy && (
                    <div style={{marginBottom:12}}>
                      {/* showSummary: with no image competing for the card, the lead has room for
                          the publisher's own summary — which is the difference between a headline
                          and a story. Never generated, only shown when the source supplied one. */}
                      {news.slice(0, 1).map((n, i) => (
                        <NewsPhotoCard key={i} n={n} idx={0} hero showSummary/>
                      ))}
                    </div>
                  )}
                  {/* ⚠️ NO PADDING. This was `news[1 + i] || news[i % …]`, which repeated the
                      hero to fill the grid — one story rendered as four photographs of itself.
                      Up to three supporting tiles, and fewer when there are fewer. */}
                  {news.length > (heroWorthy ? 1 : 0) && (
                    <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(190px, 1fr))", gap:12}}>
                      {news.slice(heroWorthy ? 1 : 0, 4).map((n, i) => (
                        <NewsPhotoCard key={i} n={n} idx={heroWorthy ? i + 1 : i} showSummary={!heroWorthy}/>
                      ))}
                    </div>
                  )}
                </>
              )}
              {/* The same rule, for the other conversion CTA on this page: a Pro reader already
                  has the full feed, so inviting them to unlock it is an error, not a nudge. */}
              {!loading && news.length > 0 && (
                <div style={{ marginTop: 12, padding: '10px 14px', background: C.greenLight, border: `1px solid ${C.greenBorder}`, borderRadius: 7 }}>
                  <a href="/news" style={{ fontSize: 13, fontWeight: 600, color: C.green, textDecoration: 'none' }}>
                    See all breaking market news for free →
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* PIT CONSENSUS — flagship cross-signal teaser (under Top Stories) */}
          <ConsensusTeaser initialRows={initialConsensus} />

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
                    {/* The row's onClick stays for the whole-row hit area; the symbol is also a
                        genuine <a> so the filing is DISCOVERABLE. stopPropagation keeps one
                        navigation rather than a link and a router.push racing each other. */}
                    <td style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif",
                      fontSize:13, fontWeight:600, color:C.green}} className="sym-lnk cp-tkr"><a href={`/ticker/${encodeURIComponent(ins.sym)}`} onClick={(e) => e.stopPropagation()} style={{display:"flex", alignItems:"center", gap:8, color:"inherit", textDecoration:"none"}}><TickerLogo symbol={ins.sym} size={18}/>{ins.sym}</a></td>
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
                    <td className="cp-num" style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim}}>{ins.filed ? <time dateTime={isoOrNull(ins.filed) || undefined}>{ins.filed}</time> : ins.filed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <HomeTeaserGate
              anonTitle="Sign in to explore all insider trades"
              anonSub="Free account · SEC Form 4 filings"
              proTitle="More insider research"
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
                {/* Six rows, and the skeleton is six too — a three-row placeholder that becomes a
                    six-row table makes the whole right-hand column jump on load. */}
                {loading ? Array(6).fill(0).map((_, i) => (
                  <tr key={i}><td colSpan={6} style={{padding:"12px 16px"}}><Skel h={14} mb={0}/></td></tr>
                )) : politicians.filter((p) => isRenderableTicker(p?.sym)).slice(0, moreForMembers ? 9 : 6).map((p, i, arr) => (
                  <tr key={i} className={p.slug ? "hov" : undefined} onClick={p.slug ? () => goPolitician(p.slug) : undefined}
                    style={{borderBottom:i < arr.length - 1 ? `1px solid ${C.surface}` : "none",
                    transition:"background 0.15s", cursor:p.slug ? "pointer" : "default",
                    borderLeft:`3px solid ${insStyle(p.type).fg}`}}>
                    <td style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif",
                      fontSize:13, fontWeight:600, color:C.green}} className="sym-lnk cp-tkr"><a href={`/ticker/${encodeURIComponent(p.sym)}`} onClick={(e) => e.stopPropagation()} style={{display:"flex", alignItems:"center", gap:8, color:"inherit", textDecoration:"none"}}><TickerLogo symbol={p.sym} size={18}/>{p.sym}</a></td>
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
                    <td className="cp-num" style={{padding:"11px 16px", fontFamily:"'DM Sans',sans-serif", fontSize:11, color:C.dim, whiteSpace:"nowrap"}}>{p.disclosed ? <time dateTime={isoOrNull(p.disclosed) || undefined}>{p.disclosed}</time> : p.disclosed}</td>
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
              proTitle="More congressional disclosures"
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

          <MarketSnapshotCard tickers={tickersPriced} loading={loading}
            freshness={priceFreshness} delayMinutes={priceDelayMinutes}/>

          <WatchlistHomeCard/>

          {/* ⚠️ PRO UPSELL — FREE VIEWERS ONLY. It used to render unconditionally, so a paying
              subscriber, an admin and a complimentary account were all shown a card inviting them to
              buy what they already had. FreeOnly asks the same source that protects the features. And
              when it renders nothing the card leaves no shell behind: the rail is a flex column whose
              gap only applies between children that exist, so the space closes on its own. */}
          <FreeOnly>
          <div style={{background:C.greenLight, border:`1px solid ${C.greenBorder}`,
            borderRadius:8, padding:"16px"}}>
            <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.green,
              letterSpacing:"1.5px", marginBottom:8}}>GO AD-FREE</div>
            <ul style={{listStyle:"none", display:"flex", flexDirection:"column", gap:6, marginBottom:12}}>
              {/* ⚠️ THIS LIST IS A PROMISE. Each line is something a paying user receives today.
                  "Options flow & dark pool" was removed because it is a product we do not have and
                  have no feed for — selling a feed we are not licensed for is the one marketing
                  mistake that is also a contract problem.

                  ⚠️ AND THE CHART LINE NOW MATCHES THE ENTITLEMENT AGAIN. It read "end-of-day",
                  written when the realtime path was switched off. It is not: /api/chart-intraday
                  serves Tiingo intraday bars under our own licence and /api/chart-daily serves
                  Tiingo daily, so a Pro user gets intraday timeframes. Meanwhile Pit Scan prints
                  REAL-TIME and the heatmap says "licensed real-time market data" — the upsell was
                  the one surface still describing the old entitlement, which understated the
                  product rather than overselling it, but was equally inaccurate.

                  ⚠️ WHAT MUST NOT CHANGE: this line describes CHART COVERAGE, not a promise that
                  every quote on every surface is real-time. Freshness is per-surface and each one
                  labels itself (LIVE / DELAYED / LAST CLOSE). Do not generalise this to "real-time
                  market data" across the product. */}
              {["All market intelligence remains free", "Browse research with fewer distractions", "No ads while your membership is active"].map(f => (
                <li key={f} style={{fontSize:12, color:C.green, display:"flex", gap:7,
                  alignItems:"center", fontWeight:400}}>
                  <span style={{fontWeight:700, fontSize:10, color:C.green}}>✓</span>{f}
                </li>
              ))}
            </ul>
            {/* ⚠️ WAS A MONTHLY BUTTON PLUS A SMALL "or save with $200/year" LINK. That link was the
                only route to the annual price anywhere in the product, and it read as an afterthought
                next to a full-width primary button. Both plans are published in the Terms, so both get
                equal standing at the point of decision. */}
            <PlanChoice align="center" cta="Go ad-free" />
          </div>
          </FreeOnly>

          {/* CATALYST PIT FEAR & GREED — the compact rail read. Deliberately score + zone + scale
              + the three comparison points only; the five-component breakdown and the history chart
              need room to be readable and live on /fear-greed, which the whole card links to. */}
          <FearGreedCard/>

          {/* MARKET HEAT MAP — full-market treemap. Replaces the old compact insider/politician
              rails (which duplicated the main tables on the homepage). */}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden"}}>
            <div style={{padding:"10px 14px", borderBottom:`1px solid ${C.border}`,
              background:C.surface, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <span style={{fontSize:12, fontWeight:600, color:C.ink}}>MARKET HEAT MAP</span>
              {/* The card used to send you to the Terminal because that was the only other place a
                  heat map existed. /heatmap is the dedicated page now, so the CTA names what it
                  opens instead of naming a room that happens to contain one. */}
              <a href="/heatmap" style={{fontSize:11, color:C.green, cursor:"pointer", fontWeight:400, textDecoration:"none", whiteSpace:"nowrap"}}>View heat map →</a>
            </div>
            <div style={{height:340}}><HeatMap limit={120} shared/></div>
          </div>

        </div>
      </div>

      <Footer/>
    </div>
  );
}
