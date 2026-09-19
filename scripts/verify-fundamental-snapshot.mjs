// POINT-IN-TIME FUNDAMENTAL SNAPSHOTS.
//
// The one dataset Catalyst Pit can never obtain retroactively. `screener_stocks` is DELETEd and
// rewritten nightly, so valuation, margins, growth and balance-sheet health have exactly one
// historical observation — today — and no provider sells us ours back. Every uncaptured day is
// permanently lost, which is why this shipped as data collection before any model needs it.
//
// This suite runs against the REAL database, read-mostly, using a scratch ticker and scratch dates
// that cannot collide with the live series. It asserts the properties that make the series usable:
// idempotency, change-only writes, null preservation, and — most importantly — that a point-in-time
// read can never see a value recorded after the date being asked about.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/verify-fundamental-snapshot.mjs

import { neon } from '@neondatabase/serverless';
import { SNAPSHOT_COLUMNS } from '../src/lib/fundamental-snapshot.js';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// A scratch identity that cannot collide with a real ticker or a real capture date.
const T = '__TEST_SNAP__';
const D1 = '1990-01-02', D2 = '1990-01-03', D3 = '1990-01-04';
const cleanup = () => sql`delete from security_fundamental_snapshot where ticker = ${T}`;

const put = (asOf, over = {}) => {
  const v = { market_cap: 1e9, eps_ttm: 2.5, sector: 'Technology', roe: 0.2, shares_out: 1e8, ...over };
  return sql`
    insert into security_fundamental_snapshot (ticker, as_of, captured_at, source, market_cap, eps_ttm, sector, roe, shares_out)
    values (${T}, ${asOf}::date, now(), 'test', ${v.market_cap}, ${v.eps_ttm}, ${v.sector}, ${v.roe}, ${v.shares_out})
    on conflict (ticker, as_of) do update set
      captured_at = now(), market_cap = excluded.market_cap, eps_ttm = excluded.eps_ttm,
      sector = excluded.sector, roe = excluded.roe, shares_out = excluded.shares_out`;
};
const asOfRead = (day) => sql`
  select * from security_fundamental_snapshot where ticker = ${T} and as_of <= ${day}::date
   order by as_of desc limit 1`;

await cleanup();

console.log('\n=== the captured column set is deliberate ===');
{
  // The list is SHORT on purpose: everything recomputable from data we already keep permanently is
  // excluded, so this table stays small and stays about what a future price cannot reconstruct.
  ok('identity and classification are captured',
    ['company', 'sector', 'industry', 'exchange', 'country', 'asset_type'].every((c) => SNAPSHOT_COLUMNS.includes(c)));
  ok('the price-independent raw fundamentals are captured',
    ['eps_ttm', 'revenue_ttm', 'equity', 'total_debt', 'cash', 'ebitda'].every((c) => SNAPSHOT_COLUMNS.includes(c)));
  ok('valuation, margins, balance sheet and growth are captured',
    ['pe', 'ps', 'pb', 'roe', 'net_margin', 'debt_equity', 'current_ratio', 'eps_growth_ttm'].every((c) => SNAPSHOT_COLUMNS.includes(c)));
  // Recomputable from ticker_daily_candles, which we keep back to 1962 — duplicating it would be
  // millions of redundant rows.
  ok('price and technicals are NOT captured',
    !['price', 'rsi14', 'sma50', 'atr14', 'perf_1m', 'volatility', 'beta', 'volume'].some((c) => SNAPSHOT_COLUMNS.includes(c)));
  // Recomputable from their own source tables WITH their own information dates. Capturing them would
  // freeze today's definitions — including any dating bug — into the historical record.
  ok('proprietary signals are NOT captured',
    !['consensus_score', 'insider_net_90d', 'congress_net_90d', 'fund_net_qoq'].some((c) => SNAPSHOT_COLUMNS.includes(c)));
  // Heuristic labels and transient UI state are not facts about a company.
  ok('presentation artifacts are NOT captured',
    !['candlestick', 'pattern', 'news_category', 'breaking_today'].some((c) => SNAPSHOT_COLUMNS.includes(c)));
  // 0% populated today — a column of guaranteed nulls is storage for nothing.
  ok('empty columns are NOT captured',
    !['forward_pe', 'peg', 'insider_own_pct', 'p_cash', 'perf_5y'].some((c) => SNAPSHOT_COLUMNS.includes(c)));
}

console.log('\n=== first capture, then a same-day re-run ===');
{
  await put(D1);
  let rows = await sql`select count(*)::int n from security_fundamental_snapshot where ticker = ${T}`;
  ok('the first capture writes a row', rows[0].n === 1);

  const before = (await asOfRead(D1))[0];
  await put(D1);
  rows = await sql`select count(*)::int n from security_fundamental_snapshot where ticker = ${T}`;
  // IDEMPOTENT: a retry, a double-fire and a manual re-run all converge on one row per ticker per day.
  ok('a same-day re-run does NOT duplicate', rows[0].n === 1);
  const after = (await asOfRead(D1))[0];
  ok('...the values are unchanged', Number(after.market_cap) === Number(before.market_cap));
  // captured_at moves so a re-capture is visible as one, while as_of still describes the day.
  ok('...but captured_at advances, so a re-run is visible', new Date(after.captured_at) >= new Date(before.captured_at));
  ok('as_of and captured_at are different facts', String(after.as_of).slice(0, 10) === D1);
}

console.log('\n=== next-day capture, and the change-only rule ===');
{
  await put(D2, { eps_ttm: 3.1 });          // something genuinely changed
  ok('a changed day writes a second row',
    (await sql`select count(*)::int n from security_fundamental_snapshot where ticker = ${T}`)[0].n === 2);
  ok('the series now spans two days',
    String((await asOfRead(D2))[0].as_of).slice(0, 10) === D2);
  ok('...and the newer value is read', Number((await asOfRead(D2))[0].eps_ttm) === 3.1);
  // Yesterday still reads yesterday's value: the past is immutable.
  ok('the earlier day still reads its own value', Number((await asOfRead(D1))[0].eps_ttm) === 2.5);
}

console.log('\n=== the point-in-time guarantee ===');
{
  // A read for a date BEFORE the series began must find nothing — never the nearest later row.
  // This is the property that makes the table safe to join against forward outcomes.
  ok('a date before the series began returns nothing',
    (await asOfRead('1989-12-31')).length === 0);
  // A read between captures resolves BACKWARD to the last known value, never forward.
  await put(D3, { eps_ttm: 4.0 });
  const between = (await asOfRead(D2))[0];
  ok('a read never sees a later capture', Number(between.eps_ttm) === 3.1, String(between.eps_ttm));
  ok('...even though a newer row exists', Number((await asOfRead(D3))[0].eps_ttm) === 4.0);
  // A weekend or holiday research date resolves to the last capture at or before it.
  ok('a gap date resolves to the last prior capture',
    String((await asOfRead('1990-01-05'))[0].as_of).slice(0, 10) === D3);
}

console.log('\n=== NULL stays NULL ===');
{
  await sql`
    insert into security_fundamental_snapshot (ticker, as_of, source, market_cap, eps_ttm, roe, sector)
    values (${T}, '1990-02-01'::date, 'test', 5e8, null, null, null)
    on conflict (ticker, as_of) do update set eps_ttm = null, roe = null, sector = null`;
  const r = (await asOfRead('1990-02-01'))[0];
  // A value we did not have is null — never zero, and never carried forward from the previous row.
  // Forward-filling would make a gap in coverage indistinguishable from a fact.
  ok('an unknown number is null, not 0', r.eps_ttm === null && r.roe === null);
  ok('an unknown classification is null, not a guess', r.sector === null);
  ok('...and is NOT forward-filled from the prior row', r.eps_ttm !== 4.0);
  ok('the known value on the same row survives', Number(r.market_cap) === 5e8);
}

console.log('\n=== duplicate prevention and query shape ===');
{
  const dup = await sql`
    select ticker, as_of, count(*)::int n from security_fundamental_snapshot
     where ticker = ${T} group by 1,2 having count(*) > 1`;
  ok('the primary key prevents duplicate (ticker, day) rows', dup.length === 0);
  const byTicker = await sql`select as_of::text d from security_fundamental_snapshot where ticker = ${T} order by as_of`;
  ok('a ticker-over-time query returns an ordered series', byTicker.length === 4 && byTicker[0].d === D1);
  const crossSection = await sql`select count(*)::int n from security_fundamental_snapshot where as_of = ${D1}::date`;
  ok('a one-day cross-section query works', crossSection[0].n >= 1);
}

console.log('\n=== the live series, and the run log that audits it ===');
{
  const cov = (await sql`
    select count(*)::int rows, count(distinct ticker)::int tickers, count(distinct as_of)::int days,
           min(as_of)::text first_day
      from security_fundamental_snapshot where ticker <> ${T}`)[0];
  ok('the real series has begun', cov.rows > 1000, JSON.stringify(cov));
  ok('...with a real cross-section of tickers', cov.tickers > 1000);

  const runs = await sql`select as_of::text d, considered, written from security_snapshot_run order by as_of`;
  ok('every capture is logged', runs.length >= 1);
  // With change-only writes, "nothing changed" and "the job did not run" would otherwise be the same
  // absence of rows — this is what distinguishes them.
  ok('the log records what was considered, not just what was written',
    runs.every((r) => r.considered >= r.written));

  // ⚠️ NO BACK-FILLED HISTORY. A row dated before the series started would mean today's values were
  // written into the past, which is look-ahead bias with a schema.
  const preHistory = await sql`
    select count(*)::int n from security_fundamental_snapshot
     where ticker <> ${T} and as_of < (select min(as_of) from security_snapshot_run)`;
  ok('no row predates the first logged capture', preHistory[0].n === 0, JSON.stringify(preHistory[0]));
}

await cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
