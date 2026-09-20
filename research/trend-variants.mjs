// STEP G / PHASE 2 — NOISE FLOOR, THEN THE PIVOT-WIDTH FRONTIER.
//
// Two jobs, in this order, because the second is meaningless without the first:
//
//   1. NOISE FLOOR. The development set is split in half by ticker hash and the CURRENT model is
//      measured on each half. The spread between halves is how much a number here moves for no
//      reason at all. Any variant difference smaller than that is not a finding.
//
//   2. THE FRONTIER. pivotWidth is the one parameter that directly trades the two things the
//      pre-registration cares about: a wider shoulder means a steadier label (C2) and a later one
//      (C3). Sweeping it answers whether the shipped setting sits on the efficient frontier or is
//      simply dominated — which is a different question from "is there a better classifier", and
//      the only one this data can actually settle.
//
// ── WHAT IS NOT DONE HERE ───────────────────────────────────────────────────
//
// C4c (fixed-horizon persistence) was added AFTER the first results were seen. It is reported for
// context and it is NOT the gate: swapping in a friendlier criterion after seeing the numbers is
// precisely what the pre-registration exists to prevent. The gate remains pre-registered C4.
//
// The holdout is not read. Nothing here is deployed.
//
// Run: node --env-file=.env.local research/trend-variants.mjs [--limit N]

import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { findSwings, swingsAsOf, deriveTrend, TREND } from '../src/lib/structure/swings.mjs';
import { aggregateBars, completedOnly, TIMEFRAMES } from '../src/lib/structure/bars.mjs';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', 0)) || 0;

const STRIDE = 5;
const MIN_DAILY_BARS = 460;
const MIN_WEEKLY_BARS = 152;
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function blank() {
  return { states: {}, samples: 0, runs: {}, staleness: {}, span: {}, fwd: {}, flips: 0 };
}
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const push = (o, k, v) => { (o[k] ||= []).push(v); };

/**
 * One pass over one timeframe at one pivot width. Mirrors production exactly: swings confirmed by T,
 * then filtered to trendWindow, then deriveTrend — the same three steps engine.mjs performs.
 */
function walk(a, tf, bars, width) {
  const closes = bars.map((b) => b.close);
  const dateIndex = new Map(bars.map((b, i) => [b.date, i]));
  const swings = findSwings(bars, { width });
  const stride = tf === 'daily' ? STRIDE : 1;
  const minBars = tf === 'daily' ? MIN_DAILY_BARS : MIN_WEEKLY_BARS;
  const fwdN = tf === 'daily' ? 10 : 4;
  let prev = null, runLen = 0, runStart = null;

  for (let i = minBars; i < bars.length; i += stride) {
    const from = Math.max(0, (i + 1) - (TIMEFRAMES[tf].trendWindow ?? (i + 1)));
    const d = deriveTrend(swingsAsOf(swings, bars[i].date).filter((s) => s.index >= from));
    const state = d.trend;
    a.samples++; bump(a.states, state);

    if (state !== TREND.UNKNOWN) {
      const pi = d.asOfPivot != null ? dateIndex.get(String(d.asOfPivot)) : undefined;
      if (pi != null) push(a.staleness, state, i - pi);
      if (i + fwdN < closes.length) push(a.fwd, state, ((closes[i + fwdN] - closes[i]) / closes[i]) * 100);
    }
    if (state === prev) { runLen++; } else {
      if (prev != null) {
        push(a.runs, prev, runLen);
        if (runStart != null && i - stride > runStart) {
          push(a.span, prev, ((closes[i - stride] - closes[runStart]) / closes[runStart]) * 100);
        }
        a.flips++;
      }
      prev = state; runLen = 1; runStart = i;
    }
  }
  if (prev != null) push(a.runs, prev, runLen);
}

/** The pre-registered numbers, reduced to one row. */
function summarise(a, tf) {
  const dirRuns = [...(a.runs[TREND.UP] || []), ...(a.runs[TREND.DOWN] || [])];
  const dirStale = [...(a.staleness[TREND.UP] || []), ...(a.staleness[TREND.DOWN] || [])];
  const up = a.span[TREND.UP] || [], dn = a.span[TREND.DOWN] || [];
  const upF = a.fwd[TREND.UP] || [], dnF = a.fwd[TREND.DOWN] || [];
  const match = (r, s) => pct(r.filter((x) => Math.sign(x) === s).length, r.length);
  return {
    samples: a.samples,
    flips100: a.samples ? (a.flips / a.samples) * 100 : 0,
    medRun: median(dirRuns),
    singles: pct(dirRuns.filter((x) => x === 1).length, dirRuns.length),
    medStale: median(dirStale),
    unknown: pct(a.states[TREND.UNKNOWN] || 0, a.samples),
    range: pct(a.states[TREND.RANGE] || 0, a.samples),
    c4Up: match(up, 1), c4Dn: match(dn, -1),
    c4cUp: match(upF, 1), c4cDn: match(dnF, -1),
  };
}

const row = (label, s) => L(
  `  ${String(label).padEnd(16)} ${String(s.samples).padStart(7)} ${s.flips100.toFixed(1).padStart(7)}`
  + ` ${String(s.medRun ?? '-').padStart(6)} ${String(s.singles).padStart(7)}%`
  + ` ${String(s.medStale ?? '-').padStart(6)} ${String(s.range).padStart(6)}%`
  + ` ${String(s.unknown).padStart(7)}% ${String(s.c4Up).padStart(6)}% ${String(s.c4Dn).padStart(6)}%`
  + ` ${String(s.c4cUp).padStart(6)}% ${String(s.c4cDn).padStart(6)}%`);

const header = () => {
  L(`  ${'config'.padEnd(16)} ${'samples'.padStart(7)} ${'flip/100'.padStart(7)} ${'medRun'.padStart(6)}`
    + ` ${'1-samp'.padStart(8)} ${'stale'.padStart(6)} ${'range'.padStart(7)} ${'unknown'.padStart(8)}`
    + ` ${'C4up'.padStart(6)} ${'C4dn'.padStart(7)} ${'C4cUp'.padStart(6)} ${'C4cDn'.padStart(7)}`);
  L(`  ${'-'.repeat(110)}`);
};

const split = JSON.parse(fs.readFileSync('research/trend-split.json', 'utf8'));
let DEV = split.development;
if (LIMIT) DEV = DEV.slice(0, LIMIT);
L(`development ${DEV.length} tickers; holdout ${split.holdout.length} NOT read\n`);

const WIDTHS = { daily: [2, 3, 4, 5, 6], weekly: [1, 2, 3, 4] };
const CURRENT = { daily: TIMEFRAMES.daily.pivotWidth, weekly: TIMEFRAMES.weekly.pivotWidth };

// half A / half B for the noise floor, by the same hashing rule the split itself used
const halfOf = (t) => (parseInt(crypto.createHash('sha256').update(`noise:${t}`).digest('hex').slice(0, 8), 16) % 2 ? 'B' : 'A');

const acc = {};
for (const tf of ['daily', 'weekly']) {
  acc[tf] = { variants: {}, halves: { A: blank(), B: blank() } };
  for (const w of WIDTHS[tf]) acc[tf].variants[w] = blank();
}

let done = 0;
for (const t of DEV) {
  const r = await sql.query(
    `select date::text date, open, high, low, close, volume
       from research_daily_split_adjusted where ticker=$1 order by date`, [t]);
  const daily = r.map((b) => ({ date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0 }));
  if (daily.length < MIN_DAILY_BARS + 40) continue;
  const weekly = completedOnly(aggregateBars(daily, 'weekly'));
  const h = halfOf(t);

  for (const w of WIDTHS.daily) walk(acc.daily.variants[w], 'daily', daily, w);
  walk(acc.daily.halves[h], 'daily', daily, CURRENT.daily);
  if (weekly.length >= MIN_WEEKLY_BARS + 10) {
    for (const w of WIDTHS.weekly) walk(acc.weekly.variants[w], 'weekly', weekly, w);
    walk(acc.weekly.halves[h], 'weekly', weekly, CURRENT.weekly);
  }
  if (++done % 100 === 0) L(`  ... ${done}/${DEV.length}`);
}

for (const tf of ['daily', 'weekly']) {
  L(`\n================ ${tf.toUpperCase()} ================`);
  L('NOISE FLOOR — the same current model on two halves of the development set.');
  L('Any variant difference below this spread is indistinguishable from nothing.');
  header();
  const A = summarise(acc[tf].halves.A, tf), B = summarise(acc[tf].halves.B, tf);
  row('half A', A); row('half B', B);
  const spread = {
    flips100: Math.abs(A.flips100 - B.flips100),
    medStale: Math.abs((A.medStale ?? 0) - (B.medStale ?? 0)),
    c4Up: Math.abs(A.c4Up - B.c4Up), c4Dn: Math.abs(A.c4Dn - B.c4Dn),
  };
  L(`  spread: flips/100 ${spread.flips100.toFixed(2)}   staleness ${spread.medStale}`
    + `   C4up ${spread.c4Up.toFixed(1)}pp   C4dn ${spread.c4Dn.toFixed(1)}pp`);

  L(`\nPIVOT WIDTH SWEEP (current = ${CURRENT[tf]})`);
  header();
  for (const w of WIDTHS[tf]) {
    row(`width ${w}${w === CURRENT[tf] ? '  <- current' : ''}`, summarise(acc[tf].variants[w], tf));
  }
}
L('\nC4 is the pre-registered gate (net change across the displayed span, matching sign).');
L('C4c is the fixed-horizon persistence measure, added after the fact and reported as context only.');
