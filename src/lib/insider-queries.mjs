// ── THE INSIDER READ, DEFINED ONCE ─────────────────────────────────────────
//
// ⚠️ MOVED OUT OF /api/insiders BECAUSE THE SERVER NOW RENDERS THAT ROOM TOO.
//
// These four predicates and the row-view registry decided what /api/insiders would serve, and they
// lived inside the route — which was correct while a browser fetch was the only way to reach them.
// app/insiders/page.jsx now renders the room's first screen at generation time, so "which Form 4
// rows may be shown, in what order" is asked from two places. Two copies of a predicate like
// NOT_SUPERSEDED is how a retracted filing comes back: one caller is fixed and the other is not.
//
// So the RULES live here and both callers import them. What stays in the route is its own filter
// layer — fifteen optional query parameters that belong to a request, not to a page.
//
// ⚠️ NOTHING IN THIS FILE CHANGED ITS MEANING IN THE MOVE. Same SQL, same view configs, same
// enrichment, same comments. verify-rooms-ssr asserts the route no longer defines its own copy.
import { db } from './db';
import { insiderTrades } from './schema';
import { and, or, eq, gt, gte, ilike, inArray, desc, sql } from 'drizzle-orm';
import { ownershipChangePct as ownPctShared } from './insider-format';

// ⚠️ A ROW WHOSE TICKER IS NOT A SYMBOL MUST NOT LEAVE THIS QUERY.
//
// /api/insiders was serving "NONE · $9.8M · 5C Lending Partners Corp · LIBERTY MUTUAL HOLDING Co
// INC." — the exact row, by accession, that the security master was written about after it reached
// the homepage. Every other ticker-facing surface gates on isRenderableTicker; this one never did,
// so the one list whose entire subject is insider filings was also the one still showing the
// unusable ones.
//
// The ingest gate added to /api/refresh stops new rows arriving, but rows already in the table
// outlive it, so the read needs its own guard. This is the SQL twin of isIngestableTicker in
// lib/security-identity.mjs, deliberately matching the standard the table now admits rather than
// the stricter card rule: the card rule would additionally hide AXIA3 (391 rows), BRK.A and NYT.A
// from the list, which is a product decision, not a dirt fix.
//
// It filters the READ. Nothing is deleted here, and a row hidden by this predicate is still in the
// table with its accession and CIK intact.
export const TICKER_IS_A_SYMBOL = sql`${insiderTrades.ticker} is not null
  and trim(${insiderTrades.ticker}) <> ''
  and length(trim(${insiderTrades.ticker})) <= 10
  and upper(trim(${insiderTrades.ticker})) not in
    ('NONE','NULL','N/A','UNKNOWN','UNDEFINED','NIL','TBD','ERROR','MISSING','PLACEHOLDER')
  and upper(trim(${insiderTrades.ticker})) ~ '^[A-Z][A-Z0-9]*([.-][A-Z0-9]+)*$'`;

// ⚠️ A FILING THE FILER HAS ALREADY RETRACTED MUST NOT LEAVE THIS QUERY EITHER.
//
// The Form 4/A work populated superseded_by on 1,591 rows and added the guard to eight consumers.
// /api/insiders was not one of them — the single most insider-centric surface in the product — so
// it still served the version a 4/A was filed to correct. In production the `top` view, which
// sorts by value descending, had as its #1 row:
//
//   MYNZ  BUY  643,850 shares @ $402,000  =  $258,827,700,000
//
// The filer had mistyped the price and corrected it the same week to 685,000 @ $1.51 ($1.03M). Our
// lineage caught the amendment and marked the original superseded; the response even carried
// supersededBy back to the client. Nothing read it, so a $258 billion insider purchase that never
// happened was the headline number on the page.
//
// ⚠️ THE SUPERSESSION HALF ONLY, NOT `is_amendment is not true` AS WELL. ticker-seo and
// x-reply-context pair both predicates because they quote a short digest and a restatement there
// reads as a second event. This is the transaction LIST, and pairing both would drop the amendment
// too — hiding MYNZ's real $1.03M purchase along with the phantom one. Excluding only superseded
// rows leaves exactly one version of every filing: the original when it was never amended, the
// correction when it was. That is the lossless reading of the same canonical rule.
export const NOT_SUPERSEDED = sql`insider_trades.superseded_by IS NULL`;

export const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

export const ROW_VIEWS = {
  latest: {
    // Open-market only (P/S). Awards, gifts, tax-withholding, option exercises etc. are NOT trades —
    // they only surface here as 'all' or in an insider NAME search (labeled).
    where: inArray(insiderTrades.action, ['BUY', 'SELL']),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.id)],
  },
  all: {
    // Raw firehose — EVERY Form 4 of every type (award/gift/tax/exercise/buy/sell), newest first.
    where: null,
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.id)],
  },
  buying: {
    where: eq(insiderTrades.action, 'BUY'),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
  selling: {
    where: eq(insiderTrades.action, 'SELL'),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
  ceo: {
    where: and(
      eq(insiderTrades.action, 'BUY'),
      or(ilike(insiderTrades.title, '%chief executive%'), ilike(insiderTrades.title, '%CEO%')),
    ),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
  top: {
    where: and(inArray(insiderTrades.action, ['BUY', 'SELL']), gt(insiderTrades.totalValue, 0)),
    orderBy: [desc(insiderTrades.totalValue)],
  },
  significant: {
    // P or S and value ≥ $1M, OR an open-market buy ≥ $100k. Excludes OTHER grants.
    where: or(
      and(inArray(insiderTrades.action, ['BUY', 'SELL']), gte(insiderTrades.totalValue, 1000000)),
      and(eq(insiderTrades.action, 'BUY'), gte(insiderTrades.totalValue, 100000)),
    ),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
  transactions: {
    where: inArray(insiderTrades.action, ['BUY', 'SELL']),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
};

export function parseTags(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.slice(0, 6) : []; } catch { return []; }
}

export async function enrichRows(rows) {
  // Canonical calc lives in lib/insider-format; this route no longer keeps its own copy.
  const shaped = rows.map((r) => ({ ...r,
    ceoCfo: /chief executive|\bCEO\b|chief financial|\bCFO\b/i.test(r.title || ''),
    openMarket: r.transactionCode === 'P' || r.transactionCode === 'S',
    // Unrounded on the wire. Rounding here threw away the sub-1% precision the shared
    // formatter needs, and left every consumer to invent its own rounding.
    ownershipChangePct: ownPctShared(r),
    // Conviction reaches the client as score + band + approved tags ONLY. The engine,
    // its weights and every intermediate factor stay server-side (lib/conviction.server.js).
    conviction: r.conviction == null ? null : Math.round(r.conviction),
    convictionBand: r.convictionBand ?? null,
    convictionTags: parseTags(r.convictionTags),
    // Prefer the precomputed context; these were a per-request history query before,
    // which is exactly the multi-year lookup that should never run per row.
    firstOpenMarketBuy: r.isFirstOmBuy === true,
    monthsSincePriorBuy: r.monthsSincePrevBuy == null ? null : Math.round(r.monthsSincePrevBuy),
  }));
  // Fallback only for rows the context job has not reached yet (it runs after each
  // backfill chunk). Once ctx_computed_at is set everywhere this does no work at all.
  const pRows = shaped.filter((r) => r.transactionCode === 'P' && r.ctxComputedAt == null);
  if (pRows.length) {
    const tks = [...new Set(pRows.map((r) => r.ticker))], exs = [...new Set(pRows.map((r) => r.executive))];
    const hist = await db.select({ executive: insiderTrades.executive, ticker: insiderTrades.ticker, date: insiderTrades.transactionDate })
      .from(insiderTrades).where(and(eq(insiderTrades.transactionCode, 'P'), inArray(insiderTrades.ticker, tks), inArray(insiderTrades.executive, exs), NOT_SUPERSEDED));
    const byKey = new Map();
    for (const h of hist) { const k = `${h.executive}|${h.ticker}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(h.date); }
    for (const r of pRows) {
      const prior = (byKey.get(`${r.executive}|${r.ticker}`) || []).filter((d) => d && d < r.transactionDate);
      r.firstOpenMarketBuy = prior.length === 0;
      if (prior.length) { const last = prior.sort().pop(); r.monthsSincePriorBuy = Math.max(0, Math.round((new Date(r.transactionDate) - new Date(last)) / (30 * 86400000))); }
    }
  }
  return shaped;
}

/**
 * The room's FIRST SCREEN: one unfiltered page of a row view, enriched, plus the matching total.
 *
 * ⚠️ THIS IS THE ROUTE'S OWN DEFAULT PATH WITH NO FILTERS APPLIED, NOT A SECOND INTERPRETATION.
 * InsidersClient's first fetch carries no filter at all — view 'latest', page 0 — so the shape it
 * renders first is exactly this. The three guards (view config, symbol predicate, supersede
 * predicate) and the enrichment are the SAME objects the route uses, imported above, so there is
 * nothing here for a future change to one of them to miss.
 *
 * ⚠️ cutoff IS THE CALLER'S DECISION AND IT IS NOT OPTIONAL IN PRACTICE. Pass the value of
 * eodCutoffIso(tier). A server-rendered public page passes the FREE cutoff, because shared HTML is
 * read by everyone; the route passes the caller's own. Freshness is what Pro buys, and it is
 * enforced here on inserted_at — the column that records when WE processed a filing — never on
 * filing_date, which is the SEC's date and says nothing about our ingest.
 *
 * @param {object}  o
 * @param {string}  [o.view='latest']  a key of ROW_VIEWS
 * @param {?string} o.cutoff           ISO instant, or null for no freshness limit
 * @param {number}  [o.page=0]
 * @param {number}  [o.pageSize=50]    matches the route's own default
 * @returns {Promise<{view: string, trades: object[], page: number, pageSize: number, total: number}>}
 */
export async function insiderRoomRows({ view = 'latest', cutoff = null, page = 0, pageSize = 50 } = {}) {
  const resolvedView = ROW_VIEWS[view] ? view : 'latest';
  const cfg = ROW_VIEWS[resolvedView];
  const conds = [TICKER_IS_A_SYMBOL, NOT_SUPERSEDED];
  if (cfg.where) conds.push(cfg.where);
  if (cutoff) conds.push(sql`${insiderTrades.insertedAt} <= ${cutoff}::timestamptz`);
  const whereClause = and(...conds);

  const [rows, counted] = await Promise.all([
    db.select().from(insiderTrades).where(whereClause)
      .orderBy(...cfg.orderBy).limit(pageSize).offset(page * pageSize),
    db.select({ n: sql`count(*)`.mapWith(Number) }).from(insiderTrades).where(whereClause),
  ]);
  return {
    view: resolvedView,
    trades: await enrichRows(rows),
    page,
    pageSize,
    total: counted?.[0]?.n ?? rows.length,
  };
}
