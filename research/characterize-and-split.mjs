// PHASE 5c / PHASE 6 — characterise the research dataset, then FREEZE the development/holdout split.
//
// ── WHY CHARACTERISE AFTER INGEST ───────────────────────────────────────────
//
// Size, price and volatility could be sampled up front. Whether a security spent five years
// grinding higher, collapsed, or went nowhere is a property OF the history and could not be a
// selection input. So achieved coverage of those regimes is MEASURED here and reported honestly —
// including any regime the sample is thin on, because a classifier validated without post-parabolic
// collapses has never been tested on one.
//
// ── WHY THE SPLIT IS FROZEN BEFORE ANY METHODOLOGY EXISTS ───────────────────
//
// A holdout inspected while tuning is not a holdout. The split is written to disk now, before a
// single trend rule is written, and the manifest records the hash of the member list so a later
// claim to have honoured it can be checked rather than trusted.
//
// MSFT, AAPL and NVDA are FORCED INTO DEVELOPMENT. They are already diagnostic cases — MSFT
// especially, whose monthly label started this work — and treating a security whose answer we have
// already argued about as untouched validation would be self-deception.
//
// Run: node --env-file=.env.local research/characterize-and-split.mjs

import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import fs from 'node:fs';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

L('=== dataset inventory ===');
const inv = await sql.query(`
  select count(*)::bigint bars, count(distinct ticker)::int tickers,
         min(date)::text mn, max(date)::text mx
    from research_daily_split_adjusted`);
L(`  ${inv[0].bars} bars, ${inv[0].tickers} tickers, ${inv[0].mn} -> ${inv[0].mx}`);

const depth = await sql.query(`
  with b as (select ticker, count(*)::int n, min(date) mn, max(date) mx from research_daily_split_adjusted group by ticker)
  select case when n>=1200 then 'a >=1200 (5y)' when n>=756 then 'b 756-1199 (3-5y)'
              when n>=252 then 'c 252-755 (1-3y)' else 'd <252 (<1y)' end bucket,
         count(*)::int tickers from b group by 1 order by 1`);
L('\n  depth distribution:');
for (const r of depth) L(`    ${r.bucket.padEnd(20)} ${String(r.tickers).padStart(5)}`);

L('\n  usable per timeframe (engine minimums, walk-forward capable):');
for (const [label, need, note] of [
  ['daily   (>=460 bars)', 460, 'minBars 60 + 200MA + trend window'],
  ['weekly  (>=760 bars = 152w)', 760, 'minBars 40 + 40MA + room to walk'],
  ['monthly (>=1500 bars = 71m)', 1500, 'minBars 36 + 20MA + 60m trend window + room to walk'],
]) {
  const r = await sql.query(`with b as (select ticker, count(*)::int n from research_daily_split_adjusted group by ticker)
    select count(*)::int c from b where n >= ${need}`);
  L(`    ${label.padEnd(30)} ${String(r[0].c).padStart(5)}   (${note})`);
}

// ── achieved regime coverage ─────────────────────────────────────────────────
L('\n=== achieved regime coverage (measured, not selected) ===');
const regimes = await sql.query(`
  with b as (
    select ticker,
           count(*)::int n,
           (array_agg(close order by date asc))[1] first_close,
           (array_agg(close order by date desc))[1] last_close,
           max(close) hi, min(close) lo,
           stddev_pop(ln_ret) * sqrt(252) annvol
      from (
        select ticker, date, close,
               ln(close / nullif(lag(close) over (partition by ticker order by date), 0)) ln_ret
          from research_daily_split_adjusted) x
     group by ticker having count(*) >= 460)
  select ticker, n, first_close, last_close, hi, lo, annvol,
         (last_close/nullif(first_close,0) - 1) total_ret,
         (last_close/nullif(hi,0) - 1) from_high,
         (last_close/nullif(lo,0) - 1) from_low
    from b`);

const R = regimes.map((r) => ({
  ticker: r.ticker, n: Number(r.n),
  totalRet: Number(r.total_ret), fromHigh: Number(r.from_high), fromLow: Number(r.from_low),
  annVol: Number(r.annvol), last: Number(r.last_close),
}));
const tag = (r) => {
  const t = [];
  if (r.totalRet > 1.0) t.push('persistent-winner');
  if (r.totalRet < -0.5) t.push('persistent-decliner');
  if (Math.abs(r.totalRet) < 0.25) t.push('sideways');
  if (r.fromHigh < -0.5) t.push('far-below-high');
  if (r.fromHigh > -0.05) t.push('near-high');
  if (r.fromLow > 3) t.push('large-recovery');
  if (r.annVol > 0.9) t.push('very-high-vol');
  if (r.annVol < 0.25) t.push('low-vol');
  if (r.last < 5) t.push('low-priced');
  if (r.last > 300) t.push('high-priced');
  return t;
};
const counts = {};
for (const r of R) for (const t of tag(r)) counts[t] = (counts[t] || 0) + 1;
L(`  tickers with >=460 bars: ${R.length}`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  L(`    ${k.padEnd(22)} ${String(v).padStart(5)}  ${pct(v, R.length)}%`);
}
const thin = Object.entries(counts).filter(([, v]) => v < 25);
if (thin.length) L(`  ⚠ THIN REGIMES (<25 names): ${thin.map(([k, v]) => `${k}=${v}`).join(', ')}`);

// ── freeze the split ─────────────────────────────────────────────────────────
L('\n=== freezing development / holdout ===');
const FORCED_DEV = new Set(['MSFT', 'AAPL', 'NVDA', 'KO', 'PG', 'JNJ', 'QQQ', 'INTC']);
// Deterministic and regime-stratified: within each regime tag, names are ordered by a hash of the
// ticker and split 60/40, so both sides carry the same mix rather than the same alphabet.
const hash = (s) => crypto.createHash('sha256').update(`trend-split-v1:${s}`).digest('hex');
const assigned = new Map();
const byRegime = new Map();
for (const r of R) {
  const key = tag(r).sort().join('+') || 'untagged';
  if (!byRegime.has(key)) byRegime.set(key, []);
  byRegime.get(key).push(r.ticker);
}
for (const [, list] of byRegime) {
  const ordered = [...list].sort((a, b) => hash(a).localeCompare(hash(b)));
  ordered.forEach((t, i) => assigned.set(t, i < Math.ceil(ordered.length * 0.6) ? 'dev' : 'holdout'));
}
for (const t of FORCED_DEV) if (assigned.has(t)) assigned.set(t, 'dev');

const dev = [...assigned.entries()].filter(([, v]) => v === 'dev').map(([k]) => k).sort();
const hold = [...assigned.entries()].filter(([, v]) => v === 'holdout').map(([k]) => k).sort();
L(`  development: ${dev.length}`);
L(`  holdout:     ${hold.length}`);
L(`  forced into development (already diagnostic): ${[...FORCED_DEV].filter((t) => assigned.has(t)).join(', ')}`);

const devCounts = {}, holdCounts = {};
for (const r of R) {
  const where = assigned.get(r.ticker);
  for (const t of tag(r)) (where === 'dev' ? devCounts : holdCounts)[t] = ((where === 'dev' ? devCounts : holdCounts)[t] || 0) + 1;
}
L('\n  regime balance across the split:');
L(`    ${'regime'.padEnd(22)} ${'dev'.padStart(6)} ${'holdout'.padStart(8)}`);
for (const k of Object.keys(counts).sort()) {
  L(`    ${k.padEnd(22)} ${String(devCounts[k] || 0).padStart(6)} ${String(holdCounts[k] || 0).padStart(8)}`);
}

const split = {
  version: 'trend-split-v1',
  frozenAt: new Date().toISOString(),
  rule: 'sha256(ticker) ordered within regime tag, first 60% development; named diagnostics forced to development',
  forcedDevelopment: [...FORCED_DEV],
  development: dev,
  holdout: hold,
  developmentHash: crypto.createHash('sha256').update(dev.join(',')).digest('hex'),
  holdoutHash: crypto.createHash('sha256').update(hold.join(',')).digest('hex'),
  note: 'HOLDOUT IS NOT TO BE INSPECTED DURING METHODOLOGY DEVELOPMENT. The hashes exist so that '
      + 'claim is checkable rather than trusted.',
};
fs.writeFileSync('research/trend-split.json', JSON.stringify(split, null, 1));
L(`\n  written to research/trend-split.json`);
L(`  development hash ${split.developmentHash.slice(0, 16)}…`);
L(`  holdout hash     ${split.holdoutHash.slice(0, 16)}…`);
