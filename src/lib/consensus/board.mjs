// PIT CONSENSUS BOARD — evidence alignment across many tickers.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// The board used to be computeConfluence(): a ticker qualified by having 2 of 3 "signals", and was
// ranked by (execs*20 + value/250k*20 + members*25 + netFunds*18) / 3, multiplied by 1.6 or 2.4.
// None of those constants was validated, the result had no units, and the ordering inherited every
// one of them. "224 CONFLUENCE" could not be explained to the person reading it.
//
// This is the same product question answered from the canonical engine instead: what do the
// independent evidence families say, where do they agree, and where do they conflict.
//
// ── ONE ENGINE, MANY CONSUMERS ──────────────────────────────────────────────
//
// Nothing here classifies evidence. resolveEvidence() produces the family values and
// computeConsensus() combines them — the identical code the ticker page and Pit Scan use, so the
// board cannot disagree with them about what a Form 4 means. This module only decides WHICH tickers
// to ask about and in WHAT ORDER to show the answers.
//
// ── WHY IT IS PRECOMPUTED ───────────────────────────────────────────────────
//
// Measured: resolveEvidence is ~1s per ticker, and six issued at once took 28s — the Neon HTTP
// driver serialises under load, so unbounded parallelism makes it worse, not better. A board of
// sixty tickers cannot be built inside a request at any concurrency.
//
// So it is built by cron with bounded concurrency and served from KV, exactly as the confluence
// board and pit-snapshot already are. A request never resolves evidence.

// evidence.js reaches the database, so it is imported LAZILY inside the build. That keeps the pure
// parts of this module — the family list, the bounds and the ordering — loadable in plain Node, so
// the ordering rules can be tested without standing up a database.
import { computeConsensus, CONSTANTS, FAMILIES } from './consensus-v1.mjs';
import { SYNTHESIS_FAMILIES, canonicalConsensus } from './synthesis.mjs';

/**
 * THE FIVE CANONICAL FAMILIES — identical to the ticker page.
 *
 * Market structure is included deliberately. It is not public disclosure like the other four; its
 * job is to say whether PRICE is confirming, rejecting or ambiguous relative to them. Leaving it off
 * the board while the ticker page showed it was a way for the two surfaces to describe the same
 * company differently, which is the defect this product cannot have.
 *
 * ⚠️ The DEPRECATED aggregate (direction/alignment/confidence) is still computed over the four
 * DISCLOSURE families only, because Pit Scan's divergence board compares evidence against price and
 * folding price into the evidence side would make that comparison circular.
 */
export const BOARD_FAMILIES = SYNTHESIS_FAMILIES;
export const AGGREGATE_FAMILIES = FAMILIES;

export const BOARD_LIMIT = 60;
/** Resolved at a time. Above this the driver serialises and wall-clock gets worse, not better. */
export const CONCURRENCY = 4;

const rows = (res) => res?.rows ?? res ?? [];

/**
 * WHICH TICKERS THE BOARD ASKS ABOUT.
 *
 * Cheap, grouped, one query per family — never per ticker. A ticker is a candidate when it shows
 * recent activity in at least TWO independent families, because the product is cross-family
 * alignment and a single family cannot produce it (§5: one active family is SINGLE-SOURCE, not
 * agreement).
 *
 * ⚠️ THIS IS NOT A RANKING OF ANYTHING. It is "where is there enough independent evidence to be
 * worth asking the engine about", which is a coverage question, not a claim about the securities.
 * The real ordering happens after the engine has answered.
 */
export async function selectCandidates(db, sql, { limit = BOARD_LIMIT } = {}) {
  const W = CONSTANTS.activationWindowDays;

  const [ins, con, cat] = await Promise.all([
    db.execute(sql`
      select ticker, count(*)::int n from insider_trades
       where filing_date >= (current_date - make_interval(days => ${W.insiders}))
         and total_value > 0 and coalesce(superseded_by,'') = ''
       group by ticker`),
    // DISCLOSURE date, never transaction date — the window must match when the market could know.
    db.execute(sql`
      select ticker, count(*)::int n from congress_trades
       where disclosure_date >= (current_date - make_interval(days => ${W.congress}))
         and ticker is not null
       group by ticker`),
    db.execute(sql`
      select ticker, count(*)::int n from eightk_filings
       where filed_at >= (now() - make_interval(days => ${W.catalysts}))
       group by ticker`),
  ]);

  const seen = new Map();   // ticker -> { fams:Set, records:number }
  const add = (res, fam) => {
    for (const r of rows(res)) {
      const t = String(r.ticker || '').toUpperCase();
      if (!t) continue;
      if (!seen.has(t)) seen.set(t, { fams: new Set(), records: 0 });
      const e = seen.get(t);
      e.fams.add(fam);
      e.records += Number(r.n) || 0;
    }
  };
  add(ins, 'insiders'); add(con, 'congress'); add(cat, 'catalysts');

  // Institutions are NOT used to select candidates. Nearly every listed company has some 13F
  // movement every quarter, so including it would make the filter meaningless — it would select
  // the market. It still participates fully once a ticker is asked about.
  //
  // ⚠️ THE TIEBREAK MATTERS. Most candidates tie at exactly two families, so breaking ties on the
  // ticker string took the alphabetically-first sixty — a board of A through C. Record volume is
  // the honest tiebreak: it asks "where is there most to look at", which is the same coverage
  // question, and it does not depend on a company's name. Ticker remains the final tiebreak so the
  // selection stays deterministic.
  return [...seen.entries()]
    .filter(([, e]) => e.fams.size >= 2)
    .sort((a, b) => (b[1].fams.size - a[1].fams.size)
      || (b[1].records - a[1].records)
      || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/** Resolve with bounded concurrency. Unbounded made this four times slower, measured. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

/**
 * ORDERING — research priority, explicitly NOT a performance ranking.
 *
 * Every term is a property of the EVIDENCE, not a claim about the security. A ticker higher on this
 * board has more independent families saying something and more confidence in that reading; it is
 * not predicted to perform better, and nothing here was tuned against returns.
 *
 * Deterministic to the last tiebreak so the same inputs always produce the same page.
 */
const CONF_RANK = { High: 3, Medium: 2, Low: 1 };
// Rows with something decided read before rows that are still ambiguous. This is coverage and
// decidedness, not bullishness: a negative alignment ranks exactly as high as a positive one.
const STATE_RANK = {
  POSITIVE_ALIGNMENT: 4, NEGATIVE_ALIGNMENT: 4,
  POSITIVE_LEAN_WITH_CONFLICT: 3, NEGATIVE_LEAN_WITH_CONFLICT: 3,
  BALANCED_CONFLICT: 2,
  SINGLE_SOURCE: 1, MIXED: 1, NO_EVIDENCE: 0,
};
export function orderBoard(list) {
  const k = (r) => r.canonical || {};
  return [...list].sort((a, b) =>
    ((STATE_RANK[k(b).state] ?? 0) - (STATE_RANK[k(a).state] ?? 0))
    || ((CONF_RANK[k(b).confidence] || 0) - (CONF_RANK[k(a).confidence] || 0))
    || ((k(b).coverage?.active ?? 0) - (k(a).coverage?.active ?? 0))
    || ((k(b).diagnostics?.positiveMass ?? 0) + (k(b).diagnostics?.negativeMass ?? 0)
      - ((k(a).diagnostics?.positiveMass ?? 0) + (k(a).diagnostics?.negativeMass ?? 0)))
    || a.ticker.localeCompare(b.ticker));
}

/**
 * The board.
 *
 * Returns rows carrying the FULL consensus_v1 object plus its families, so the UI renders canonical
 * output and Pit Scan's contract (version, directionValue, confidence, activeCount) is satisfied by
 * the same shape.
 *
 * A ticker with no active family is dropped: it has nothing to say, and showing it would pad the
 * page with absence. A ticker with ONE active family is KEPT — single-source is a real, useful and
 * honestly-labelled state, not a failure.
 */
export async function buildConsensusBoard(db, sql, { limit = BOARD_LIMIT, now = Date.now() } = {}) {
  const candidates = await selectCandidates(db, sql, { limit });
  if (!candidates.length) return { rows: [], candidates: 0, builtAt: new Date(now).toISOString() };

  const { resolveEvidence } = await import('./evidence.js');

  const built = await mapLimit(candidates, CONCURRENCY, async (ticker) => {
    try {
      const families = await resolveEvidence(ticker, { now });
      // Structure is resolved for the ticker page; the board is an account of DISCLOSED evidence.
      // The aggregate excludes structure (see AGGREGATE_FAMILIES); the FAMILY ROWS include it, so
      // the board shows the same five families the ticker page does.
      const disclosure = families.filter((f) => AGGREGATE_FAMILIES.includes(f.family));
      const all = families.filter((f) => BOARD_FAMILIES.includes(f.family));
      const k = computeConsensus(disclosure, { now });
      if (!all.some((f) => f.active)) return null;
      // THE CANONICAL OBJECT. Every surface renders from this; nothing recomputes it.
      // k.direction/alignment/confidence remain ONLY for Pit Scan and are shown to nobody.
      const canonical = canonicalConsensus(all, { now });
      return { ticker, ...k, families: all, canonical };
    } catch {
      // One ticker failing must not empty the board, and must not be reported as "no evidence".
      return { ticker, error: true };
    }
  });

  const ok = built.filter((r) => r && !r.error);
  const failed = built.filter((r) => r && r.error).length;
  return {
    rows: orderBoard(ok),
    candidates: candidates.length,
    failed,
    builtAt: new Date(now).toISOString(),
  };
}
