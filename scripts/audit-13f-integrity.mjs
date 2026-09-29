// 13F / INSTITUTIONAL DATA INTEGRITY AUDIT — measurement only. Writes nothing.
//
//   node --env-file=.env.local scripts/audit-13f-integrity.mjs
//
// ⚠️ IT ASKS PRODUCTION, NOT THE COMMENTS. Every number here comes from the live tables; where a
// claim can only be settled by the SEC document, the document is fetched.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const S = (s) => console.log(`\n${'='.repeat(76)}\n${s}\n${'='.repeat(76)}`);
const row1 = async (q) => (await q)[0];
const t0 = Date.now();
const timed = async (label, q) => { const s = Date.now(); const r = await q; console.log(`  ${label.padEnd(52)} ${String(Date.now() - s).padStart(6)}ms`); return r; };

S('1. POPULATION');
console.log(await row1(sql`SELECT
  (SELECT count(*)::int FROM fund_filings)                     AS filings,
  (SELECT count(DISTINCT cik)::int FROM fund_filings)          AS filers,
  (SELECT count(DISTINCT quarter)::int FROM fund_filings)      AS quarters,
  (SELECT min(quarter)::text FROM fund_filings)                AS first_q,
  (SELECT max(quarter)::text FROM fund_filings)                AS last_q,
  (SELECT count(*)::int FROM fund_holdings)                    AS holdings,
  (SELECT count(DISTINCT cusip)::int FROM fund_holdings)       AS cusips,
  (SELECT count(*)::int FROM ticker_institutional_ownership)   AS ownership_rows`));

S('2. AMENDMENTS — what is stored, and can an original count alongside one?');
// fund_filings' PRIMARY KEY is (cik, quarter): one operative filing per fund-quarter, structurally.
// So the question is not "do both rows exist" but "do the HOLDINGS carry more than one accession, and
// if so, is that the additive-amendment layering the SEC metadata calls for".
const multi = await sql`
  SELECT count(*)::int quarters_with_multiple_accessions FROM (
    SELECT cik, quarter FROM fund_holdings
     WHERE accession IS NOT NULL GROUP BY 1,2 HAVING count(DISTINCT accession) > 1) t`;
console.log('  fund_filings rows per (cik,quarter): enforced unique by primary key');
console.log(`  quarters whose holdings span >1 accession: ${multi[0].quarters_with_multiple_accessions}`);
const layered = await sql`
  SELECT f.cik, f.quarter::text, f.accession AS head, f.holdings_count,
         count(DISTINCT h.accession)::int accessions, count(*)::int rows
    FROM fund_filings f JOIN fund_holdings h ON h.cik = f.cik AND h.quarter = f.quarter
   GROUP BY 1,2,3,4 HAVING count(DISTINCT h.accession) > 1
   ORDER BY 6 DESC LIMIT 10`;
console.log('  sample layered quarters (head accession + additive amendments):');
for (const r of layered) console.log(`    cik ${r.cik} ${r.quarter}  head ${r.head}  ${r.accessions} accessions, ${r.rows} rows (stored count ${r.holdings_count})`);

// ⚠️ THE SELF-HEALING SIGNAL. storeFilingSuperseded rewrites a quarter when the stored holdings_count
// disagrees with what it parses — which is how a quarter written by the OLD restatement-only logic
// heals. A surviving mismatch means a quarter that has not been re-ingested since that fix.
const mismatch = await sql`
  SELECT count(*)::int n FROM (
    SELECT f.cik, f.quarter, f.holdings_count, count(*)::int actual
      FROM fund_filings f JOIN fund_holdings h ON h.cik=f.cik AND h.quarter=f.quarter
     GROUP BY 1,2,3) t WHERE t.holdings_count IS DISTINCT FROM t.actual`;
console.log(`\n  ⚠️ quarters where stored holdings_count <> actual row count: ${mismatch[0].n}`);
const mmSample = await sql`
  SELECT f.cik, f.quarter::text, f.holdings_count stored, count(*)::int actual
    FROM fund_filings f JOIN fund_holdings h ON h.cik=f.cik AND h.quarter=f.quarter
   GROUP BY 1,2,3 HAVING f.holdings_count IS DISTINCT FROM count(*)
   ORDER BY abs(f.holdings_count - count(*)) DESC LIMIT 8`;
for (const r of mmSample) console.log(`    cik ${r.cik} ${r.quarter}  stored ${r.stored} vs actual ${r.actual}`);

const orphanFilings = await row1(sql`
  SELECT count(*)::int n FROM fund_filings f
   WHERE NOT EXISTS (SELECT 1 FROM fund_holdings h WHERE h.cik=f.cik AND h.quarter=f.quarter)`);
const orphanHoldings = await row1(sql`
  SELECT count(DISTINCT (cik, quarter))::int n FROM fund_holdings h
   WHERE NOT EXISTS (SELECT 1 FROM fund_filings f WHERE f.cik=h.cik AND f.quarter=h.quarter)`);
console.log(`\n  filings with no holdings (13F-NT or empty table): ${orphanFilings.n}`);
console.log(`  holdings with no filing row (orphans):            ${orphanHoldings.n}`);

S('3. FILING IDENTITY AND DUPLICATES');
const dupes = await row1(sql`SELECT
  (SELECT count(*)::int FROM (SELECT cik, quarter FROM fund_filings GROUP BY 1,2 HAVING count(*)>1) t) AS dup_cik_quarter,
  (SELECT count(*)::int FROM (SELECT accession FROM fund_filings WHERE accession IS NOT NULL GROUP BY 1 HAVING count(*)>1) t) AS dup_accession,
  (SELECT count(*)::int FROM (SELECT cik,quarter,cusip,class,put_call FROM fund_holdings GROUP BY 1,2,3,4,5 HAVING count(*)>1) t) AS dup_holding_key`);
console.log(dupes);
// An accession legitimately appearing for two (cik,quarter) pairs would mean one document filed for
// two periods — worth seeing rather than assuming.
const dupAcc = await sql`
  SELECT accession, count(*)::int n, string_agg(cik || '@' || quarter::text, ' ') AS pairs
    FROM fund_filings WHERE accession IS NOT NULL GROUP BY 1 HAVING count(*)>1 ORDER BY 2 DESC LIMIT 5`;
for (const r of dupAcc) console.log(`  accession ${r.accession} on ${r.n}: ${r.pairs}`);

// ⚠️ DOES THE UNIQUE KEY COLLAPSE DIMENSIONS THE SEC REPORTS SEPARATELY? The key is
// (cik, quarter, cusip, class, put_call). voting authority, investment discretion and otherManager
// are NOT columns at all, so they cannot be part of it — the question is whether the SUM is right.
const cols = await sql`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='fund_holdings' ORDER BY ordinal_position`;
console.log(`\n  fund_holdings columns: ${cols.map((c) => c.column_name).join(', ')}`);

S('4. LATEST-QUARTER SELECTION — report period vs filing date');
// A later FILING DATE must never promote an older REPORT PERIOD to "latest".
const clocks = await row1(sql`SELECT
  (SELECT max(quarter)::text FROM fund_filings)                                        AS max_quarter,
  (SELECT max(filed_date)::text FROM fund_filings)                                     AS max_filed,
  (SELECT count(*)::int FROM fund_filings WHERE filed_date < quarter)                  AS filed_before_period_end,
  (SELECT count(*)::int FROM fund_filings WHERE filed_date > quarter + interval '400 days') AS filed_over_400d_late`);
console.log(clocks);
const lateAmend = await sql`
  SELECT cik, quarter::text, filed_date::text, (filed_date - quarter) AS lag_days
    FROM fund_filings WHERE filed_date IS NOT NULL ORDER BY (filed_date - quarter) DESC LIMIT 6`;
console.log('  largest report-period → filed-date lags (a late filing or amendment):');
for (const r of lateAmend) console.log(`    cik ${r.cik} period ${r.quarter} filed ${r.filed_date} (+${r.lag_days}d)`);
const perQuarter = await sql`
  SELECT quarter::text, count(*)::int filers FROM fund_filings GROUP BY 1 ORDER BY 1 DESC LIMIT 8`;
console.log('  filers per report period (most recent first):');
for (const r of perQuarter) console.log(`    ${r.quarter}  ${r.filers}`);

S('5. POSITION VALUE SCALE');
// Form 13F reported values were in THOUSANDS before 2023-06 and in whole dollars after. A double
// conversion shows up as an implausible value-per-share.
const vps = await sql`
  SELECT quarter::text,
         count(*)::int rows,
         round(percentile_cont(0.5) within group (order by value/nullif(shares,0))::numeric, 2) AS median_value_per_share,
         round(percentile_cont(0.99) within group (order by value/nullif(shares,0))::numeric, 2) AS p99
    FROM fund_holdings WHERE put_call = '' AND shares > 0 AND value > 0
   GROUP BY 1 ORDER BY 1 DESC LIMIT 12`;
console.log('  median USD value per share by report period (a sane equity market is ~$10-200):');
for (const r of vps) console.log(`    ${r.quarter}  rows ${String(r.rows).padStart(8)}  median ${String(r.median_value_per_share).padStart(9)}  p99 ${r.p99}`);

S('6. QoQ SANITY');
const qoq = await row1(sql`SELECT
  (SELECT count(*)::int FROM fund_holdings WHERE shares < 0)      AS negative_shares,
  (SELECT count(*)::int FROM fund_holdings WHERE value  < 0)      AS negative_value,
  (SELECT count(*)::int FROM fund_holdings WHERE shares IS NULL)  AS null_shares,
  (SELECT count(*)::int FROM fund_holdings WHERE value IS NULL)   AS null_value`);
console.log(qoq);

S('7. CUSIP / SYMBOL RESOLUTION');
const cusips = await row1(sql`SELECT
  (SELECT count(DISTINCT cusip)::int FROM fund_holdings)                                  AS distinct_cusips,
  (SELECT count(DISTINCT cusip)::int FROM fund_holdings WHERE ticker IS NOT NULL)          AS with_ticker,
  (SELECT count(DISTINCT cusip)::int FROM fund_holdings WHERE ticker IS NULL)              AS without_ticker,
  (SELECT count(*)::int FROM cusip_map)                                                     AS map_rows,
  (SELECT count(*)::int FROM cusip_map WHERE status='resolved')                             AS map_resolved,
  (SELECT count(*)::int FROM cusip_map WHERE status='unresolved')                           AS map_unresolved,
  (SELECT count(*)::int FROM cusip_map WHERE status='manual')                               AS map_manual`);
console.log(cusips);
const multiSym = await sql`
  SELECT cusip, count(DISTINCT ticker)::int n, string_agg(DISTINCT ticker, ' ') AS tickers
    FROM fund_holdings WHERE ticker IS NOT NULL GROUP BY 1 HAVING count(DISTINCT ticker)>1
   ORDER BY 2 DESC LIMIT 12`;
console.log(`\n  ⚠️ CUSIPs resolving to MORE THAN ONE ticker: ${multiSym.length} (top 12 shown)`);
for (const r of multiSym) console.log(`    ${r.cusip}  ${r.n}  ${r.tickers}`);
const multiCusip = await sql`
  SELECT ticker, count(DISTINCT cusip)::int n, string_agg(DISTINCT cusip, ' ') cusips
    FROM fund_holdings WHERE ticker IS NOT NULL GROUP BY 1 HAVING count(DISTINCT cusip)>2
   ORDER BY 2 DESC LIMIT 8`;
console.log(`  tickers carrying >2 distinct CUSIPs (share classes, or a symbol reused):`);
for (const r of multiCusip) console.log(`    ${r.ticker}  ${r.n}  ${String(r.cusips).slice(0, 90)}`);

S('8. OWNERSHIP AGGREGATION — what "institutional ownership" counts');
const own = await row1(sql`SELECT
  (SELECT count(*)::int FROM fund_holdings WHERE put_call <> '')                 AS option_rows,
  (SELECT count(DISTINCT put_call)::int FROM fund_holdings)                      AS distinct_putcall,
  (SELECT count(*)::int FROM ticker_institutional_ownership)                     AS rows,
  (SELECT count(DISTINCT as_of_quarter)::int FROM ticker_institutional_ownership) AS distinct_quarters,
  (SELECT max(as_of_quarter)::text FROM ticker_institutional_ownership)          AS latest_quarter,
  (SELECT count(*)::int FROM ticker_institutional_ownership WHERE ownership_pct > 100) AS pct_over_100`);
console.log(own);
console.log('  put_call values in use:', (await sql`SELECT put_call, count(*)::int n FROM fund_holdings GROUP BY 1 ORDER BY 2 DESC`));

S('9. STALENESS');
const stale = await sql`
  WITH latest AS (SELECT cik, max(quarter) q FROM fund_filings GROUP BY 1)
  SELECT q::text quarter, count(*)::int filers FROM latest GROUP BY 1 ORDER BY 1 DESC LIMIT 10`;
console.log('  each filer\'s most recent report period:');
for (const r of stale) console.log(`    ${r.quarter}  ${r.filers} filers`);

S('10. INTEGRITY');
const integ = await row1(sql`SELECT
  (SELECT count(*)::int FROM fund_holdings WHERE cusip IS NULL OR cusip = '')            AS null_cusip,
  (SELECT count(*)::int FROM fund_holdings h JOIN fund_filings f ON f.cik=h.cik AND f.quarter=h.quarter
     WHERE h.filed_date IS NOT NULL AND h.filed_date < h.quarter)                        AS holding_filed_before_period,
  (SELECT count(*)::int FROM fund_filings WHERE quarter > current_date)                   AS future_period,
  (SELECT count(*)::int FROM fund_filings WHERE filed_date > current_date)                AS future_filed,
  (SELECT count(*)::int FROM fund_holdings WHERE quarter > current_date)                  AS holding_future_period`);
console.log(integ);

S('11. QUERY TIMING (user-facing shapes)');
await timed('ticker ownership by primary key', sql`SELECT * FROM ticker_institutional_ownership WHERE ticker='AAPL'`);
await timed('fund latest quarter', sql`SELECT max(quarter)::text FROM fund_filings WHERE cik=(SELECT cik FROM fund_filings ORDER BY total_value DESC NULLS LAST LIMIT 1)`);
await timed('fund holdings for one cik+quarter', sql`SELECT count(*)::int FROM fund_holdings WHERE cik=(SELECT cik FROM fund_filings ORDER BY total_value DESC NULLS LAST LIMIT 1) AND quarter=(SELECT max(quarter) FROM fund_filings)`);
await timed('reverse-13F: funds holding one ticker, latest q', sql`
  SELECT count(*)::int FROM fund_holdings WHERE ticker='AAPL' AND quarter=(SELECT max(quarter) FROM fund_holdings WHERE ticker='AAPL')`);

console.log(`\ntotal ${Date.now() - t0}ms`);
