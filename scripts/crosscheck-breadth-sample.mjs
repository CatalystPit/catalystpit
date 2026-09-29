// INDEPENDENT CROSS-CHECK — recompute a deterministic sample from raw candles in JavaScript, with no
// production breadth code in the path, and compare ticker by ticker.
//
//   node --env-file=.env.local scripts/crosscheck-breadth-sample.mjs [--n 150]
//
// ⚠️ NOTHING HERE IMPORTS THE AGGREGATE. Candles are pulled per ticker and every figure — direction,
// SMA50, SMA200, 52-week status — is computed from the array. The production SQL is then asked the same
// questions and the two must agree. A disagreement is a defect in one of them; agreement means the
// remaining gap to any external reference is methodology or session, not arithmetic.
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const N = Number((/--n\s+(\d+)/.exec(process.argv.join(' ')) || [])[1] || 150);
const W = 364, S50 = 50, S200 = 200;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

// The market's latest completed session, and the session before it — market-wide, not per ticker.
const [{ s1, s2 }] = await sql`
  WITH s AS (SELECT DISTINCT date FROM ticker_daily_candles ORDER BY date DESC LIMIT 2)
  SELECT max(date)::text AS s1, min(date)::text AS s2 FROM s`;
console.log(`market sessions: latest ${s1}, previous ${s2}`);

// Deterministic: ordered by ticker, every Nth row, across all three venues.
const universe = await sql`
  SELECT ticker, exchange FROM screener_stocks
   WHERE asset_type = 'Stock' AND exchange = ANY(ARRAY['NYSE','NASDAQ','AMEX'])
   ORDER BY ticker`;
const step = Math.max(1, Math.floor(universe.length / N));
const sample = universe.filter((_, i) => i % step === 0).slice(0, N);
console.log(`sample: ${sample.length} of ${universe.length} (every ${step}th by ticker)\n`);

const byVenue = {};
let dirAgree = 0, s50Agree = 0, s200Agree = 0, hlAgree = 0, checked = 0;
const mismatches = [];

for (const { ticker, exchange } of sample) {
  const rows = await sql`
    SELECT date::text AS date, close, high, low, source FROM ticker_daily_candles
     WHERE ticker = ${ticker} AND close > 0 ORDER BY date DESC`;
  byVenue[exchange] = (byVenue[exchange] || 0) + 1;
  if (!rows.length) continue;
  checked++;

  const latest = rows[0].date;
  const cutoffMs = Date.parse(`${latest}T00:00:00Z`) - W * 86400000;
  const win = rows.filter((r) => Date.parse(`${r.date}T00:00:00Z`) > cutoffMs);
  const closes = win.map((r) => Number(r.close));

  // ── my independent answers ────────────────────────────────────────────────
  const onMarketSession = latest === s1;
  const prevRow = rows[1] || null;
  const prevIsPriorSession = prevRow ? prevRow.date === s2 : false;
  const last = Number(rows[0].close);
  const prev = prevRow ? Number(prevRow.close) : null;
  const dir = prev == null ? null : (last > prev ? 'ADV' : last < prev ? 'DECL' : 'UNCH');
  const sma50 = closes.length >= S50 ? closes.slice(0, S50).reduce((a, b) => a + b, 0) / S50 : null;
  const sma200 = closes.length >= S200 ? closes.slice(0, S200).reduce((a, b) => a + b, 0) / S200 : null;
  const above50 = sma50 == null ? null : (last > sma50 ? 'ABOVE' : last < sma50 ? 'BELOW' : 'AT');
  const above200 = sma200 == null ? null : (last > sma200 ? 'ABOVE' : last < sma200 ? 'BELOW' : 'AT');
  const firstDate = rows[rows.length - 1].date;
  const has52w = Date.parse(`${firstDate}T00:00:00Z`) <= cutoffMs;
  const hi = Math.max(...closes), lo = Math.min(...closes);
  const hlState = !has52w ? null : (last === hi ? 'HIGH' : last === lo ? 'LOW' : 'NEITHER');

  // ── the production SQL's answers, asked the same way the aggregate asks ────
  const [got] = await sql`
    WITH ranked AS (
      SELECT close, date, row_number() OVER (ORDER BY date DESC) rn,
             max(date) OVER () latest_date, min(date) OVER () first_date
        FROM ticker_daily_candles WHERE ticker = ${ticker} AND close > 0),
    win AS (SELECT * FROM ranked WHERE date > latest_date - ${W}::int)
    SELECT max(close) FILTER (WHERE rn = 1) AS last_close,
           max(close) FILTER (WHERE rn = 2) AS prev_close,
           max(close) AS hi, min(close) AS lo,
           avg(close) FILTER (WHERE rn <= ${S50}) AS s50,
           count(*) FILTER (WHERE rn <= ${S50})::int AS n50,
           avg(close) FILTER (WHERE rn <= ${S200}) AS s200,
           count(*) FILTER (WHERE rn <= ${S200})::int AS n200,
           (min(first_date) <= max(latest_date) - ${W}::int) AS ok_hl
      FROM win`;

  const gDir = got.prev_close == null ? null
    : (Number(got.last_close) > Number(got.prev_close) ? 'ADV'
      : Number(got.last_close) < Number(got.prev_close) ? 'DECL' : 'UNCH');
  const gS50 = got.n50 >= S50 ? Number(got.s50) : null;
  const gS200 = got.n200 >= S200 ? Number(got.s200) : null;
  const gAbove50 = gS50 == null ? null : (Number(got.last_close) > gS50 ? 'ABOVE' : Number(got.last_close) < gS50 ? 'BELOW' : 'AT');
  const gAbove200 = gS200 == null ? null : (Number(got.last_close) > gS200 ? 'ABOVE' : Number(got.last_close) < gS200 ? 'BELOW' : 'AT');
  const gHl = !got.ok_hl ? null
    : (Number(got.last_close) === Number(got.hi) ? 'HIGH' : Number(got.last_close) === Number(got.lo) ? 'LOW' : 'NEITHER');

  if (dir === gDir) dirAgree++; else mismatches.push(`${ticker} dir ${dir} vs ${gDir}`);
  if (above50 === gAbove50 && (sma50 === null ? gS50 === null : near(sma50, gS50))) s50Agree++;
  else mismatches.push(`${ticker} sma50 ${sma50}/${above50} vs ${gS50}/${gAbove50}`);
  if (above200 === gAbove200 && (sma200 === null ? gS200 === null : near(sma200, gS200))) s200Agree++;
  else mismatches.push(`${ticker} sma200 ${sma200}/${above200} vs ${gS200}/${gAbove200}`);
  if (hlState === gHl) hlAgree++; else mismatches.push(`${ticker} 52w ${hlState} vs ${gHl}`);

  // ⚠️ AND THE SESSION FACTS, which are the thing the aggregate never checked.
  if (!onMarketSession) mismatches.push(`STALE ${ticker} latest ${latest} (market ${s1}) dir=${dir}`);
  else if (!prevIsPriorSession) mismatches.push(`GAP ${ticker} prev ${prevRow?.date} (expected ${s2}) dir=${dir}`);
}

console.log('sample by venue:', byVenue);
console.log(`\nchecked ${checked}`);
ok('direction agrees on every sampled ticker', dirAgree === checked, `${dirAgree}/${checked}`);
ok('SMA50 and its classification agree', s50Agree === checked, `${s50Agree}/${checked}`);
ok('SMA200 and its classification agree', s200Agree === checked, `${s200Agree}/${checked}`);
ok('52-week status agrees', hlAgree === checked, `${hlAgree}/${checked}`);
const stale = mismatches.filter((m) => m.startsWith('STALE'));
const gaps = mismatches.filter((m) => m.startsWith('GAP'));
const real = mismatches.filter((m) => !m.startsWith('STALE') && !m.startsWith('GAP'));
console.log(`\narithmetic disagreements: ${real.length}`);
for (const m of real.slice(0, 10)) console.log(`  ${m}`);
console.log(`\n⚠️ session problems the aggregate does not currently detect:`);
console.log(`  stale (latest candle is not the market session): ${stale.length}`);
for (const m of stale.slice(0, 8)) console.log(`    ${m}`);
console.log(`  gap (previous candle is not the prior market session): ${gaps.length}`);
for (const m of gaps.slice(0, 8)) console.log(`    ${m}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
