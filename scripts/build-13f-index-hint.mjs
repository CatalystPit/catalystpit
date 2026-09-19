// WHICH FILERS ARE WORTH CRAWLING FIRST — from SEC's quarterly full-index.
//
//   node --env-file=.env.local scripts/build-13f-index-hint.mjs 2024/4 2025/1
//
// ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
//
// The backfill orders its queue by `institutions.filing_count`, which is a proxy for "important
// filer" and says nothing about whether the filer has the quarter we are missing. Measured on the
// live registry: 9,725 filers lack anything at or before 2024-09-30, but only 8,109 of them filed a
// 13F-HR in 2024Q4 or 2025Q1 at all. The other 1,616 registered later and CANNOT produce a
// 2024-09-30 quarter — crawling them costs a submissions fetch each and returns nothing.
//
// Worse, the ordering actively fought the goal. The top filer by `filing_count` among the todo set
// turned out to have seven stored quarters running 2024-12-31 → 2026-06-30 and no 2024-09-30 at all:
// a high score for having been crawled thoroughly, which is the opposite of the signal wanted here.
//
// ── THE HINT IS ORDERING ONLY. IT IS NEVER DATA. ─────────────────────────────
//
// master.idx gives CIK, form type, filing date and accession — it does NOT give the period of
// report. A 13F-HR filed in 2024Q4 is USUALLY for period 2024-09-30, but late filings and amendments
// for older periods appear in the same index, so the filing quarter is a hint and nothing more.
// Nothing here is written to fund_filings or fund_holdings, and no quarter is inferred from it. The
// period of report still comes from the filer's own submissions JSON via ingestFiler, exactly as
// before. If this table were deleted the backfill would produce identical data, more slowly.
//
// Safe to re-run: the table is keyed (cik, idx_quarter) and upserted.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const unpad = (c) => String(Number(String(c).replace(/\D/g, '')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const want = process.argv.slice(2).filter((a) => /^\d{4}\/[1-4]$/.test(a));
if (!want.length) want.push('2024/4', '2025/1');

await sql`
  create table if not exists institution_index_hint (
    cik text not null, idx_quarter text not null, form text,
    seen_at timestamptz not null default now(),
    primary key (cik, idx_quarter))`;

let total = 0;
for (const w of want) {
  const [y, q] = w.split('/');
  const url = `https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/master.idx`;
  const r = await fetch(url, { headers: SEC_HEADERS, cache: 'no-store' });
  if (!r.ok) { console.error(`  ${w}: HTTP ${r.status} — skipped`); continue; }
  const text = await r.text();

  // Take the FIRST form seen per CIK in this index. Which one it is does not matter: the hint is
  // "this filer was active in this quarter", and the form column is kept only for inspection.
  const seen = new Map();
  let filings = 0;
  let started = false;
  for (const line of text.split('\n')) {
    if (!started) { if (/^-{5,}/.test(line) || /^CIK\|/.test(line)) started = true; continue; }
    const p = line.split('|');
    if (p.length < 5) continue;
    if (!String(p[2]).startsWith('13F-HR')) continue;   // 13F-HR and 13F-HR/A
    const c = unpad(p[0]);
    if (!c || c === '0') continue;
    filings++;
    if (!seen.has(c)) seen.set(c, String(p[2]).trim());
  }

  const rows = [...seen.entries()];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await sql`
      insert into institution_index_hint (cik, idx_quarter, form)
      select * from unnest(
        ${chunk.map((x) => x[0])}::text[],
        ${chunk.map(() => `${y}Q${q}`)}::text[],
        ${chunk.map((x) => x[1])}::text[])
      on conflict (cik, idx_quarter) do update set form = excluded.form, seen_at = now()`;
  }
  total += rows.length;
  console.log(`  ${y}Q${q}: ${filings} 13F-HR filings → ${rows.length} distinct filers`);
  await sleep(300);
}

console.log(`\n${total} (cik, quarter) hints written`);

// What the hint is actually worth for the quarter the research is gated on.
const [m] = await sql`
  select count(*)::int todo,
         count(*) filter (where exists (
           select 1 from institution_index_hint h where h.cik = i.cik))::int hinted
    from institutions i
   where not exists (select 1 from fund_filings f where f.cik = i.cik and f.quarter <= '2024-09-30'::date)`;
console.log(`todo filers: ${m.todo} · of which known-active in an indexed quarter: ${m.hinted} ` +
  `(${m.todo - m.hinted} cannot produce the quarter and now sort last)`);
