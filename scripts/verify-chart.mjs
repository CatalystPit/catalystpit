// LIGHTWEIGHT CHARTS FOUNDATION: the data boundary, the palettes, the indicator seam.
//
// The chart component itself needs a browser, so what is asserted here is everything that decides
// what the chart SHOWS — which is where the errors that matter live. A wrong colour is visible; a
// bar list that is out of order, deduplicated wrongly, or silently invented is not.
//
//   node --env-file=.env.local scripts/verify-chart.mjs
//
// With POLYGON_API_KEY present, the last section checks the extended-hours claim against the live
// vendor rather than trusting the comment that says it works.

import { readFile } from 'node:fs/promises';
import {
  TIMEFRAMES, DEFAULT_TIMEFRAME, timeframe, isIntraday, supportsExtendedHours,
  barsUrl, normalizeBars, refreshIntervalMs, diffBars, isValidSymbol,
} from '../src/lib/chart/chart-source.mjs';
import { CHART_THEMES, palette, chartOptions, CHART_ATTRIBUTION } from '../src/lib/chart/chart-theme.mjs';
import { sma, ema, vwap, rsi, macd, bollinger, atr, trueRange, smaValues, emaValues,
  INDICATORS, INDICATOR_IDS, availableIndicators, defaultParams, sanitizeParams,
  indicatorLabel, computeIndicator, isMultiInstance, nextInstanceKey, defaultParamsForNew,
  MAX_INSTANCES_PER_INDICATOR } from '../src/lib/chart/chart-indicators.mjs';
import { loadIndicators, saveIndicators, DEFAULT_ACTIVE, STORAGE_KEY, STORAGE_VERSION,
  __coerceInstance, __enforce } from '../src/lib/chart/chart-settings.mjs';
import { indicatorColor, indicatorColors } from '../src/lib/chart/chart-theme.mjs';
import { sessionKeyFor } from '../src/lib/chart/chart-source.mjs';
import { TOOLS, tool, createDrawing, coerceDrawing, moveDrawing, fibLevels, extendRay,
  hitTest, distanceToSegment, sanitizeStyle, DEFAULT_STYLE } from '../src/lib/chart/chart-drawings.mjs';
import { loadDrawings, saveDrawings, MAX_PER_SYMBOL, MAX_SYMBOLS,
  DRAWINGS_STORAGE_KEY } from '../src/lib/chart/chart-drawing-store.mjs';
import { loadView, saveView, DEFAULT_VIEW, VIEW_STORAGE_KEY } from '../src/lib/chart/chart-settings.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

section('1. the timeframe registry describes data we actually have');
{
  ok('every timeframe names an endpoint',
    TIMEFRAMES.every((t) => t.endpoint === 'daily' || t.endpoint === 'intraday'));
  ok('every timeframe declares a real bar size', TIMEFRAMES.every((t) => t.barSeconds > 0));
  // Only 1D and 5D are intraday, because /api/chart-intraday serves only those two.
  ok('intraday is exactly 1D and 5D',
    TIMEFRAMES.filter((t) => t.kind === 'intraday').map((t) => t.id).join(',') === '1D,5D');
  ok('the default timeframe exists', !!timeframe(DEFAULT_TIMEFRAME));
  ok('an unknown timeframe resolves to nothing', timeframe('7Y') === null);
  // NOT OFFERED, because nothing serves them: a 1-minute or weekly button would be a promise the
  // data cannot keep.
  for (const absent of ['1m', '5m', '1h', '1W', '1M1'])
    ok(`"${absent}" is not offered`, !TIMEFRAMES.some((t) => t.id === absent));
  ok('extended hours is claimed only for intraday',
    TIMEFRAMES.every((t) => !t.extendedCapable || t.kind === 'intraday'));
  ok('supportsExtendedHours agrees', supportsExtendedHours('1D') && !supportsExtendedHours('1Y'));
}

section('2. the URL is the whole of the vendor coupling');
{
  ok('intraday goes to the intraday route', barsUrl('AAPL', '1D').startsWith('/api/chart-intraday?'));
  ok('daily goes to the daily route', barsUrl('AAPL', '1Y').startsWith('/api/chart-daily?'));
  ok('the symbol is passed through', barsUrl('AAPL', '1Y').includes('ticker=AAPL'));
  ok('"All" is lowercased for the route', barsUrl('AAPL', 'All').includes('range=all'));
  ok('a lowercase symbol is accepted and upcased', barsUrl('aapl', '1Y').includes('ticker=AAPL'));
  ok('a share class survives', barsUrl('BRK.B', '1Y').includes('ticker=BRK.B'));
  // Nothing malformed is ever turned into a request.
  for (const bad of ['', '   ', '1AAPL', 'TOOLONGSYMBOL', 'A B', '../etc'])
    ok(`${JSON.stringify(bad)} produces no URL`, barsUrl(bad, '1Y') === null);
  ok('an unknown timeframe produces no URL', barsUrl('AAPL', 'nope') === null);
  ok('extended hours is requested only when asked for',
    barsUrl('AAPL', '1D', { session: 'extended' }).includes('session=extended')
    && !barsUrl('AAPL', '1D').includes('session='));
  ok('extended hours is NOT requested on a daily timeframe',
    !barsUrl('AAPL', '1Y', { session: 'extended' }).includes('session='));
}

section('3. normalisation never invents or reorders a price');
{
  const intradayPayload = { bars: [
    { time: 300, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { time: 100, open: 1, high: 2, low: 0.5, close: 1.2, volume: 5 },
    { time: 200, open: 1, high: 2, low: 0.5, close: 1.3, volume: null },
  ], meta: { delayed: true, source: 'polygon' } };
  const n = normalizeBars(intradayPayload, '1D');
  ok('bars come back ascending', n.bars.map((b) => b.time).join(',') === '100,200,300');
  ok('the delayed flag is carried, not guessed', n.meta.delayed === true);
  ok('the source is carried', n.meta.source === 'polygon');
  ok('the kind is derived from the timeframe', n.meta.kind === 'intraday');
  ok('a null volume stays null rather than becoming zero', n.bars[1].volume === null);

  // The daily route speaks a different dialect; it must come out identical in shape.
  const daily = normalizeBars({ candles: [{ date: '2026-01-02', open: 1, high: 2, low: 0.5, close: 1.4, volume: 7 }] }, '1Y');
  ok('daily candles normalise too', daily.bars.length === 1 && daily.bars[0].time === '2026-01-02');
  ok('daily kind is reported', daily.meta.kind === 'daily');
  ok('a missing delayed flag is unknown, not false', daily.meta.delayed === null);

  // A row that cannot be drawn honestly is dropped, never repaired.
  const dirty = normalizeBars({ bars: [
    { time: 1, open: 1, high: 2, low: 1, close: 1.5, volume: 1 },
    { time: 2, open: null, high: 2, low: 1, close: 1.5 },
    { time: 3, open: 1, high: 2, low: 1, close: 'n/a' },
    { time: null, open: 1, high: 2, low: 1, close: 1.5 },
  ] }, '1D');
  ok('rows with a missing price are dropped', dirty.bars.length === 1, JSON.stringify(dirty.bars));
  // Lightweight Charts throws on duplicate timestamps, so the last value wins.
  const dup = normalizeBars({ bars: [
    { time: 5, open: 1, high: 2, low: 1, close: 1.1, volume: 1 },
    { time: 5, open: 1, high: 2, low: 1, close: 1.9, volume: 2 },
  ] }, '1D');
  ok('duplicate timestamps collapse to one', dup.bars.length === 1);
  ok('the later value wins', dup.bars[0].close === 1.9);
  ok('empty input is empty output, not an error', normalizeBars({}, '1D').bars.length === 0);
  ok('a payload error is surfaced', normalizeBars({ error: 'data_unavailable' }, '1D').meta.error === 'data_unavailable');
}

section('4. refresh is honest about a delayed feed');
{
  // There is no stream. Polling faster than the bar size buys load, not freshness.
  ok('1D refreshes on its bar size', refreshIntervalMs('1D') === 300_000);
  ok('5D refreshes on its bar size', refreshIntervalMs('5D') === 900_000);
  ok('never faster than a minute', TIMEFRAMES.every((t) => !refreshIntervalMs(t.id) || refreshIntervalMs(t.id) >= 60_000));
  for (const d of ['1M', '1Y', 'All'])
    ok(`${d} does not poll at all`, refreshIntervalMs(d) === null);
}

section('5. incremental updates preserve zoom and pan');
{
  const base = [
    { time: 1, open: 1, high: 2, low: 1, close: 1.5, volume: 1 },
    { time: 2, open: 1, high: 2, low: 1, close: 1.6, volume: 2 },
  ];
  ok('an unchanged refresh changes nothing', diffBars(base, base.map((b) => ({ ...b }))) === null);
  const appended = [...base.map((b) => ({ ...b })), { time: 3, open: 1, high: 2, low: 1, close: 1.7, volume: 3 }];
  ok('a new bar is returned alone', diffBars(base, appended)?.length === 1);
  ok('...and it is the new one', diffBars(base, appended)[0].time === 3);
  // The live candle moves until it closes: that must update in place, not append.
  const moved = [base[0], { ...base[1], close: 1.9, high: 2.4 }];
  ok('the live bar updating is detected', diffBars(base, moved)?.length === 1);
  ok('...and keeps its timestamp', diffBars(base, moved)[0].time === 2);
  // A changed window is a different chart; patching it would corrupt the series.
  ok('a shifted window forces a full reset', diffBars(base, [{ time: 9, open: 1, high: 2, low: 1, close: 1.5, volume: 1 }]) === null);
  ok('an empty side forces a reset', diffBars(base, []) === null && diffBars([], base) === null);
}

section('6. chart colours are real colours, not CSS variables');
{
  // THE BUG THIS PREVENTS. The chart paints to a <canvas>, and a canvas colour is parsed by the 2D
  // context, which does not resolve var(). An invalid colour is silently ignored and the previous
  // value kept — so the chart does not error, it just renders wrong. The existing TickerChart passes
  // C.muted ("var(--cp-muted,#5A6458)") straight into layout.textColor and has exactly this defect.
  const isCanvasColor = (v) => typeof v === 'string'
    && !v.includes('var(')
    && (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/i.test(v) || v === 'transparent');
  for (const [name, p] of Object.entries(CHART_THEMES)) {
    for (const [k, v] of Object.entries(p)) ok(`${name}.${k} is a canvas colour`, isCanvasColor(v), String(v));
  }
  ok('both themes define the same keys',
    Object.keys(CHART_THEMES.light).sort().join() === Object.keys(CHART_THEMES.dark).sort().join());
  ok('up and down differ in both themes',
    CHART_THEMES.light.up !== CHART_THEMES.light.down && CHART_THEMES.dark.up !== CHART_THEMES.dark.down);
  ok('the two themes actually differ', CHART_THEMES.light.background !== CHART_THEMES.dark.background);
  ok('an unknown theme falls back to light', palette('sepia') === CHART_THEMES.light);

  const o = chartOptions('dark', { intraday: true });
  ok('options carry a resolved text colour', isCanvasColor(o.layout.textColor));
  ok('intraday shows the time axis', o.timeScale.timeVisible === true);
  ok('daily hides it', chartOptions('light', { intraday: false }).timeScale.timeVisible === false);
  ok('transparent is honoured', chartOptions('light', { transparent: true }).layout.background.color === 'transparent');
  ok('the built-in vendor logo is off (we render the credit ourselves)', o.layout.attributionLogo === false);
}

section('7. the Apache-2.0 attribution is present on every chart surface');
{
  ok('the credit names TradingView', /TradingView/.test(CHART_ATTRIBUTION));
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('the component renders it', /CHART_ATTRIBUTION/.test(cmp));
  ok('it is not hidden behind a conditional',
    !/\{\s*false\s*&&[\s\S]{0,80}CHART_ATTRIBUTION/.test(cmp));
  ok('it links to the project', /CHART_ATTRIBUTION_HREF/.test(cmp));
}

section('8. the indicator maths, against hand-computed values');
{
  // A ramp: close = 10,11,12,... Every average has a closed form on this input, so a wrong
  // implementation cannot hide behind output that merely looks plausible.
  const ramp = Array.from({ length: 40 }, (_, i) => ({
    time: i + 1, open: 10 + i, high: 11 + i, low: 9 + i, close: 10 + i, volume: 100,
  }));

  const s = sma(ramp, { length: 5 }).plots[0].data;
  ok('SMA starts only when the window is full', s.length === ramp.length - 4);
  ok('SMA of a ramp is the window midpoint', Math.abs(s[0].value - 12) < 1e-9, String(s[0].value));
  ok('SMA carries the bar time', s[0].time === 5);
  ok('SMA of too-short input is empty', sma(ramp.slice(0, 3), { length: 5 }).plots[0].data.length === 0);

  // EMA MUST BE SEEDED WITH THE SMA. Seeded from the first value instead, this point would be 10.
  const e = ema(ramp, { length: 5 }).plots[0].data;
  ok('EMA is seeded with the SMA of the first window', Math.abs(e[0].value - 12) < 1e-9, String(e[0].value));
  // Hand-checked: 15*(2/6) + 12*(4/6) = 13.
  ok('the EMA recurrence is right', Math.abs(e[1].value - 13) < 1e-9, String(e[1].value));
  ok('EMA tracks the ramp upward', e[e.length - 1].value > e[0].value);

  // RSI OF AN UNBROKEN ADVANCE IS EXACTLY 100: every delta is a gain, so average loss is zero.
  const r = rsi(ramp, { length: 14 }).plots[0].data;
  ok('RSI of an unbroken advance is 100', Math.abs(r[0].value - 100) < 1e-9, String(r[0].value));
  ok('RSI starts after `length` bars', r[0].time === 15, String(r[0].time));
  const down = ramp.map((b, i) => ({ ...b, close: 100 - i }));
  ok('RSI of an unbroken decline is 0', Math.abs(rsi(down, { length: 14 }).plots[0].data[0].value) < 1e-9);
  const flat = ramp.map((b) => ({ ...b, close: 50 }));
  ok('RSI of a flat series is defined, not NaN',
    Number.isFinite(rsi(flat, { length: 14 }).plots[0].data[0]?.value));
  ok('RSI is bounded 0..100', r.every((d) => d.value >= 0 && d.value <= 100));
  ok('RSI declares its guides', (rsi(ramp).guides || []).join(',') === '30,50,70');

  // ATR: each bar spans 2 (high-low) and gaps 1 from the previous close, so TR is 2 throughout.
  const a = atr(ramp, { length: 14 }).plots[0].data;
  ok('ATR of a constant-range series is that range', Math.abs(a[0].value - 2) < 1e-9, String(a[0].value));
  ok('ATR starts after `length` bars', a[0].time === 15, String(a[0].time));
  ok('true range uses the previous close when price gaps', trueRange({ high: 12, low: 11 }, 8) === 4);
  ok('true range falls back to high-low on the first bar', trueRange({ high: 12, low: 11 }, null) === 1);

  const bFlat = bollinger(flat, { length: 20, mult: 2 }).plots;
  ok('Bollinger emits three bands', bFlat.length === 3);
  ok('a flat series collapses the bands onto the basis',
    Math.abs(bFlat[0].data[0].value - bFlat[2].data[0].value) < 1e-9);
  const bRamp = bollinger(ramp, { length: 20, mult: 2 }).plots;
  ok('upper > basis > lower',
    bRamp[0].data[0].value > bRamp[1].data[0].value && bRamp[1].data[0].value > bRamp[2].data[0].value);
  // POPULATION deviation: for closes 10..29 that is sqrt(33.25). The sample figure would be 5.9161.
  const sd = (bRamp[0].data[0].value - bRamp[1].data[0].value) / 2;
  ok('Bollinger uses the population deviation', Math.abs(sd - Math.sqrt(33.25)) < 1e-6, String(sd));
  ok('a wider multiplier widens the band',
    bollinger(ramp, { length: 20, mult: 3 }).plots[0].data[0].value > bRamp[0].data[0].value);

  // MACD: the signal is an EMA OF THE MACD LINE and may only begin where that line exists.
  const m = macd(ramp, { fast: 12, slow: 26, signal: 9 });
  ok('MACD emits line, signal and histogram', m.plots.map((x) => x.key).join(',') === 'macd,signal,hist');
  ok('the MACD line starts at the slow EMA', m.plots[0].data[0].time === 26, String(m.plots[0].data[0].time));
  ok('the signal starts 8 bars after the line', m.plots[1].data[0].time === 34, String(m.plots[1].data[0].time));
  ok('the histogram is line minus signal',
    Math.abs(m.plots[2].data[0].value - (m.plots[0].data[8].value - m.plots[1].data[0].value)) < 1e-9);
  ok('the histogram is drawn signed', m.plots[2].signed === true);
  ok('MACD of a steady advance is positive', m.plots[0].data[0].value > 0);

  // WILDER SMOOTHING IS NOT AN EMA, and a ramp cannot tell them apart because it has no losses.
  // An alternating series can. closes 10,11,10,11... with length 2:
  //   seed   avgGain 0.5, avgLoss 0.5           -> RSI 50
  //   next   Wilder (0.5*1+1)/2 = 0.75 gain, (0.5*1+0)/2 = 0.25 loss -> RS 3     -> RSI 75
  //          an EMA of the same period would give 0.8333 / 0.1667    -> RS 5     -> RSI 83.33
  const alt = Array.from({ length: 12 }, (_, i) => ({
    time: i + 1, open: 10, high: 12, low: 9, close: i % 2 === 0 ? 10 : 11, volume: 100,
  }));
  const rAlt = rsi(alt, { length: 2 }).plots[0].data;
  ok('RSI uses Wilder smoothing, not an EMA', Math.abs(rAlt[1].value - 75) < 1e-9, String(rAlt[1].value));

  // ATR the same way: a constant true range cannot distinguish the recurrence from a plain mean.
  // Ranges alternate 1 and 3 with no gaps, length 2:
  //   seed  (3 + 1) / 2 = 2        next  Wilder (2*1 + 3)/2 = 2.5, a plain mean would be 3
  const varied = Array.from({ length: 10 }, (_, i) => ({
    time: i + 1, open: 10, close: 10, high: i % 2 === 1 ? 11.5 : 10.5, low: i % 2 === 1 ? 8.5 : 9.5, volume: 100,
  }));
  const aVar = atr(varied, { length: 2 }).plots[0].data;
  ok('ATR uses Wilder smoothing, not a plain mean', Math.abs(aVar[1].value - 2.5) < 1e-9, String(aVar[1].value));

  // The MACD SIGNAL is seeded with the SMA of the MACD LINE's own first `signal` values. Computing
  // it over an array still padded with zeros pulls the early signal toward zero, and the start time
  // alone does not reveal that — only the value does.
  const mm = macd(ramp, { fast: 12, slow: 26, signal: 9 });
  const lineVals = mm.plots[0].data.slice(0, 9).map((d) => d.value);
  const expectedSeed = lineVals.reduce((x, y) => x + y, 0) / 9;
  ok('the MACD signal is seeded from the line, not from padding',
    Math.abs(mm.plots[1].data[0].value - expectedSeed) < 1e-9,
    `${mm.plots[1].data[0].value} vs ${expectedSeed}`);

  // VWAP must RESET at the session boundary, or it is not VWAP.
  const two = [
    { time: 1, high: 10, low: 10, close: 10, open: 10, volume: 100 },
    { time: 2, high: 20, low: 20, close: 20, open: 20, volume: 100 },
    { time: 3, high: 40, low: 40, close: 40, open: 40, volume: 100 },
  ];
  ok('continuous VWAP averages the whole run',
    Math.abs(vwap(two, {}, {}).plots[0].data[2].value - 23.3333) < 0.001);
  ok('session VWAP resets at the boundary',
    Math.abs(vwap(two, {}, { sessionKey: (b) => (b.time <= 2 ? 'd1' : 'd2') }).plots[0].data[2].value - 40) < 1e-9);
  ok('a zero-volume bar is skipped, not counted at its price',
    vwap([...two, { time: 4, high: 999, low: 999, close: 999, open: 999, volume: 0 }], {}, {}).plots[0].data.length === 3);
  ok('no volume at all means no VWAP line',
    vwap(two.map((b) => ({ ...b, volume: 0 })), {}, {}).plots[0].data.length === 0);
}

section('8b. session boundaries, including extended hours');
{
  // 2026-09-15 ET (UTC-4 in September). Pre-market 08:00, regular 10:00, after-hours 18:00.
  const at = (h) => Math.floor(Date.UTC(2026, 8, 15, h + 4, 0) / 1000);
  const key = sessionKeyFor('1D');
  ok('intraday timeframes get a session key', typeof key === 'function');
  ok('daily timeframes get none', sessionKeyFor('1Y') === null);
  ok('pre-market shares the session with the regular open', key({ time: at(8) }) === key({ time: at(10) }));
  ok('after-hours shares it too', key({ time: at(18) }) === key({ time: at(10) }));
  ok('the next day is a different session', key({ time: at(10) }) !== key({ time: at(10) + 86400 }));

  // THE EXTENDED-HOURS CASE. With pre-market bars on the chart, VWAP anchors at the first traded
  // bar of the day — 04:00 — which is what a platform showing extended hours displays.
  const bars = [
    { time: at(8), high: 10, low: 10, close: 10, open: 10, volume: 100 },
    { time: at(10), high: 20, low: 20, close: 20, open: 20, volume: 100 },
    { time: at(10) + 86400, high: 60, low: 60, close: 60, open: 60, volume: 100 },
  ];
  const v = vwap(bars, {}, { sessionKey: key }).plots[0].data;
  ok('pre-market is included in the session VWAP', Math.abs(v[1].value - 15) < 1e-9, String(v[1].value));
  ok('the next day starts a fresh anchor', Math.abs(v[2].value - 60) < 1e-9, String(v[2].value));
}

section('8c. the registry, settings and persistence');
{
  for (const id of ['sma', 'ema', 'vwap', 'bollinger', 'rsi', 'macd', 'atr', 'volume'])
    ok(`${id} is registered`, !!INDICATORS[id]);
  ok('every entry declares a pane',
    Object.values(INDICATORS).every((i) => i.pane === 'price' || i.pane === 'separate'));
  ok('every entry is callable', Object.values(INDICATORS).every((i) => typeof i.compute === 'function'));
  ok('every entry declares its params as data', Object.values(INDICATORS).every((i) => Array.isArray(i.params)));
  ok('RSI, MACD and ATR take their own pane',
    ['rsi', 'macd', 'atr'].every((id) => INDICATORS[id].pane === 'separate'));
  ok('SMA, EMA, VWAP and Bollinger overlay price',
    ['sma', 'ema', 'vwap', 'bollinger'].every((id) => INDICATORS[id].pane === 'price'));

  ok('defaults come from the declaration', defaultParams('macd').fast === 12);
  ok('an unknown id yields no defaults', Object.keys(defaultParams('nope')).length === 0);

  // Settings arrive from a text box and from localStorage, so they can be anything at all. `length`
  // drives loop bounds, which is why this is a correctness check and not a cosmetic one.
  ok('a string is coerced', sanitizeParams('sma', { length: '30' }).length === 30);
  ok('a float is rounded for an int param', sanitizeParams('sma', { length: 14.7 }).length === 15);
  ok('NaN falls back to the default', sanitizeParams('sma', { length: 'abc' }).length === 20);
  ok('missing falls back to the default', sanitizeParams('sma', {}).length === 20);
  ok('below the minimum clamps up', sanitizeParams('sma', { length: -5 }).length === 1);
  ok('above the maximum clamps down', sanitizeParams('sma', { length: 99999 }).length === 1000);
  ok('MACD fast is forced below slow', sanitizeParams('macd', { fast: 30, slow: 26, signal: 9 }).fast === 25);

  ok('the legend names the settings', indicatorLabel('sma', { length: 50 }) === 'SMA 50');
  ok('a no-param indicator just names itself', indicatorLabel('vwap', {}) === 'VWAP');
  ok('MACD shows all three', indicatorLabel('macd', { fast: 12, slow: 26, signal: 9 }) === 'MACD 12/26/9');

  // An indicator that throws must never take the chart down with it.
  ok('a bad id computes to nothing', computeIndicator('nope', [{ close: 1 }], {}, {}).plots.length === 0);
  ok('empty bars compute to nothing', computeIndicator('sma', [], {}, {}).plots.length === 0);
  ok('a null bar list is safe', computeIndicator('sma', null, {}, {}).plots.length === 0);

  ok('VWAP is offered on intraday', availableIndicators({ intraday: true }).some((i) => i.id === 'vwap'));
  ok('VWAP is withheld on daily', !availableIndicators({ intraday: false }).some((i) => i.id === 'vwap'));
  ok('everything else is offered on both',
    availableIndicators({ intraday: false }).length === INDICATOR_IDS.length - 1);

  // Colours are theme-resolved, never hard-coded in the registry — the same rule as the palettes.
  ok('the registry stores colour INDEXES, not hex',
    Object.values(INDICATORS).every((i) => !i.colors || Object.values(i.colors).every((c) => typeof c === 'number')));
  ok('both themes define indicator colours',
    indicatorColors('light').length > 0 && indicatorColors('dark').length > 0);
  ok('indicator colours differ between themes', indicatorColor('light', 0) !== indicatorColor('dark', 0));
  ok('an out-of-range index wraps', typeof indicatorColor('light', 99) === 'string');
  ok('a negative index wraps too', typeof indicatorColor('light', -3) === 'string');

  // Persistence runs in the browser; on the server it must degrade to the default, never throw.
  ok('loading without a browser returns the default', loadIndicators().length === DEFAULT_ACTIVE.length);
  ok('saving without a browser is a no-op, not a throw',
    (() => { try { saveIndicators([{ id: 'sma' }]); return true; } catch { return false; } })());
  ok('the storage key follows the cp_ convention', /^cp_/.test(STORAGE_KEY));
}

section('8d. multiple SMAs and EMAs, each with its own length');
{
  ok('SMA and EMA are multi-instance', isMultiInstance('sma') && isMultiInstance('ema'));
  ok('the single-instance ones are not',
    !isMultiInstance('rsi') && !isMultiInstance('macd') && !isMultiInstance('volume') && !isMultiInstance('vwap'));

  // ANY LENGTH THE USER TYPES. The ones traders actually reach for must all survive sanitising
  // unchanged — a clamp that quietly turned a 200 EMA into something else would be invisible.
  for (const n of [1, 5, 8, 9, 10, 12, 20, 21, 34, 50, 55, 89, 100, 144, 200, 233, 377, 500, 1000])
    ok(`length ${n} is accepted verbatim`, sanitizeParams('ema', { length: n }).length === n);
  ok('0 clamps to the minimum', sanitizeParams('ema', { length: 0 }).length === 1);
  ok('a negative length clamps to the minimum', sanitizeParams('sma', { length: -20 }).length === 1);
  ok('beyond the ceiling clamps down', sanitizeParams('ema', { length: 5000 }).length === 1000);
  ok('a typed string is accepted', sanitizeParams('ema', { length: '200' }).length === 200);
  ok('an empty box falls back to the default', sanitizeParams('ema', { length: '' }).length === 20);

  // A ribbon: four EMAs at different lengths, all at once.
  const bars = Array.from({ length: 300 }, (_, i) => ({
    time: i + 1, open: 10 + i, high: 11 + i, low: 9 + i, close: 10 + i, volume: 100,
  }));
  const lengths = [9, 21, 50, 200];
  const series = lengths.map((n) => computeIndicator('ema', bars, { length: n }, {}).plots[0].data);
  ok('every length produces its own line', series.every((d) => d.length > 0));
  ok('a longer average starts later', series[0].length > series[3].length);
  ok('the four lines are genuinely different',
    new Set(series.map((d) => d[d.length - 1].value.toFixed(6))).size === 4);
  ok('a 200 EMA needs 200 bars', computeIndicator('ema', bars.slice(0, 100), { length: 200 }, {}).plots[0].data.length === 0);

  // Instance keys must be unique and stable.
  const a1 = { key: nextInstanceKey('ema', []), id: 'ema' };
  const a2 = { key: nextInstanceKey('ema', [a1]), id: 'ema' };
  const a3 = { key: nextInstanceKey('ema', [a1, a2]), id: 'ema' };
  ok('keys are unique', new Set([a1.key, a2.key, a3.key]).size === 3);
  ok('keys name their indicator', a1.key.startsWith('ema-'));
  ok('a key is not reused after a removal', nextInstanceKey('ema', [a1, a3]) !== a1.key && nextInstanceKey('ema', [a1, a3]) !== a3.key);

  // Adding repeatedly should build a conventional ribbon, not four identical lines.
  const built = [];
  for (let i = 0; i < 4; i += 1) {
    built.push({ key: nextInstanceKey('ema', built), id: 'ema', params: defaultParamsForNew('ema', built) });
  }
  ok('successive adds pick different lengths',
    new Set(built.map((b) => b.params.length)).size === 4, JSON.stringify(built.map((b) => b.params.length)));
  ok('the first suggestions are the common ones',
    built.slice(0, 4).map((b) => b.params.length).join(',') === '9,21,50,200');
  ok('a single-instance indicator just takes its default', defaultParamsForNew('rsi', []).length === 14);
}

section('8e. instances persist with their own colour and visibility');
{
  const mk = (id, length, color, visible = true, key = null) =>
    ({ key: key || `${id}-${length}`, id, params: { length }, color, visible });

  // Each instance keeps its own settings through a save/load round trip.
  const set = [mk('ema', 9, 0), mk('ema', 21, 1), mk('ema', 50, 2), mk('sma', 200, 3, false)];
  const kept = __enforce(set.map((e, i, arr) => __coerceInstance(e, arr.slice(0, i))));
  ok('all four survive', kept.length === 4);
  ok('lengths are preserved individually', kept.map((k) => k.params.length).join(',') === '9,21,50,200');
  ok('colours are preserved individually', kept.map((k) => k.color).join(',') === '0,1,2,3');
  ok('visibility is preserved', kept[3].visible === false && kept[0].visible === true);
  ok('keys are preserved', kept[0].key === 'ema-9');

  // Defensive reads: none of this may throw or produce a broken row.
  ok('an unknown indicator is dropped', __coerceInstance({ id: 'nope', params: {} }, []) === null);
  ok('a missing key is generated', !!__coerceInstance({ id: 'ema', params: { length: 9 } }, []).key);
  ok('a missing colour means "use the default"', __coerceInstance({ id: 'ema' }, []).color === null);
  ok('a non-numeric colour means "use the default"', __coerceInstance({ id: 'ema', color: 'red' }, []).color === null);
  ok('visibility defaults to visible when absent', __coerceInstance({ id: 'ema' }, []).visible === true);
  ok('an out-of-range stored length is re-clamped',
    __coerceInstance({ id: 'ema', params: { length: 99999 } }, []).params.length === 1000);

  // The ceiling stops a runaway from filling the chart, and single-instance stays single.
  const many = Array.from({ length: 20 }, (_, i) => mk('ema', i + 2, i, true, `ema-${i}`));
  ok('multi-instance is capped', __enforce(many).length === MAX_INSTANCES_PER_INDICATOR);
  const dupRsi = [mk('rsi', 14, 0, true, 'rsi-1'), mk('rsi', 21, 1, true, 'rsi-2')];
  ok('a single-instance indicator stays single', __enforce(dupRsi).length === 1);
  ok('duplicate keys are dropped',
    __enforce([mk('ema', 9, 0, true, 'x'), mk('ema', 21, 1, true, 'x')]).length === 1);

  ok('the stored version moved with the shape', STORAGE_VERSION === 2);
}

section('11. drawings live in DATA space, so they survive zoom, pan and reload');
{
  const P = (time, price) => ({ time, price });

  ok('every tool declares how many anchors it needs',
    Object.values(TOOLS).every((t) => t.points >= 1 && typeof t.segments === 'function'));
  ok('the six requested tools exist',
    ['trend', 'horizontal', 'vertical', 'ray', 'rectangle', 'fib'].every((id) => !!tool(id)));
  ok('an unknown tool resolves to nothing', tool('spiral') === null);

  // THE DECISION THAT MAKES DRAWINGS WORK: anchors are { time, price }, never pixels. A stored
  // pixel would slide off its level the moment the chart moved.
  const d = createDrawing('trend', [P(100, 10), P(200, 20)], { color: 1, width: 3, dash: 'dashed' });
  ok('a drawing stores time and price', d.points[0].time === 100 && d.points[0].price === 10);
  ok('no pixel ever reaches the model', !JSON.stringify(d).includes('"x"') && !JSON.stringify(d).includes('"y"'));
  ok('it carries its style', d.style.color === 1 && d.style.width === 3 && d.style.dash === 'dashed');
  ok('it starts visible', d.visible === true);
  ok('wrong anchor counts are refused', createDrawing('trend', [P(1, 1)]) === null);
  ok('a non-numeric price is refused', createDrawing('trend', [P(1, 'abc'), P(2, 2)]) === null);
  ok('an unknown tool is refused', createDrawing('spiral', [P(1, 1)]) === null);
  ok('ids are unique', createDrawing('trend', [P(1, 1), P(2, 2)], {}, [d]).id !== d.id);

  // A horizontal line and a ray have to reach the edge of whatever is on screen, which is why
  // segments take the view rather than storing a second anchor that would move when the user pans.
  const view = { from: 0, to: 1000, high: 100, low: 0 };
  const h = createDrawing('horizontal', [P(500, 42)]);
  const hs = tool('horizontal').segments(h.points, view);
  ok('a horizontal line spans the visible window', hs[0][0].time === 0 && hs[0][1].time === 1000);
  ok('...at a constant price', hs[0][0].price === 42 && hs[0][1].price === 42);
  const v = createDrawing('vertical', [P(500, 42)]);
  const vs = tool('vertical').segments(v.points, view);
  ok('a vertical line spans the visible prices', vs[0][0].price === 0 && vs[0][1].price === 100);
  ok('...at a constant time', vs[0][0].time === 500 && vs[0][1].time === 500);

  // A ray extends past its second anchor, along its own slope.
  const end = extendRay(P(0, 0), P(100, 10), view);
  ok('a ray reaches the right edge', end.time === 1000);
  ok('...following its slope', Math.abs(end.price - 100) < 1e-9, String(end.price));
  const back = extendRay(P(100, 10), P(0, 0), view);
  ok('a leftward ray reaches the left edge', back.time === 0);
  ok('a vertical ray does not divide by zero', Number.isFinite(extendRay(P(5, 1), P(5, 2), view).price));

  const r = createDrawing('rectangle', [P(10, 5), P(20, 15)]);
  ok('a rectangle is four sides', tool('rectangle').segments(r.points, view).length === 4);
  ok('a rectangle is filled', tool('rectangle').fill === true);

  // Fibonacci: 0 and 1 are the anchors, and the ratios sit between them.
  const f = fibLevels([P(0, 100), P(10, 50)]);
  ok('seven levels', f.length === 7);
  ok('the 0 level is the second anchor', Math.abs(f[0].price - 50) < 1e-9, String(f[0].price));
  ok('the 1 level is the first anchor', Math.abs(f[6].price - 100) < 1e-9, String(f[6].price));
  ok('0.5 is the midpoint', Math.abs(f[3].price - 75) < 1e-9, String(f[3].price));
  ok('0.618 is where it should be', Math.abs(f[4].price - 80.9) < 0.01, String(f[4].price));

  // Hit testing is a PIXEL judgement: "near enough to click" does not change with the zoom level.
  ok('distance to a segment is measured perpendicular',
    Math.abs(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }) - 5) < 1e-9);
  ok('past the end it measures to the endpoint',
    Math.abs(distanceToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }) - 10) < 1e-9);
  ok('a zero-length segment is a point',
    Math.abs(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }) - 5) < 1e-9);

  const projected = [
    { id: 'a', visible: true, segments: [[{ x: 0, y: 0 }, { x: 100, y: 0 }]], handles: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { id: 'b', visible: true, segments: [[{ x: 0, y: 50 }, { x: 100, y: 50 }]], handles: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
  ];
  ok('a click on a line selects it', hitTest({ x: 50, y: 51 }, projected)?.id === 'b');
  ok('a click in empty space selects nothing', hitTest({ x: 50, y: 25 }, projected) === null);
  // A handle wins over the body: dragging an endpoint is a different intent, on a smaller target.
  ok('a click on a handle reports the handle', hitTest({ x: 100, y: 50 }, projected)?.handle === 1);
  ok('a hidden drawing cannot be hit',
    hitTest({ x: 50, y: 1 }, [{ ...projected[0], visible: false }]) === null);
  // Newest first, so clicking a stack grabs the one on top.
  const stacked = [projected[0], { ...projected[1], id: 'top', segments: projected[0].segments, handles: [] }];
  ok('the topmost drawing wins a stack', hitTest({ x: 50, y: 1 }, stacked)?.id === 'top');

  // Moving is done in data space, so a drag behaves identically at any zoom.
  const moved = moveDrawing(d, { dTime: 10, dPrice: 5 });
  ok('moving shifts every anchor', moved.points[0].time === 110 && moved.points[1].price === 25);
  ok('moving one handle leaves the other alone',
    moveDrawing(d, { dTime: 10, dPrice: 5 }, 0).points[1].time === 200);
  // A date-string time cannot take a numeric delta, so those drawings move vertically only rather
  // than inventing a date.
  const daily = createDrawing('trend', [P('2026-01-02', 10), P('2026-02-02', 20)]);
  const dmoved = moveDrawing(daily, { dTime: 5, dPrice: 1 });
  ok('a daily drawing keeps its dates', dmoved.points[0].time === '2026-01-02');
  ok('...but still moves in price', dmoved.points[0].price === 11);

  // Styles are persisted and user-editable, so they arrive as anything.
  ok('a bad width falls back', sanitizeStyle({ width: 99 }).width === DEFAULT_STYLE.width);
  ok('a bad dash falls back', sanitizeStyle({ dash: 'wavy' }).dash === 'solid');
  ok('a bad colour falls back', sanitizeStyle({ color: 'red' }).color === DEFAULT_STYLE.color);
  ok('colour is stored as an index, not hex', typeof sanitizeStyle({ color: 3 }).color === 'number');
}

section('12. drawings persist per symbol');
{
  const mk = (type, pts) => createDrawing(type, pts);
  const line = mk('trend', [{ time: 1, price: 10 }, { time: 2, price: 20 }]);

  ok('a valid drawing round-trips', !!coerceDrawing(JSON.parse(JSON.stringify(line))));
  ok('a tool that no longer exists is dropped', coerceDrawing({ type: 'spiral', points: [] }) === null);
  ok('a wrong anchor count is dropped',
    coerceDrawing({ type: 'trend', points: [{ time: 1, price: 1 }] }) === null);
  ok('a non-numeric price is dropped',
    coerceDrawing({ type: 'trend', points: [{ time: 1, price: 'x' }, { time: 2, price: 2 }] }) === null);
  ok('a missing time is dropped',
    coerceDrawing({ type: 'trend', points: [{ price: 1 }, { time: 2, price: 2 }] }) === null);
  ok('a missing id is generated', !!coerceDrawing({ type: 'trend', points: line.points }).id);
  ok('visibility defaults to visible', coerceDrawing({ type: 'trend', points: line.points }).visible === true);
  ok('an explicit hide is kept',
    coerceDrawing({ type: 'trend', points: line.points, visible: false }).visible === false);

  // Without a browser these must degrade quietly, not throw — the chart renders on the server too.
  ok('loading without a browser is empty', loadDrawings('AAPL').length === 0);
  ok('saving without a browser does not throw',
    (() => { try { saveDrawings('AAPL', [line]); return true; } catch { return false; } })());
  ok('the store is bounded per symbol', MAX_PER_SYMBOL > 0 && MAX_PER_SYMBOL <= 500);
  ok('the number of remembered symbols is bounded', MAX_SYMBOLS > 0 && MAX_SYMBOLS <= 200);
  ok('the drawings key follows the cp_ convention', /^cp_/.test(DRAWINGS_STORAGE_KEY));
}

section('13. view options persist');
{
  ok('the defaults are sane',
    DEFAULT_VIEW.chartType === 'Candles' && DEFAULT_VIEW.logScale === false
    && DEFAULT_VIEW.autoScale === true && DEFAULT_VIEW.showDrawings === true);
  ok('loading without a browser returns the defaults', loadView().chartType === 'Candles');
  ok('saving without a browser does not throw',
    (() => { try { saveView({ logScale: true }); return true; } catch { return false; } })());
  ok('the view key follows the cp_ convention', /^cp_/.test(VIEW_STORAGE_KEY));
  ok('the view key is separate from the indicator key', VIEW_STORAGE_KEY !== STORAGE_KEY);

  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('log and linear are applied to the live scale', /PriceScaleMode\.Logarithmic/.test(cmp));
  ok('auto-scale is applied to the live scale', /autoScale: view\.autoScale/.test(cmp));
  ok('reset refits the content', /fitContent\(\)/.test(cmp));
  ok('there is a current-price line', /priceLineVisible: true/.test(cmp));
  // Fullscreen must not take the whole tab: the chart is one panel of several in the Terminal.
  // Checked for the CALL, not the word: the comment above it explains why the Fullscreen API is the
  // wrong choice here, and matching prose made this assertion fail on its own explanation.
  ok('fullscreen is an overlay, not the Fullscreen API',
    !/\.requestFullscreen\(/.test(cmp) && /position: 'fixed'/.test(cmp));
  ok('keyboard shortcuts are scoped to the chart, not the document',
    /el\.addEventListener\('keydown'/.test(cmp) && !/document\.addEventListener\('keydown'/.test(cmp));
  ok('typing in an input is never hijacked', /t\.tagName === 'INPUT'/.test(cmp));

  const layer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  ok('the overlay is pointer-transparent when idle', /pointerEvents: interactive \? 'auto' : 'none'/.test(layer));
  ok('selection comes from the chart click, so panning still works', /subscribeClick/.test(layer));
  ok('anchors are snapped to a bar', /coordinateToLogical/.test(layer));
  ok('it repaints when the chart moves', /subscribeVisibleLogicalRangeChange/.test(layer));
  ok('it repaints on resize', /ResizeObserver/.test(layer));
}

section('14. the toolbar layout: top bar, left rail, nothing over the candles');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const rail = await readFile(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8');

  // THE RAIL IS A FLEX SIBLING OF THE CHART, never an overlay. Absolute positioning over the chart
  // is what covers a candle, a price label or the time axis in a small Terminal panel.
  ok('the rail sits beside the chart, not on top of it',
    /rail \+ chart row/.test(cmp) && !/DrawingRail[\s\S]{0,200}position: 'absolute'/.test(cmp));
  ok('the chart box can shrink beside it', /flex: 1, minWidth: 0, minHeight: 0/.test(cmp));
  ok('the rail itself does not position absolutely over the chart',
    !/position: 'absolute'[\s\S]{0,120}borderRight/.test(rail));

  // The horizontal drawing row is gone; its controls moved to the rail.
  ok('the old horizontal drawing row is gone', !/DrawingToolbar/.test(cmp));
  ok('drawing tools render from the registry', /Object\.values\(TOOLS\)\.map/.test(rail));
  ok('every rail button carries a tooltip and a label',
    /title=\{title\}/.test(rail) && /aria-label=\{title\}/.test(rail));
  ok('there is a select/edit mode', /Select \/ edit/.test(rail));
  ok('hide/show lives on the rail', /Hide all drawings/.test(rail));
  ok('delete and clear live on the rail',
    /Delete selected/.test(rail) && /Clear all/.test(rail));

  // Style settings must not permanently consume another row.
  // Asserted on the STATE, not the word: a mutant that hard-wired the panel off still contained
  // every mention of it, so matching the name proved nothing.
  ok('style settings are a popover, not a row',
    /const \[stylePanel, setStylePanel\] = useState/.test(rail) && /position: 'absolute'/.test(rail));
  ok('...and it can be opened from the rail', /setStylePanel\(\(v\) => !v\)/.test(rail));
  ok('the popover can be dismissed', /Escape/.test(rail));

  // The top bar keeps chart-level controls only, and the indicator controls stay behind the button.
  ok('timeframes are on the top bar', /TIMEFRAMES\.map/.test(cmp));
  ok('chart type is on the top bar', /'Candles', 'Line'/.test(cmp));
  ok('fullscreen is on the top bar', /setFullscreen/.test(cmp));
  ok('indicators open a menu rather than spilling across the bar',
    /<IndicatorMenu/.test(cmp) && !/availableIndicators/.test(cmp));

  // RESPONSIVE ON THE ELEMENT, not the viewport: a Terminal panel resizes independently of the
  // window, so a media query would call a 280px panel "desktop".
  ok('width is measured with a ResizeObserver', /new ResizeObserver/.test(cmp));
  ok('...on the chart element, not the window', !/window\.matchMedia/.test(cmp));
  ok('there is a narrow mode', /setNarrow/.test(cmp));
  ok('narrow collapses the wordy controls into one menu', /narrow && \(\s*<ChartMenu/.test(cmp));
  ok('narrow collapses the rail to a single button', /compact=\{narrow\}/.test(cmp));
  ok('the compact rail is a popover, not a squeezed rail', /if \(compact\)/.test(rail));

  const menu = await readFile(new URL('../src/components/chart/ChartMenu.jsx', import.meta.url), 'utf8');
  // The answer to "not enough room" is to move controls, not to remove them.
  for (const control of ['Chart type', 'Extended hours', 'Price scale', 'Auto scale', 'Reset view'])
    ok(`"${control}" survives in the narrow menu`, menu.includes(control));
}

section('9. the component does not reach past the boundary');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  // The point of the boundary: the chart must not know a vendor's name or build its own URL.
  for (const vendor of ['polygon', 'tiingo', 'api.polygon.io', 'apiKey'])
    ok(`the component never mentions ${vendor}`, !new RegExp(vendor, 'i').test(cmp));
  ok('it builds no endpoint path of its own', !/['"]\/api\/chart-/.test(cmp));
  ok('it asks the boundary for the URL', /barsUrl\(/.test(cmp));
  ok('it normalises through the boundary', /normalizeBars\(/.test(cmp));
  ok('volume is drawn on its own price scale', /priceScaleId: 'cp-volume'/.test(cmp));
  ok('the chart is created once, not per timeframe', /Created once for the life of the component/.test(cmp));
  ok('a theme change applies options rather than rebuilding', /applyOptions\(chartOptions\(theme/.test(cmp));
  ok('a background tab does not poll', /document\.hidden/.test(cmp));
  ok('all four states are handled',
    ['loading', 'ready', 'empty', 'error'].every((s) => cmp.includes(`'${s}'`)));
}

if (!process.env.POLYGON_API_KEY && !process.env.POLYGON_KEY) {
  console.log('\n(section 10 skipped — no Polygon key)');
} else {
  section('10. extended hours, checked against the live vendor');
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY;
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/AAPL/range/5/minute/${day}/${day}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`);
  const j = await r.json();
  const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const times = (j.results || []).map((b) => ET.format(new Date(b.t)));
  const pre = times.filter((t) => t < '09:30').length;
  const post = times.filter((t) => t >= '16:00').length;
  console.log(`  AAPL ${day}: ${times.length} bars, ${pre} pre-market, ${post} after-hours`);
  ok('the entitlement returns bars at all', times.length > 0, String(r.status));
  ok('pre-market bars are included', pre > 0, String(pre));
  ok('after-hours bars are included', post > 0, String(post));

  const route = await readFile(new URL('../src/app/api/chart-intraday/route.js', import.meta.url), 'utf8');
  ok('the route can serve them on request', /session === 'extended' \? inExtended/.test(route));
  ok('the default is unchanged', /params\.get\('session'\) === 'extended' \? 'extended' : 'regular'/.test(route));
  // A shared cache key would serve one session's bars for the other.
  ok('the cache key separates the two sessions', /:ext' : ''/.test(route));
  ok('the payload says which session it is', /source: 'polygon', session/.test(route));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
