// Re-ingests fund-quarters whose holdings were destroyed by an additive 13F-HR/A being treated as a
// full restatement. Uses the corrected amendment-aware ingest, so each quarter is recomposed from
// its base filing plus any NEW HOLDINGS amendments, with per-row accession preserved.
//
//   node --env-file=.env.local scripts/repair-13f-amendments.mjs --dry
//   node --env-file=.env.local scripts/repair-13f-amendments.mjs --cik=1736225
//   node --env-file=.env.local scripts/repair-13f-amendments.mjs
import { neon } from '@neondatabase/serverless';
import { ingestFiler } from '../src/lib/institutions-universe.js';

const sql = neon(process.env.DATABASE_URL);
const DRY = process.argv.includes('--dry');
const one = (process.argv.find((a) => a.startsWith('--cik=')) || '').split('=')[1];

const cases = one ? [{ cik: one }] : await sql`
  with c as (select cik, quarter, count(*)::int n from fund_holdings
      where quarter >= '2025-09-30' group by 1,2),
  w as (select cik, quarter, n, lag(n) over (partition by cik order by quarter) prev,
        lead(n) over (partition by cik order by quarter) next from c)
  select distinct w.cik from w
   where w.prev is not null and w.next is not null and w.prev >= 20 and w.next >= 20
     and w.n < w.prev*0.2 and w.n < w.next*0.2`;

console.log(`${cases.length} filers to re-ingest${DRY ? ' [DRY]' : ''}`);
for (const { cik } of cases) {
  const before = await sql`select quarter::text q, count(*)::int n from fund_holdings where cik=${cik} group by 1 order by 1`;
  if (DRY) { console.log(`  ${cik}: ${before.map((b) => b.q + '=' + b.n).join(' ')}`); continue; }
  const res = await ingestFiler(cik, '2025-09-30');
  const after = await sql`select quarter::text q, count(*)::int n from fund_holdings where cik=${cik} group by 1 order by 1`;
  const bm = Object.fromEntries(before.map((b) => [b.q, b.n]));
  const changes = after.map((a) => `${a.q}: ${bm[a.q] ?? 0} -> ${a.n}${(bm[a.q] ?? 0) !== a.n ? ' *' : ''}`).join('  ');
  console.log(`  ${String(cik).padStart(8)} ${JSON.stringify(res).slice(0, 60)}  ${changes}`);
}
