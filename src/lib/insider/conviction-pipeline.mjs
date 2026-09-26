// THE INSIDER CONVICTION WRITE PATH — the part that was missing.
//
// ── ⚠️ WHAT ACTUALLY BROKE ─────────────────────────────────────────────────
//
// Nothing. The engine (lib/conviction.server.js) was correct, its inputs were present, and the
// last run completed cleanly over every row that existed at the time — the graded ids run 81 to
// 1,772,281 with ZERO ungraded rows below that ceiling. Every Form 4 ingested afterwards was
// simply never offered to it, because the only thing that had ever called the engine was a
// developer typing `node scripts/score-conviction.mjs`. There was no cron entry, no API route and
// no caller anywhere in src/. The pipeline was built as a one-off backfill tool and never wired to
// a schedule, so it stopped the moment someone stopped running it by hand.
//
// This file is the scheduled path. It does not re-implement the engine — scoreConviction,
// convictionTags and isConvictionEligible are imported unchanged, and remain the one place a score
// is decided.
//
// ── ⚠️ WHY THE SQL LIVES HERE AND NOT IN THE SCRIPT ────────────────────────
//
// The context statements were inside scripts/build-insider-context.mjs. A scheduled runner needs
// them too, and copying them would put the definition of "what is an open-market buy" in two files
// that no test compares — the exact shape of drift that put a $10M CEO purchase on the chart in one
// resolver and not the other. They are exported as SQL TEXT so both callers can run them through
// their own client: the scripts use postgres-js `sql.unsafe`, the cron uses neon's `sql.query`, and
// both take (text, params).

import { scoreConviction, convictionTags, isConvictionEligible } from '../conviction.server.js';

/**
 * The predicate for "a genuine open-market purchase".
 *
 * ⚠️ ONE DEFINITION, USED BY CONTEXT AND SCORING ALIKE, so the counts, the badges and the score
 * can never disagree about what a buy is.
 */
export const OM_BUY = `transaction_code = 'P' AND is_derivative = false AND superseded_by IS NULL AND owner_cik IS NOT NULL`;

/** Eligible for a score: an open-market buy with the two figures the engine needs. */
export const SCOREABLE = `transaction_code = 'P' AND is_derivative = false AND superseded_by IS NULL
  AND total_value > 0 AND shares > 0`;

// ── context ──────────────────────────────────────────────────────────────────
//
// Moved verbatim from scripts/build-insider-context.mjs. Full recomputes of derived columns only;
// no source data is touched, so re-running is a no-op in effect.

export const CONTEXT_STATEMENTS = [
  ['sequence + trailing counts', `
    WITH om AS (
      SELECT id, owner_cik, issuer_cik, transaction_date,
        LAG(transaction_date) OVER w                                          AS prev_date,
        ROW_NUMBER()           OVER w                                          AS seq,
        COUNT(*) OVER (PARTITION BY owner_cik, issuer_cik)                     AS total_buys,
        COUNT(*) OVER (PARTITION BY owner_cik, issuer_cik ORDER BY transaction_date
                       RANGE BETWEEN INTERVAL '3 months'  PRECEDING AND CURRENT ROW) AS c3,
        COUNT(*) OVER (PARTITION BY owner_cik, issuer_cik ORDER BY transaction_date
                       RANGE BETWEEN INTERVAL '6 months'  PRECEDING AND CURRENT ROW) AS c6,
        COUNT(*) OVER (PARTITION BY owner_cik, issuer_cik ORDER BY transaction_date
                       RANGE BETWEEN INTERVAL '12 months' PRECEDING AND CURRENT ROW) AS c12,
        COUNT(*) OVER (PARTITION BY owner_cik, issuer_cik ORDER BY transaction_date
                       RANGE BETWEEN INTERVAL '24 months' PRECEDING AND CURRENT ROW) AS c24,
        COUNT(*) OVER (PARTITION BY owner_cik, issuer_cik ORDER BY transaction_date
                       RANGE BETWEEN INTERVAL '36 months' PRECEDING AND CURRENT ROW) AS c36
      FROM insider_trades
      WHERE ${OM_BUY}
      WINDOW w AS (PARTITION BY owner_cik, issuer_cik ORDER BY transaction_date, id)
    )
    UPDATE insider_trades t SET
      is_first_om_buy       = (om.seq = 1),
      prev_om_buy_date      = om.prev_date,
      months_since_prev_buy = CASE WHEN om.prev_date IS NULL THEN NULL
                                   ELSE (t.transaction_date - om.prev_date) / 30.44 END,
      om_buys_3m = om.c3, om_buys_6m = om.c6, om_buys_12m = om.c12,
      om_buys_24m = om.c24, om_buys_36m = om.c36,
      om_buys_total = om.total_buys,
      is_repeat_buyer = (om.total_buys > 1),
      ctx_computed_at = now()
    FROM om WHERE t.id = om.id`],

  ['ownership increase %', `
    UPDATE insider_trades SET
      ownership_increase_pct = CASE
        WHEN shares_owned_after IS NULL OR shares IS NULL OR shares <= 0 THEN NULL
        WHEN (shares_owned_after - shares) <= 0 THEN NULL
        ELSE LEAST(shares / (shares_owned_after - shares) * 100.0, 100000)
      END
    WHERE ${OM_BUY}`],

  ['cluster participation (10d)', `
    UPDATE insider_trades t SET cluster_insiders_10d = (
      SELECT COUNT(DISTINCT x.owner_cik) FROM insider_trades x
       WHERE x.issuer_cik = t.issuer_cik
         AND x.transaction_code = 'P' AND x.is_derivative = false AND x.superseded_by IS NULL
         AND x.transaction_date BETWEEN t.transaction_date - 10 AND t.transaction_date
    ) WHERE ${OM_BUY} AND issuer_cik IS NOT NULL`],

  ['insider_people baselines', `
    INSERT INTO insider_people (owner_cik, name, first_seen, last_seen, om_buy_count,
                                om_buy_total, om_buy_avg, om_buy_median, om_buy_p90,
                                om_buy_max, issuers_count, updated_at)
    SELECT owner_cik,
           MAX(executive), MIN(transaction_date), MAX(transaction_date),
           COUNT(*), COALESCE(SUM(total_value), 0), AVG(total_value),
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_value),
           PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total_value),
           MAX(total_value), COUNT(DISTINCT issuer_cik), now()
    FROM insider_trades
    WHERE ${OM_BUY} AND total_value > 0
    GROUP BY owner_cik
    ON CONFLICT (owner_cik) DO UPDATE SET
      name = EXCLUDED.name, first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen,
      om_buy_count = EXCLUDED.om_buy_count, om_buy_total = EXCLUDED.om_buy_total,
      om_buy_avg = EXCLUDED.om_buy_avg, om_buy_median = EXCLUDED.om_buy_median,
      om_buy_p90 = EXCLUDED.om_buy_p90, om_buy_max = EXCLUDED.om_buy_max,
      issuers_count = EXCLUDED.issuers_count, updated_at = now()`],
];

/** Run every context statement in order. `run(text, params) -> rows`. */
export async function refreshContext(run) {
  const done = [];
  for (const [label, text] of CONTEXT_STATEMENTS) {
    const t = Date.now();
    await run(text, []);
    done.push({ step: label, ms: Date.now() - t });
  }
  return done;
}

// ── scoring ──────────────────────────────────────────────────────────────────

/**
 * The wording must never outrun the data we hold: a 3-year backfill says "3-YEAR HISTORY".
 * Derived from insider_history_meta, never hardcoded, and never "EVER".
 */
export async function historyLabel(run) {
  try {
    const [m] = await run(`SELECT covered_from, covered_to FROM insider_history_meta WHERE id = 1`, []);
    if (!m?.covered_from) return 'AVAILABLE HISTORY';
    const years = (new Date(m.covered_to || Date.now()) - new Date(m.covered_from)) / (365.25 * 864e5);
    return years >= 0.9 ? `${Math.round(years)}-YEAR HISTORY`
      : `${Math.max(1, Math.round(years * 12))}-MONTH HISTORY`;
  } catch { return 'AVAILABLE HISTORY'; }
}

/**
 * Score purchases the engine has not seen yet.
 *
 * ⚠️ RESUMABLE AND IDEMPOTENT BY CONSTRUCTION, NOT BY BOOKKEEPING. The work queue is the query
 * `conviction IS NULL` — so a run that dies half way leaves the rest still selected next time, and
 * a run with nothing to do selects nothing and writes nothing. There is no cursor to corrupt and
 * no "last processed id" that a partial failure could advance past.
 *
 * ⚠️ AND IT NEVER INVENTS A SCORE. A row the engine declines (ineligible, or missing the figures it
 * needs) is counted as skipped and left NULL. Null means "no score", which the product must keep
 * being able to distinguish from a low one.
 *
 * @param opts.rescore  when true, re-score rows that already have one. Off by default so a routine
 *                      run cannot churn history; used only for a deliberate recalibration.
 */
export async function scoreUngraded(run, {
  limit = 20000, batch = 2000, budgetMs = 240_000, rescore = false, marketCaps = null, now = Date.now(),
} = {}) {
  const started = Date.now();
  const label = await historyLabel(run);

  const caps = marketCaps || new Map();
  if (!marketCaps) {
    try {
      for (const r of await run(`SELECT ticker, market_cap FROM screener_stocks WHERE market_cap > 0`, [])) {
        caps.set(r.ticker, Number(r.market_cap));
      }
    } catch { /* no caps → the engine falls back to absolute scale, which it documents */ }
  }

  const people = new Map();
  try {
    for (const p of await run(`SELECT * FROM insider_people`, [])) people.set(p.owner_cik, p);
  } catch { /* no baselines → fSizeVsSelf uses its documented neutral default */ }

  let scored = 0, skipped = 0, batches = 0, exhausted = false;
  const gate = rescore ? '' : 'AND conviction IS NULL';

  // ⚠️ KEYSET PAGINATION, AND THE BUG IT FIXES IS NOT HYPOTHETICAL. The first version relied on
  // the predicate shrinking — true while the gate is `conviction IS NULL`, false the moment
  // rescore drops that gate. With no gate the same first page was re-selected every iteration:
  // a run reported "scored 60000" having written 2,000 rows thirty times, and the pending count
  // never moved. Advancing an id watermark makes progress a property of the loop rather than a
  // side effect of the rows it happens to be writing.
  let afterId = 0;

  while (scored + skipped < limit) {
    if (Date.now() - started > budgetMs) break;
    const rows = await run(`
      SELECT id, ticker, title, is_officer, is_director, is_ten_pct_owner, transaction_code,
             is_derivative, superseded_by, shares, total_value, owner_cik, ownership_type,
             rule_10b5_1, is_first_om_buy, months_since_prev_buy, om_buys_12m, om_buys_total,
             is_repeat_buyer, cluster_insiders_10d, ownership_increase_pct
        FROM insider_trades
       WHERE ${SCOREABLE} ${gate} AND id > $1
       ORDER BY id LIMIT $2`, [afterId, Math.min(batch, limit - scored - skipped)]);
    if (!rows.length) { exhausted = true; break; }
    afterId = rows[rows.length - 1].id;

    const ids = [], scores = [], bands = [], tags = [];
    for (const row of rows) {
      if (!isConvictionEligible(row)) { skipped++; continue; }
      const s = scoreConviction(row, people.get(row.owner_cik) || null, { marketCap: caps.get(row.ticker) });
      if (!s) { skipped++; continue; }
      // Only score, band and tags are persisted. s.factors never leaves this process.
      ids.push(row.id); scores.push(s.score); bands.push(s.band);
      tags.push(JSON.stringify(convictionTags(row, people.get(row.owner_cik) || null, label)));
      scored++;
    }

    if (ids.length) {
      await run(`
        UPDATE insider_trades AS t
           SET conviction = v.score, conviction_band = v.band,
               conviction_tags = v.tags, conviction_at = now()
          FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::double precision[]) AS score,
                       unnest($3::text[]) AS band, unnest($4::text[]) AS tags) v
         WHERE t.id = v.id`, [ids, scores, bands, tags]);
    }
    batches++;
  }

  return { scored, skipped, batches, exhausted, ms: Date.now() - started, now };
}

// ── freshness ────────────────────────────────────────────────────────────────

/**
 * How far behind grading is, if at all.
 *
 * ⚠️ THIS EXISTS SO THE PRODUCT CANNOT SILENTLY SHOW STALE CONVICTION AGAIN. Before it, a NULL
 * band meant two different things the UI could not tell apart — "this purchase is not the kind we
 * score" and "we have not scored it yet" — so fourteen days of ungraded filings looked exactly
 * like fourteen days of ineligible ones. This answers the second question from data.
 */
export const STALE_AFTER_DAYS = 3;

export async function convictionCoverage(run) {
  try {
    const [r] = await run(`
      SELECT
        (SELECT max(filing_date) FROM insider_trades WHERE ${SCOREABLE} AND conviction IS NOT NULL) AS graded_through,
        (SELECT max(filing_date) FROM insider_trades WHERE ${SCOREABLE})                            AS newest_eligible,
        (SELECT count(*)::int    FROM insider_trades WHERE ${SCOREABLE} AND conviction IS NULL)     AS pending,
        (SELECT max(conviction_at) FROM insider_trades)                                             AS last_write`, []);
    const gradedThrough = r?.graded_through ? new Date(r.graded_through).toISOString() : null;
    const newestEligible = r?.newest_eligible ? new Date(r.newest_eligible).toISOString() : null;
    const lagDays = (gradedThrough && newestEligible)
      ? Math.max(0, Math.round((Date.parse(newestEligible) - Date.parse(gradedThrough)) / 86400000))
      : null;
    const pending = Number(r?.pending) || 0;
    return {
      gradedThrough,
      newestEligible,
      pendingEligible: pending,
      lastWrite: r?.last_write ? new Date(r.last_write).toISOString() : null,
      lagDays,
      // ⚠️ UNKNOWN IS NOT CURRENT. A coverage read that cannot establish the two dates reports
      // `current: false`, so the UI qualifies what it shows rather than assuming the best.
      current: gradedThrough != null && lagDays != null && lagDays <= STALE_AFTER_DAYS,
    };
  } catch {
    return { gradedThrough: null, newestEligible: null, pendingEligible: null, lastWrite: null, lagDays: null, current: false };
  }
}
