import { sql } from 'drizzle-orm';
import { db } from './db';
import { tickerEvidence } from './evidence/resolve';
import { isIngestableTicker } from './security-identity.mjs';

// WHAT CHANGED ON YOUR NAMES — "what became public since you last looked".
//
// ── ONE INTERPRETER, AND THIS IS NOT IT ─────────────────────────────────────
//
// Every sentence a user reads here comes from the Evidence Engine via tickerEvidence(). This file
// decides WHICH tickers to ask about and nothing else. It does not classify a filing, does not
// write a summary, does not decide direction or materiality, and must never start: four surfaces
// each reimplementing "what changed" is exactly how four surfaces end up with four different
// answers about the same company, which is the failure the engine was built to end.
//
// ── WHY THERE IS A PREFILTER AT ALL ─────────────────────────────────────────
//
// tickerEvidence() resolves four families with their full historical context — measured at 0.2s
// warm and 2.5s for a busy name. A watchlist holds up to 1,000 tickers, so asking it about every
// one of them on every page load is not a slow endpoint, it is an outage. On a normal day almost
// no watched name has new public evidence, so the expensive question is asked about almost nothing.
//
// `candidateTickers` is an INDEX, not an interpretation: one batched query per source table asking
// only "did any row for these tickers become public at or after `since`". It answers with symbols;
// the engine then answers what they mean.
//
// ⚠️ THE PREFILTER MUST NEVER MISS, ONLY OVER-INCLUDE. It is deliberately looser than the engine's
// own `since` test — date columns are compared as whole days and the bound is inclusive — because
// a false positive costs one resolver call that returns nothing, while a false negative silently
// hides a filing from someone who is watching for it. The engine applies the exact
// publicTime > since cut afterwards; this only decides who to ask about.

/** Never ask the engine about more names than this in one request. */
export const MAX_RESOLVE = 25;
/** How many resolver calls run at once. Each is several DB queries, so this stays small. */
export const RESOLVE_CONCURRENCY = 4;
/** With no watermark, "what changed" means the last day. */
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Which of `tickers` have ANY source row that became public at or after `since`.
 *
 * ⚠️ EVERY COLUMN HERE IS A PUBLICATION CLOCK, NOT AN EVENT CLOCK, AND NOT OUR INGEST CLOCK.
 *   Form 4   → filing_date       (not transaction_date: the market learns when it is filed)
 *   8-K      → filed_at
 *   Congress → disclosure_date   (NEVER transaction_date — a member's trade is not news until
 *                                 disclosed, typically 30-45 days later)
 *   13F      → filed_date        (the quarter is the reference period, not the clock)
 * inserted_at is deliberately absent from all four: it records when WE caught up, so a backfill
 * would present years-old filings as things that just happened.
 */
export async function candidateTickers(tickers, since) {
  const clean = [...new Set((tickers || []).filter(isIngestableTicker).map((t) => t.toUpperCase()))];
  if (!clean.length) return [];
  const sinceIso = new Date(since).toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  // ⚠️ NOT `= any(${clean})`. Drizzle's sql template does not bind a JS array to a Postgres
  // text[] — it throws at once, which is how the /api/health liveness probe shipped broken. An
  // explicit parameterised IN list is bound correctly and stays injection-safe: every element has
  // already passed isIngestableTicker, and each is still sent as its own placeholder.
  const list = sql.join(clean.map((t) => sql`${t}`), sql`, `);

  const res = await db.execute(sql`
    select distinct ticker from (
      select upper(ticker) as ticker from insider_trades
        where upper(ticker) in (${list}) and filing_date >= ${sinceDay}::date
      union all
      select upper(ticker) from eightk_filings
        where upper(ticker) in (${list}) and filed_at >= ${sinceIso}::timestamptz
      union all
      select upper(ticker) from congress_trades
        where upper(ticker) in (${list}) and disclosure_date >= ${sinceDay}::date
      union all
      select upper(h.ticker) from fund_holdings h
        join fund_filings f on f.cik = h.cik and f.quarter = h.quarter
        where upper(h.ticker) in (${list}) and f.filed_date >= ${sinceDay}::date
    ) s`);
  return (res.rows ?? res).map((r) => String(r.ticker).toUpperCase());
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pooled(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  }
  return out;
}

/**
 * The changes on a set of watched tickers since `since`.
 *
 * Returns one flat, newest-first list plus a per-ticker index. Every entry is an Evidence Engine
 * object passed through unchanged apart from being trimmed to what a one-line row renders —
 * nothing here rewords the engine.
 */
export async function watchlistChanges(tickers, {
  since, now = Date.now(), limit = MAX_RESOLVE,
  // Seams, for tests only. The suite drives this with Form 4 / 8-K fixtures instead of a live
  // database, so the assembly — ordering, the invalid-ticker gate, truncation, per-ticker
  // indexing, failure reporting — is verified without needing a filing to land first.
  // Production passes neither and gets the real prefilter and the real engine.
  _candidates = candidateTickers,
  _resolve = tickerEvidence,
} = {}) {
  const sinceMs = new Date(since).getTime();
  const sinceIso = new Date(Number.isFinite(sinceMs) ? sinceMs : now - DEFAULT_LOOKBACK_MS).toISOString();

  // ⚠️ INVALID TICKERS NEVER REACH THE ENGINE. 'NONE' and friends are still in insider_trades
  // until the cleanup script is run, and a watchlist row could name one.
  const watched = [...new Set((tickers || []).filter(isIngestableTicker).map((t) => t.toUpperCase()))];
  if (!watched.length) {
    return { since: sinceIso, changes: [], byTicker: {}, scanned: 0, resolved: 0, truncated: false, failed: [] };
  }

  const candidates = await _candidates(watched, sinceIso);
  // Watchlist order is the user's order, so a truncated run keeps the names they put first.
  const ordered = watched.filter((t) => candidates.includes(t));
  const resolve = ordered.slice(0, limit);

  const results = await pooled(resolve, RESOLVE_CONCURRENCY, async (ticker) => {
    try {
      const r = await _resolve(ticker, { now, since: sinceIso });
      return { ticker, evidence: r.evidence || [], failedFamilies: r.failedFamilies || [] };
    } catch (e) {
      // ⚠️ A RESOLVER FAILURE IS NOT "NOTHING CHANGED". Reported, never rendered as silence.
      return { ticker, evidence: [], error: String(e?.message || e) };
    }
  });

  const byTicker = {};
  const changes = [];
  const failed = [];
  for (const r of results) {
    if (r.error) { failed.push({ ticker: r.ticker, error: r.error }); continue; }
    for (const f of r.failedFamilies) failed.push({ ticker: r.ticker, ...f });
    if (!r.evidence.length) continue;
    const rows = r.evidence.map((e) => ({
      ticker: r.ticker,
      family: e.family,
      type: e.type,
      direction: e.direction,
      summary: e.summary,
      publicTime: e.publicTime,
      // 13F's quarter end, a results 8-K's fiscal period. Carried so the UI can say "Q2, disclosed
      // Aug 14" instead of implying someone is buying now.
      referencePeriod: e.referencePeriod ?? null,
      url: e.url ?? null,
      tickerUrl: `/ticker/${encodeURIComponent(r.ticker)}`,
    }));
    byTicker[r.ticker] = rows;
    changes.push(...rows);
  }
  changes.sort((a, b) => new Date(b.publicTime) - new Date(a.publicTime));

  return {
    since: sinceIso,
    changes,
    byTicker,
    scanned: watched.length,
    resolved: resolve.length,
    truncated: ordered.length > resolve.length,
    failed,
  };
}
