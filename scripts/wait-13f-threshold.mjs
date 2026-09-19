// WAIT UNTIL THE 13F HISTORY IS RESEARCH-USABLE.
//
//   node --env-file=.env.local scripts/wait-13f-threshold.mjs [quarters...]
//
// Polls until every named quarter carries at least MIN_FILERS distinct filers, then exits. Used to
// hold an unattended pipeline — backfill, then audit, then rerun the frozen research — without
// anybody having to watch a log.
//
// The threshold is the FROZEN one from experiment-002-spec.md and is not configurable here on
// purpose: a waiting script that could lower the bar would be a way to make a quarter "ready"
// without any more data arriving.
//
// Progress goes to stderr, the completion line to stdout, so a caller can wait on stdout alone.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const MIN_FILERS = 1000;
const POLL_MS = 10 * 60 * 1000;

const want = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!want.length) want.push('2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30');

console.error(`waiting for ${want.join(', ')} to reach ${MIN_FILERS} filers each`);

// ⚠️ POLLS fund_filings, WHICH IS A TRIGGER — THE AUDIT REMAINS THE AUTHORITY.
//
// The obvious query, `count(distinct cik) from fund_holdings group by quarter`, aggregates the whole
// holdings table: 11M+ rows, and it was measured at 3.3s even when narrowed to the four quarters of
// interest, against 173ms here. Unbounded and repeated every ten minutes, it competes with the very
// crawler it is waiting on — the same full-table-aggregate mistake that once stalled the backfill's
// own queue query.
//
// fund_filings carries one row per (cik, quarter), so the count is the same number by construction.
// Verified equal on live data at the moment of the change: 202/203/244/247 across the four target
// quarters from both queries. This decides only WHEN to stop waiting; audit-13f-history.mjs still
// counts distinct filers from fund_holdings itself, and that is what the threshold is judged on.
for (;;) {
  const rs = await sql`select quarter::text q, count(*)::int n from fund_filings group by 1`;
  const have = new Map(rs.map((r) => [r.q, r.n]));
  const short = want.filter((q) => (have.get(q) ?? 0) < MIN_FILERS);
  console.error(`${new Date().toISOString()}  ${want.map((q) => `${q}:${have.get(q) ?? 0}`).join('  ')}`);
  if (!short.length) { console.log('THRESHOLD MET'); break; }
  await new Promise((s) => setTimeout(s, POLL_MS));
}
