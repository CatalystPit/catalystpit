// DID THE 503 SILENT-SKIP LOSE ANY 13F DATA? — the completeness audit, and its repair.
//
//   node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/audit-13f-gaps.mjs [--repair]
//
// ── WHY OUR OWN ERROR LOG CANNOT ANSWER THIS ─────────────────────────────────
//
// The defect being audited is precisely that a skipped filing recorded NOTHING. secFetch returned
// null for a 503, fetchHoldings turned that into [], and the caller read [] as "this filing reports
// no positions" and moved on — no error, no counter, no retry. So "no error recorded" is exactly
// what a lost filing looks like, and any audit that trusts our own bookkeeping would confirm a
// completeness it cannot see. Present since the path's first commit, 113a871d.
//
// The expectation therefore has to come from OUTSIDE our pipeline. SEC's quarterly full-index lists
// every 13F-HR filed in a quarter, independently of anything we did with it, and that is what
// institution_index_hint holds. A filer in the index with no stored filing for the matching report
// quarter is a CANDIDATE gap.
//
// ── A CANDIDATE IS NOT YET A GAP ─────────────────────────────────────────────
//
// The index says WHEN a filing was filed, never which period it reports. A 13F-HR filed in 2024Q4
// is usually for 2024-09-30, but amendments and late filings for older periods sit in the same
// index. So every candidate is then checked against the filer's own submissions history, which does
// carry the period of report, and only a filer that genuinely has a 13F-HR for that exact period is
// counted as a gap. Anything else is a filer who simply did not file that quarter.
//
// ── REPAIR IS NARROW BY CONSTRUCTION ─────────────────────────────────────────
//
// --repair calls the SAME idempotent ingestFiler the rest of the system uses, once per proven gap.
// It writes only quarters that are missing, it cannot touch a quarter already stored (storeFiling-
// Superseded declines to rewrite an unchanged one), and filed_date, accession, fund identity,
// security identity and amendment layering all come from the ingest path unchanged. There is no
// delete, no reset and no reload.

import { neon } from '@neondatabase/serverless';
import { ingestFiler } from '../src/lib/institutions-universe.js';

const sql = neon(process.env.DATABASE_URL);
const REPAIR = process.argv.includes('--repair');
const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const pad10 = (c) => String(c).replace(/\D/g, '').padStart(10, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each report quarter against the filing quarter its 13F-HR is due in.
const QUARTERS = [
  ['2024-09-30', '2024Q4'], ['2024-12-31', '2025Q1'], ['2025-03-31', '2025Q2'], ['2025-06-30', '2025Q3'],
  ['2025-09-30', '2025Q4'], ['2025-12-31', '2026Q1'], ['2026-03-31', '2026Q2'], ['2026-06-30', '2026Q3'],
];

console.log('13F COMPLETENESS AUDIT — stored history vs SEC\'s own quarterly full-index');
console.log(`mode: ${REPAIR ? 'AUDIT + REPAIR' : 'AUDIT ONLY (pass --repair to fix proven gaps)'}\n`);

// ── 1. CANDIDATES ────────────────────────────────────────────────────────────
console.log('report q     expected  stored  candidates  coverage');
const candidates = [];
for (const [q, idx] of QUARTERS) {
  const [c] = await sql`
    select (select count(*) from institution_index_hint where idx_quarter = ${idx})::int expected,
           (select count(*) from fund_filings where quarter = ${q}::date)::int stored`;
  const rows = await sql`
    select h.cik from institution_index_hint h
     where h.idx_quarter = ${idx}
       and not exists (select 1 from fund_filings f where f.cik = h.cik and f.quarter = ${q}::date)`;
  for (const r of rows) candidates.push({ cik: r.cik, quarter: q });
  const cov = (100 * (c.expected - rows.length)) / Math.max(1, c.expected);
  console.log(`${q}  ${String(c.expected).padStart(8)}  ${String(c.stored).padStart(6)}  ` +
    `${String(rows.length).padStart(10)}  ${cov.toFixed(2).padStart(7)}%`);
}
console.log(`\ncandidate (cik, quarter) units to verify against SEC: ${candidates.length}`);

// ── 2. VERIFY EACH CANDIDATE AGAINST THE FILER'S OWN SUBMISSIONS ─────────────
// One request per distinct filer, paced. The submissions payload carries the period of report,
// which the full-index does not, so this is what turns a candidate into a verdict.
const byCik = new Map();
for (const c of candidates) {
  if (!byCik.has(c.cik)) byCik.set(c.cik, []);
  byCik.get(c.cik).push(c.quarter);
}
console.log(`distinct filers to check: ${byCik.size}\n`);

const gaps = [];
const notFiled = [];
const unchecked = [];
let n = 0;
for (const [cik, quarters] of byCik) {
  n += 1;
  if (n % 25 === 0) console.log(`  checked ${n}/${byCik.size} filers...`);
  let sub = null;
  for (let attempt = 1; attempt <= 3 && !sub; attempt++) {
    try {
      const r = await fetch(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { headers: SEC_HEADERS, cache: 'no-store' });
      if (r.ok) sub = await r.json();
      else { await r.text(); await sleep(1000 * attempt); }
    } catch { await sleep(1000 * attempt); }
  }
  await sleep(220);                       // ~4.5 req/s, under SEC's published 10/s
  if (!sub) {
    // Could not ask. NOT counted as "no gap" — that is the very mistake being audited.
    for (const q of quarters) unchecked.push({ cik, quarter: q });
    continue;
  }
  const R = sub.filings?.recent || {};
  const periods = new Set();
  for (let i = 0; i < (R.form || []).length; i++) {
    if (String(R.form[i]).startsWith('13F-HR')) periods.add(R.reportDate?.[i]);
  }
  for (const q of quarters) {
    if (periods.has(q)) gaps.push({ cik, quarter: q, name: sub.name });
    else notFiled.push({ cik, quarter: q });
  }
}

console.log(`\n=== VERDICT ===`);
console.log(`  PROVEN GAPS      (SEC has a 13F-HR for that period, we do not): ${gaps.length}`);
console.log(`  legitimately absent (filer has no 13F-HR for that period)     : ${notFiled.length}`);
console.log(`  UNCHECKED        (submissions unreadable — NOT assumed clean) : ${unchecked.length}`);

if (gaps.length) {
  console.log('\nproven gaps by quarter:');
  const byQ = new Map();
  for (const g of gaps) byQ.set(g.quarter, (byQ.get(g.quarter) || 0) + 1);
  for (const [q, c] of [...byQ].sort()) console.log(`  ${q}  ${c}`);
  console.log('\nfirst 15:');
  for (const g of gaps.slice(0, 15)) console.log(`  ${g.quarter}  CIK ${g.cik}  ${String(g.name || '').slice(0, 50)}`);
}
if (unchecked.length) {
  console.log('\nunchecked (retry these before declaring the audit clean):');
  for (const u of unchecked.slice(0, 15)) console.log(`  ${u.quarter}  CIK ${u.cik}`);
}

// ── 3. REPAIR ────────────────────────────────────────────────────────────────
if (REPAIR && gaps.length) {
  console.log(`\n=== REPAIRING ${gaps.length} proven gaps via the existing idempotent ingestFiler ===`);
  const ciks = [...new Set(gaps.map((g) => g.cik))];
  // The earliest quarter proven missing for a filer is its cutoff, so one pass repairs every gap it
  // has without reaching further back than the audit proved.
  const earliest = new Map();
  for (const g of gaps) {
    const cur = earliest.get(g.cik);
    if (!cur || g.quarter < cur) earliest.set(g.cik, g.quarter);
  }
  let repaired = 0, failed = 0, quartersWritten = 0;
  for (const cik of ciks) {
    try {
      const r = await ingestFiler(cik, earliest.get(cik), { skipUnchanged: true });
      if (r.error) { failed += 1; console.log(`  ${cik}: ${r.error}`); continue; }
      if ((r.unreadable || []).length) { failed += 1; console.log(`  ${cik}: unreadable ${r.unreadable.join(',')}`); continue; }
      repaired += 1; quartersWritten += r.quarters || 0;
    } catch (e) { failed += 1; console.log(`  ${cik}: ${String(e.message).slice(0, 90)}`); }
  }
  console.log(`\nrepaired filers: ${repaired}  ·  quarters written: ${quartersWritten}  ·  failed: ${failed}`);

  console.log('\n=== POST-REPAIR COVERAGE ===');
  console.log('report q     expected  stored  remaining  coverage');
  for (const [q, idx] of QUARTERS) {
    const [c] = await sql`
      select (select count(*) from institution_index_hint where idx_quarter = ${idx})::int expected,
             (select count(*) from fund_filings where quarter = ${q}::date)::int stored,
             (select count(*) from institution_index_hint h where h.idx_quarter = ${idx}
                and not exists (select 1 from fund_filings f where f.cik = h.cik and f.quarter = ${q}::date))::int remaining`;
    const cov = (100 * (c.expected - c.remaining)) / Math.max(1, c.expected);
    console.log(`${q}  ${String(c.expected).padStart(8)}  ${String(c.stored).padStart(6)}  ` +
      `${String(c.remaining).padStart(9)}  ${cov.toFixed(2).padStart(7)}%`);
  }
}
