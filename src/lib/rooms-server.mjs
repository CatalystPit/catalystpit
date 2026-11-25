// ── WHAT THE SERVER READS TO RENDER THE RESEARCH ROOMS ─────────────────────
//
// The front door was fixed first (lib/home-server.mjs). This is the same change for the rooms
// behind it, and it is the same mechanism for the same measured reason.
//
// ⚠️ THE MEASUREMENT THIS EXISTS TO ANSWER. Fetched from production as Googlebot with no
// JavaScript, 2026-11-24 (scripts/measure-crawl-surface.mjs):
//
//     route          words  /ticker links  <time>  tbody
//     /dividends     4,958            298       0      6
//     /insiders        376              0       0      0
//     /politicians     264              0       0      1   ← a table with no rows
//     /scan            189              0       0      0
//     /institutions    177              0       0      0
//     /consensus       163              0       0      0
//     /news            129              0       0      0
//     /screener          4              0       0      0
//
// Nine of twelve indexable rooms served a crawler the column headings and nothing underneath
// them. The titles already name what a reader searches for — "Insider Trading Tracker · SEC Form 4
// Buys and Sells", "Congress Stock Trades", "13F Filings" — and the document behind each one was
// empty. Not an indexing fault: robots, canonicals, descriptions and sitemap agreement all checked
// out, and all eight permitted agents received identical bytes. The pages had nothing to read.
//
// ⚠️ WHAT MAKES ONE SHARED COPY SAFE, AND IT IS NOT AN ASSUMPTION. Three rules, each enforced
// below rather than promised:
//
//   1. NO SESSION. No auth(), no cookies(), no headers(), no Clerk, nothing about who is asking.
//      The root layout avoids auth() deliberately so that 141 pages can stay static; this module
//      must not undo that. Every reader here is a pure function of a cache key or an indexed
//      query.
//   2. NO MARKET DATA. Prices, quotes and the ticker tape are licensed, resolved per viewer by
//      /api/quotes, and that route fails closed. They stay client-side and arrive after
//      hydration, exactly as they do today. What is baked into shared HTML is PUBLIC DISCLOSURE
//      EVIDENCE: Form 4 filings, STOCK Act disclosures, 13F holdings, 8-K filings, published
//      newsroom headlines. Baking a quote into cached public HTML is a licensing decision, and
//      this change does not make it.
//   3. FREE-TIER FRESHNESS, APPLIED BY THE SAME RULE THE ROUTES APPLY. Insider, congressional and
//      institutional rows are gated by FRESHNESS, not by row count — eodCutoffIso(tier) returns
//      the last COMPLETED session close for free, and null for Pro. So every reader here passes
//      the free cutoff and gets exactly what an anonymous visitor is entitled to. Imported from
//      lib/entitlement-rules.mjs, never re-derived: that module was split out of entitlements.js
//      precisely so the rule could be used without Clerk.
//
//      ⚠️ AND THE STALENESS RUNS IN THE SAFE DIRECTION. HTML generated at T carries the cutoff as
//      it was at T. The cutoff only ever moves FORWARD, so a page regenerated at T and served at
//      T+300 shows a SUBSET of what a visitor is entitled to by then — never a superset. There is
//      no window in which cached HTML can out-run the entitlement.
//
// ⚠️ EVERY READER RETURNS null ON ANY FAILURE — NEVER A THROW, AND NEVER [] DRESSED AS AN ANSWER.
// null means "we could not read this", which leaves the client's own fetch to fill the page in and
// degrades to exactly the behaviour that shipped before this change. [] would mean "there are no
// insider filings", which is a claim about the market rather than about us. That distinction is
// the one /api/eightk and the consensus board both learned the hard way, and it is why a cache
// outage here costs a crawler the research but never costs a reader the page.
import { unstable_cache } from 'next/cache';
import { eodCutoffIso } from './entitlement-rules.mjs';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// A page regeneration must not hang on a cache. If KV is slow we publish the shell and the browser
// fills it in, which is strictly better than a stalled build or a timed-out render.
const KV_TIMEOUT_MS = 2500;

// ⚠️ THE ISR WINDOW, AND IT IS A CEILING SET BY THE WRITERS. The crons that publish what these
// pages read run at 15 minutes (pit-snapshot), hourly on weekdays (refresh-content) and on the
// consensus refresh policy. The rule /api/market was corrected to follow — a TTL may be shorter
// than the write cadence but never longer — holds here too, so five minutes cannot serve HTML more
// than one generation behind the data it came from. Each page repeats this as a LITERAL because
// Next statically analyses `export const revalidate` at build time and an imported identifier is
// not a literal it can read: it is accepted and then silently ignored. verify-rooms-ssr asserts
// that every page's literal equals this constant.
export const ROOM_CACHE_SECONDS = 300;

// ── ⚠️ `cache: no-store` HERE WOULD MAKE EVERY ROOM DYNAMIC, WHICH IS THE OPPOSITE OF THE POINT
//
// This is the trap the homepage change documents, and it has already been measured twice in this
// repo. An uncached fetch inside a server component opts the WHOLE route out of static generation,
// so every visitor to every room would pay a KV round-trip before first byte — a performance
// regression introduced by an SEO change, which is the one trade this work is not allowed to make.
// `next: { revalidate }` is the opposite instruction: cache the read for the same window the page
// is regenerated on. The two numbers must stay equal.
//
// ⚠️ AND THIS IS WHY THE CONSENSUS BOARD IS READ BY KEY HERE RATHER THAN THROUGH
// readPublishedBoard(). That function is the right reader for a request — and it reaches kvGetJson
// in lib/consensus/materialization.mjs, which uses no-store (correctly, for a request-time read)
// and would therefore have made /consensus dynamic. Same keys, same fallback order, same
// fail-soft, cacheable read. The key FUNCTIONS are imported so the deployed methodology version
// stays part of the key.
//
// ⚠️ lib/home-server.mjs HAS ITS OWN COPY OF THIS FUNCTION AND THAT IS DELIBERATE, NOT DRIFT.
// verify-home-ssr pins the literal `next: { revalidate: HOME_CACHE_SECONDS }` inside that file, so
// hoisting the body out of it would fail a suite that is guarding the live homepage. Instead
// verify-rooms-ssr asserts the RULE in both files — that each reads with `next: { revalidate }`
// and that neither contains a no-store read — which is the property that actually matters.
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      signal: AbortSignal.timeout(KV_TIMEOUT_MS),
      next: { revalidate: ROOM_CACHE_SECONDS },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.result == null) return null;
    let v = d.result;
    // Upstash returns a string, and some writers double-encode it. Same handling as /api/news.
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* a plain string is fine */ } }
    return v;
  } catch { return null; }
}

/** The free tier's freshness boundary, captured once per generation. See rule 3 above. */
export const freeCutoff = (now = Date.now()) => eodCutoffIso('free', now);

// ── shared: the canonical material-8-K read ────────────────────────────────
//
// ⚠️ ONE QUERY PER REVALIDATION, NOT PER VISITOR, AND NO DDL. `ensure: false` skips
// ensureEightkTable's four CREATE … IF NOT EXISTS statements, which have no business running while
// a public page is generated. Any failure — unreachable database, missing table, a build with no
// DATABASE_URL — returns [] and the page degrades to what it rendered before.
async function readMaterialFilings({ limit = 40, days = 7 } = {}) {
  try {
    const { recentEightK } = await import('./eightk.js');
    const list = await recentEightK({ materialOnly: true, limit, days, ensure: false });
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// ── /news ──────────────────────────────────────────────────────────────────
//
// ⚠️ THE ONE ROOM WHERE NOTHING IS GATED AT ALL, AND THE ROUTE SAYS SO IN ITS OWN WORDS:
// "Market news is free without an account" — data = raw, lockedCount = 0. The auth() call that
// remains in /api/news sets a loggedIn flag for reporting and gates nothing. So the server can
// render the entire river, not a teaser of it.
//
// ⚠️ AND NO TAPE. fetchNews also pulls ticker_tape for the strip and the Market Snapshot card.
// Those are prices (rule 2), so `tickers` stays null here and the browser fills it in — which is a
// state the component already handles, because an empty tape has always been possible.
/**
 * The news river in NewsFeed's own display shape, or null.
 * @returns {Promise<{articles: object[], tickers: null, lockedCount: number}|null>}
 */
export async function readNewsRoom({ now = Date.now() } = {}) {
  try {
    const [{ buildNewsRiver }, { normalizeArticles }, { filingsToStories }] = await Promise.all([
      import('./news-river.mjs'),
      import('./news-feed-view.mjs'),
      import('./news-filings.mjs'),
    ]);

    // ⚠️ SETTLED INDEPENDENTLY, BECAUSE ONE FAILURE MUST NOT COST THE OTHERS. A missing wire pool
    // still leaves a page full of journalism and filings; an unreachable filings table leaves the
    // journalism-only river the page rendered before this change.
    const [curated, wire, filings] = await Promise.all([
      kvGet('catalystpit:top_stories').then((v) => (Array.isArray(v) ? v : [])).catch(() => []),
      kvGet('catalystpit:wire_news').then((v) => (Array.isArray(v) ? v : [])).catch(() => []),
      readMaterialFilings({ limit: 40 }).then((f) => filingsToStories(f)).catch(() => []),
    ]);

    // ⚠️ null, NOT AN EMPTY FEED. Nothing readable anywhere means "we could not read the news",
    // and the component's own loading state is the honest rendering of that.
    if (!curated.length && !wire.length && !filings.length) return null;

    const articles = normalizeArticles(buildNewsRiver({ curated, wire, filings }, { now }), { now });
    return articles.length ? { articles, tickers: null, lockedCount: 0 } : null;
  } catch { return null; }
}

// ── /insiders ──────────────────────────────────────────────────────────────
//
// ⚠️ THE ROW LIST IS NOT ROW-GATED, AND THE ROUTE IS EXPLICIT ABOUT IT: "All paginated historical
// research is publicly available." Free is the end-of-day research product — full history,
// paginated — and what Pro buys is FRESHNESS. So the first screen of this room is public, and the
// only thing a shared copy must get right is the cutoff.
//
// ⚠️ WHICH IS WHY THIS PASSES THE FREE CUTOFF EXPLICITLY RATHER THAN DEFAULTING TO null.
// insiderRoomRows takes `cutoff` as a required decision precisely so that no caller can forget
// it: null means "no freshness limit", which is correct for a Pro request and would be a licensing
// leak in cached public HTML. This page is read by everyone, so it gets what everyone is entitled
// to — and the measured consequence of getting this wrong is on record: an anonymous caller asking
// /api/insiders?ticker=GOOGL was once served 48 rows ingested after the Free cutoff.
//
// ⚠️ THE INTELLIGENCE SECTIONS (Pulse, Heatmap, Notable) ARE DELIBERATELY NOT HERE. They are three
// more round-trips for aggregates the client already fetches on its own, and the row table is what
// carries the research a crawler needs: issuer, insider, role, action, size and date, with a link
// to each company. Adding them is a follow-up, not a prerequisite.
/**
 * The first page of the latest open-market insider filings, in InsidersClient's payload shape,
 * or null.
 * @returns {Promise<{view: string, trades: object[], page: number, pageSize: number, total: number}|null>}
 */
export async function readInsidersRoom({ now = Date.now() } = {}) {
  try {
    const { insiderRoomRows } = await import('./insider-queries.mjs');
    // pageSize 50 is InsidersClient's own default (useState(50)) and the route's default, so the
    // server renders the same first page the browser would have asked for.
    const payload = await insiderRoomRows({
      view: 'latest', cutoff: freeCutoff(now), page: 0, pageSize: 50,
    });
    return payload?.trades?.length ? payload : null;
  } catch { return null; }
}

// ── /politicians ───────────────────────────────────────────────────────────
//
// ⚠️ ALSO NOT ROW-GATED — every lockedCount in /api/politicians is a literal 0, and the route's
// own comments mark the detail and ticker views "LEFT UNGATED". Free is the full history; Pro is
// freshness. So the member list is public and the only thing a shared copy must get right is the
// cutoff, which is why ctCut moved to lib/congress-overview beside listView: a second copy of a
// freshness gate is a licensing leak waiting to be written.
/**
 * The member list in PoliticiansList's payload shape, or null.
 * @returns {Promise<{members: object[], meta: null, lockedCount: number}|null>}
 */
export async function readPoliticiansRoom({ now = Date.now() } = {}) {
  try {
    const { listView } = await import('./congress-overview.js');
    // 'most_active' is PoliticiansList's own default view, so the server renders the same first
    // screen the browser would have asked for. chamber and party are the component's empty
    // defaults — a filtered view belongs to a request, not to a shared page.
    const members = await listView({
      view: 'most_active', chamber: null, party: null, cutoff: freeCutoff(now),
    });
    // ⚠️ meta IS null ON PURPOSE. It is the leaderboard's sample-size metadata and only the
    // 'leaderboard' view produces it; the client already reads `json.meta || null`.
    return Array.isArray(members) && members.length
      ? { members, meta: null, lockedCount: 0 }
      : null;
  } catch { return null; }
}

// ── /markets ───────────────────────────────────────────────────────────────
//
// ⚠️ THE ONE ROOM WITH NO PRICE QUESTION TO ANSWER AT ALL, AND ITS OWN SOURCE SAYS SO:
// "C4 — Markets = 'names with catalysts today' from the pit_snapshot. NO last-sale/prices
// (compliance): this is a catalyst board (filings + Congress + headlines), not a gainers tape."
//
// So this reads the same `catalystpit:pit_snapshot` blob the homepage already reads — session-less,
// rebuilt by cron every ~15 minutes, identical for every visitor — and there is no EOD-versus-
// delayed decision to make here, because the room contains no market data in the first place.
//
// ⚠️ AND THE FOUR KEYS ARE NAMED RATHER THAN THE BLOB PASSED THROUGH. If a future snapshot gains a
// `tape` or a `marketSnap` — both of which the homepage reader explicitly refuses — passing the
// whole object would quietly publish prices into cached HTML on the next cron deploy. Naming the
// keys makes rule 2 structural instead of a promise. MarketsClient reads exactly these four.
/**
 * The catalyst board in MarketsClient's own shape, or null.
 * @returns {Promise<{catalysts: object[], insiders: object[], congress: object[], stories: object[]}|null>}
 */
export async function readMarketsRoom() {
  try {
    const snap = await kvGet('catalystpit:pit_snapshot');
    if (!snap || typeof snap !== 'object') return null;
    const pick = (v) => (Array.isArray(v) ? v : []);
    const out = {
      catalysts: pick(snap.catalysts),
      insiders: pick(snap.insiders),
      congress: pick(snap.congress),
      stories: pick(snap.stories),
      generatedAt: snap.generatedAt ?? null,
    };
    // The same usability test the homepage reader applies, so the two agree about when there is a
    // snapshot at all. Nothing readable means null, never four empty arrays presented as a quiet
    // market.
    return (out.catalysts.length || out.insiders.length || out.congress.length || out.stories.length)
      ? out : null;
  } catch { return null; }
}

// ── /fear-greed ────────────────────────────────────────────────────────────
//
// ⚠️ FIRST-PARTY RESEARCH WITH NO PRICE IN IT. The index is a 0-100 score computed daily from
// components that are each scored against their own distribution; what reaches a reader is the
// score, the zone, the component scores and the methodology. No quote, no last sale, no tape — so
// there is no EOD-versus-delayed question here either.
//
// ⚠️ AND THE STRIPPING IS NOT RE-IMPLEMENTED. What /api/fear-greed publishes is a DISCLOSURE
// boundary — the normalisation window, the refusal threshold, the methodology version and each
// component's sample count are deliberately withheld, and one of those leaks was once caught
// against the live response rather than the source. fearGreedPublicPayload is that one function;
// a copy of it here would put the recipe into cached public HTML.
/**
 * The index as a reader may see it, or null. Note that an UNAVAILABLE index is a real answer and
 * is passed through — "we have not computed it" is a fact about us, and the component renders it.
 * null is reserved for "the read itself failed".
 * @returns {Promise<object|null>}
 */
// ⚠️ WRAPPED, BECAUSE THE STORE READS KV WITH no-store AND THAT MADE THE PAGE DYNAMIC. Measured:
// adding this reader flipped /fear-greed from `○ 300s` to `ƒ`. readPayload reaches kvGetJson in
// lib/consensus/materialization.mjs — the same `cache: 'no-store'` read that forced /consensus to
// be fetched by key instead of through readPublishedBoard. Here the key is versioned and the
// reshape-from-history fallback is a database query, so bypassing the module would mean
// re-implementing both; unstable_cache is the house answer to exactly this (see
// lib/ticker-seo.server.mjs) and it keeps the page prerendered.
const cachedFearGreed = unstable_cache(
  async () => {
    const { fearGreedPublicPayload } = await import('./fear-greed/public-payload.mjs');
    return fearGreedPublicPayload();
  },
  ['fear-greed-public-payload'],
  { revalidate: ROOM_CACHE_SECONDS, tags: ['fear-greed-public-payload'] },
);

export async function readFearGreedRoom() {
  try {
    const payload = await cachedFearGreed();
    return payload && typeof payload === 'object' ? payload : null;
  } catch { return null; }
}

// ── /heatmap's leadership lists ─────────────────────────────────────────────
//
// ⚠️ THE BOARD WAS ALREADY SERVER-RENDERED AND THE PAGE STILL MEASURED 231 WORDS WITH NO LINKS,
// FOR A REASON WORTH RECORDING: the treemap is drawn on a <canvas>, so the board itself can never
// be crawlable text however well it is rendered. The leadership lists beside it are ordinary DOM
// with ticker links in them — and they were the half still arriving in an effect.
//
// ⚠️ AND THE EMPTY STATE WAS PUBLISHING A FINDING IT DID NOT HAVE. With `movers` null the lists
// rendered "Nothing to rank for this window." into cached HTML — the same class of defect as
// /institutions' "No position changes disclosed": a claim about the market made while we had
// simply not asked. Rendering them on the server fixes the content; the component change beside
// it fixes the claim.
//
// ⚠️ realtime: false IS THE WHOLE POINT, AND marketMovers HONOURS IT STRUCTURALLY. That path calls
// completedSessionMovers and makes NO vendor request at all — "Free, signed out, or vendor realtime
// disabled → the completed-session list. No Tiingo call." So this is licensed previous-session
// closing data by construction, not by a flag someone has to remember, and no provider call is
// added to any crawler request.
/**
 * The completed-session top gainers and losers, or null.
 * @returns {Promise<{gainers: object[], losers: object[], asOf: string|null, baselineDate: string|null, freshness: string}|null>}
 */
// ⚠️ WRAPPED FOR THE SAME REASON AND IT WAS MEASURED THE SAME WAY: adding this reader flipped
// /heatmap from `○ 300s` to `ƒ`, which would have handed every anonymous reader the 2,431ms cold
// render that page's own cache was created to remove — a performance regression introduced by an
// SEO change, the one trade this work is not allowed to make. completedSessionMovers reads its
// session-keyed KV entry through a POST with `cache: 'no-store'`, so the uncached fetch is inside
// a function worth keeping whole: it is session-keyed rather than TTL'd, which is the property
// that makes a new candle load switch the board over immediately.
//
// ⚠️ THE WINDOW IS DELIBERATELY NOT THE SESSION KEY. unstable_cache re-reads every
// ROOM_CACHE_SECONDS, so the page picks up a new completed session within one window of the
// nightly load rather than holding yesterday's board until a deploy.
const cachedMovers = unstable_cache(
  async () => {
    const { marketMovers } = await import('./movers/movers-store');
    // realtime: false takes the completedSessionMovers path and makes NO vendor request —
    // "Free, signed out, or vendor realtime disabled → the completed-session list. No Tiingo call."
    return marketMovers({ realtime: false, limit: 10 });
  },
  ['heatmap-eod-movers'],
  { revalidate: ROOM_CACHE_SECONDS, tags: ['heatmap-eod-movers'] },
);

export async function readMoversRoom() {
  try {
    const m = await cachedMovers();
    if (!m || (!m.gainers?.length && !m.losers?.length)) return null;
    // ⚠️ A SHARED COPY MUST NOT CARRY A REALTIME LABEL EVEN IF ONE SOMEHOW ARRIVED. The realtime
    // path is unreachable from here by construction, so this is a belt on top of braces rather
    // than a fix — but a cached page that claimed 'realtime' would be a licensing problem, not a
    // cosmetic one, and refusing it costs nothing.
    if (m.freshness && m.freshness !== 'eod') return null;
    return m;
  } catch { return null; }
}

// ── /scan ──────────────────────────────────────────────────────────────────
//
// ⚠️ THE BOARDS ALREADY SHOWED THE LAST COMPLETED SESSION TO EVERYONE, AND ALREADY SAID SO.
// ScanClient's own header: "Realtime is not entitled, so what these boards show is the last
// completed session. A page headed 'what is moving right now' that quietly showed yesterday's move
// would be the one failure this scanner was built to refuse." The feed state is printed once at the
// top and again on every row. So the basis was never the problem — the boards were simply arriving
// after JavaScript, leaving 189 words and no ticker links for a crawler.
//
// ⚠️ realtime: false IS STATED, NOT RESOLVED, AND THAT IS WHAT KEEPS THE PAGE STATIC. loadScanContext
// used to call callerHasRealtime() unconditionally; a shared cached page has no caller to resolve,
// and the auth() behind that call would have made the route per-request. The override can only
// narrow — `stated === false` is the entire gate — so no caller can grant itself realtime by
// asserting it, and the realtime snapshot path is not reached at all from here.
//
// ⚠️ WRAPPED, BECAUSE THE EOD PATH STILL ASKS getQuotes FOR THE CLOSES. One call per revalidation
// window rather than one per crawl, which is the difference between a cached page and the
// "expensive provider call on every crawler request" this work is not allowed to add.
const cachedScanBoards = unstable_cache(
  async () => {
    const { buildAllScanBoards } = await import('./scan/board-payload');
    return buildAllScanBoards({ realtime: false });
  },
  ['scan-boards-eod'],
  { revalidate: ROOM_CACHE_SECONDS, tags: ['scan-boards-eod'] },
);

/**
 * All three completed-session Scan boards, or null.
 * @returns {Promise<{boards: object, degraded: boolean}|null>}
 */
export async function readScanRoom() {
  try {
    const out = await cachedScanBoards();
    // ⚠️ degraded MEANS THE EVIDENCE BOARD COULD NOT BE READ, which is not an empty market. The
    // client's own fetch handles that state, including its 503 path, so a degraded build is null
    // here rather than a page that renders three empty boards as a finding.
    if (!out || out.degraded) return null;
    const any = Object.values(out.boards || {}).some((b) => (b?.rows || []).length);
    return any ? out : null;
  } catch { return null; }
}

// ── /screener ──────────────────────────────────────────────────────────────
//
// ⚠️ FOUR WORDS. That was the measurement, as Googlebot, on a page in our own sitemap at priority
// 0.7 aimed at one of the highest-volume non-branded phrases in the category.
//
// ⚠️ AND IT IS EOD BY SOURCE, NOT BY A FLAG. screener_stocks.price/.changePct/.volume are written
// from ticker_daily_candles — previous-session closing values, the basis a guest or a crawler may
// be shown. The delayed and real-time overlay is a separate, per-viewer concern that
// ScreenerClient applies from /api/quotes after hydration, so nothing of either is rendered or
// cached here. See lib/screener-page.mjs.
//
// ⚠️ THE FILTER METADATA IS DELIBERATELY NOT INCLUDED. /api/screener?meta=1 carries
// `quoteFreshness`, which is resolved from the CALLER's entitlement — a per-viewer freshness claim
// that must not be baked into a shared copy. The chips keep arriving from that fetch, exactly as
// before; only the rows move to the server.
/**
 * The screener's unfiltered opening page, or null.
 * @returns {Promise<{rows: object[], total: number, page: number, pageSize: number}|null>}
 */
export async function readScreenerRoom() {
  try {
    const { screenerDefaultPage } = await import('./screener-page.mjs');
    return await screenerDefaultPage();
  } catch { return null; }
}

// ── /institutions ──────────────────────────────────────────────────────────
//
// ⚠️ THIS ROOM IS ROW-GATED AND THE OTHERS ARE NOT, WHICH CHANGES WHAT CAN HONESTLY BE DONE HERE.
// /api/institutions wraps every payload in publicCap: a logged-OUT caller sees at most ten rows of
// any array, with the remainder reported as a locked count. Measured against production as an
// anonymous caller: directory 10 rows / 38 locked, largest 10 / 14, featured 10 / 33,
// latest-filings 10 / 15 — out of a registry of 10,013 institutions.
//
// That cap is a LOGIN FUNNEL, not a licensing limit — the route says so: "Logged-out sees at most
// PUBLIC_ROWS records; signed-in Free sees the full history at the EOD cutoff." A crawler is
// always logged out, so this room can never show a crawler more than ten rows however it is
// rendered. Whether the directory of 10,013 managers should be crawlable at all is a decision
// about the funnel and belongs to the owner, not to this change.
//
// ⚠️ SO WHAT IS RENDERED IS THE TEN MOST CITABLE ROWS IN THE ROOM, NOT A TOKEN SAMPLE. Each 13F
// filing carries the organization, the reporting period, the disclosure date, the holdings count,
// a link to our own research on that manager and a link to the primary document on SEC EDGAR —
// a complete, attributed, dated fact with no number of our own invention in it. The directory and
// the activity feed depend on six route-local helpers between them and are deliberately left for
// a later pass; a thin extraction of a licensed query is worse than none.
/**
 * The latest 13F filings, capped exactly as an anonymous caller is capped, or null.
 * @returns {Promise<{filings: object[], filingsLockedCount?: number, publicPreview: boolean}|null>}
 */
export async function readInstitutionsRoom({ now = Date.now() } = {}) {
  try {
    const { latestFilings, latestActivity, publicCap } = await import('./institutions-queries.mjs');
    const cutoff = freeCutoff(now);
    // ⚠️ THE ACTIVITY FEED IS THE DEFAULT TAB, AND LEAVING IT OUT PUT THE RESEARCH BEHIND A TAB NO
    // CRAWLER SELECTS. The first version of this reader server-rendered only the filings list;
    // measured on the build output, that left /institutions at 251 words with no manager links in
    // the crawlable path, because LatestActivity opens on 'activity'. Both halves now arrive.
    //
    // ⚠️ SETTLED INDEPENDENTLY. The activity query is a multi-CTE comparison across filing pairs
    // and the filings list is one indexed select; a failure in the heavier one must not cost the
    // lighter one, and either half alone is still a real improvement on an empty room.
    const [filings, activity] = await Promise.all([
      latestFilings(25, cutoff).catch(() => []),
      latestActivity({ cutoff }).catch(() => []),
    ]);
    if (!filings.length && !activity.length) return null;
    // ⚠️ loggedIn: false IS NOT A DEFAULT BEING RELIED ON, IT IS THE STATEMENT. Shared HTML is the
    // logged-out view by definition, so it gets the logged-out cap — the same ten rows, with the
    // same locked counts, that /api/institutions hands an anonymous browser.
    //
    // ⚠️ AND NOTHING HERE IS A PRICE. A 13F position change is a disclosed holding count and value
    // as of a quarter end, published by the filer; it carries no quote and no last sale, which is
    // what makes it publishable in a shared copy regardless of the EOD-versus-delayed line.
    return publicCap({ view: 'institutions-room', filings, activity }, { loggedIn: false });
  } catch { return null; }
}

// ── /consensus ─────────────────────────────────────────────────────────────
//
// ⚠️ ALSO UNGATED, AND ALSO IN THE ROUTE'S OWN WORDS: "First-party evidence intelligence is free
// for all visitors" — rows = full, lockedCount = 0, and /api/consensus-board calls no auth() at
// all. This is the site's most distinctive research and it was 163 words of boilerplate to a
// crawler.
//
// ⚠️ A READ NEVER COMPUTES. The route schedules a rebuild when the board is missing or was built
// by an older methodology; a page REGENERATION must not, because a regenerating page is not a
// reader asking a question. A missing board returns null and the client's fetch handles it,
// including the 503 degraded path, exactly as before.
/**
 * The published evidence board in ConsensusClient's payload shape, or null.
 * @returns {Promise<{rows: object[], universe: number|null, builtAt: string|null, lockedCount: number}|null>}
 */
export async function readConsensusRoom() {
  try {
    const [{ boardKey, LAST_GOOD_KEY }, { displayFacts }] = await Promise.all([
      import('./consensus/materialization.mjs'),
      import('./consensus/board-display.mjs'),
    ]);
    const board = (await kvGet(boardKey())) || (await kvGet(LAST_GOOD_KEY));
    if (!board || !Array.isArray(board.rows)) return null;
    const rows = board.rows.map(displayFacts);
    return {
      rows,
      universe: board.universe ?? null,
      builtAt: board.builtAt ?? null,
      lockedCount: 0,
    };
  } catch { return null; }
}
