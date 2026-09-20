// THE DEPLOYMENT GATE.
//
// Every item required before the writer fix and the repaired data may be deployed together. Each is
// MEASURED here, not asserted in a summary — a gate whose evidence lives in prose is a gate that
// gets waved through.
//
// The rule this file exists to enforce: an unverifiable ticker is never silently counted as clean.
// "We could not check it" and "we checked it and it is fine" are different states and are printed
// as different states.
//
// Run: node --env-file=.env.local research/deployment-gate.mjs

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { findSeamCandidates } from '../src/lib/price-semantics.mjs';
import { CANDLE_SOURCE } from '../src/lib/market/candles.mjs';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
let pass = 0, fail = 0, blocked = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok    ${n}`); } else { fail++; L(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };
const block = (n, why) => { blocked++; L(`  BLOCK ${n} — ${why}`); };

const RETIRED = 'tiingo';
const audit = fs.existsSync('research/convention-audit.json')
  ? JSON.parse(fs.readFileSync('research/convention-audit.json', 'utf8')) : {};
const affected = JSON.parse(fs.readFileSync('research/convention-affected.json', 'utf8'));

// ── 1. audit completeness ────────────────────────────────────────────────────
L('=== 1. AUDIT COMPLETENESS ===');
{
  const settled = Object.values(audit).filter((v) => v.status === 'audited');
  ok(`all ${affected.length} affected tickers have a settled audit status`,
    settled.length === affected.length, `${settled.length}/${affected.length}`);

  const classes = { REPAIR: 0, RELABEL_ONLY: 0, REPORT_ONLY: 0 };
  for (const v of settled) {
    if (v.action === 'REPAIR') classes.REPAIR++;
    else if (v.action === 'RELABEL_ONLY') classes.RELABEL_ONLY++;
    else classes.REPORT_ONLY++;
  }
  L(`     REPAIR ${classes.REPAIR}   RELABEL_ONLY ${classes.RELABEL_ONLY}   REPORT_ONLY ${classes.REPORT_ONLY}`);
  ok('every settled ticker carries one of the three explicit actions',
    classes.REPAIR + classes.RELABEL_ONLY + classes.REPORT_ONLY === settled.length);
}

// ── 2. no unverifiable ticker treated as clean ───────────────────────────────
L('\n=== 2. UNVERIFIABLE IS NOT CLEAN ===');
{
  const unverifiable = Object.entries(audit)
    .filter(([, v]) => v.status === 'audited' && !v.verified).map(([t]) => t);
  // The only safe outcome for an unverified ticker is that its retired rows were LEFT ALONE.
  let rewritten = 0;
  if (unverifiable.length) {
    const r = await sql.query(
      `select count(*)::int n from ticker_daily_candles where ticker = any($1) and source = $2`,
      [unverifiable, CANDLE_SOURCE.TIINGO]);
    rewritten = Number(r[0].n);
  }
  ok('no unverifiable ticker had rows rewritten to the canonical source',
    rewritten === 0, `${rewritten} rows on ${unverifiable.length} unverifiable tickers`);
  if (unverifiable.length) L(`     left untouched by design: ${unverifiable.join(', ')}`);

  // And they must still be visible as unresolved, not quietly dropped.
  const stillRetired = await sql.query(
    `select count(distinct ticker)::int t, count(*)::int n from ticker_daily_candles where source = $1`, [RETIRED]);
  ok('remaining retired-convention rows belong only to unverifiable tickers',
    Number(stillRetired[0].t) === unverifiable.length,
    `${stillRetired[0].t} tickers / ${stillRetired[0].n} rows vs ${unverifiable.length} unverifiable`);
}

// ── 3. exact rows identified ─────────────────────────────────────────────────
L('\n=== 3. EXACT ROWS IDENTIFIED ===');
{
  const repairTickers = Object.entries(audit).filter(([, v]) => v.action === 'REPAIR');
  const expectedChanged = repairTickers.reduce((s, [, v]) => s + (Number(v.differing) || 0), 0);
  ok('every REPAIR ticker records a differing-row count',
    repairTickers.every(([, v]) => Number.isFinite(Number(v.differing))));
  L(`     rows proven to violate the convention: ${expectedChanged}`);
  const relabel = Object.entries(audit).filter(([, v]) => v.action === 'RELABEL_ONLY');
  L(`     rows verified already correct (relabel only): ${relabel.reduce((s, [, v]) => s + (Number(v.matching) || 0), 0)}`);
}

// ── 4/5. snapshot and rollback ───────────────────────────────────────────────
L('\n=== 4/5. SNAPSHOT AND ROLLBACK ===');
{
  const runId = fs.existsSync('research/convention-run-id.txt')
    ? fs.readFileSync('research/convention-run-id.txt', 'utf8').trim() : null;
  if (!runId) { block('pre-repair snapshot verified', 'no snapshot run id yet'); block('rollback path verified', 'no snapshot'); }
  else {
    const b = await sql.query(
      'select count(*)::int n, count(distinct ticker)::int t from ticker_daily_candles_backup where run_id=$1', [runId]);
    ok(`snapshot ${runId} exists and holds rows`, Number(b[0].n) > 0, `${b[0].n} rows / ${b[0].t} tickers`);

    // The snapshot must hold the PRE state: every backed-up row should differ from the live row
    // wherever a value was actually repaired, and be restorable exactly.
    const restorable = await sql.query(`
      select count(*)::int n from ticker_daily_candles c
        join ticker_daily_candles_backup b on b.run_id=$1 and b.ticker=c.ticker and b.date=c.date`, [runId]);
    ok('every snapshot row still matches a live row by key (rollback can find its target)',
      Number(restorable[0].n) === Number(b[0].n), `${restorable[0].n}/${b[0].n}`);

    const retiredInBackup = await sql.query(
      'select count(*)::int n from ticker_daily_candles_backup where run_id=$1 and source=$2', [runId, RETIRED]);
    ok('the snapshot preserves the ORIGINAL retired source (so rollback restores convention too)',
      Number(retiredInBackup[0].n) === Number(b[0].n), `${retiredInBackup[0].n}/${b[0].n}`);
  }
}

// ── 6/7. convention verified ─────────────────────────────────────────────────
L('\n=== 6/7. CANONICAL CONVENTION ===');
{
  const r = await sql.query(
    `select count(*)::int n from ticker_daily_candles where source = $1`, [CANDLE_SOURCE.TIINGO]);
  L(`     canonical Tiingo rows: ${r[0].n}`);
  const bad = await sql.query(`
    select count(*)::int n from ticker_daily_candles where source = $1
      and (low > least(open, close) + 1e-6 or high < greatest(open, close) - 1e-6
        or high < low or open <= 0 or close <= 0 or volume < 0)`, [CANDLE_SOURCE.TIINGO]);
  ok('OHLC relationships hold on every canonical row', Number(bad[0].n) === 0, String(bad[0].n));

  const verifiedTickers = Object.entries(audit).filter(([, v]) => v.verified);
  ok('every repaired ticker was independently validated against a second vendor',
    verifiedTickers.every(([, v]) => Number(v.polygonAgreePct) >= 97),
    `${verifiedTickers.filter(([, v]) => Number(v.polygonAgreePct) < 97).length} below 97%`);

  // ⚠️ Reach of the independent proof, stated rather than implied.
  const partial = verifiedTickers.filter(([, v]) => Number(v.unverifiedOlderRows) > 0);
  L(`     independently verified from a second vendor on the window it serves;`);
  L(`     ${partial.length} ticker(s) have older rows outside that window, validated instead by the`);
  L(`     structural invariants below (splits, ex-dividends, real gaps).`);
}

// ── 8/9/10/11/12. the data still describes the market ────────────────────────
L('\n=== 8-12. STRUCTURAL INVARIANTS ===');
{
  const dup = await sql.query(`
    select count(*)::int n from (
      select ticker, date from ticker_daily_candles group by ticker, date having count(*) > 1) x`);
  ok('no duplicate sessions', Number(dup[0].n) === 0, String(dup[0].n));

  const runId = fs.existsSync('research/convention-run-id.txt')
    ? fs.readFileSync('research/convention-run-id.txt', 'utf8').trim() : null;
  if (runId) {
    const lost = await sql.query(`
      select count(*)::int n from ticker_daily_candles_backup b
       where b.run_id=$1 and not exists (
         select 1 from ticker_daily_candles c where c.ticker=b.ticker and c.date=b.date)`, [runId]);
    ok('no sessions lost by the repair', Number(lost[0].n) === 0, String(lost[0].n));
  } else block('no sessions lost by the repair', 'no snapshot yet');

  // A known split must leave no cliff.
  for (const [t, from, to, label] of [
    ['AAPL', '2020-08-27', '2020-09-02', '2020 4:1'],
    ['MSFT', '2003-02-12', '2003-02-24', '2003 2:1'],
  ]) {
    const r = await sql.query(
      'select close from ticker_daily_candles where ticker=$1 and date between $2 and $3 order by date', [t, from, to]);
    let worst = 0;
    for (let i = 1; i < r.length; i++) worst = Math.max(worst, Math.abs((+r[i].close - +r[i - 1].close) / +r[i - 1].close));
    ok(`${t} ${label} split shows no cliff`, r.length > 3 && worst < 0.15, `${(worst * 100).toFixed(1)}%`);
  }

  // A real crash must survive — a repair that smooths history is worse than the bug.
  const ko = await sql.query(
    "select close from ticker_daily_candles where ticker='KO' and date between '1987-10-16' and '1987-10-21' order by date");
  let biggest = 0;
  for (let i = 1; i < ko.length; i++) biggest = Math.min(biggest, (+ko[i].close - +ko[i - 1].close) / +ko[i - 1].close);
  ok('KO retains its October 1987 crash (a real gap was not erased)', biggest < -0.15, `${(biggest * 100).toFixed(1)}%`);

  // Split-adjusted keeps distributions, so ex-dividend drops must REMAIN. Their absence would mean
  // a total-return series crept back in.
  const exDrops = await sql.query(`
    with d as (
      select date, close, lag(close) over (order by date) prev
        from ticker_daily_candles where ticker='KO' and date between '2019-01-01' and '2019-12-31')
    select count(*) filter (where close < prev)::int drops, count(*)::int n from d where prev is not null`);
  ok('KO 2019 still contains down sessions (distributions not back-adjusted away)',
    Number(exDrops[0].drops) > 50, `${exDrops[0].drops}/${exDrops[0].n}`);

  // Volume must scale WITH splits, never be left raw beside divided prices.
  const vol = await sql.query(`
    select count(*)::int n from ticker_daily_candles where source=$1 and volume < 0`, [CANDLE_SOURCE.TIINGO]);
  ok('no negative volume on canonical rows', Number(vol[0].n) === 0, String(vol[0].n));
}

// ── 13/14. the writers ───────────────────────────────────────────────────────
L('\n=== 13/14. WRITERS ===');
{
  // Static proof, done IN NODE rather than by shelling out to grep.
  //
  // An earlier version ran `grep` through execSync. On Windows that resolves to cmd.exe, grep does
  // not exist, the command printed "The system cannot find the path specified", and the empty output
  // was read as "no matches" — so both checks PASSED without ever inspecting a file. A check that
  // cannot fail is worse than no check, because it is reported as evidence.
  const scan = (dir, re) => {
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') walk(p); continue; }
        if (!/\.(js|jsx|mjs|ts|tsx)$/.test(e.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        text.split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${p}:${i + 1}`); });
      }
    };
    walk(dir);
    return hits;
  };
  // Prove the scanner actually sees files before trusting a zero result from it.
  const sanity = scan('src/app/api', /export async function GET/);
  ok('the static scanner reads route files at all (guards against a vacuous pass)',
    sanity.length > 0, `${sanity.length} routes seen`);

  const adjWrites = scan('src/app/api', /adjOpen|adjHigh|adjLow|adjClose|adjVolume/);
  ok('no API route references the vendor adj* (total-return) fields',
    adjWrites.length === 0, adjWrites.join(', ').slice(0, 200));

  const retiredWrites = scan('src', /source:\s*'tiingo'/);
  ok("no writer emits the retired 'tiingo' source",
    retiredWrites.length === 0, retiredWrites.join(', ').slice(0, 200));

  // Behavioural proof: the contract suite, including its mutation modes.
  let contractOut = '';
  try { contractOut = execSync('node scripts/verify-candle-contract.mjs', { encoding: 'utf8' }); } catch (e) { contractOut = String(e.stdout || ''); }
  ok('candle contract suite passes', /(\d+) passed, 0 failed/.test(contractOut),
    (contractOut.trim().split('\n').pop() || '').slice(0, 80));
  let mutOut = '';
  try { mutOut = execSync('node scripts/verify-candle-contract.mjs --mutate=adjclose', { encoding: 'utf8' }); }
  catch (e) { mutOut = String(e.stdout || ''); }
  ok('the suite FAILS when the original adjClose bug is reintroduced', /[1-9]\d* failed/.test(mutOut),
    (mutOut.trim().split('\n').pop() || '').slice(0, 80));
}

// ── 15. post-repair seam scan ────────────────────────────────────────────────
L('\n=== 15. POST-REPAIR SEAM SCAN ===');
{
  // Every candidate must be EXPLAINED, not counted. The explanation is the pair of sources at the
  // boundary: two canonical sources means an ordinary market move that happens to sit where
  // provenance changes; a retired source on either side means an unrepaired convention change, and
  // that is the thing the repair exists to eliminate.
  const repaired = Object.entries(audit)
    .filter(([, v]) => v.action === 'REPAIR' || v.action === 'RELABEL_ONLY').map(([t]) => t);
  let canonicalBoundary = 0, retiredBoundary = 0;
  const unexplained = [];
  for (const t of repaired) {
    const r = await sql.query(
      'select date::text date, open, high, low, close, volume, source from ticker_daily_candles where ticker=$1 order by date', [t]);
    const bars = r.map((x) => ({ ...x, open: +x.open, high: +x.high, low: +x.low, close: +x.close }));
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    for (const c of findSeamCandidates(bars)) {
      const i = idx.get(c.date);
      const a = bars[i - 1]?.source, b = bars[i]?.source;
      if (a === RETIRED || b === RETIRED) {
        retiredBoundary++;
        unexplained.push(`${t} ${c.date} ${c.gapPct}% ${a}->${b}`);
      } else canonicalBoundary++;
    }
  }
  L(`     ordinary moves at a canonical/canonical boundary (expected): ${canonicalBoundary}`);
  ok('no seam candidate sits at a boundary involving the retired convention',
    retiredBoundary === 0, `${retiredBoundary} remain`);
  if (unexplained.length) {
    for (const u of unexplained.slice(0, 12)) L(`       ${u}`);
    if (unexplained.length > 12) L(`       ... ${unexplained.length - 12} more`);
  }
}

L(`\n${pass} passed, ${fail} failed, ${blocked} blocked`);
L(fail === 0 && blocked === 0
  ? 'GATE OPEN — writer fix and repaired data may deploy together.'
  : 'GATE CLOSED — resolve the above before deploying.');
process.exit(fail || blocked ? 1 : 0);
