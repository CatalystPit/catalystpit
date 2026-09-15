// fund_net_qoq: the shipped calculation against the corrected V2 one.
//
// The current values are NOT ground truth — they come from one arbitrary row per filer per quarter,
// picked by physical order. This harness exists to show WHERE and WHY the corrected semantics differ,
// so the change is inspected rather than assumed.
//
// Read-only. Run: node --env-file=.env.local scripts/compare-fund-net-qoq.mjs

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const n = (x) => Number(x).toLocaleString('en-US');

const qs = await sql.query('select quarter::text q from fund_filings group by quarter order by quarter desc limit 2');
const [q0, q1] = qs.map((r) => r.q);
console.log(`quarters: ${q0} (current) vs ${q1} (prior)\n`);

const OLD = `
  select ticker, sum(case when cur > prev then 1 when cur < prev then -1 else 0 end)::int as net
    from (select ticker, cik,
            coalesce((array_agg(shares order by id desc) filter (where quarter = '${q0}'))[1], 0) cur,
            coalesce((array_agg(shares order by id desc) filter (where quarter = '${q1}'))[1], 0) prev
       from fund_holdings
      where (quarter = '${q0}' or quarter = '${q1}') and ticker is not null and put_call = ''
      group by ticker, cik) x
   group by ticker`;

const NEW = `
  with primary_cusip as (
    select distinct on (ticker) ticker, cusip
      from (select h.ticker, h.cusip, count(*)::int c from fund_holdings h
             where (h.quarter='${q0}' or h.quarter='${q1}') and h.ticker is not null and h.put_call=''
             group by h.ticker, h.cusip) z
     order by ticker, c desc, cusip),
  scoped as (
    select h.ticker,h.cik,h.quarter,h.cusip,h.shares,h.accession,h.filed_date
      from fund_holdings h
      left join primary_cusip p on p.ticker = h.ticker
      left join security_position_class s
        on s.cusip=h.cusip and s.cls=h.class and s.put_call=h.put_call
     where (h.quarter='${q0}' or h.quarter='${q1}') and h.ticker is not null and h.put_call=''
       and (h.cusip = p.cusip or s.kind is null
            or s.kind not in ('debt','option','warrant','right','preferred'))),
  latest as (select distinct on (cik,quarter,cusip) cik,quarter,cusip,accession from scoped
              order by cik,quarter,cusip,filed_date desc nulls last,accession desc),
  kept as (select sc.ticker,sc.cik,sc.quarter,sc.cusip,sc.shares from scoped sc join latest l
            on l.cik=sc.cik and l.quarter=sc.quarter and l.cusip=sc.cusip and l.accession=sc.accession),
  per_security as (select ticker,cik,quarter,cusip,sum(shares)::numeric shares from kept group by 1,2,3,4),
  per_filer as (select ticker,cik,coalesce(sum(shares) filter (where quarter='${q0}'),0) cur,
                       coalesce(sum(shares) filter (where quarter='${q1}'),0) prev
                  from per_security group by 1,2)
  select ticker, sum(case when cur>prev then 1 when cur<prev then -1 else 0 end)::int net
    from per_filer group by ticker`;

const run = async (label, q) => {
  await sql.query(q);                                    // warm
  const t = Date.now(); const r = await sql.query(q); const ms = Date.now() - t;
  const kb = Math.round(Buffer.byteLength(JSON.stringify(r)) / 1024);
  console.log(`  ${label.padEnd(22)} ${n(r.length).padStart(8)} rows   ~${String(kb).padStart(4)} KB   ${String(ms).padStart(6)}ms`
    + `   ${(kb * 1024 / 64e6 * 100).toFixed(2)}% of the 64 MB limit`);
  return { rows: r, ms, kb };
};
console.log('=== QUERY COST ===');
const oldR = await run('OLD (shipped)', OLD);
const newR = await run('NEW (V2)', NEW);

const O = new Map(oldR.rows.map((r) => [r.ticker, r.net]));
const N = new Map(newR.rows.map((r) => [r.ticker, r.net]));
const keys = [...new Set([...O.keys(), ...N.keys()])];
const diffs = [];
let same = 0;
for (const k of keys) {
  const a = O.get(k) ?? null, b = N.get(k) ?? null;
  if (a === b) same++; else diffs.push({ t: k, a, b, m: Math.abs((b ?? 0) - (a ?? 0)) });
}
console.log('\n=== CHANGE ===');
console.log(`  total tickers      ${n(keys.length)}`);
console.log(`  unchanged          ${n(same)}  (${(100 * same / keys.length).toFixed(1)}%)`);
console.log(`  changed            ${n(diffs.length)}  (${(100 * diffs.length / keys.length).toFixed(1)}%)`);
const dropped = diffs.filter((d) => d.b === null).length;
const added = diffs.filter((d) => d.a === null).length;
console.log(`  no longer scored   ${n(dropped)}   (all positions were debt or derivatives)`);
console.log(`  newly scored       ${n(added)}`);

console.log('\n  largest absolute changes:');
for (const d of [...diffs].sort((x, y) => y.m - x.m).slice(0, 12))
  console.log(`    ${d.t.padEnd(9)} ${String(d.a).padStart(6)} -> ${String(d.b).padStart(6)}   (|Δ| ${n(d.m)})`);

// The tickers named in the review gate, stocks and funds, whatever they did.
const WATCH = ['AAPL', 'MSFT', 'NVDA', 'MSTR', 'SPY', 'QQQ', 'VOO', 'VUG', 'SGOV', 'SPTL', 'BSV'];
console.log('\n=== NAMED TICKERS ===');
console.log('  ticker     old     new    delta   why');
for (const t of WATCH) {
  const a = O.get(t) ?? null, b = N.get(t) ?? null;
  // Rows ACTUALLY excluded — which is not the same as rows the classifier calls debt. A bond ETF's
  // own CUSIP is classified debt by most filers and is kept anyway, because it is what the ticker
  // names. Reporting the classifier's raw count here would say BSV lost 1,679 rows when it lost none.
  const [k] = await sql.query(`
    with p as (select distinct on (ticker) ticker, cusip from
        (select h.ticker,h.cusip,count(*)::int c from fund_holdings h
          where (h.quarter='${q0}' or h.quarter='${q1}') and h.ticker is not null and h.put_call=''
          group by 1,2) z order by ticker, c desc, cusip)
    select count(*)::int rows,
      count(*) filter (where h.cusip <> p.cusip
        and s.kind in ('debt','option','warrant','right','preferred'))::int excluded,
      count(*) filter (where s.kind in ('debt','option','warrant','right','preferred'))::int classified_nonequity,
      count(distinct h.cusip)::int cusips, count(distinct h.cik)::int filers
      from fund_holdings h
      left join p on p.ticker = h.ticker
      left join security_position_class s
        on s.cusip=h.cusip and s.cls=h.class and s.put_call=h.put_call
     where h.ticker=$1 and (h.quarter='${q0}' or h.quarter='${q1}') and h.put_call=''`, [t]);
  const why = k.excluded
    ? `${n(k.excluded)} of ${n(k.rows)} rows excluded (non-primary debt/deriv)`
    : k.classified_nonequity
    ? `0 excluded — its own CUSIP is protected (${n(k.classified_nonequity)} rows read as debt by filers)`
    : `${n(k.cusips)} cusips, ${n(k.filers)} filers, nothing excluded`;
  console.log(`  ${t.padEnd(8)} ${String(a).padStart(6)}  ${String(b).padStart(6)}  ${String((b ?? 0) - (a ?? 0)).padStart(6)}   ${why}`);
}

console.log('\n=== SANITY ===');
const bad = newR.rows.filter((r) => !Number.isInteger(r.net));
console.log(`  non-integer scores        ${bad.length}`);
const [f] = await sql.query(`select count(distinct cik)::int filers from fund_holdings
  where (quarter='${q0}' or quarter='${q1}') and ticker is not null and put_call=''`);
const maxAbs = Math.max(...newR.rows.map((r) => Math.abs(r.net)));
console.log(`  filers in scope           ${n(f.filers)}`);
console.log(`  largest |net|             ${n(maxAbs)}   ${maxAbs <= f.filers ? 'within the filer count, as it must be' : 'EXCEEDS the filer count — a filer is being scored twice'}`);
console.log(`  payload bounded           ${newR.kb} KB, server-aggregated, ${n(newR.rows.length)} rows`);
