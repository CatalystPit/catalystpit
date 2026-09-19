// BACKFILL MISSING 13F REPORTING QUARTERS FROM EDGAR.
//
// Uses the EXISTING ingestion architecture — `ingestFiler(cik, cutoff)` from
// src/lib/institutions-universe.js — rather than a parallel 13F system. That function already
// handles everything this job needs and has been in production for the current quarters:
//
//   idempotent      a (cik, quarter) already in fund_filings is skipped
//   amendment-aware resolveQuarter() composes the restating filing plus additive amendments
//   rate-limited    SEC fetches are spaced and secBlocked() backs off on a 429
//   provenance      every row keeps its own accession and filed_date, so the point-in-time
//                   information date survives the backfill
//
//   node --env-file=.env.local scripts/backfill-13f-quarters.mjs --cutoff 2024-09-30 --minutes 30
//   node --env-file=.env.local scripts/backfill-13f-quarters.mjs --cutoff 2025-06-30 --cap 200
//
// RESUMABLE BY CONSTRUCTION. Progress is the database, not a cursor file: each run asks which filers
// still lack a filing at or after the cutoff and works on those. Interrupt it and re-run; it picks
// up where it stopped and never re-fetches a quarter it already stored.
//
// ⚠️ WHY THIS MATTERS MORE THAN IT LOOKS. Quarter-over-quarter accumulation is only meaningful when
// BOTH quarters are populated. 2025-09-30 holds 7,590 funds and its predecessor 2025-06-30 holds
// ONE — so every fund in Q3 looks like a new initiation, and that quarter's acc/red counts are
// fiction. Backfilling the predecessor is what makes the successor usable, which is why the highest
// priority quarter is the one immediately BEFORE the first real one.

import { neon } from '@neondatabase/serverless';
import { ingestFiler, secBlocked } from '../src/lib/institutions-universe.js';

const sql = neon(process.env.DATABASE_URL);
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const CUTOFF = argOf('cutoff', '2024-09-30');
const CAP = parseInt(argOf('cap', '100000'), 10);
const MINUTES = parseFloat(argOf('minutes', '25'));
const DRY = args.includes('--dry');

const t0 = Date.now();
const budgetMs = MINUTES * 60_000;
const elapsed = () => (Date.now() - t0) / 1000;

console.log(`13F backfill — cutoff ${CUTOFF}, cap ${CAP}, budget ${MINUTES} min${DRY ? ' (DRY)' : ''}\n`);

// WHICH FILERS STILL NEED WORK. Ordered by how many holdings they already contribute, so the funds
// that move the QoQ numbers most are filled first and a partial run is still a useful run.
const todo = await sql`
  select i.cik, i.name, coalesce(h.n, 0)::int as weight
    from institutions i
    left join (select cik, count(*)::int n from fund_holdings group by cik) h on h.cik = i.cik
   where not exists (
     select 1 from fund_filings f where f.cik = i.cik and f.quarter <= ${CUTOFF}::date
   )
   order by coalesce(h.n, 0) desc
   limit ${CAP}`;

console.log(`filers with nothing at or before ${CUTOFF}: ${todo.length}`);
if (DRY) {
  console.log('top 10 by existing holdings:');
  for (const f of todo.slice(0, 10)) console.log(`  ${f.cik.padEnd(10)} ${String(f.name).slice(0, 44).padEnd(46)} ${f.weight}`);
  process.exit(0);
}

let done = 0, quarters = 0, stored = 0, errors = 0, blocked = 0;
for (const f of todo) {
  if (Date.now() - t0 > budgetMs) { console.log(`\nbudget reached after ${elapsed().toFixed(0)}s — re-run to continue`); break; }
  // The shared SEC backoff. If EDGAR has rate-limited us, stop rather than hammer it.
  if (secBlocked()) { blocked += 1; console.log('SEC backoff active — stopping this run'); break; }
  try {
    const r = await ingestFiler(f.cik, CUTOFF);
    quarters += r.quarters || 0;
    stored += r.stored || 0;
  } catch (e) {
    errors += 1;
    if (errors <= 3) console.log(`  ${f.cik}: ${e.message.slice(0, 80)}`);
  }
  done += 1;
  if (done % 25 === 0) {
    const rate = done / elapsed();
    console.log(`  ${done}/${todo.length} filers · ${quarters} quarters · ${stored.toLocaleString()} holdings · ` +
      `${rate.toFixed(2)} filers/s · ${(elapsed() / 60).toFixed(1)} min`);
  }
}

console.log(`\nrun complete: ${done} filers, ${quarters} quarters, ${stored.toLocaleString()} holdings, ${errors} errors, ${elapsed().toFixed(0)}s`);

const after = await sql`
  select quarter::text q, count(distinct cik)::int funds, count(*)::int holdings
    from fund_holdings group by 1 order by 1`;
console.log('\nquarter coverage now:');
for (const r of after) console.log(`  ${r.q}  funds=${String(r.funds).padStart(5)}  holdings=${r.holdings.toLocaleString()}`);

const remaining = await sql`
  select count(*)::int n from institutions i
   where not exists (select 1 from fund_filings f where f.cik = i.cik and f.quarter <= ${CUTOFF}::date)`;
console.log(`\nfilers still without a filing at or before ${CUTOFF}: ${remaining[0].n}`);
if (remaining[0].n > 0) console.log('re-run the same command to continue — it resumes from the database.');
