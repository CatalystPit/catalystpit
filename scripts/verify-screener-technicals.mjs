// SCREENER TECHNICALS: that the job collects enough history for the indicators it computes, and
// that a rebuild does not throw them away.
//
// Two defects are pinned here, both measured in production on 2026-09-15:
//
//   1. backfillTechnicals walked back `days + 30` CALENDAR days to collect `days` TRADING days. The
//      real ratio is about 30% — weekends alone are 28.6% — so asking for 150 returned 123. Every
//      indicator with a longer lookback was null for the entire market while the job reported
//      success: sma200 needs 200 closes and had 0.6% coverage, perf_6m needs 127 and had 0.6%,
//      missing by four.
//
//   2. rebuildScreener clears screener_stocks and does not compute twenty-two of the technical
//      columns at all, so every rebuild nulled them market-wide until the next technicals run —
//      9.1% rsi14 and 0.0% for perf_ytd, perf_3y, volatility, beta, high20d, high50d,
//      all_time_high, candlestick and pattern.
//
//   node --env-file=.env.local scripts/verify-screener-technicals.mjs
//   (source and arithmetic sections run without DATABASE_URL; live sections are skipped without it)

import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);
const n = (x) => Number(x).toLocaleString('en-US');

const lib = await readFile(new URL('../src/lib/screener-data.js', import.meta.url), 'utf8');
const route = await readFile(new URL('../src/app/api/cron/screener-technicals/route.js', import.meta.url), 'utf8');

// The lookback each indicator needs, read off the helpers rather than restated:
//   smaN  -> closes.length >= n          perf -> closes.length > back
const NEEDS = { sma20: 20, sma50: 50, sma200: 200, rsi14: 15, atr14: 15,
  perf_1w: 6, perf_1m: 22, perf_3m: 64, perf_6m: 127, perf_1y: 253 };

section('1. the calendar budget actually yields the trading days asked for');
{
  const m = lib.match(/const calendarBudget = Math\.ceil\(days \* ([\d.]+)\) \+ (\d+)/);
  ok('the budget is a ratio, not a flat constant', !!m, 'days + 30 was the defect');
  ok('the old flat allowance is gone', !/i <= days \+ 30/.test(lib));
  // NOT guarded by `if (m)`. A missing match means the budget is not a ratio at all, which is the
  // defect itself — skipping the arithmetic there would make this whole section vacuous, and it did:
  // mutating the budget back to days + 30 produced one failure instead of six.
  const mult = m ? Number(m[1]) : 1, add = m ? Number(m[2]) : 30;
  // 252 trading days per 365 calendar is the standard ratio; the budget must clear it.
  ok('the multiplier exceeds the calendar-to-trading ratio', mult >= 365 / 252,
    `${mult} < ${(365 / 252).toFixed(3)}`);
  for (const days of [30, 150, 200, 260, 300]) {
    const budget = Math.ceil(days * mult) + add;
    const tradingDaysAvailable = Math.floor(budget * 252 / 365);
    ok(`days=${days} is reachable (${budget} calendar -> ~${tradingDaysAvailable} trading)`,
      tradingDaysAvailable >= days, `only ~${tradingDaysAvailable}`);
  }
}

section('2. the configured default covers every indicator the job computes');
{
  const d = route.match(/parseInt\(new URL\(request\.url\)\.searchParams\.get\('days'\) \|\| '(\d+)'/);
  const cap = route.match(/Math\.min\((\d+), Math\.max\(/);
  ok('a default is configured', !!d);
  ok('a cap is configured', !!cap);
  const def = d ? Number(d[1]) : 0, max = cap ? Number(cap[1]) : 0;
  console.log('  default ' + def + ' trading days, cap ' + max);
  const longest = Math.max(...Object.values(NEEDS));
  ok(`the default covers the longest lookback (${longest} closes, perf_1y)`, def >= longest,
    `default ${def} cannot ever produce perf_1y or sma200`);
  ok('the cap is at least the default', max >= def);
  for (const [f, need] of Object.entries(NEEDS))
    ok(`${f} needs ${need} closes and the default supplies ${def}`, def >= need);
}

section('3. a rebuild does not throw the technicals away');
{
  const fn = lib.slice(lib.indexOf('export async function rebuildScreener'));
  ok('the previous technicals are read before the table is cleared',
    fn.indexOf('const prevTech') > 0 && fn.indexOf('const prevTech') < fn.indexOf('await db.delete(screenerStocks)'),
    'reading after the delete would return nothing');
  ok('the row binds them', /pv = prevTech\.get\(t\)/.test(fn));
  // Every column backfillTechnicals owns must survive a rebuild.
  for (const f of ['rsi14', 'sma20', 'sma50', 'sma200', 'hi52', 'lo52', 'atr14',
    'perf1w', 'perf1m', 'perf3m', 'perf6m', 'perf1y'])
    ok(`${f} falls back to the stored value`, new RegExp(`${f}: tk\\?\\.${f} \\?\\? pv\\?\\.${f}`).test(fn),
      'a rebuild would null it for every ticker it cannot recompute');
  for (const f of ['perfYtd', 'perf3y', 'perf5y', 'volatility', 'beta', 'high20d', 'high50d',
    'allTimeHigh', 'candlestick', 'pattern'])
    ok(`${f} is carried forward outright`, new RegExp(`${f}: pv\\?\\.${f} \\?\\? null`).test(fn),
      'the rebuild never computes this one, so it must not write over it');
  ok('a ticker leaving the universe still disappears', /await db\.delete\(screenerStocks\)/.test(fn));
}

if (!process.env.DATABASE_URL) { console.log('\n(live sections skipped — no DATABASE_URL)'); }
else {
  const sql = neon(process.env.DATABASE_URL);
  section('4. live coverage of the fields that were empty');
  const F = ['rsi14', 'sma20', 'sma50', 'sma200', 'hi52', 'lo52', 'atr14', 'perf_1w', 'perf_1m',
    'perf_3m', 'perf_6m', 'perf_1y', 'perf_ytd', 'volatility', 'beta', 'high20d', 'high50d',
    'all_time_high'];
  const sel = F.map((f) => `count(*) filter (where ${f} is not null)::int "${f}"`).join(', ');
  const [r] = await sql.query(`select count(*)::int total, ${sel} from screener_stocks`);
  const [c] = await sql.query('select count(distinct ticker)::int n from ticker_daily_candles');
  console.log('  screener rows ' + n(r.total) + ', tickers with candles ' + n(c.n));
  // A floor, not a target. These sat at 0.4-0.6% before the fix; anything near zero means the job
  // silently stopped collecting enough history again.
  for (const f of F) {
    const pct = 100 * r[f] / r.total;
    ok(`${f} is populated (${n(r[f])}, ${pct.toFixed(1)}%)`, pct > 30,
      'was 0.6% when the day window was too short');
  }
  section('5. no field is left entirely empty');
  for (const f of F) ok(`${f} is not wholly null`, r[f] > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
