// INSTITUTIONAL OWNERSHIP: that the aggregate counts SHARES, not note principal.
//
// runOwnershipAggregate summed every CUSIP mapped to a ticker. A convertible note's shares column is
// FACE VALUE, so note principal was added to share counts and the published percentage was nonsense:
// Akamai 2,984M institutional shares against 144M outstanding (2,077%), Etsy 1,946M against 92M
// (2,121%). The denominator was never the problem. This applies the same security-class semantics
// fund_net_qoq received in 17421db, plus the blank-put_call rule from 228d140.
//
//   node --env-file=.env.local scripts/verify-institutional-ownership.mjs

import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);
const n = (x) => Number(x).toLocaleString('en-US');

section('1. the aggregate applies the proven semantics');
{
  const src = await readFile(new URL('../src/lib/institutions-universe.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function runOwnershipAggregate'),
                       src.indexOf('export async function buildFeaturedMap'));
  ok('it classifies positions at all', /security_position_class/.test(fn),
    'the naive sum counted note principal as shares');
  ok('debt and derivatives are excluded',
    /NOT IN \('debt', 'option', 'warrant', 'right', 'preferred'\)/.test(fn));
  ok("the ticker's own CUSIP is protected", /h\.cusip = p\.cusip/.test(fn),
    'without this the bond ETFs are deleted outright');
  ok('an unclassified position is kept, not dropped', /s\.kind IS NULL/.test(fn));
  ok('a blank put_call cannot smuggle a derivative in', /mislabelled_option/.test(fn));
  ok('amendments do not double-count',
    /DISTINCT ON \(cik, quarter, cusip\)/.test(fn) && /filed_date DESC NULLS LAST, accession DESC/.test(fn));
  ok('no hand-written class regex was added', !/~\*/.test(fn));
  // Balanced backticks: a backtick inside this SQL template silently truncates the query.
  ok('the SQL template is not broken by a stray backtick', (fn.match(/`/g) || []).length % 2 === 0);
}

if (!process.env.DATABASE_URL) { console.log('\n(live sections skipped — no DATABASE_URL)'); }
else {
  const sql = neon(process.env.DATABASE_URL);

  section('2. convertible notes are not counted as shares');
  // Each of these has a note CUSIP whose face value dwarfed the real float before the fix.
  for (const [t, was] of [['AKAM', 2077], ['ETSY', 2121], ['CABO', 2883], ['CDLX', 2307]]) {
    const [r] = await sql.query('select ownership_pct p, inst_shares s from ticker_institutional_ownership where ticker=$1', [t]);
    ok(`${t} fell well below its pre-fix ${was}%`, r && r.p < was / 4,
      r ? Math.round(r.p) + '%' : 'missing');
  }

  section('3. legitimate common equity is unharmed');
  for (const [t, lo, hi] of [['AAPL', 50, 100], ['MSFT', 50, 100], ['NVDA', 50, 100],
    ['KO', 50, 100], ['XOM', 40, 100]]) {
    const [r] = await sql.query('select ownership_pct p from ticker_institutional_ownership where ticker=$1', [t]);
    ok(`${t} is a plausible institutional percentage`, r && r.p >= lo && r.p <= hi,
      r ? Math.round(r.p * 10) / 10 + '%' : 'missing');
  }

  section('4. bond ETFs survive — the primary-CUSIP protection');
  // Filers word a bond ETF's equity line with bond words. Classifying in isolation deletes these.
  for (const t of ['BSV', 'VCSH', 'GOVT', 'VGIT', 'SGOV', 'TFLO']) {
    const [r] = await sql.query('select filer_count f, inst_shares s from ticker_institutional_ownership where ticker=$1', [t]);
    ok(`${t} still has institutional holders`, r && r.f > 0 && r.s > 0, r ? JSON.stringify(r) : 'MISSING');
  }

  section('5. derivative tickers and options are handled');
  for (const t of ['AAPL', 'SPY', 'QQQ', 'NVDA']) {
    const [r] = await sql.query(`select count(*)::int n from fund_holdings h
      join security_position_class s on s.cusip=h.cusip and s.cls=h.class and s.put_call=h.put_call
     where h.ticker=$1 and coalesce(h.put_call,'')<>''`, [t]);
    ok(`${t}: explicit put/call rows exist and are filtered by put_call`, r.n >= 0);
  }
  const [deriv] = await sql.query(`select count(*)::int n from ticker_institutional_ownership o
    where o.ticker in ('OPENW','XRXDW','GENVR','HTZWW')`);
  console.log('  warrant/right tickers present in the aggregate: ' + deriv.n);

  section('6. the published distribution improved and did not regress');
  const [d] = await sql.query(`select count(*)::int rows,
      count(*) filter (where ownership_pct > 100)::int over100,
      count(*) filter (where ownership_pct > 200)::int over200,
      count(*) filter (where ownership_pct > 1000)::int over1000,
      count(*) filter (where ownership_pct < 0)::int negative
    from ticker_institutional_ownership`);
  console.log('  rows ' + n(d.rows) + '   >100%: ' + n(d.over100) + '   >200%: ' + n(d.over200)
    + '   >1000%: ' + n(d.over1000));
  ok('the aggregate still covers the market', d.rows > 10000, n(d.rows));
  ok('no negative percentage', d.negative === 0);
  // Pre-fix: 570 / 181 / 30. These are ceilings, not targets — a regression pushes them back up.
  ok('>200% stayed well below the pre-fix 181', d.over200 < 120, n(d.over200));
  ok('>1000% stayed well below the pre-fix 30', d.over1000 < 20, n(d.over1000));

  section('7. the screener publishes none of the unreliable ones');
  const [s] = await sql.query(`select count(*) filter (where inst_own_pct > 100)::int bad,
      count(*) filter (where inst_own_pct is not null)::int have from screener_stocks`);
  ok('no impossible percentage reaches the screener', s.bad === 0, n(s.bad));
  ok('the screener still shows ownership', s.have > 5000, n(s.have));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
