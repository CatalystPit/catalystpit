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
