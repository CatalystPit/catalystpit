// Institutional CUSIP -> ticker resolution coverage. Read-only. Run before and after a repair.
//   node --env-file=.env.local scripts/institutional-coverage.mjs [label]
//
// Coverage is NOT the thing being optimised. It is reported so that a drop can be checked against
// what was removed: a ticker lost is a win when the security was never that ticker's.

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const n = (x) => Number(x).toLocaleString('en-US');
const pct = (a, b) => b ? (100 * a / b).toFixed(2) + '%' : '-';
const label = process.argv[2] || '';
console.log('=== INSTITUTIONAL RESOLUTION COVERAGE ' + label + ' ===');

const [h] = await sql.query(`select count(*)::int rows,
  count(*) filter (where ticker is not null)::int with_t,
  count(*) filter (where ticker is null)::int no_t,
  count(distinct cusip)::int cusips, count(distinct ticker)::int tickers from fund_holdings`);
console.log('  total fund_holdings              ' + n(h.rows));
console.log('  holdings with a ticker           ' + n(h.with_t) + '   ' + pct(h.with_t, h.rows));
console.log('  holdings without a ticker        ' + n(h.no_t) + '   ' + pct(h.no_t, h.rows));
console.log('  distinct cusips / tickers        ' + n(h.cusips) + ' / ' + n(h.tickers));

const p = await sql.query(`select
    case when m.cusip is null then 'no mapping row'
         when m.status = 'rejected' then 'rejected by repair'
         when m.source in ('openfigi','manual','consensus') and m.ticker is not null then 'trustworthy CUSIP-level'
         when m.source in ('openfigi','manual','consensus') then 'authority: unmappable'
         else 'issuer/name-inferred (' || m.source || ')' end k,
    count(*)::int rows, count(*) filter (where f.ticker is not null)::int with_t
  from fund_holdings f left join cusip_map m on m.cusip = f.cusip group by 1 order by rows desc`);
console.log('\n  by resolution provenance:');
for (const r of p) console.log('    ' + r.k.padEnd(34) + n(r.rows).padStart(10) + ' rows   ' + n(r.with_t).padStart(10) + ' with ticker');

const [c] = await sql.query(`with pfx as (select ticker, left(cusip,6) p from fund_holdings
    where ticker is not null and cusip ~ '^[0-9A-Z]{9}$' group by ticker, left(cusip,6))
  select (select count(*) from (select ticker from pfx group by ticker having count(*)>1) z)::int tickers,
         (select count(*) from pfx where ticker in (select ticker from pfx group by ticker having count(*)>1))::int groups`);
console.log('\n  cross-issuer conflicts:');
console.log('    tickers carrying >1 CUSIP issuer ' + n(c.tickers));
console.log('    (ticker, issuer-prefix) groups   ' + n(c.groups));
const [x] = await sql.query(`select count(*)::int t from
  (select cusip from cusip_map where ticker is not null group by cusip having count(distinct ticker)>1) z`);
console.log('    CUSIPs mapping to >1 ticker      ' + n(x.t));
const [ct] = await sql.query(`select count(*)::int n from fund_holdings f join cusip_map m on m.cusip=f.cusip
  where f.ticker is not null and m.source in ('openfigi','manual','consensus')
    and m.ticker is not null and m.ticker <> f.ticker`);
console.log('    holdings authority contradicts   ' + n(ct.n));

console.log('\n  cusip_map:');
for (const r of await sql.query(`select coalesce(source,'-') source, status, count(*)::int rows from cusip_map group by 1,2 order by rows desc`))
  console.log('    ' + r.source.padEnd(12) + r.status.padEnd(12) + n(r.rows).padStart(8));
