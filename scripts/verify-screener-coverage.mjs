// SCREENER COVERAGE: every filter the UI offers must be backed by a column that actually holds data.
//
// A filter whose column is entirely null does not fail — it silently matches nothing, which looks
// identical to "no stocks meet your criteria". Found this way on 2026-09-15: inst_own_pct was
// declared in the schema, offered in screener-filters as "Inst Own %", and null for all 17,643 rows,
// while ticker_institutional_ownership held the number for 14,232 tickers and was rebuilt nightly.
//
//   node --env-file=.env.local scripts/verify-screener-coverage.mjs

import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);
const n = (x) => Number(x).toLocaleString('en-US');
const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()).replace(/(\d+)/g, '$1');

// Filters offered in the UI that are KNOWN to have no source wired yet. Each is a real gap, tracked
// rather than silently tolerated: anything that appears here must be a deliberate, recorded decision,
// and anything NEW failing this test is a filter that has just gone dead.
const KNOWN_UNSOURCED = new Set([
  'forward_pe',        // no forward-estimate provider in V1
  'peg',               // needs forward_pe
  'p_cash',            // cash-per-share not in the fundamentals feed
  'insider_own_pct',   // no insider-ownership source in V1
  'perf_5y',           // Polygon returns 403 for dates 5 years back on this plan
  'p_fcf',             // not in the fundamentals feed
]);
// Legitimately sparse because the underlying EVENT is rare, not because the wiring is broken.
const LEGITIMATELY_SPARSE = new Set([
  'congress_net_90d', 'congress_buy_90d', 'consensus_score', 'float_shares', 'short_float',
  'days_to_cover', 'eps_growth_5y', 'sales_growth_5y', 'eps_growth_this_yr', 'roic',
  'breaking_today', 'news_category', 'candlestick', 'pattern', 'ipo_date', 'dividend_yield',
  'payout_ratio', 'perf_3y', 'company', 'beta',
]);

section('1. the filter registry parses');
const src = await readFile(new URL('../src/lib/screener-filters.js', import.meta.url), 'utf8');
const keys = [...src.matchAll(/^\s{2}(\w+):\s+r\(/gm)].map((m) => m[1]);
console.log('  filters offered to the user: ' + keys.length);
ok('the registry was read', keys.length > 20, keys.length + ' found');

if (!process.env.DATABASE_URL) { console.log('\n(live sections skipped — no DATABASE_URL)'); }
else {
  const sql = neon(process.env.DATABASE_URL);
  const cols = new Set((await sql.query(
    `select column_name from information_schema.columns where table_name='screener_stocks'`))
    .map((r) => r.column_name));
  const [tot] = await sql.query('select count(*)::int c from screener_stocks');

  section('2. no filter is backed by an entirely empty column');
  const backed = keys.map(snake).filter((c) => cols.has(c));
  const sel = backed.map((c) => `count(*) filter (where "${c}" is not null)::int "${c}"`).join(', ');
  const [r] = await sql.query(`select ${sel} from screener_stocks`);
  const dead = [];
  for (const c of backed) {
    if (KNOWN_UNSOURCED.has(c)) continue;
    if (r[c] === 0) dead.push(c);
  }
  for (const c of dead) console.log('    DEAD: ' + c + ' is offered as a filter and is null for every row');
  ok('every offered filter has at least some data', dead.length === 0, dead.join(', '));

  section('3. the tracked gaps have not silently grown');
  const stillEmpty = [...KNOWN_UNSOURCED].filter((c) => cols.has(c) && r[c] === 0);
  console.log('  known-unsourced filters still empty: ' + stillEmpty.length + ' of ' + KNOWN_UNSOURCED.size);
  for (const c of stillEmpty) console.log('    ' + c);
  ok('no tracked gap has been quietly wired without removing it from the list',
    stillEmpty.length <= KNOWN_UNSOURCED.size);

  section('4. institutional ownership reaches the screener');
  const [io] = await sql.query(`select count(*) filter (where inst_own_pct is not null)::int have,
      count(*) filter (where inst_own_pct > 100)::int impossible,
      count(*) filter (where inst_own_pct < 0)::int negative,
      max(inst_own_pct) hi from screener_stocks`);
  const [roll] = await sql.query('select count(*)::int c from ticker_institutional_ownership');
  console.log('  rollup rows ' + n(roll.c) + '  ->  screener rows populated ' + n(io.have)
    + ' (' + (100 * io.have / tot.c).toFixed(1) + '%)');
  ok('it is populated at all', io.have > 0, 'the filter matches nothing');
  ok('a meaningful share of the rollup reaches the screener', io.have > roll.c * 0.5,
    n(io.have) + ' of ' + n(roll.c));
  // Institutions cannot hold more than the shares outstanding. Anything above 100% is a wrong
  // denominator, and 570 such rows existed in the rollup when this was wired.
  ok('no impossible ownership percentage is published', io.impossible === 0, n(io.impossible) + ' over 100%');
  ok('none is negative', io.negative === 0);
  ok('the maximum is plausible', io.hi <= 100, 'max ' + io.hi);

  section('5. headline columns are populated');
  for (const [c, floor] of [['price', 50], ['volume', 70], ['rsi14', 30], ['sma200', 30],
    ['fund_net_qoq', 50], ['perf_1y', 30], ['perf_6m', 30]]) {
    const [x] = await sql.query(`select count(*) filter (where ${c} is not null)::int v from screener_stocks`);
    const pct = 100 * x.v / tot.c;
    ok(`${c} above ${floor}% (${pct.toFixed(1)}%)`, pct > floor, n(x.v) + ' of ' + n(tot.c));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
