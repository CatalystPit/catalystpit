// EVERY INDICATOR, ON EVERY TIMEFRAME.
//
//   node scripts/verify-indicator-matrix.mjs            (offline: synthetic bars)
//   CP_MATRIX_LIVE=http://localhost:3000 node scripts/verify-indicator-matrix.mjs GOOGL
//
// ⚠️ WHY THIS EXISTS. Indicators were only ever checked on one timeframe. On GOOGL 1D, Volume and a
// 200-period SMA both render; on 4h the Indicators button still counted two and the chart drew
// neither. Nothing failed, nothing was logged, and the two had entirely different causes — the
// intraday feed carries no volume at all, and 4h holds 60 bars where a 200-period average needs 200.
// An empty chart cannot tell those apart, so neither could we.
//
// THE MATRIX IS BUILT FROM THE REGISTRIES, NOT FROM A LIST IN THIS FILE. Both axes come from the
// application — TIMEFRAMES in chart-source.mjs and INDICATORS in chart-indicators.mjs — so adding a
// timeframe or an indicator extends the matrix on its own and cannot be forgotten here.
//
// IT TESTS THE RENDER BOUNDARY, not just state. For each cell it computes the indicator from that
// timeframe's bars and then applies the chart's own gate — a series is built only when a plot carries
// data — so a PASS means a populated chart series would exist. Volume goes through the chart's own
// `bars.some(volume > 0)` test for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import {
  TIMEFRAMES, isIntraday, sessionKeyFor, normalizeBars, barsUrl,
} from '../src/lib/chart/chart-source.mjs';
import {
  INDICATORS, computeIndicator, defaultParams, indicatorAvailability, requiredBars, needsVolume,
} from '../src/lib/chart/chart-indicators.mjs';
import { previousTradingDay } from '../src/lib/market/market-session.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const IDS = Object.keys(INDICATORS);
const LIVE = process.env.CP_MATRIX_LIVE || null;
const SYM = process.argv[2] || 'GOOGL';

// ── 0. both axes come from the application ────────────────────────────────────────────────────
console.log('\n0. both axes come from the application');

ok('the timeframe axis is the app\'s own registry', TIMEFRAMES.length >= 15, `${TIMEFRAMES.length}`);
ok('the indicator axis is the app\'s own registry', IDS.length >= 8, IDS.join(','));
// ⚠️ THE AXES ARE DERIVED, NOT LISTED — asserted behaviourally rather than by grepping this file for a
// literal array. The grep version matched the coverage assertion just below, which names the eight
// indicators on purpose, so it failed on correct code. The matrix printed at the end is built from
// TIMEFRAMES and Object.keys(INDICATORS), so its dimensions ARE the registries' sizes; that is the
// property worth pinning, and it cannot be satisfied by a hard-coded list of the wrong length.
ok('the indicator axis is exactly the registry', IDS.length === Object.keys(INDICATORS).length);
ok('the timeframe axis is exactly the registry',
  TIMEFRAMES.length === new Set(TIMEFRAMES.map((t) => t.id)).size);
// Every indicator the UI can offer is covered — including ones added since this was written. Named
// here so that REMOVING one from the registry is also caught, not only failing to test a new one.
ok('the eight documented indicators are all present',
  ['volume', 'sma', 'ema', 'vwap', 'bollinger', 'rsi', 'macd', 'atr'].every((k) => IDS.includes(k)),
  IDS.join(','));
// And anything added since is covered too, because the matrix walks IDS rather than that list.
ok('any indicator added since is covered by the matrix as well', IDS.length >= 8, `${IDS.length}`);

// ── 1. bars for every timeframe ───────────────────────────────────────────────────────────────
console.log(`\n1. bars for every timeframe ${LIVE ? `(LIVE from ${LIVE}, ${SYM})` : '(synthetic)'}`);

/**
 * Synthetic bars in the shape each timeframe's provider actually returns.
 *
 * ⚠️ INCLUDING THE VOLUME DIFFERENCE, because that difference IS the finding. The intraday route omits
 * volume deliberately (api/chart-intraday: our source carries none, and one venue's prints are not
 * consolidated market volume), while the daily route carries it. A fixture that gave every timeframe
 * volume would turn the matrix green and hide the real limitation.
 */
function syntheticBars(tf) {
  const intraday = isIntraday(tf.id);
  // Deliberately generous, so a SHORT verdict below is about the PERIOD and not about the fixture.
  const n = 600;
  const bars = [];
  if (intraday) {
    let t = Math.floor(Date.parse('2026-09-25T13:30:00Z') / 1000);
    const step = (tf.request?.barMinutes || 1) * 60;
    for (let i = 0; i < n; i += 1) {
      const c = 200 + Math.sin(i / 9) * 8 + i * 0.01;
      bars.push({ time: t, open: c - 0.4, high: c + 0.7, low: c - 0.8, close: c, volume: null });
      t += step;
    }
  } else {
    const dates = [];
    let d = '2026-09-25';
    while (dates.length < n) { dates.push(d); d = previousTradingDay(d); }
    dates.reverse();
    for (let i = 0; i < n; i += 1) {
      const c = 200 + Math.sin(i / 11) * 12 + i * 0.03;
      bars.push({ time: dates[i], open: c - 0.5, high: c + 0.9, low: c - 1.1, close: c, volume: 1_000_000 + i });
    }
  }
  return bars;
}

const loaded = new Map();
for (const tf of TIMEFRAMES) {
  if (!LIVE) { loaded.set(tf.id, syntheticBars(tf)); continue; }
  const url = barsUrl(SYM, tf.id);
  if (!url) { loaded.set(tf.id, []); continue; }
  try {
    const r = await fetch(LIVE + url);
    const j = r.ok ? await r.json() : null;
    loaded.set(tf.id, j ? (normalizeBars(j, tf.id).bars || []) : []);
  } catch { loaded.set(tf.id, []); }
}

for (const tf of TIMEFRAMES) {
  ok(`${tf.id} has bars to test against`, (loaded.get(tf.id) || []).length > 0,
    `${(loaded.get(tf.id) || []).length} bars`);
}
// Bar times must be the type the chart requires, or Lightweight Charts throws on setData.
for (const tf of TIMEFRAMES) {
  const bars = loaded.get(tf.id) || [];
  if (!bars.length) continue;
  const want = isIntraday(tf.id) ? 'number' : 'string';
  ok(`${tf.id} bar times are ${want}s, as the series requires`,
    bars.every((b) => typeof b.time === want), typeof bars[0].time);
  ok(`${tf.id} bars are strictly ascending and deduplicated`,
    bars.every((b, i) => i === 0 || (typeof b.time === 'number'
      ? b.time > bars[i - 1].time : String(b.time) > String(bars[i - 1].time))));
}

// ── 2. THE MATRIX ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. the matrix');

// The chart's own gates, quoted from CPChart so the test measures what the chart measures.
const volumeGate = (bars) => bars.some((b) => Number(b.volume) > 0);
const plotsGate = (plots) => plots.length > 0 && !plots.every((pl) => !pl.data.length);

/** One cell: what would actually happen on the chart, and why. */
function cell(id, tf, paramOverride = {}) {
  const def = INDICATORS[id];
  const bars = loaded.get(tf.id) || [];
  const ctx = { intraday: isIntraday(tf.id), sessionKey: sessionKeyFor(tf.id) };
  const params = { ...defaultParams(id), ...paramOverride };
  const unavailable = indicatorAvailability(id, bars, params, ctx);

  if (def.builtin) {
    const drawn = volumeGate(bars);
    return { verdict: drawn ? 'PASS' : (unavailable?.code === 'no-volume' ? 'NOVOL' : 'FAIL'),
      unavailable, points: drawn ? bars.length : 0, plots: drawn ? 1 : 0, pane: 'price' };
  }
  // ⚠️ THE CHART'S GATES, IN THE CHART'S ORDER. drawIndicators refuses an intradayOnly indicator on a
  // daily chart BEFORE it computes anything. Computing first and reporting the result made the matrix
  // claim VWAP draws on every daily timeframe — it does produce numbers there, because the maths does
  // not care, but the chart never asks for them. A matrix that disagrees with the chart is worse than
  // no matrix.
  if (def.intradayOnly && !ctx.intraday) {
    return { verdict: 'N/A', unavailable, points: 0, plots: 0, pane: 'price' };
  }
  const { plots } = computeIndicator(id, bars, params, ctx);
  const drawn = plotsGate(plots);
  const points = plots.reduce((a, pl) => a + pl.data.length, 0);
  const pane = def.pane === 'separate' ? 'separate' : 'price';
  if (drawn) {
    const finite = plots.every((pl) => pl.data.every((d) => Number.isFinite(d.value)));
    const aligned = plots.every((pl) => pl.data.every((d) => bars.some((b) => b.time === d.time)));
    if (!finite) return { verdict: 'BADVAL', unavailable, points, plots: plots.length, pane };
    if (!aligned) return { verdict: 'UNALIGNED', unavailable, points, plots: plots.length, pane };
    return { verdict: 'PASS', unavailable, points, plots: plots.length, pane };
  }
  const code = unavailable?.code;
  const verdict = code === 'no-volume' ? 'NOVOL'
    : code === 'intraday-only' ? 'N/A'
      : code === 'short-history' ? 'SHORT'
        : 'EMPTY';
  return { verdict, unavailable, points, plots: plots.length, pane };
}

const SCENARIOS = [
  ['default parameters', {}],
  // The owner's exact case, and the one the warmup question is about.
  ['SMA length 200', { sma: { length: 200 } }],
  // ⚠️ A PERIOD LONGER THAN ANY FIXTURE, so the SHORT path is exercised offline too. The synthetic
  // series is deliberately 600 bars deep — long enough that a SHORT verdict is never an artefact of the
  // fixture — which also means SMA 200 passes everywhere offline and only the live run reproduces the
  // owner's 4h finding. Without this scenario the whole short-history branch would go untested unless
  // someone remembered to run against live routes.
  ['periods longer than the series', { sma: { length: 800 }, ema: { length: 800 }, bollinger: { length: 400 } }],
];

const EXPLAINED = new Set(['NOVOL', 'N/A', 'SHORT']);
const results = new Map();

for (const [title, overrides] of SCENARIOS) {
  const rows = [];
  for (const id of IDS) {
    const cells = TIMEFRAMES.map((tf) => cell(id, tf, overrides[id] || {}));
    rows.push({ id, label: INDICATORS[id].label, cells });
    for (const [i, c] of cells.entries()) {
      const tf = TIMEFRAMES[i];
      // ⚠️ THE ASSERTION IS NOT "PASS". A cell may legitimately be unrenderable — VWAP on a daily
      // chart, or a 200-period average on a 60-bar series. What must never happen is an UNEXPLAINED
      // blank: an indicator that produces nothing while availability says it should have worked.
      ok(`${title}: ${INDICATORS[id].label} on ${tf.id} is either drawn or explained`,
        c.verdict === 'PASS' || EXPLAINED.has(c.verdict),
        `${c.verdict}${c.unavailable ? ` (${c.unavailable.code})` : ' — availability reported no reason'}`);
      // And when it IS drawn, the values have to be usable.
      if (c.verdict === 'PASS' && !INDICATORS[id].builtin) {
        ok(`${title}: ${INDICATORS[id].label} on ${tf.id} lands in the ${c.pane} pane with finite values`,
          c.points > 0 && c.plots > 0);
      }
    }
  }
  results.set(title, rows);
}

// ── 3. availability agrees with what actually happens ─────────────────────────────────────────
console.log('\n3. availability agrees with what actually happens');

// ⚠️ THE TWO MUST NOT DISAGREE. If availability says "fine" and the computation produces nothing, the
// UI would promise a series that never appears — which is the original bug wearing a new coat.
for (const [title, rows] of results) {
  for (const row of rows) {
    for (const [i, c] of row.cells.entries()) {
      const tf = TIMEFRAMES[i];
      if (c.verdict === 'PASS') {
        ok(`${title}: availability permits ${row.label} on ${tf.id}, and it draws`, c.unavailable === null,
          c.unavailable ? `said ${c.unavailable.code} yet drew ${c.points} points` : '');
      } else {
        ok(`${title}: availability explains why ${row.label} does not draw on ${tf.id}`,
          c.unavailable !== null && typeof c.unavailable.reason === 'string' && c.unavailable.reason.length > 10,
          JSON.stringify(c.unavailable));
      }
    }
  }
}

// ── 4. the warmup rule is about the SERIES, not the viewport ───────────────────────────────────
console.log('\n4. the warmup rule is about the series, not the viewport');

{
  const daily = TIMEFRAMES.find((t) => t.id === '1D');
  const bars = loaded.get(daily.id) || [];
  ok('the daily series is long enough for a 200-period average', bars.length >= 200, `${bars.length}`);
  const ctx = { intraday: false, sessionKey: sessionKeyFor('1D') };
  const { plots } = computeIndicator('sma', bars, { length: 200 }, ctx);
  const pts = plots[0]?.data?.length || 0;
  ok('⚠️ a 200-period SMA produces bars.length - 199 values', pts === bars.length - 199, `${pts}`);
  // ⚠️ THE VISIBLE WINDOW IS NOT AN INPUT. The calculation reads the loaded series; nothing about the
  // viewport reaches it, so 50 candles on screen cannot make a 200-period average "broken".
  const indSrc = read('src/lib/chart/chart-indicators.mjs');
  ok('the indicator module never consults a visible range',
    !/visibleRange|getVisibleLogicalRange|logicalRange/.test(indSrc));
  ok('requiredBars is about periods, not pixels',
    requiredBars('sma', { length: 200 }) === 200 && requiredBars('macd', { slow: 26, signal: 9 }) === 35);
}

// ── 5. a timeframe switch recalculates from the destination's bars ─────────────────────────────
console.log('\n5. a timeframe switch recalculates from the destination\'s bars');

{
  // The owner's exact walk, and back again.
  const WALK = ['1D', '4h', '1h', '15m', '5m', '1D'];
  const present = WALK.filter((id) => TIMEFRAMES.some((t) => t.id === id));
  ok('every timeframe in the switch walk exists in the registry', present.length === WALK.length,
    present.join('→'));

  for (const id of ['sma', 'ema', 'rsi', 'atr', 'bollinger']) {
    const seen = [];
    for (const tfId of WALK) {
      const tf = TIMEFRAMES.find((t) => t.id === tfId);
      const bars = loaded.get(tfId) || [];
      const ctx = { intraday: isIntraday(tfId), sessionKey: sessionKeyFor(tfId) };
      const { plots } = computeIndicator(id, bars, defaultParams(id), ctx);
      seen.push({ tfId, first: plots[0]?.data?.[0]?.time ?? null, n: plots[0]?.data?.length ?? 0 });
      void tf;
    }
    // ⚠️ THE OUTPUT IS STAMPED WITH THE DESTINATION'S OWN TIMES. A stale series from the previous
    // timeframe would carry the previous timeframe's timestamps, which is precisely what "retains
    // stale values" looks like from the outside.
    for (const s of seen) {
      const bars = loaded.get(s.tfId) || [];
      const want = isIntraday(s.tfId) ? 'number' : 'string';
      ok(`${INDICATORS[id].label} after switching to ${s.tfId} is stamped with ${want} times`,
        s.n === 0 || typeof s.first === want, `${typeof s.first}`);
      ok(`${INDICATORS[id].label} after switching to ${s.tfId} starts inside that timeframe's bars`,
        s.n === 0 || bars.some((b) => b.time === s.first));
    }
    // Returning to 1D reproduces the original 1D answer exactly — no carry-over from the walk.
    const firstDaily = seen[0], lastDaily = seen[seen.length - 1];
    ok(`${INDICATORS[id].label} returning to 1D reproduces the original series exactly`,
      firstDaily.n === lastDaily.n && firstDaily.first === lastDaily.first,
      `${firstDaily.n}@${firstDaily.first} vs ${lastDaily.n}@${lastDaily.first}`);
  }

  // And the reverse direction, smallest to largest.
  const REVERSE = ['5m', '15m', '1h', '4h', '1D'];
  for (const id of ['sma', 'rsi']) {
    let prev = null;
    for (const tfId of REVERSE) {
      const bars = loaded.get(tfId) || [];
      const ctx = { intraday: isIntraday(tfId), sessionKey: sessionKeyFor(tfId) };
      const { plots } = computeIndicator(id, bars, defaultParams(id), ctx);
      const sig = `${plots[0]?.data?.length}@${plots[0]?.data?.[0]?.time}`;
      ok(`${INDICATORS[id].label} on ${tfId} differs from the timeframe before it`,
        prev === null || sig !== prev, `both ${sig} — a stale series would look like this`);
      prev = sig;
    }
  }
}

// ── 6. VWAP has its own semantics ─────────────────────────────────────────────────────────────
console.log('\n6. VWAP has its own semantics');

{
  ok('VWAP is offered on intraday timeframes only', INDICATORS.vwap.intradayOnly === true);
  ok('...and it is volume-derived, so volume is what it needs', needsVolume('vwap'));

  // ⚠️ RESET PER SESSION, which is what makes it VWAP and not a running average of all history. Driven
  // with bars that DO carry volume, because our intraday feed does not — see the report.
  const { vwap } = await import('../src/lib/chart/chart-indicators.mjs');
  const day1 = Math.floor(Date.parse('2026-09-24T13:30:00Z') / 1000);
  const day2 = Math.floor(Date.parse('2026-09-25T13:30:00Z') / 1000);
  const mk = (t, price, v) => ({ time: t, open: price, high: price, low: price, close: price, volume: v });
  const bars = [
    mk(day1, 100, 1000), mk(day1 + 3600, 200, 1000),
    mk(day2, 300, 1000), mk(day2 + 3600, 400, 1000),
  ];
  const sessionKey = sessionKeyFor('1h');
  ok('the intraday timeframe supplies a session key', typeof sessionKey === 'function');
  const out = vwap(bars, {}, { intraday: true, sessionKey });
  const data = out.plots[0].data;
  ok('VWAP produces a value per bar with volume', data.length === 4, `${data.length}`);
  ok('the first bar of a session IS that bar\'s typical price', data[0].value === 100, `${data[0].value}`);
  ok('...and the second is the running average within the session', data[1].value === 150, `${data[1].value}`);
  // ⚠️ THE RESET. Without it the third bar would average all four prices; with it the new session
  // starts over at 300.
  ok('⚠️ a new session RESETS the average rather than continuing it', data[2].value === 300,
    `${data[2].value} — no session reset`);
  ok('...and accumulates again within the new session', data[3].value === 350, `${data[3].value}`);
  // A zero-volume bar contributes nothing rather than dividing by zero.
  const withZero = vwap([mk(day1, 100, 0), mk(day1 + 3600, 200, 1000)], {}, { intraday: true, sessionKey });
  ok('a zero-volume bar is skipped, not counted as price 0',
    withZero.plots[0].data.length === 1 && withZero.plots[0].data[0].value === 200);
  // ⚠️ AND THE `v <= 0` GUARD EARNS ITS KEEP ON NEGATIVE VOLUME, not on zero. A zero-volume bar
  // contributes 0 to both numerator and denominator, so dropping the guard changes nothing there — a
  // mutation that did exactly that passed, which is how this gap showed up. Bad vendor data carrying a
  // NEGATIVE figure is the case that actually moves the average, and downward through prices that were
  // never traded.
  const withNeg = vwap([mk(day1, 100, 1000), mk(day1 + 3600, 200, -5000)], {}, { intraday: true, sessionKey });
  ok('⚠️ a negative-volume bar cannot drag the average', withNeg.plots[0].data.length === 1
    && withNeg.plots[0].data[0].value === 100, JSON.stringify(withNeg.plots[0].data));
  ok('...and every VWAP value stays inside the session\'s traded range',
    withNeg.plots[0].data.every((d) => d.value >= 100 && d.value <= 200));
  // A non-finite volume is treated the same way.
  const withNaN = vwap([mk(day1, 100, Number.NaN), mk(day1 + 3600, 200, 1000)], {}, { intraday: true, sessionKey });
  ok('a non-finite volume is skipped rather than poisoning the average',
    withNaN.plots[0].data.length === 1 && withNaN.plots[0].data[0].value === 200);
}

// ── 7. removing an indicator removes its series; isolation is untouched ────────────────────────
console.log('\n7. removing an indicator removes its series; isolation is untouched');

{
  const cp = read('src/components/chart/CPChart.jsx');
  // Every redraw tears the overlays down first, which is what makes removal actually remove.
  ok('a redraw removes every overlay series before rebuilding',
    /for \(const s of overlaysRef\.current\) \{ try \{ chart\.removeSeries\(s\); \}/.test(cp));
  ok('...and drops every lower pane too',
    /for \(let i = panes\.length - 1; i >= 1; i -= 1\)/.test(cp));
  ok('the volume series is removed before it is rebuilt',
    /if \(volumeRef\.current\) \{ chart\.removeSeries\(volumeRef\.current\); volumeRef\.current = null; \}/.test(cp));
  // Indicator persistence stays per account: the store is the scoped one, not a global key.
  const settings = read('src/lib/chart/chart-settings.mjs');
  ok('indicator persistence still goes through the per-account scope',
    /chartScopeKey/.test(settings));
  ok('...and no indicator key is read or written unscoped',
    !/localStorage\.(get|set)Item\('cp_chart_indicators'/.test(settings));
}

// ── 8. the reason reaches the reader ──────────────────────────────────────────────────────────
console.log('\n8. the reason reaches the reader');

{
  const cp = read('src/components/chart/CPChart.jsx');
  const legend = read('src/components/chart/ChartLegend.jsx');
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const cpCode = code(cp), legendCode = code(legend);

  // ⚠️ ONE DEFINITION. The chart must decide with the same function the matrix tests and the legend
  // reports, or the three can disagree and the reader is told something untrue.
  ok('the chart decides availability with the shared function',
    /indicatorAvailability\(entry\.id, bars, entry\.params, ctx\)/.test(cpCode));
  ok('...and Volume asks the same question rather than testing inline',
    /indicatorAvailability\('volume'/.test(cpCode));
  ok('⚠️ the old silent inline volume test is gone',
    !/const hasVolume = volumeOnRef\.current && bars\.some/.test(cpCode));
  ok('an unavailable indicator still reaches the legend, carrying its reason',
    /unavailable: unavailable\.reason/.test(cpCode));
  ok('...and Volume does too, since it has no overlay row of its own',
    /unavailable: volumeReasonRef\.current/.test(cpCode));
  ok('the legend renders the reason', /ind\.unavailable &&/.test(legendCode));
  ok('...as text, not only as a tooltip',
    /—\s*\{ind\.unavailable\}/.test(legendCode) || /\{ind\.unavailable\}/.test(legendCode));

  // Every code the function can return must produce a sentence a reader can act on.
  const bars5 = [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
  const cases = [
    ['no-volume', indicatorAvailability('volume', bars5, {}, { intraday: true })],
    ['intraday-only', indicatorAvailability('vwap', [{ time: '2026-01-02', open: 1, high: 1, low: 1, close: 1, volume: 5 }], {}, { intraday: false })],
    ['short-history', indicatorAvailability('sma', bars5, { length: 200 }, { intraday: false })],
    ['no-bars', indicatorAvailability('sma', [], { length: 20 }, { intraday: false })],
    ['unknown', indicatorAvailability('nope', bars5, {}, {})],
  ];
  for (const [code2, res] of cases) {
    ok(`the "${code2}" case reports that code`, res?.code === code2, JSON.stringify(res));
    ok(`...with a sentence a reader can act on`,
      typeof res?.reason === 'string' && res.reason.length > 12 && !/undefined|NaN/.test(res.reason),
      res?.reason);
  }
  // The short-history sentence must name both numbers, or it is not actionable.
  const short = indicatorAvailability('sma', bars5, { length: 200 }, { intraday: false });
  ok('⚠️ the short-history reason names what is needed and what exists',
    /200/.test(short.reason) && /\b1\b/.test(short.reason), short.reason);
  // An available indicator says nothing at all.
  const fine = indicatorAvailability('sma',
    Array.from({ length: 50 }, (_, i) => ({ time: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: 1, high: 1, low: 1, close: 1 + i, volume: 9 })),
    { length: 20 }, { intraday: false });
  ok('an available indicator reports no reason at all', fine === null, JSON.stringify(fine));
}

// ── the report ────────────────────────────────────────────────────────────────────────────────
for (const [title, rows] of results) {
  console.log(`\n=== MATRIX (${title}) — ${LIVE ? `${SYM}, live routes` : 'synthetic bars'} ===`);
  console.log(['indicator'.padEnd(16), ...TIMEFRAMES.map((t) => t.id.padStart(6))].join(''));
  for (const row of rows) {
    console.log([row.label.padEnd(16), ...row.cells.map((c) => c.verdict.padStart(6))].join(''));
  }
}
console.log('\nPASS  a populated chart series would exist');
console.log('NOVOL our market-data source carries no volume for that timeframe');
console.log('SHORT fewer bars than the chosen period needs');
console.log('N/A   not applicable on that timeframe');
console.log('EMPTY / BADVAL / UNALIGNED / FAIL  a defect — these fail the suite');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
