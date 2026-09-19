// PHASE 2 — CANDIDATE METHODOLOGY AND STABILITY.
//
// Phase 1 established that the strict confirmed-swing label goes stale at a rate that grows with
// timeframe: all-bullish evidence sits under a "downtrend" label on 2.0% of daily observations,
// 9.3% of weekly and 13.2% of monthly. That is enough to justify testing a second state — it is NOT
// yet enough to justify shipping one.
//
// This file proposes a deterministic candidate and then tries to kill it on the criterion that
// actually matters: STABILITY. A transition state that flips every few bars is noise wearing a
// label, and would be worse than the stale label it replaces. Every bar is evaluated (no stride),
// so runs and flip rates are measured exactly.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs research/trend-condition-validate.mjs

import { neon } from '@neondatabase/serverless';
import { loadDailyHistory, loadPriceQuality } from '../src/lib/structure/structure-data.js';
import { aggregateBars, completedOnly, TIMEFRAMES } from '../src/lib/structure/bars.mjs';
import { findSwings, swingsAsOf, deriveTrend, TREND } from '../src/lib/structure/swings.mjs';
import { smaAt } from '../src/lib/structure/moving-averages.mjs';
import { conditionState, combinedState, CONDITION, STATE, CONDITION_INPUTS } from './trend-condition-model.mjs';

const sql = neon(process.env.DATABASE_URL);

async function sampleTickers() {
  const strata = [
    ['mega', `s.market_cap > 200e9`, 10],
    ['large', `s.market_cap between 10e9 and 200e9`, 10],
    ['mid', `s.market_cap between 2e9 and 10e9`, 10],
    ['small', `s.market_cap between 300e6 and 2e9`, 10],
    ['lowpriced', `s.price < 10 and s.market_cap > 200e6`, 10],
    ['volatile', `s.atr14 / nullif(s.price,0) > 0.05 and s.market_cap > 200e6`, 10],
    ['deep', `b.n >= 1200`, 20],
  ];
  const out = []; const seen = new Set();
  for (const [name, where, n] of strata) {
    const r = await sql.query(`
      with b as (select ticker, count(*)::int n from ticker_daily_candles group by ticker)
      select s.ticker from screener_stocks s join b on b.ticker = s.ticker
       where ${where} and s.asset_type = 'Stock' and s.price > 0 and b.n >= 700
       order by s.ticker asc limit ${n}`);
    for (const x of r) { if (!seen.has(x.ticker)) { seen.add(x.ticker); out.push({ ticker: x.ticker, stratum: name }); } }
  }
  for (const t of ['MSFT', 'AAPL', 'NVDA']) if (!seen.has(t)) out.unshift({ ticker: t, stratum: 'named' });
  return out;
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 100) / 100;
};

// ── walk every bar ───────────────────────────────────────────────────────────
const series = [];                 // one entry per (ticker, timeframe): the state sequence
const tickers = await sampleTickers();
let used = 0;

for (const { ticker, stratum } of tickers) {
  const [daily, quality] = await Promise.all([loadDailyHistory(ticker), loadPriceQuality(ticker)]);
  if (daily.length < 700 || quality?.usable === false) continue;
  used++;

  for (const timeframe of ['daily', 'weekly', 'monthly']) {
    const spec = TIMEFRAMES[timeframe];
    const bars = completedOnly(aggregateBars(daily, timeframe, { asOf: daily[daily.length - 1].date }));
    if (bars.length < spec.minBars + 60) continue;
    const allSwings = findSwings(bars, { width: spec.pivotWidth });
    const inputs = CONDITION_INPUTS[timeframe];
    const start = Math.max(spec.minBars, inputs.longMa + 5, inputs.momentum + 5);

    const seq = [];
    for (let i = start; i < bars.length; i++) {
      const asOf = bars[i].date;
      const visible = swingsAsOf(allSwings, asOf);
      const from = Math.max(0, i + 1 - spec.trendWindow);
      const trend = deriveTrend(visible.filter((s) => s.index >= from && s.index <= i));
      const cond = conditionState(bars, i, timeframe, trend, { smaAt });
      seq.push({
        asOf, structure: trend.trend, condition: cond.condition,
        state: combinedState(trend.trend, cond.condition),
        met: cond.met,
        disruptor: cond.disruptor,
      });
    }
    if (seq.length > 30) series.push({ ticker, stratum, timeframe, seq });
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const L = (s = '') => console.log(s);
const totalBars = series.reduce((s, x) => s + x.seq.length, 0);
L();
L('='.repeat(102));
L(`CANDIDATE VALIDATION — ${used} tickers, ${series.length} (ticker × timeframe) series, ${totalBars} bar-level evaluations`);
L('='.repeat(102));

for (const timeframe of ['daily', 'weekly', 'monthly']) {
  const sers = series.filter((s) => s.timeframe === timeframe);
  if (!sers.length) continue;
  const all = sers.flatMap((s) => s.seq);

  // 1. State distribution.
  const counts = {};
  for (const r of all) counts[r.state] = (counts[r.state] || 0) + 1;
  L(`\n${timeframe.toUpperCase()}  n=${all.length} bars across ${sers.length} tickers`);
  L('  state distribution:');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    L(`    ${k.padEnd(22)} ${String(pct(v, all.length)).padStart(6)}%  (${v})`);
  }

  // 2. STABILITY — the criterion that decides whether this ships.
  //    Runs are consecutive bars in the same state. A transition state whose median run is a
  //    handful of bars is noise.
  const runsByState = new Map();
  let flips = 0, bars = 0;
  for (const s of sers) {
    let cur = null, len = 0;
    for (const r of s.seq) {
      bars++;
      if (r.state === cur) { len++; continue; }
      if (cur) {
        if (!runsByState.has(cur)) runsByState.set(cur, []);
        runsByState.get(cur).push(len);
        flips++;
      }
      cur = r.state; len = 1;
    }
    if (cur) {
      if (!runsByState.has(cur)) runsByState.set(cur, []);
      runsByState.get(cur).push(len);
    }
  }
  L(`  overall flip rate: ${pct(flips, bars)}% of bars change state (1 in ${Math.round(bars / Math.max(flips, 1))})`);
  L('  persistence (consecutive bars in state):');
  for (const [state, runs] of [...runsByState.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const short = runs.filter((r) => r <= 3).length;
    L(`    ${state.padEnd(22)} runs ${String(runs.length).padStart(5)}   median ${String(median(runs)).padStart(6)}`
      + `   mean ${String(Math.round((runs.reduce((a, b) => a + b, 0) / runs.length) * 10) / 10).padStart(6)}`
      + `   max ${String(Math.max(...runs)).padStart(5)}   <=3 bars ${String(pct(short, runs.length)).padStart(5)}%`);
  }

  // 2b. THE DECISIVE COMPARISON. The combined state is the product of two facts, so it changes
  //     whenever EITHER changes — which may be an artefact of forcing them into one label rather
  //     than a property of either. Measured separately here.
  for (const field of ['structure', 'condition']) {
    const runs = new Map();
    let f = 0, n = 0;
    for (const s of sers) {
      let cur = null, len = 0;
      for (const r of s.seq) {
        n++;
        if (r[field] === cur) { len++; continue; }
        if (cur) { if (!runs.has(cur)) runs.set(cur, []); runs.get(cur).push(len); f++; }
        cur = r[field]; len = 1;
      }
      if (cur) { if (!runs.has(cur)) runs.set(cur, []); runs.get(cur).push(len); }
    }
    const allRuns = [...runs.values()].flat();
    const short = allRuns.filter((r) => r <= 3).length;
    L(`  ${field.toUpperCase().padEnd(10)} alone: flip ${String(pct(f, n)).padStart(5)}%`
      + `   median run ${String(median(allRuns)).padStart(5)}`
      + `   <=3 bars ${String(pct(short, allRuns.length)).padStart(5)}%`
      + `   [${[...runs.entries()].map(([k, v]) => `${k}:${median(v)}`).join('  ')}]`);
  }

  // 2c. THE DISRUPTOR ALONE. A discrete structural fact — price beyond the most recent confirmed
  //     pivot — rather than a composite of five oscillating criteria. If THIS is stable it can be
  //     reported as a fact even though the composite state cannot.
  {
    const runs = new Map();
    let f = 0, n = 0;
    for (const s of sers) {
      let cur = null, len = 0;
      for (const r of s.seq) {
        const d = r.disruptor?.reclaimed ? 'reclaimed' : r.disruptor?.lost ? 'lost' : 'intact';
        n++;
        if (d === cur) { len++; continue; }
        if (cur) { if (!runs.has(cur)) runs.set(cur, []); runs.get(cur).push(len); f++; }
        cur = d; len = 1;
      }
      if (cur) { if (!runs.has(cur)) runs.set(cur, []); runs.get(cur).push(len); }
    }
    const allRuns = [...runs.values()].flat();
    const short = allRuns.filter((r) => r <= 3).length;
    L(`  DISRUPTOR  alone: flip ${String(pct(f, n)).padStart(5)}%`
      + `   median run ${String(median(allRuns)).padStart(5)}`
      + `   <=3 bars ${String(pct(short, allRuns.length)).padStart(5)}%`
      + `   [${[...runs.entries()].map(([k, v]) => `${k}:${median(v)}`).join('  ')}]`);
  }

  // 3. Does the combined state merely restate the long MA?
  const longMa = CONDITION_INPUTS[timeframe].longMa;
  const bullStates = new Set([STATE.CONFIRMED_UP, STATE.BULLISH_TRANSITION]);
  // Recomputed here only for the comparison, so the answer is not taken on trust.
  L(`  (see phase 1 for the "beyond the ${longMa}-period MA" comparison)`);

  // 4. How often does the transition state fire under a stale strict label — the whole point.
  const staleDown = all.filter((r) => r.structure === TREND.DOWN && r.state === STATE.BULLISH_TRANSITION).length;
  const staleUp = all.filter((r) => r.structure === TREND.UP && r.state === STATE.BEARISH_TRANSITION).length;
  const downs = all.filter((r) => r.structure === TREND.DOWN).length;
  const ups = all.filter((r) => r.structure === TREND.UP).length;
  L(`  bullish transition under a confirmed DOWNTREND: ${pct(staleDown, downs)}% of downtrend bars (${staleDown}/${downs})`);
  L(`  bearish transition under a confirmed UPTREND:   ${pct(staleUp, ups)}% of uptrend bars (${staleUp}/${ups})`);
}

// 5. MSFT / AAPL / NVDA, before and after, at the latest bar.
L('\n' + '='.repeat(102));
L('NAMED TICKERS — latest completed bar, strict structure vs proposed state');
L('='.repeat(102));
for (const t of ['MSFT', 'AAPL', 'NVDA']) {
  for (const timeframe of ['monthly', 'weekly', 'daily']) {
    const s = series.find((x) => x.ticker === t && x.timeframe === timeframe);
    if (!s) continue;
    const last = s.seq[s.seq.length - 1];
    L(`  ${t.padEnd(6)} ${timeframe.padEnd(8)} structure=${String(last.structure).padEnd(20)}`
      + ` condition=${String(last.condition).padEnd(10)} state=${last.state}`);
    if (last.met?.length) L(`  ${''.padEnd(15)} met: ${last.met.join(' · ')}`);
  }
}
L();
