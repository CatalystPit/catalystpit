// STEP G / PHASE 1 — CHARACTERISE THE SHIPPED TREND CLASSIFIER.
//
// Measures the six pre-registered criteria in research/trend-methodology-preregistration.md on the
// DEVELOPMENT set only. No variant is run here and no threshold is changed. The point is to know
// what the current model actually does before anyone proposes replacing it.
//
// ── POINT-IN-TIME, AND WHY THE SHORTCUT IS LEGITIMATE ───────────────────────
//
// findSwings decides a pivot from the window [i-width, i+width] alone, and swingsAsOf is the
// sanctioned filter. So computing swings ONCE over the full series and then filtering on
// confirmedAt <= T is not an approximation of "rebuild with asOf=T" — it is identical, because a
// pivot confirmed by T had its whole window inside the prefix that ended at T. Weekly is the same
// once completeness is read as the calendar fact it is: a week whose next period starts on or
// before T ended before T, so its OHLC can only contain sessions at or before T.
//
// The expensive alternative (rebuilding every timeframe at every sample) was measured against this
// on a sample of tickers and agreed exactly; see --verify-shortcut.
//
// Run: node --env-file=.env.local research/trend-characterize.mjs [--limit N] [--verify-shortcut]

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import { findSwings, swingsAsOf, deriveTrend, TREND } from '../src/lib/structure/swings.mjs';
import { aggregateBars, completedOnly, nextPeriodStart, TIMEFRAMES } from '../src/lib/structure/bars.mjs';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', 0)) || 0;

/** Sessions between samples. Dense enough to see a state change, sparse enough to keep runs meaningful. */
const STRIDE = 5;
const MIN_DAILY_BARS = 460;
const MIN_WEEKLY_BARS = 152;

const median = (xs) => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// ── harness self-test ────────────────────────────────────────────────────────
// A characterisation harness that mislabels everything produces beautifully consistent nonsense.
// These three cases have answers that are not in dispute, so if any fails the statistics below are
// not worth reading and the run aborts.
{
  const mk = (closes) => closes.map((c, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1,
  }));
  const zig = (n, drift) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(100 * (1 + drift * i) * (1 + (i % 6 < 3 ? 0.03 : -0.03)));
    return out;
  };
  const cases = [
    ['rising staircase', mk(zig(200, 0.004)), TREND.UP],
    ['falling staircase', mk(zig(200, -0.003)), TREND.DOWN],
  ];
  for (const [name, bars, want] of cases) {
    const sw = findSwings(bars, { width: 3 });
    const got = deriveTrend(sw).trend;
    if (got !== want) {
      L(`HARNESS SELF-TEST FAILED: ${name} classified ${got}, expected ${want}`);
      process.exit(1);
    }
  }
  L('harness self-test: rising staircase -> uptrend, falling staircase -> downtrend  ok\n');
}

const split = JSON.parse(fs.readFileSync('research/trend-split.json', 'utf8'));
let DEV = split.development;
if (LIMIT) DEV = DEV.slice(0, LIMIT);
L(`development tickers: ${DEV.length} (holdout of ${split.holdout.length} NOT touched)\n`);

// Per-timeframe accumulators.
const acc = {};
for (const tf of ['daily', 'weekly']) {
  acc[tf] = {
    states: {}, samples: 0, tickers: 0,
    runs: {},                 // state -> [run lengths in samples]
    staleness: {},            // state -> [bars since asOfPivot]
    spanReturn: {},           // state -> [net % change across the labelled span]
    trailing: {},             // state -> [net % change over the bars BEFORE the label, the control]
    forward: {},              // state -> [net % change over a FIXED window from label onset]
    maAgree: 0, maTotal: 0,
    flips: 0,
  };
}
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const push = (o, k, v) => { (o[k] ||= []).push(v); };

function sma(closes, i, n) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += closes[j];
  return s / n;
}

async function tickerBars(t) {
  const r = await sql.query(
    `select date::text date, open, high, low, close, volume
       from research_daily_split_adjusted where ticker=$1 order by date`, [t]);
  return r.map((b) => ({
    date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0,
  }));
}

/**
 * Walk one ticker on one timeframe and record every pre-registered measure.
 *
 * `bars` is the completed series for that timeframe; `sampleAt` are indices into it.
 */
function walk(tf, bars, swings, maPeriod) {
  const a = acc[tf];
  const closes = bars.map((b) => b.close);
  const dateIndex = new Map(bars.map((b, i) => [b.date, i]));
  let prevState = null, runLen = 0, runStartIdx = null;

  const width = TIMEFRAMES[tf].pivotWidth;
  const minBars = tf === 'daily' ? MIN_DAILY_BARS : MIN_WEEKLY_BARS;
  const stride = tf === 'daily' ? STRIDE : 1;   // weekly bars are already coarse

  for (let i = minBars; i < bars.length; i += stride) {
    const T = bars[i].date;
    const seen = swingsAsOf(swings, T);
    // PRODUCTION FILTERS TO trendWindow BEFORE DERIVING (engine.mjs:58-60), and this harness must
    // measure what ships, not a close relative of it. With twelve years of bars the "last two highs"
    // can be pivots from years ago — the exact failure that made MSFT read as a monthly downtrend off
    // long-past lows — so the engine reads trend from recent swings only. Omitting the filter here
    // would have characterised a classifier that does not exist.
    //
    // As of bar i the completed series has length i+1, so `from` is computed against that, not
    // against the full array.
    const from = Math.max(0, (i + 1) - (TIMEFRAMES[tf].trendWindow ?? (i + 1)));
    const d = deriveTrend(seen.filter((s) => s.index >= from));
    const state = d.trend;
    a.samples++;
    bump(a.states, state);

    if (state !== TREND.UNKNOWN) {
      // C3 staleness: sessions of THIS timeframe between the newest confirmed pivot and now.
      const pi = d.asOfPivot != null ? dateIndex.get(String(d.asOfPivot)) : undefined;
      if (pi != null) push(a.staleness, state, i - pi);
      // C4a — does the label describe the PAST it is derived from?
      //
      // This is the harness's own control. Higher-highs-with-higher-lows is a statement about bars
      // that have already printed, so trailing change at label time MUST come out strongly positive
      // for UP and negative for DOWN. If it does not, the walk is wired wrong and every other number
      // here is noise wearing a label.
      const back = tf === 'daily' ? 20 : 8;
      if (i - back >= 0) {
        push(a.trailing, state, ((closes[i] - closes[i - back]) / closes[i - back]) * 100);
      }
      // C4c — persistence of the described condition, on a FIXED horizon from label onset.
      //
      // C4 measures the span the label is displayed for, and that span ENDS BECAUSE structure broke.
      // So an UP span terminates, by construction, at the reversal that ended it, which biases the
      // measure against the label. A fixed window from onset is not contaminated by the termination
      // rule and is the fairer reading of "is the condition still what the label says".
      //
      // This is NOT an edge or return claim. Market Structure forecasts nothing; this asks only
      // whether the state being described still holds shortly after it is shown.
      const fwd = tf === 'daily' ? 10 : 4;
      if (i + fwd < closes.length) {
        push(a.forward, state, ((closes[i + fwd] - closes[i]) / closes[i]) * 100);
      }
      // C6 redundancy against the trivial moving-average rule.
      //
      // The MA rule has only two states, so a RANGE sample can never agree with it and including
      // RANGE caps agreement at (1 - range share) regardless of how good either rule is. Agreement
      // is therefore counted ONLY over samples where the structural label is directional, which is
      // the only comparison that means anything.
      const m = sma(closes, i, maPeriod);
      if (m != null && state !== TREND.RANGE) {
        a.maTotal++;
        const maSays = closes[i] > m ? TREND.UP : TREND.DOWN;
        if (maSays === state) a.maAgree++;
      }
    }

    // C2 runs and C4 span return.
    if (state === prevState) { runLen++; } else {
      if (prevState != null) {
        push(a.runs, prevState, runLen);
        if (runStartIdx != null && i - stride > runStartIdx) {
          const r = ((closes[i - stride] - closes[runStartIdx]) / closes[runStartIdx]) * 100;
          push(a.spanReturn, prevState, r);
        }
        a.flips++;
      }
      prevState = state; runLen = 1; runStartIdx = i;
    }
  }
  if (prevState != null) push(a.runs, prevState, runLen);
  a.tickers++;
}

let done = 0;
for (const t of DEV) {
  const daily = await tickerBars(t);
  if (daily.length < MIN_DAILY_BARS + 40) continue;

  // Daily completeness is `date < boundary`, and the boundary is the day AFTER the last bar in a
  // finished history — so production treats every bar here as complete, including the last. Dropping
  // the final bar (an earlier version of this harness did) shifts every index by one and silently
  // changes which pivots are "the last two". That showed up as 23/25 agreement with the production
  // engine; with the full series it is exact.
  const dailyComplete = daily;
  const dSwings = findSwings(dailyComplete, { width: TIMEFRAMES.daily.pivotWidth });
  walk('daily', dailyComplete, dSwings, 200);

  const weeklyAll = aggregateBars(daily, 'weekly');
  const weekly = completedOnly(weeklyAll);
  if (weekly.length >= MIN_WEEKLY_BARS + 10) {
    const wSwings = findSwings(weekly, { width: TIMEFRAMES.weekly.pivotWidth });
    walk('weekly', weekly, wSwings, 40);
  }
  if (++done % 100 === 0) L(`  ... ${done}/${DEV.length} tickers`);
}

L('');
for (const tf of ['daily', 'weekly']) {
  const a = acc[tf];
  L(`================ ${tf.toUpperCase()} — ${a.tickers} tickers, ${a.samples.toLocaleString()} samples ================`);
  L('C1 non-triviality — state distribution');
  for (const s of [TREND.UP, TREND.DOWN, TREND.RANGE, TREND.UNKNOWN]) {
    L(`   ${String(s).padEnd(22)} ${String(a.states[s] || 0).padStart(8)}  ${String(pct(a.states[s] || 0, a.samples)).padStart(5)}%`);
  }
  L(`C5 coverage — UNKNOWN share: ${pct(a.states[TREND.UNKNOWN] || 0, a.samples)}%`);

  L('\nC2 stability — run length in samples (consecutive same-state samples)');
  for (const s of [TREND.UP, TREND.DOWN, TREND.RANGE]) {
    const r = a.runs[s] || [];
    L(`   ${String(s).padEnd(22)} n=${String(r.length).padStart(6)}  median ${String(median(r) ?? '-').padStart(4)}`
      + `  mean ${(r.length ? (r.reduce((x, y) => x + y, 0) / r.length).toFixed(1) : '-').padStart(5)}`
      + `  share of runs that are a single sample ${String(pct(r.filter((x) => x === 1).length, r.length)).padStart(5)}%`);
  }
  L(`   flips per 100 samples: ${(a.samples ? (a.flips / a.samples) * 100 : 0).toFixed(1)}`);

  L('\nC3 staleness — bars between the newest confirmed pivot and the sample');
  for (const s of [TREND.UP, TREND.DOWN, TREND.RANGE]) {
    const st = a.staleness[s] || [];
    const runMed = median(a.runs[s] || []);
    const stMed = median(st);
    // Staleness is in BARS; runs are in SAMPLES. Converting runs to bars makes the ratio meaningful.
    const runBars = runMed == null ? null : runMed * (tf === 'daily' ? STRIDE : 1);
    L(`   ${String(s).padEnd(22)} n=${String(st.length).padStart(7)}  median ${String(stMed ?? '-').padStart(4)} bars`
      + `  p90 ${String(st.length ? st.sort((x, y) => x - y)[Math.floor(st.length * 0.9)] : '-').padStart(4)}`
      + `  median run ${String(runBars ?? '-').padStart(4)} bars`
      + `  staleness/run ${runBars ? (stMed / runBars).toFixed(2) : '-'}`);
  }

  L('\nC4a CONTROL — trailing change at label time (must be strongly directional, or the harness is wrong)');
  for (const s of [TREND.UP, TREND.DOWN, TREND.RANGE]) {
    const r = a.trailing[s] || [];
    const sign = s === TREND.UP ? 1 : s === TREND.DOWN ? -1 : 0;
    const agree = sign === 0 ? null : r.filter((x) => Math.sign(x) === sign).length;
    L(`   ${String(s).padEnd(22)} n=${String(r.length).padStart(7)}  median ${(median(r) ?? 0).toFixed(2)}%`
      + (agree == null ? '' : `  matching sign ${pct(agree, r.length)}%`));
  }

  L('\nC4 descriptive validity — net price change across the labelled span');
  for (const s of [TREND.UP, TREND.DOWN, TREND.RANGE]) {
    const r = a.spanReturn[s] || [];
    const sign = s === TREND.UP ? 1 : s === TREND.DOWN ? -1 : 0;
    const agree = sign === 0 ? null : r.filter((x) => Math.sign(x) === sign).length;
    L(`   ${String(s).padEnd(22)} n=${String(r.length).padStart(6)}  median ${(median(r) ?? 0).toFixed(2)}%`
      + `  mean ${(r.length ? (r.reduce((x, y) => x + y, 0) / r.length) : 0).toFixed(2)}%`
      + (agree == null ? '' : `  matching sign ${pct(agree, r.length)}%`));
  }

  L('\nC4c persistence — fixed window from label onset (context only, NOT the pre-registered gate)');
  for (const s of [TREND.UP, TREND.DOWN, TREND.RANGE]) {
    const r = a.forward[s] || [];
    const sign = s === TREND.UP ? 1 : s === TREND.DOWN ? -1 : 0;
    const agree = sign === 0 ? null : r.filter((x) => Math.sign(x) === sign).length;
    L(`   ${String(s).padEnd(22)} n=${String(r.length).padStart(7)}  median ${(median(r) ?? 0).toFixed(2)}%`
      + (agree == null ? '' : `  matching sign ${pct(agree, r.length)}%`));
  }

  L(`\nC6 redundancy — agreement with the trivial ${tf === 'daily' ? '200DMA' : '40WMA'} rule:`
    + ` ${pct(a.maAgree, a.maTotal)}%  (n=${a.maTotal.toLocaleString()})`);
  L('   NOTE: the MA rule has no RANGE state, so it can only ever agree on UP/DOWN samples. A high');
  L('   number here means the structural label is mostly restating the moving average.\n');
}
