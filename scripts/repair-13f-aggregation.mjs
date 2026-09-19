// REPAIR FILINGS STORED BEFORE SUB-ACCOUNT AGGREGATION EXISTED.
//
//   node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/repair-13f-aggregation.mjs [--dry] [--limit N]
//
// ── WHAT IS WRONG WITH THEM ──────────────────────────────────────────────────
//
// A 13F may report the same security many times in one filing — once per sub-account, discretion
// category or other manager. Measured on CIK 2056315 Q3 2025: 7,268 reported lines covering 644
// securities, one of them appearing 308 times. Those lines must be SUMMED into one position, which
// is what aggregateHoldings does and what commit 7c72dc39 introduced.
//
// Filings written before that landed took a different route: raw lines were inserted and the unique
// index on (cik, quarter, cusip, class, put_call) was left to "dedupe" them with
// onConflictDoNothing. That does not sum — it keeps whichever line arrived FIRST and silently drops
// the other 307. The stored position then carries one sub-account's value and shares instead of the
// security's total.
//
// Measured against the filings' own cover pages, which declare tableValueTotal independently of our
// parse, stored value came to 7% - 41% of what the filer reported:
//
//   CIK 2056315  2025-09-30   stored $21,733,219   declared $156,019,625   13.9%
//   CIK 1513703  2026-06-30   stored $11,203,661   declared $149,654,403    7.5%
//   CIK 1384042  2026-06-30   stored $811,944,966  declared $2,052,588,990  39.6%
//
// Re-ingesting 2056315 with current code restored it to exactly $156,019,625 — the cover-page total
// to the dollar — which is what proves both the diagnosis and the fix.
//
// ── HOW THEY ARE IDENTIFIED ──────────────────────────────────────────────────
//
// `fund_filings.holdings_count` records what the writer believed it stored. The old path set it to
// the RAW line count while storing only the deduped subset; the current path sets it to the
// aggregated count, which equals the rows actually stored. So a filing whose declared count differs
// from its actual row count is one the old path wrote — a precise, self-contained signature needing
// no external data. Measured: 1,276 filings across 477 filers, 1.90% of all filings.
//
// A filing where every security happened to appear once has declared == actual and is invisible to
// this check, which is correct: there were no sub-accounts to sum, so there is nothing to repair.
//
// ── WHY skipUnchanged IS OFF ─────────────────────────────────────────────────
//
// The affected filings carry the RIGHT accession — only their contents are wrong. The fast path
// skips on an accession match and would skip exactly the filings that need rewriting, so this repair
// must re-read them. storeFilingSuperseded then rewrites a quarter whose stored count disagrees with
// the freshly aggregated count, which is the self-healing behaviour it was built for.
//
// Nothing is deleted outright: each quarter is replaced inside the existing idempotent store, and
// filed_date, accession, fund identity, security identity and amendment layering are unchanged.

import { neon } from '@neondatabase/serverless';
import { ingestFiler } from '../src/lib/institutions-universe.js';

const sql = neon(process.env.DATABASE_URL);
const DRY = process.argv.includes('--dry');
const li = process.argv.indexOf('--limit');
const LIMIT = li >= 0 && process.argv[li + 1] ? parseInt(process.argv[li + 1], 10) : 0;

const affected = await sql`
  select f.cik, min(f.quarter)::text earliest, count(*)::int filings
    from fund_filings f
   where f.holdings_count is distinct from (select count(*) from fund_holdings h where h.cik = f.cik and h.quarter = f.quarter)
   group by f.cik
   order by count(*) desc`;

const targets = LIMIT ? affected.slice(0, LIMIT) : affected;
const totalFilings = affected.reduce((s, a) => s + a.filings, 0);
console.log(`under-aggregated filings: ${totalFilings} across ${affected.length} filers`);
console.log(`repairing: ${targets.length} filers${LIMIT ? ` (limited from ${affected.length})` : ''}`);
console.log(DRY ? 'DRY RUN — nothing will be written\n' : '');

if (DRY) {
  for (const a of targets.slice(0, 15)) console.log(`  cik ${a.cik}  from ${a.earliest}  ${a.filings} filings`);
  process.exit(0);
}

const t0 = Date.now();
let repaired = 0, failed = 0, quarters = 0, done = 0;
for (const a of targets) {
  done += 1;
  try {
    const r = await ingestFiler(a.cik, a.earliest, { skipUnchanged: false });
    if (r.status === 'failed') { failed += 1; console.log(`  ${a.cik}: FAILED ${r.error || ''}`); continue; }
    if (r.status === 'partial') { failed += 1; console.log(`  ${a.cik}: PARTIAL ${(r.unresolved || []).map((u) => `${u.quarter}:${u.reason}`).join(' ')}`); continue; }
    repaired += 1; quarters += r.quarters || 0;
  } catch (e) { failed += 1; console.log(`  ${a.cik}: ${String(e.message).slice(0, 100)}`); }
  if (done % 25 === 0) {
    const rate = done / ((Date.now() - t0) / 60000);
    console.log(`  [${((Date.now() - t0) / 60000).toFixed(1)}m] ${done}/${targets.length} filers · ${quarters} quarters rewritten · ${rate.toFixed(1)}/min`);
  }
}

console.log(`\nrepaired filers: ${repaired}  ·  quarters rewritten: ${quarters}  ·  failed: ${failed}`);

const [after] = await sql`
  select count(*)::int n from fund_filings f
   where f.holdings_count is distinct from (select count(*) from fund_holdings h where h.cik = f.cik and h.quarter = f.quarter)`;
console.log(`filings still under-aggregated: ${after.n} (was ${totalFilings})`);
