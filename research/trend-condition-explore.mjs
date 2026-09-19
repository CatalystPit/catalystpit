// PHASE 1 — EXPLORATION. Does the strict confirmed-swing label go stale often enough to justify a
// second state, or is MSFT monthly a one-off?
//
// Deliberately measures BEFORE proposing anything. No state machine exists yet, no thresholds are
// chosen. This walks a deterministic stratified sample point-in-time, records the strict label
// alongside raw condition evidence, and reports the joint distribution. The thresholds for any
// proposed state come AFTER looking at these numbers, not before.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs research/trend-condition-explore.mjs

import { neon } from '@neondatabase/serverless';
import { loadDailyHistory, loadPriceQuality } from '../src/lib/structure/structure-data.js';
import { aggregateBars, completedOnly, TIMEFRAMES, atr } from '../src/lib/structure/bars.mjs';
import { findSwings, swingsAsOf, deriveTrend, TREND } from '../src/lib/structure/swings.mjs';
import { smaAt } from '../src/lib/structure/moving-averages.mjs';

const sql = neon(process.env.DATABASE_URL);

/** Stride between samples, per timeframe, in that timeframe's own bars. */
const STRIDE = { daily: 20, weekly: 8, monthly: 3 };
/** The MA periods used as condition evidence, per timeframe. Same sets as the engine. */
const MAS = { daily: [20, 50, 200], weekly: [10, 30, 40], monthly: [10, 20] };
/** Momentum lookbacks in that timeframe's bars. */
const MOM = { daily: [20, 63, 126, 252], weekly: [4, 13, 26, 52], monthly: [3, 6, 12] };

// ── deterministic stratified sample ──────────────────────────────────────────
// Ordered by ticker so the sample is reproducible, stratified so the result is not just mega-caps.
async function sampleTickers() {
  // ⚠️ HISTORY DEPTH IS THE BINDING CONSTRAINT, not breadth. Only 7 stocks in our data hold 10+
  // years of daily bars and 13 more hold 5-10 years; 971 hold 3-5. So the sample is drawn from
  // tickers with at least 700 sessions, and MONTHLY conclusions are necessarily thin — 757 daily
  // bars is 36 monthly bars, which barely reaches the engine's own minimum. Reported, not hidden.
  const strata = [
    ['mega', `s.market_cap > 200e9`, 10],
    ['large', `s.market_cap between 10e9 and 200e9`, 10],
    ['mid', `s.market_cap between 2e9 and 10e9`, 10],
    ['small', `s.market_cap between 300e6 and 2e9`, 10],
    ['lowpriced', `s.price < 10 and s.market_cap > 200e6`, 10],
    ['volatile', `s.atr14 / nullif(s.price,0) > 0.05 and s.market_cap > 200e6`, 10],
    ['deep', `b.n >= 1200`, 20],
  ];
  const out = [];
  const seen = new Set();
  for (const [name, where, n] of strata) {
    const r = await sql.query(`
      with b as (select ticker, count(*)::int n from ticker_daily_candles group by ticker)
      select s.ticker from screener_stocks s join b on b.ticker = s.ticker
       where ${where} and s.asset_type = 'Stock' and s.price > 0 and b.n >= 700
       order by s.ticker asc limit ${n}`);
    for (const x of r) {
      if (seen.has(x.ticker)) continue;
      seen.add(x.ticker);
      out.push({ ticker: x.ticker, stratum: name });
    }
  }
  // Always include the three the report must cover.
  for (const t of ['MSFT', 'AAPL', 'NVDA']) {
    if (!out.some((o) => o.ticker === t)) out.unshift({ ticker: t, stratum: 'named' });
  }
  return out;
}

/**
 * Raw condition evidence at bar index i. No scoring, no labels — just the measurements.
 */
export function conditionEvidence(bars, i, timeframe, trend) {
  const close = bars[i].close;
  const mas = {};
  for (const p of MAS[timeframe]) {
    const now = smaAt(bars, p, i);
    const prev = smaAt(bars, p, i - Math.max(3, Math.round(p / 4)));
    mas[p] = now == null ? null : {
      value: now,
      above: close > now,
      slope: prev == null ? null : (now - prev) / prev,
    };
  }
  const mom = {};
  for (const k of MOM[timeframe]) {
    const then = bars[i - k]?.close;
    mom[k] = then > 0 ? (close - then) / then : null;
  }
  // Distance travelled since the pivot the strict label is anchored on.
  let sincePivot = null, barsSince = null;
  if (trend.pivotIndex != null && bars[trend.pivotIndex]) {
    const p = bars[trend.pivotIndex].close;
    sincePivot = p > 0 ? (close - p) / p : null;
    barsSince = i - trend.pivotIndex;
  }
  // Has price closed back above the last confirmed swing HIGH (a reclaim), or below the last
  // confirmed swing LOW (a breakdown)? These are structural facts the swing SEQUENCE does not carry.
  const reclaimedLastHigh = trend.lastHigh ? close > trend.lastHigh.price : null;
  const lostLastLow = trend.lastLow ? close < trend.lastLow.price : null;

  return { close, mas, mom, sincePivot, barsSince, reclaimedLastHigh, lostLastLow };
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// ── walk ─────────────────────────────────────────────────────────────────────
const rowsOut = [];
const tickers = await sampleTickers();
let used = 0, skipped = 0;

for (const { ticker, stratum } of tickers) {
  const [daily, quality] = await Promise.all([loadDailyHistory(ticker), loadPriceQuality(ticker)]);
  if (daily.length < 700 || quality?.usable === false) { skipped++; continue; }
  used++;

  for (const timeframe of ['daily', 'weekly', 'monthly']) {
    const spec = TIMEFRAMES[timeframe];
    const bars = completedOnly(aggregateBars(daily, timeframe, { asOf: daily[daily.length - 1].date }));
    if (bars.length < spec.minBars + 60) continue;
    const width = spec.pivotWidth;
    const allSwings = findSwings(bars, { width });
    const start = Math.max(spec.minBars, Math.max(...MAS[timeframe]) + 5, Math.max(...MOM[timeframe]) + 5);

    for (let i = start; i < bars.length; i += STRIDE[timeframe]) {
      const asOf = bars[i].date;
      // POINT IN TIME: only pivots confirmed by this bar, and only inside the trend window.
      const visible = swingsAsOf(allSwings, asOf);
      const from = Math.max(0, i + 1 - spec.trendWindow);
      const recent = visible.filter((s) => s.index >= from && s.index <= i);
      const trend = deriveTrend(recent);
      const ev = conditionEvidence(bars, i, timeframe, trend);
      rowsOut.push({ ticker, stratum, timeframe, asOf, i, strict: trend.trend, ...ev });
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const L = (s = '') => console.log(s);
L();
L('='.repeat(100));
L(`EXPLORATION — ${used} tickers (${skipped} skipped), ${rowsOut.length} point-in-time observations`);
L('='.repeat(100));

// 1. How common is each strict label?
for (const timeframe of ['daily', 'weekly', 'monthly']) {
  const rows = rowsOut.filter((r) => r.timeframe === timeframe);
  if (!rows.length) continue;
  const counts = {};
  for (const r of rows) counts[r.strict] = (counts[r.strict] || 0) + 1;
  L(`\n${timeframe.toUpperCase()}  n=${rows.length}`);
  L('  strict label distribution: '
    + Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${pct(v, rows.length)}%`).join('   '));

  // 2. THE STALENESS QUESTION. Within each strict label, how does the other evidence look?
  for (const label of [TREND.DOWN, TREND.UP, TREND.RANGE]) {
    const sub = rows.filter((r) => r.strict === label);
    if (sub.length < 20) continue;
    const longMa = Math.max(...MAS[timeframe]);
    const midMa = MAS[timeframe][1];
    const aboveLong = sub.filter((r) => r.mas[longMa]?.above).length;
    const aboveMid = sub.filter((r) => r.mas[midMa]?.above).length;
    const risingMid = sub.filter((r) => (r.mas[midMa]?.slope ?? 0) > 0.002).length;
    const bigUp = sub.filter((r) => (r.sincePivot ?? 0) > 0.20).length;
    const bigDown = sub.filter((r) => (r.sincePivot ?? 0) < -0.20).length;
    const reclaim = sub.filter((r) => r.reclaimedLastHigh === true).length;
    const lost = sub.filter((r) => r.lostLastLow === true).length;
    // The specific shape the brief describes: a downtrend label while every other signal is bullish.
    const contraBull = sub.filter((r) => r.mas[longMa]?.above && r.mas[midMa]?.above
      && (r.mas[midMa]?.slope ?? 0) > 0.002 && (r.sincePivot ?? 0) > 0.15).length;
    const contraBear = sub.filter((r) => r.mas[longMa]?.above === false && r.mas[midMa]?.above === false
      && (r.mas[midMa]?.slope ?? 0) < -0.002 && (r.sincePivot ?? 0) < -0.15).length;

    L(`  ${label.padEnd(20)} n=${String(sub.length).padStart(5)}`
      + `  >long ${String(pct(aboveLong, sub.length)).padStart(5)}%`
      + `  >mid ${String(pct(aboveMid, sub.length)).padStart(5)}%`
      + `  midRising ${String(pct(risingMid, sub.length)).padStart(5)}%`
      + `  +20% since pivot ${String(pct(bigUp, sub.length)).padStart(5)}%`
      + `  -20% ${String(pct(bigDown, sub.length)).padStart(5)}%`);
    L(`  ${''.padEnd(20)}       reclaimed last high ${String(pct(reclaim, sub.length)).padStart(5)}%`
      + `  lost last low ${String(pct(lost, sub.length)).padStart(5)}%`
      + `  ALL-BULLISH-CONTRA ${String(pct(contraBull, sub.length)).padStart(5)}%`
      + `  ALL-BEARISH-CONTRA ${String(pct(contraBear, sub.length)).padStart(5)}%`);
  }
}

// 3. Does condition evidence just restate the long MA? If "price above the long MA" and the
//    proposed bullish-contra condition always coincide, the second state adds nothing.
L('\n' + '='.repeat(100));
L('DOES CONDITION EVIDENCE ADD ANYTHING BEYOND "PRICE vs LONG MA"?');
L('='.repeat(100));
for (const timeframe of ['daily', 'weekly', 'monthly']) {
  const rows = rowsOut.filter((r) => r.timeframe === timeframe && r.strict !== TREND.UNKNOWN);
  if (rows.length < 50) continue;
  const longMa = Math.max(...MAS[timeframe]);
  const agree = rows.filter((r) => {
    const maBull = !!r.mas[longMa]?.above;
    const strictBull = r.strict === TREND.UP;
    return maBull === strictBull;
  }).length;
  L(`${timeframe.padEnd(9)} strict label agrees with "above ${longMa}-period MA" ${pct(agree, rows.length)}% of the time (n=${rows.length})`);
}

// 4. Raw dump of the most extreme contradictions, for eyeballing.
L('\n' + '='.repeat(100));
L('MOST EXTREME CONTRADICTIONS (strict downtrend, price far above a rising long MA)');
L('='.repeat(100));
const contra = rowsOut
  .filter((r) => r.strict === TREND.DOWN)
  .map((r) => {
    const longMa = Math.max(...MAS[r.timeframe]);
    const m = r.mas[longMa];
    return m?.above ? { ...r, over: (r.close - m.value) / m.value } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.over - a.over)
  .slice(0, 12);
for (const r of contra) {
  L(`  ${r.ticker.padEnd(6)} ${r.timeframe.padEnd(8)} ${r.asOf}  close ${r.close.toFixed(2).padStart(9)}`
    + `  +${(r.over * 100).toFixed(0)}% over long MA`
    + `  sincePivot ${r.sincePivot == null ? '—' : (r.sincePivot * 100).toFixed(0) + '%'}`
    + `  reclaimedHigh=${r.reclaimedLastHigh}`);
}
L();
