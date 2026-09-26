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
// ⚠️ ONE DEFINITION. These statements are also run by /api/cron/score-conviction; keeping a
// second copy here would put 'what is an open-market buy' in two files no test compares.
import { OM_BUY, CONTEXT_STATEMENTS } from '../src/lib/insider/conviction-pipeline.mjs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 30 });

// The predicate for "a real open-market purchase". Used identically everywhere so the
// counts, the badges and the score can never disagree about what a buy is.

const step = async (label, fn) => {
  const t = Date.now();
  const r = await fn();
  console.log(`  ${label.padEnd(46)} ${String(r ?? '').padStart(8)}  ${((Date.now() - t) / 1000).toFixed(1)}s`);
};

(async () => {
  console.log('[context] building historical context for open-market purchases');

  // ⚠️ THE STATEMENTS THEMSELVES LIVE IN lib/insider/conviction-pipeline.mjs, so the scheduled
  // run and this manual full-recompute cannot drift apart. This file remains the CLI entry point
  // and the place to run a deliberate whole-table rebuild; the cron runs the same four.
  for (const [label, text] of CONTEXT_STATEMENTS) {
    await step(label, async () => (await sql.unsafe(text)).count);
  }
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
