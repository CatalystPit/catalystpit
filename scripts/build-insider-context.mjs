// scripts/build-insider-context.mjs
//
// Materialises the historical context that badges and the Conviction engine read.
// These are multi-year lookbacks over ~500k rows; running them per row per request
// would be far too slow, so they are computed here and only ever READ at request time.
//
//   node --env-file=.env.local scripts/build-insider-context.mjs
//   node --env-file=.env.local scripts/build-insider-context.mjs --stats
//
// Safe to re-run: every statement is a full recompute of derived columns only. No
// source data is modified. Run it after each backfill chunk.
//
// Scope: context is computed for genuine open-market PURCHASES (code P, non-derivative,
// not superseded by an amendment). Grants, exercises, tax withholding and gifts never
// get buy-context, because they are not discretionary purchases.

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 30 });

// The predicate for "a real open-market purchase". Used identically everywhere so the
// counts, the badges and the score can never disagree about what a buy is.
const OM_BUY = `transaction_code = 'P' AND is_derivative = false AND superseded_by IS NULL AND owner_cik IS NOT NULL`;

const step = async (label, fn) => {
  const t = Date.now();
  const r = await fn();
  console.log(`  ${label.padEnd(46)} ${String(r ?? '').padStart(8)}  ${((Date.now() - t) / 1000).toFixed(1)}s`);
};

(async () => {
  console.log('[context] building historical context for open-market purchases');

  // ── 1. Sequence context: first buy, previous buy, gap, trailing counts ──────
  // Partitioned by (owner_cik, issuer_cik): "first buy in 18 months" is a claim about
  // THIS insider at THIS company, which is what the badge means.
  //
  // is_first_om_buy is explicitly first-in-STORED-HISTORY, never "first ever" — the UI
  // phrases it against insider_history_meta.covered_from.
  await step('sequence + trailing counts', async () => {
    const res = await sql.unsafe(`
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
      FROM om WHERE t.id = om.id`);
    return res.count;
  });

  // ── 2. Ownership increase ──────────────────────────────────────────────────
  // shares_owned_after includes this purchase, so the prior holding is (after - shares).
  // Guarded: a filer who reports owning exactly what they just bought would divide by
  // zero, and that case is genuinely "new position", not an infinite percentage.
  await step('ownership increase %', async () => {
    const res = await sql.unsafe(`
      UPDATE insider_trades SET
        ownership_increase_pct = CASE
          WHEN shares_owned_after IS NULL OR shares IS NULL OR shares <= 0 THEN NULL
          WHEN (shares_owned_after - shares) <= 0 THEN NULL
          ELSE LEAST(shares / (shares_owned_after - shares) * 100.0, 100000)
        END
      WHERE ${OM_BUY}`);
    return res.count;
  });

  // ── 3. Cluster participation ───────────────────────────────────────────────
  // Distinct insiders buying the SAME issuer within a trailing 10 days. COUNT(DISTINCT)
  // is not available as a window function in Postgres, so this is a correlated subquery
  // riding idx_insider_issuer_buy.
  await step('cluster participation (10d)', async () => {
    const res = await sql.unsafe(`
      UPDATE insider_trades t SET cluster_insiders_10d = (
        SELECT COUNT(DISTINCT x.owner_cik) FROM insider_trades x
         WHERE x.issuer_cik = t.issuer_cik
           AND x.transaction_code = 'P' AND x.is_derivative = false AND x.superseded_by IS NULL
           AND x.transaction_date BETWEEN t.transaction_date - 10 AND t.transaction_date
      ) WHERE ${OM_BUY} AND issuer_cik IS NOT NULL`);
    return res.count;
  });

  // ── 4. Per-insider baselines ───────────────────────────────────────────────
  // The normalisation inputs for Conviction. Deliberately across ALL issuers: "is this
  // large for THIS person" is a statement about the person, not one holding. This is what
  // keeps the score meaningful for both a founder and an ordinary director.
  await step('insider_people baselines', async () => {
    const res = await sql.unsafe(`
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
        issuers_count = EXCLUDED.issuers_count, updated_at = now()`);
    return res.count;
  });

  // ── 5. Report ──────────────────────────────────────────────────────────────
  const [s] = await sql.unsafe(`
    SELECT count(*)::int buys,
           count(*) FILTER (WHERE ctx_computed_at IS NOT NULL)::int with_ctx,
           count(*) FILTER (WHERE is_first_om_buy)::int first_buys,
           count(*) FILTER (WHERE is_repeat_buyer)::int repeat_buys,
           count(*) FILTER (WHERE cluster_insiders_10d >= 3)::int in_cluster,
           count(*) FILTER (WHERE ownership_increase_pct IS NOT NULL)::int with_own,
           round(avg(months_since_prev_buy)::numeric, 1)::text avg_gap
    FROM insider_trades WHERE ${OM_BUY}`);
  const [p] = await sql.unsafe(`SELECT count(*)::int n FROM insider_people`);
  const [h] = await sql.unsafe(`SELECT covered_from::text cf, covered_to::text ct FROM insider_history_meta WHERE id = 1`);

  console.log(`\n[context] open-market buys ${s.buys}  contextualised ${s.with_ctx}`);
  console.log(`[context] first-in-history ${s.first_buys}  repeat buyers ${s.repeat_buys}  in 3+ clusters ${s.in_cluster}`);
  console.log(`[context] ownership % known ${s.with_own}  avg months between buys ${s.avg_gap}`);
  console.log(`[context] insider_people ${p.n}   history covered ${h.cf || '?'} .. ${h.ct || '?'}`);
  await sql.end();
})();
