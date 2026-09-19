// APPLY THE EXISTING CUSIP→TICKER MAP TO BACKFILLED HOLDINGS.
//
//   node --env-file=.env.local scripts/apply-cusip-map.mjs [--dry]
//
// WHY THIS IS NEEDED. The 13F ingestion stores holdings with `ticker = null` and resolves tickers
// afterwards, for CUSIPs it has never seen. Historical backfill mostly re-encounters CUSIPs the map
// ALREADY contains — measured on the backfilled quarters, 86–92% of holdings have a CUSIP already in
// `cusip_map` — but nothing retro-applies it, so those rows sit unresolved and the quarters read as
// `tickers=0` and are useless to research despite the holdings being present and correct.
//
// This is NOT a new classification system and it resolves nothing itself. It copies answers the
// existing resolver already produced, into rows written later. No OpenFIGI call, no SEC call, no
// network at all.
//
// SAFETY:
//   · only rows where `ticker IS NULL` are touched — an existing ticker is never overwritten, so a
//     newer, better resolution can never be clobbered by this pass
//   · only `status = 'resolved'` map rows are used; 'rejected' and 'unresolved' are ignored, which
//     is what keeps a known-bad mapping from being applied
//   · chunked, so a large update does not hold one enormous transaction

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const DRY = process.argv.includes('--dry');

const before = await sql`
  select quarter::text q, count(*)::int holdings,
         count(ticker)::int with_ticker,
         count(*) filter (where h.ticker is null and exists (
           select 1 from cusip_map m where m.cusip = h.cusip and m.status = 'resolved' and m.ticker is not null))::int applicable
    from fund_holdings h group by 1 order by 1`;
console.log('before:');
for (const r of before) {
  console.log(`  ${r.q}  holdings=${String(r.holdings.toLocaleString()).padStart(11)}  ` +
    `withTicker=${String(r.with_ticker.toLocaleString()).padStart(11)}  applicable=${r.applicable.toLocaleString()}`);
}
const total = before.reduce((a, r) => a + r.applicable, 0);
console.log(`\ntotal rows this pass would resolve: ${total.toLocaleString()}${DRY ? '  (DRY RUN)' : ''}`);
if (DRY || total === 0) process.exit(0);

// Chunked by a bounded subselect: one statement, one index scan, no giant transaction.
//
// PROGRESS IS MEASURED, NOT REPORTED BY THE DRIVER. This driver does not surface a rowCount for a
// tagged-template UPDATE — it reads 0 even when rows changed, which silently ended the loop after a
// single chunk on the first attempt. The remaining count is therefore re-queried each pass, and the
// loop stops when it stops falling.
const remaining = async () => Number((await sql`
  select count(*)::int n from fund_holdings h
   where h.ticker is null and exists (
     select 1 from cusip_map m where m.cusip = h.cusip and m.status = 'resolved' and m.ticker is not null)`)[0].n);

let left = await remaining();
let stalls = 0;
while (left > 0 && stalls < 2) {
  await sql`
    update fund_holdings h
       set ticker = m.ticker
      from cusip_map m
     where m.cusip = h.cusip
       and m.status = 'resolved' and m.ticker is not null
       and h.ticker is null
       and h.ctid in (
         select h2.ctid from fund_holdings h2
          join cusip_map m2 on m2.cusip = h2.cusip and m2.status = 'resolved' and m2.ticker is not null
          where h2.ticker is null limit 100000)`;
  const now = await remaining();
  if (now >= left) stalls += 1; else stalls = 0;
  console.log(`  applied ${(total - now).toLocaleString()} / ${total.toLocaleString()}  (remaining ${now.toLocaleString()})`);
  left = now;
}

console.log('\nafter:');
for (const r of await sql`
  select quarter::text q, count(*)::int holdings, count(ticker)::int with_ticker, count(distinct ticker)::int tickers
    from fund_holdings group by 1 order by 1`) {
  console.log(`  ${r.q}  holdings=${String(r.holdings.toLocaleString()).padStart(11)}  ` +
    `withTicker=${String(r.with_ticker.toLocaleString()).padStart(11)}  distinctTickers=${r.tickers}`);
}
