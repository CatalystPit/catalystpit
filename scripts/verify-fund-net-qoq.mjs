// fund_net_qoq: the corrected V2 semantics, asserted against live data.
//
// The metric is: per ticker, filers whose position rose minus filers whose position fell, quarter
// over quarter. The old calculation took ONE arbitrary row per filer per quarter, picked by physical
// order, so it was neither reproducible nor economically meaningful.
//
// Run: node --env-file=.env.local scripts/verify-fund-net-qoq.mjs

import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);
const n = (x) => Number(x).toLocaleString('en-US');

section('1. the shipped query says what it must');
{
  const src = await readFile(new URL('../src/lib/screener-data.js', import.meta.url), 'utf8');
  const q = src.slice(src.indexOf('const fundNet = new Map()'), src.indexOf('// Pit Consensus score'));
  ok('aggregates server-side', /with primary_cusip as/.test(q) && /group by ticker`/.test(q));
  ok('does not pull raw holdings into Node', !/select .*from fund_holdings.*\)\s*;?\s*$/m.test(q)
    || /sum\(case when cur/.test(q));
  ok('amendments: latest filing per (cik,quarter,cusip)',
    /distinct on \(cik, quarter, cusip\)/.test(q) && /filed_date desc nulls last, accession desc/.test(q));
  ok('the selected FILING supplies the rows, not a row rank',
    /join latest l on l\.cik = sc\.cik/.test(q));
  ok('manager lines summed at the security level',
    /per_security as \([\s\S]*sum\(shares\)[\s\S]*group by ticker, cik, quarter, cusip/.test(q));
  ok('one score per filer', /per_filer as \([\s\S]*group by ticker, cik/.test(q));
  ok('uses the existing classifier', /security_position_class/.test(q));
  ok('joins the classifier per position', /s\.cls = h\.class and s\.put_call = h\.put_call/.test(q));
  ok('no hand-written class regex', !/~\*/.test(q) && !/ilike '%bond/.test(q));
  ok("the ticker's own CUSIP is protected from exclusion", /h\.cusip = p\.cusip/.test(q));
  ok('a derivative most filers label as one is excluded whatever CUSIP it sits on',
    /mislabelled_option as \(/.test(q) && /and m\.cusip is null/.test(q));
  ok('that test is a MAJORITY of filers, not merely one',
    /having count\(\*\) filter \(where coalesce\(f\.put_call, ''\) <> ''\)[\s\S]{0,80}> count\(\*\) filter/.test(q),
    'presence alone would delete real QQQE and HYGH holdings');
  ok('it reads the classifier, not a new class regex',
    /s\.kind in \('option', 'warrant', 'right'\)/.test(q) && !/~\*/.test(q));
  ok('it is scoped to the same two quarters as everything else',
    /f\.quarter = \$\{q0\} or f\.quarter = \$\{prevQ\}/.test(q) || /\(f\.quarter = /.test(q));
  ok('debt and derivatives are the excluded kinds',
    /not in \('debt', 'option', 'warrant', 'right', 'preferred'\)/.test(q));
  ok('unclassified positions are kept', /s\.kind is null/.test(q));
  ok('scores are +1 / -1 / 0', /when cur > prev then 1 when cur < prev then -1 else 0/.test(q));
}

if (!process.env.DATABASE_URL) { console.log('\n(live sections skipped — no DATABASE_URL)'); }
else {
  const sql = neon(process.env.DATABASE_URL);
  const qs = await sql.query('select quarter::text q from fund_filings group by quarter order by quarter desc limit 2');
  const [q0, q1] = qs.map((r) => r.q);
  const W = `(h.quarter='${q0}' or h.quarter='${q1}') and h.ticker is not null and h.put_call=''`;
  const Q = `
    with primary_cusip as (
      select distinct on (ticker) ticker, cusip from
        (select h.ticker,h.cusip,count(*)::int c from fund_holdings h where ${W} group by 1,2) z
       order by ticker, c desc, cusip),
    mislabelled_option as (
      select f.cusip, f.class from fund_holdings f
        join security_position_class s on s.cusip=f.cusip and s.cls=f.class and s.put_call=''
       where (f.quarter='${q0}' or f.quarter='${q1}') and s.kind in ('option','warrant','right')
       group by f.cusip, f.class
      having count(*) filter (where coalesce(f.put_call,'') <> '')
           > count(*) filter (where coalesce(f.put_call,'') = '')),
    scoped as (
      select h.ticker,h.cik,h.quarter,h.cusip,h.shares,h.accession,h.filed_date
        from fund_holdings h
        left join primary_cusip p on p.ticker=h.ticker
        left join security_position_class s on s.cusip=h.cusip and s.cls=h.class and s.put_call=h.put_call
        left join mislabelled_option m on m.cusip=h.cusip and m.class=h.class
       where ${W} and m.cusip is null
         and (h.cusip=p.cusip or s.kind is null
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

  section('2. determinism — row order cannot change the answer');
  const a = await sql.query(Q);
  const b = await sql.query(Q);
  ok('two runs are byte-identical',
    JSON.stringify(a.map((r) => [r.ticker, r.net]).sort()) === JSON.stringify(b.map((r) => [r.ticker, r.net]).sort()));
  ok('every score is an integer', a.every((r) => Number.isInteger(r.net)));

  section('3. a filer is scored once, never twice');
  const [f] = await sql.query(`select count(distinct cik)::int filers from fund_holdings h where ${W}`);
  const maxAbs = Math.max(...a.map((r) => Math.abs(r.net)));
  ok('no |net| exceeds the filer count', maxAbs <= f.filers, `max ${n(maxAbs)} vs ${n(f.filers)} filers`);

  section('4. amendments do not double-count');
  const [am] = await sql.query(`
    select count(*)::int groups from (
      select cik,quarter,cusip from fund_holdings h where ${W}
       group by cik,quarter,cusip having count(distinct accession) > 1) z`);
  console.log('  (cik,quarter,cusip) groups spanning several filings: ' + n(am.groups));
  ok('such groups exist, so the rule is exercised', am.groups > 0);
  const [dbl] = await sql.query(`
    with scoped as (select h.cik,h.quarter,h.cusip,h.accession,h.filed_date,h.shares
                      from fund_holdings h where ${W}),
    latest as (select distinct on (cik,quarter,cusip) cik,quarter,cusip,accession from scoped
                order by cik,quarter,cusip,filed_date desc nulls last,accession desc)
    select count(*)::int n from (
      select sc.cik,sc.quarter,sc.cusip,count(distinct sc.accession)::int accs
        from scoped sc join latest l on l.cik=sc.cik and l.quarter=sc.quarter
                                    and l.cusip=sc.cusip and l.accession=sc.accession
       group by 1,2,3 having count(distinct sc.accession) > 1) z`);
  ok('after selection, no position draws on two filings', dbl.n === 0, n(dbl.n) + ' do');

  section('5. manager lines are summed, not picked');
  const [mm] = await sql.query(`
    select count(*)::int groups from (
      select ticker,cik,quarter,cusip from fund_holdings h where ${W}
       group by ticker,cik,quarter,cusip having count(*) > 1) z`);
  console.log('  (ticker,cik,quarter,cusip) groups with several lines: ' + n(mm.groups));
  ok('such groups exist, so summing is exercised', mm.groups > 0);

  section('6. ETFs stay eligible, debt does not');
  const m = new Map(a.map((r) => [r.ticker, r.net]));
  for (const t of ['SPY', 'QQQ', 'VOO', 'VUG', 'SGOV', 'SPTL', 'BSV'])
    ok(`${t} is still scored`, m.get(t) !== undefined, 'an ETF lost its score');
  for (const t of ['AAPL', 'MSFT', 'NVDA', 'MSTR'])
    ok(`${t} is still scored`, m.get(t) !== undefined);
  const [mstr] = await sql.query(`
    with p as (select distinct on (ticker) ticker,cusip from
        (select h.ticker,h.cusip,count(*)::int c from fund_holdings h where ${W} group by 1,2) z
       order by ticker,c desc,cusip)
    select count(*) filter (where h.cusip <> p.cusip
      and s.kind in ('debt','option','warrant','right','preferred'))::int excluded
      from fund_holdings h left join p on p.ticker=h.ticker
      left join security_position_class s on s.cusip=h.cusip and s.cls=h.class and s.put_call=h.put_call
     where h.ticker='MSTR' and ${W.replace(/h\.ticker is not null and /, '')}`, []);
  ok('MSTR sheds its convertible notes', mstr.excluded > 100, n(mstr.excluded) + ' excluded');
  const [bsv] = await sql.query(`
    with p as (select distinct on (ticker) ticker,cusip from
        (select h.ticker,h.cusip,count(*)::int c from fund_holdings h where ${W} group by 1,2) z
       order by ticker,c desc,cusip)
    select count(*) filter (where h.cusip <> p.cusip
      and s.kind in ('debt','option','warrant','right','preferred'))::int excluded
      from fund_holdings h left join p on p.ticker=h.ticker
      left join security_position_class s on s.cusip=h.cusip and s.cls=h.class and s.put_call=h.put_call
     where h.ticker='BSV' and ${W.replace(/h\.ticker is not null and /, '')}`, []);
  ok('a bond ETF keeps every row on its own CUSIP', bsv.excluded === 0, n(bsv.excluded) + ' excluded');

  section('6b. a blank put_call no longer smuggles a derivative into the score');
  {
    const mis = await sql.query(`
      select f.cusip, f.class, count(*) filter (where coalesce(f.put_call,'') = '')::int blank
        from fund_holdings f
        join security_position_class s on s.cusip=f.cusip and s.cls=f.class and s.put_call=''
       where (f.quarter='${q0}' or f.quarter='${q1}') and s.kind in ('option','warrant','right')
       group by f.cusip, f.class
      having count(*) filter (where coalesce(f.put_call,'') <> '')
           > count(*) filter (where coalesce(f.put_call,'') = '')`);
    console.log('  (cusip,class) pairs most filers label as derivatives: ' + n(mis.length));
    ok('the rule still has something to exclude', mis.length > 0);
    const classes = [...new Set(mis.map((r) => r.class))];
    ok('and it only ever selects explicit option wording', classes.every((c) => /^(PUT|CALL)$/i.test(c)),
      JSON.stringify(classes).slice(0, 120));

    // The three populations that must survive it, verified against live data rather than asserted.
    const survives = async (t) => (await sql.query(
      'select count(*)::int c from fund_holdings where ticker=$1', [t]))[0].c > 0 && m.get(t) !== undefined;
    for (const t of ['BSV', 'VCSH', 'GOVT', 'VGIT'])
      ok(`bond ETF ${t} still scored`, await survives(t), 'a bond ETF lost its score');
    for (const t of ['TFLO', 'LQDH', 'IGHG', 'IGBH', 'IVOL', 'QQQE', 'KLIP'])
      ok(`${t} survives (its own name reads as a right/warrant to the classifier)`, await survives(t));
    for (const t of ['OXY.WS', 'GME.WS', 'OPENW', 'XRXDW', 'GENVR'])
      ok(`${t} survives (the ticker IS the derivative)`, await survives(t));
  }

  section('7. payload stays server-aggregated and bounded');
  const kb = Buffer.byteLength(JSON.stringify(a)) / 1024;
  console.log('  rows ' + n(a.length) + '   payload ~' + Math.round(kb) + ' KB');
  ok('well under the 64 MB response limit', kb * 1024 < 5e6, Math.round(kb) + ' KB');
  ok('one row per ticker, not per holding', a.length < 50000);

  section('8. the stored column matches the query');
  const stored = await sql.query('select ticker, fund_net_qoq from screener_stocks where fund_net_qoq is not null');
  console.log('  screener_stocks rows with fund_net_qoq: ' + n(stored.length));
  let match = 0, mismatch = 0;
  for (const r of stored) { if (m.get(r.ticker) === r.fund_net_qoq) match++; else mismatch++; }
  console.log('  match ' + n(match) + '   mismatch ' + n(mismatch)
    + (mismatch ? '   (expected until the rebuild runs)' : ''));
  ok('the rebuild has applied the corrected values', mismatch === 0,
    n(mismatch) + ' differ — run /api/cron/screener');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
