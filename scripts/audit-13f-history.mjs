// AUDIT THE 13F HISTORY — is it actually usable for point-in-time research?
//
//   node --env-file=.env.local scripts/audit-13f-history.mjs
//
// Completeness is NOT runtime. A quarter is complete when enough filers reported it, its holdings
// carry resolvable securities, and its filing dates are sane — not when the crawler stopped.
//
// The threshold is the FROZEN one from experiment-002-spec.md: a quarter needs >= 1,000 qualifying
// filers before it may be used. It is not lowered here to make a quarter pass. If the EDGAR universe
// is exhausted and a quarter still cannot reach it, that is documented as a gap rather than papered
// over.
//
// Read-only. Writes nothing.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const MIN_FILERS = 1000;
const pad = (s, n) => String(s).padStart(n);

console.log('=== QUARTER COVERAGE ===\n');
const qs = await sql`
  select h.quarter::text q,
         count(distinct h.cik)::int funds,
         count(*)::int holdings,
         count(distinct h.ticker)::int tickers,
         count(*) filter (where h.ticker is null)::int unresolved,
         min(h.filed_date)::text first_filed,
         max(h.filed_date)::text last_filed
    from fund_holdings h group by 1 order by 1`;
console.log('quarter      funds   holdings    tickers  unresolved  first filed   status');
for (const r of qs) {
  const ok = r.funds >= MIN_FILERS;
  const resolvedPct = r.holdings ? (100 * (r.holdings - r.unresolved)) / r.holdings : 0;
  console.log(`${r.q}  ${pad(r.funds, 6)}  ${pad(r.holdings.toLocaleString(), 10)}  ${pad(r.tickers, 7)}  ` +
    `${pad(`${resolvedPct.toFixed(0)}%`, 10)}  ${r.first_filed}   ${ok ? 'COMPLETE' : 'BELOW THRESHOLD'}`);
}

console.log('\n=== FILING-DATE SANITY (point-in-time depends on these) ===\n');
for (const r of await sql`
  select quarter::text q,
         count(*) filter (where filed_date < quarter)::int filed_before_quarter_end,
         count(*) filter (where filed_date is null)::int no_filed_date,
         count(*) filter (where filed_date > quarter + 200)::int filed_very_late
    from fund_holdings group by 1 order by 1`) {
  const bad = r.filed_before_quarter_end + r.no_filed_date;
  console.log(`  ${r.q}  filedBeforeQuarterEnd=${pad(r.filed_before_quarter_end, 7)}  noFiledDate=${pad(r.no_filed_date, 5)}  ` +
    `filed>200d=${pad(r.filed_very_late, 7)}  ${bad === 0 ? 'ok' : '⚠️ REVIEW'}`);
}
console.log('\n  (a holding filed BEFORE its own quarter ended would break point-in-time dating —');
console.log('   the information date must never precede the period it describes)');

console.log('\n=== DUPLICATE / AMENDMENT INTEGRITY ===\n');
const dup = await sql`
  select count(*)::int n from (
    select cik, quarter, cusip, class, put_call, count(*)::int c
      from fund_holdings group by 1,2,3,4,5 having count(*) > 1) t`;
console.log(`  duplicate (cik, quarter, cusip, class, put_call) rows: ${dup[0].n}  ${dup[0].n === 0 ? 'ok — the unique index holds' : '⚠️ REVIEW'}`);
const multiAcc = await sql`
  select count(*)::int n from (
    select cik, quarter, count(distinct accession)::int a from fund_holdings group by 1,2 having count(distinct accession) > 1) t`;
console.log(`  (cik, quarter) spanning multiple accessions: ${multiAcc[0].n}  — expected where amendments were layered`);

console.log('\n=== VALID CONSECUTIVE QoQ PAIRS ===\n');
const valid = [];
for (let i = 1; i < qs.length; i += 1) {
  if (qs[i].funds >= MIN_FILERS && qs[i - 1].funds >= MIN_FILERS) valid.push([qs[i - 1].q, qs[i].q]);
}
if (!valid.length) console.log('  NONE');
for (const [prev, cur] of valid) {
  // The four movements the research reads, computed the canonical way — from holdings, per fund,
  // never from the production fund_qoq cache.
  const r = (await sql`
    with per_fund as (
      select ticker, cik,
             sum(case when quarter = ${cur}::date then shares else 0 end) cur,
             sum(case when quarter = ${prev}::date then shares else 0 end) prev
        from fund_holdings
       where quarter in (${cur}::date, ${prev}::date) and ticker is not null and put_call = ''
       group by ticker, cik)
    select count(distinct ticker)::int tickers,
           sum(case when cur > prev and prev > 0 then 1 else 0 end)::int increased,
           sum(case when cur < prev and cur > 0 then 1 else 0 end)::int reduced,
           sum(case when prev = 0 and cur > 0 then 1 else 0 end)::int initiated,
           sum(case when cur = 0 and prev > 0 then 1 else 0 end)::int exited
      from per_fund`)[0];
  console.log(`  ${prev} → ${cur}`);
  console.log(`      tickers=${r.tickers}  increased=${r.increased.toLocaleString()}  reduced=${r.reduced.toLocaleString()}  ` +
    `initiated=${r.initiated.toLocaleString()}  exited=${r.exited.toLocaleString()}`);
  // ⚠️ THE SHAPE THAT REVEALS A BROKEN PAIR. If the earlier quarter is thin, almost every position
  // looks like a new initiation — which is exactly how Experiment 001's institutional arm was wrong.
  const initShare = (100 * r.initiated) / Math.max(1, r.increased + r.reduced + r.initiated + r.exited);
  console.log(`      initiations are ${initShare.toFixed(1)}% of all movements  ` +
    `${initShare > 60 ? '⚠️ SUSPICIOUS — the earlier quarter may be incomplete' : 'plausible'}`);
}

console.log('\n=== PRODUCTION CACHE vs CANONICAL HISTORY ===\n');
const cache = await sql`select quarter::text q, count(*)::int n from fund_qoq group by 1 order by 1`;
console.log(`  fund_qoq holds: ${cache.map((c) => `${c.q} (${c.n} tickers)`).join(', ') || 'nothing'}`);
console.log('  ⚠️ fund_qoq is a PRODUCTION CACHE of the current quarter, not history. Research must read');
console.log('     fund_holdings directly, keyed by filed_date — which is what dataset-002.mjs does.');

console.log('\n=== REMAINING BACKFILL WORK ===\n');
for (const cutoff of ['2024-09-30', '2025-06-30']) {
  const r = await sql`
    select count(*)::int n from institutions i
     where not exists (select 1 from fund_filings f where f.cik = i.cik and f.quarter <= ${cutoff}::date)`;
  console.log(`  filers with nothing at or before ${cutoff}: ${r[0].n}`);
}
const errs = await sql`select count(*)::int n, sum(case when attempts >= 3 then 1 else 0 end)::int abandoned from institution_backfill_error`;
console.log(`  recorded per-filer failures: ${errs[0].n} (abandoned after 3 attempts: ${errs[0].abandoned ?? 0})`);
