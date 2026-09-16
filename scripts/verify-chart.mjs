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
  indicatorLabel, computeIndicator } from '../src/lib/chart/chart-indicators.mjs';
import { loadIndicators, saveIndicators, DEFAULT_ACTIVE, STORAGE_KEY } from '../src/lib/chart/chart-settings.mjs';
import { indicatorColor, indicatorColors } from '../src/lib/chart/chart-theme.mjs';
import { sessionKeyFor } from '../src/lib/chart/chart-source.mjs';

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
  ok('below the minimum clamps up', sanitizeParams('sma', { length: -5 }).length === 2);
  ok('above the maximum clamps down', sanitizeParams('sma', { length: 99999 }).length === 400);
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
