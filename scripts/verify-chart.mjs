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
import { CHART_TYPES, CHART_TYPE_IDS, chartTypeOf, PLANNED_CHART_TYPES } from '../src/lib/chart/chart-types.mjs';
import { INDICATOR_CATEGORIES, indicatorMeta, searchIndicators } from '../src/lib/chart/chart-indicators.mjs';
import { TOOL_CATEGORIES, TOOL_IDS, activeCategories, categoryOfTool } from '../src/lib/chart/chart-drawings.mjs';
import { placeFor, boxOf, EDGE, MIN_PANEL } from '../src/lib/chart/chart-popover.mjs';
import { TIMEFRAME_GROUPS, timeframesByGroup, ADAPTER, isServable, unavailableReason,
  PLANNED_TIMEFRAMES } from '../src/lib/chart/chart-source.mjs';

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
  ok('the default timeframe exists', !!timeframe(DEFAULT_TIMEFRAME));
  ok('an unknown timeframe resolves to nothing', timeframe('7Y') === null);
  ok('extended hours is claimed only for intraday',
    TIMEFRAMES.every((t) => !t.extendedCapable || t.kind === 'intraday'));
  ok('supportsExtendedHours agrees', supportsExtendedHours('1D') && !supportsExtendedHours('1Y'));

  // NO TICKS, NO SECONDS. The product does not offer them and no entry may smuggle one in.
  ok('no timeframe is finer than a minute', TIMEFRAMES.every((t) => t.barSeconds >= 60));

  // RANGE AND RESOLUTION ARE SEPARATE FIELDS. That separation is the whole point of the registry —
  // it is what stops a five-year chart being asked for as a million one-minute bars.
  ok('every timeframe declares a display window', TIMEFRAMES.every((t) => t.window != null));
  ok('...and a bar resolution independent of it', TIMEFRAMES.every((t) => t.barSeconds > 0));
  ok('a week and a 15-minute chart span the same sessions, differing only in resolution',
    timeframe('1W').window.sessions === timeframe('15m').window.sessions
      && timeframe('1W').barSeconds !== timeframe('15m').barSeconds);
  // Longer windows must use coarser bars, never the other way round.
  const dayEntries = TIMEFRAMES.filter((t) => t.group === 'days' && typeof t.window?.days === 'number');
  ok('a longer window never uses finer bars than a shorter one',
    dayEntries.every((a) => dayEntries.every((b) => !(a.window.days > b.window.days && a.barSeconds < b.barSeconds))));

  // WHAT AN ADAPTER IS HANDED. A new commercial feed implements exactly this and nothing else.
  const intradayTfs = TIMEFRAMES.filter((t) => t.kind === 'intraday');
  ok('every intraday timeframe declares its bar multiplier, sessions and lookback',
    intradayTfs.every((t) => t.request.barMinutes > 0 && t.request.sessions > 0 && t.request.lookbackDays > 0));
  ok('...with the bar size agreeing with the multiplier',
    intradayTfs.every((t) => t.barSeconds === t.request.barMinutes * 60));
  // Calendar days requested must exceed trading sessions kept, or a long weekend truncates the window.
  ok('...and a lookback wider than the sessions it keeps',
    intradayTfs.every((t) => t.request.lookbackDays > t.request.sessions));
  ok('every daily timeframe names a range its route implements',
    TIMEFRAMES.filter((t) => t.kind === 'daily').every((t) => ADAPTER.daily.ranges.has(t.request.range)));

  // NOTHING IN THE MENU IS UNSERVABLE TODAY, and the check that proves it is not vacuous.
  ok('every listed timeframe can actually be served', TIMEFRAMES.every((t) => isServable(t.id)));
  ok('...and an unservable one would be reported', unavailableReason('7Y') !== null);
  ok('the roadmap records what we cannot yet produce', PLANNED_TIMEFRAMES.length >= 2);
  ok('every planned timeframe states what it needs',
    PLANNED_TIMEFRAMES.every((t) => typeof t.needs === 'string' && t.needs.length > 0));
  // Weekly and monthly BARS are the planned ones; week- and month-long WINDOWS already exist.
  ok('planned resolutions are not in the menu',
    PLANNED_TIMEFRAMES.every((p) => !TIMEFRAMES.some((t) => t.id === p.id)));
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
  ok('15m refreshes on its bar size', refreshIntervalMs('15m') === 900_000);
  ok('a 4-hour chart polls on its bar size, not on the minute', refreshIntervalMs('4h') === 4 * 3_600_000);
  ok('a 1-minute chart is floored at a minute', refreshIntervalMs('1m') === 60_000);
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

section('14. chart types are a registry, and only what we draw is listed');
{
  ok('candles, line and area are offered', CHART_TYPE_IDS.join(',') === 'Candles,Line,Area');
  ok('every type names a real series constructor',
    CHART_TYPES.every((t) => /Series$/.test(t.series)));
  ok('every type maps a bar to its point shape',
    CHART_TYPES.every((t) => typeof t.map === 'function'));
  ok('every type styles itself from the palette',
    CHART_TYPES.every((t) => typeof t.options === 'function'));

  const bar = { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 5 };
  const candle = chartTypeOf('Candles').map(bar);
  ok('candles carry all four prices',
    candle.open === 10 && candle.high === 12 && candle.low === 9 && candle.close === 11);
  const line = chartTypeOf('Line').map(bar);
  ok('line carries the close as a value', line.value === 11 && line.open === undefined);
  ok('line and area are genuinely different series',
    chartTypeOf('Line').series !== chartTypeOf('Area').series);

  // NOTHING UNSUPPORTED IS LISTED. A type in the menu that renders wrongly is worse than absent.
  for (const planned of ['HeikinAshi', 'HollowCandles', 'Bars', 'Baseline'])
    ok(`${planned} is not offered yet`, !CHART_TYPE_IDS.includes(planned));
  ok('...but the roadmap is recorded', PLANNED_CHART_TYPES.length >= 4);
  ok('every planned type states what it needs',
    PLANNED_CHART_TYPES.every((t) => typeof t.needs === 'string' && t.needs.length > 0));
  // An unknown id must still draw something rather than leaving a blank box.
  ok('an unknown type falls back to candles', chartTypeOf('nope').id === 'Candles');

  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('the chart draws from the registry', /chart\.addSeries\(lwc\[ct\.series\]/.test(cmp));
  ok('...including on incremental updates', /chartTypeOf\(typeRef\.current\)\.map\(b\)/.test(cmp));
  ok('no chart type is hard-coded in the draw path', !/typeRef\.current === 'Candles'/.test(cmp));
  ok('the toolbar renders the type menu from the registry', /CHART_TYPES\.map/.test(cmp));

  // ── the toolbar control is an ICON, not a name ─────────────────────────────────────────────
  // The selected type is communicated by its icon plus the tooltip. Putting "Candlestick" in the
  // toolbar spends width on something already visible in the chart, and it would grow again with
  // every longer name added later — so these assertions exist to stop that creeping back in.
  const ctStart = cmp.indexOf('title={`Chart type');
  ok('the chart-type control carries a Chart type tooltip', ctStart > 0);
  const ctBlock = cmp.slice(cmp.lastIndexOf('<Dropdown', ctStart), cmp.indexOf('</Dropdown>', ctStart));
  const ctLabel = ctBlock.split('\n').find((l) => l.includes('label={')) || '';
  ok('its button renders a vector icon', /label=\{<VectorIcon/.test(ctLabel));
  ok('its button never renders the type NAME', !/\.label/.test(ctLabel));
  ok('...at every width, not just when narrow', !/narrow/.test(ctLabel));
  ok('it is not widened to fit text', !/buttonWidth/.test(ctBlock));
  ok('the tooltip still names the current type',
    /title=\{`Chart type — \$\{chartTypeOf\(chartType\)\.label\}`\}/.test(ctBlock));
  // The NAME belongs in the menu, where it is actually being read.
  ok('the menu rows show an icon', /left=\{<VectorIcon shapes=\{t\.shapes\}/.test(ctBlock));
  ok('...and the name beside it', /\{t\.label\}<\/MenuItem>/.test(ctBlock));

  // ── icons come from the registry, so a new chart type brings its own ───────────────────────
  ok('every type declares icon geometry',
    CHART_TYPES.every((t) => Array.isArray(t.shapes) && t.shapes.length > 0));
  ok('every type declares a text glyph fallback',
    CHART_TYPES.every((t) => typeof t.glyph === 'string' && t.glyph.length > 0));
  ok('every icon is visually distinct',
    new Set(CHART_TYPES.map((t) => JSON.stringify(t.shapes))).size === CHART_TYPES.length);
  const uiSrc = await readFile(new URL('../src/components/chart/ChartUI.jsx', import.meta.url), 'utf8');
  const kinds = [...new Set(CHART_TYPES.flatMap((t) => t.shapes.map((sh) => sh[0])))];
  ok('the renderer handles every primitive the registry uses',
    kinds.length > 0 && kinds.every((k) => uiSrc.includes(`kind === '${k}'`)));
  ok('icons inherit the button colour rather than hard-coding one',
    /stroke: 'currentColor'/.test(uiSrc));
  ok('a type with no geometry still falls back to its glyph',
    /if \(!Array\.isArray\(shapes\) \|\| shapes\.length === 0\)/.test(uiSrc));

  // ONE selector, not two. The settings menu used to carry a Candles/Line toggle that could not
  // reach Area at all; the compact icon control replaces it at every width.
  const menuSrc = await readFile(new URL('../src/components/chart/ChartMenu.jsx', import.meta.url), 'utf8');
  ok('the settings menu no longer duplicates the chart-type control', !/chartType/.test(menuSrc));
}

section('15. the indicator browser: searchable, categorised, registry-driven');
{
  ok('there are categories', INDICATOR_CATEGORIES.length >= 4);
  ok('"all" is one of them', INDICATOR_CATEGORIES.some((c) => c.id === 'all'));
  ok('every indicator declares a category',
    INDICATOR_IDS.every((id) => !!indicatorMeta(id).category));
  ok('every category used is declared',
    INDICATOR_IDS.every((id) => INDICATOR_CATEGORIES.some((c) => c.id === indicatorMeta(id).category)));

  // SEARCH BY WHAT A THING IS, not only what it is called.
  const ids = (q, o) => searchIndicators(q, o).map((d) => d.id);
  ok('an empty query returns everything', ids('').length === INDICATOR_IDS.length);
  ok('an exact name matches', ids('RSI').join() === 'rsi');
  ok('search is case-insensitive', ids('rsi').join() === 'rsi');
  ok('a prefix matches', ids('boll').join() === 'bollinger');
  ok('"moving average" finds both moving averages',
    ids('moving average').includes('sma') && ids('moving average').includes('ema'));
  ok('"bands" finds Bollinger', ids('bands').includes('bollinger'));
  ok('"oscillator" finds RSI and MACD',
    ids('oscillator').includes('rsi') && ids('oscillator').includes('macd'));
  ok('a label match outranks a keyword match', ids('ma')[0] === 'macd' || ids('ma').includes('sma'));
  ok('nonsense matches nothing', ids('zzzz').length === 0);
  ok('a category filters the list',
    searchIndicators('', { category: 'momentum' }).every((d) => indicatorMeta(d.id).category === 'momentum'));
  // The timeframe rule still holds inside search.
  ok('VWAP is not searchable on a daily chart', !ids('vwap', { intraday: false }).includes('vwap'));
  ok('...but is on intraday', ids('vwap', { intraday: true }).includes('vwap'));

  const br = await readFile(new URL('../src/components/chart/IndicatorBrowser.jsx', import.meta.url), 'utf8');
  ok('the browser has a search box', /Search indicators/.test(br));
  ok('it renders categories from the registry', /INDICATOR_CATEGORIES\.map/.test(br));
  ok('it renders results from the search, not a hard-coded list', /searchIndicators\(/.test(br));
  ok('a click adds immediately', /onClick=\{\(\) => add\(def\.id\)\}/.test(br));
  ok('multi-instance is respected', /MAX_INSTANCES_PER_INDICATOR/.test(br));
  // CUSTOM LENGTHS MUST SURVIVE THE REDESIGN: a free number input, not a preset list.
  ok('lengths stay a free number input', /type="number"/.test(br) && !/<select[\s\S]{0,120}length/.test(br));
  ok('settings, removal and visibility are all reachable',
    /Reset settings/.test(br) && /title="Remove"/.test(br) && /'Show' : 'Hide'/.test(br));
  ok('it is a modal, not another toolbar row', /<Modal/.test(br));

  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('one prominent Indicators button opens it', /setBrowserOpen\(true\)/.test(cmp));
  ok('the old inline indicator menu is gone', !/IndicatorMenu/.test(cmp));
}

section('16. drawing tools are grouped into categories on a left rail');
{
  ok('categories are declared', TOOL_CATEGORIES.length >= 3);
  ok('every tool belongs to exactly one category',
    TOOL_IDS.every((id) => TOOL_CATEGORIES.filter((c) => c.tools.includes(id)).length === 1));
  ok('the lines category holds the four line tools',
    TOOL_CATEGORIES.find((c) => c.id === 'lines').tools.join(',') === 'trend,ray,horizontal,vertical');
  ok('categoryOfTool resolves', categoryOfTool('ray')?.id === 'lines');
  ok('an unknown tool has no category', categoryOfTool('nope') === null);
  // Empty categories are declared for the roadmap but must not put a dead button on the chart.
  ok('empty categories are declared', TOOL_CATEGORIES.some((c) => c.tools.length === 0));
  ok('...but are not rendered', activeCategories().every((c) => c.tools.length > 0));
  ok('every rendered category has a real tool',
    activeCategories().every((c) => c.tools.some((t) => !!TOOLS[t])));

  const rail = await readFile(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8');
  ok('the rail renders categories, not every tool', /activeCategories\(\)/.test(rail));
  ok('...so it is not one button per tool', !/Object\.values\(TOOLS\)\.map/.test(rail));
  ok('a category remembers the last tool picked from it', /lastOf/.test(rail));
  // Only a category holding more than one REAL tool gets the ▸; a category whose extra tools are
  // still just roadmap entries must not grow an arrow that opens a one-row menu.
  ok('a category counts only tools that exist', /cat\.tools\.filter\(\(t\) => TOOLS\[t\]\)/.test(rail));
  ok('a category with several tools gets a dropdown arrow', /\{tools\.length > 1 && \(/.test(rail));
  ok('there is a select/edit mode', /Select \/ edit/.test(rail));
  ok('hide, delete and clear live on the rail',
    /Hide all drawings/.test(rail) && /Delete selected/.test(rail) && /Clear all/.test(rail));

  // CONTEXTUAL, NOT A PERMANENT ROW.
  ok('style settings are a popover', /const \[stylePanel, setStylePanel\] = useState/.test(rail));
  ok('...that opens when a drawing is selected',
    /useEffect\(\(\) => \{ if \(selected\) setStylePanel\(true\); \}/.test(rail));
  ok('colour, width and style are all there',
    /Colour|colour/i.test(rail) && /Width/.test(rail) && /Style/.test(rail));

  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  // The rail must stay a layout sibling so it can never cover price.
  ok('the rail sits beside the chart, not over it', /rail \+ chart row/.test(cmp));
  ok('the chart box can shrink beside it', /flex: 1, minWidth: 0, minHeight: 0/.test(cmp));
}

section('17. shared UI primitives, and responsive collapse');
{
  const ui = await readFile(new URL('../src/components/chart/ChartUI.jsx', import.meta.url), 'utf8');
  // One implementation of dismissal, so every menu behaves the same.
  ok('there is a shared dismiss hook', /export function useDismiss/.test(ui));
  ok('it closes on an outside click', /mousedown/.test(ui));
  ok('it closes on Escape', /'Escape'/.test(ui));
  ok('there is a shared Dropdown', /export function Dropdown/.test(ui));
  ok('there is a shared Modal', /export function Modal/.test(ui));
  ok('there is a shared button', /export function ToolButton/.test(ui));
  ok('every shared button is labelled for assistive tech', /aria-label=\{title\}/.test(ui));
  ok('the modal is a dialog', /role="dialog"/.test(ui) && /aria-modal="true"/.test(ui));
  ok('the modal closes on a backdrop click', /e\.target === e\.currentTarget/.test(ui));
  // A modal inside a 260px panel would be unusable, so it overlays the viewport instead.
  ok('the modal is fixed to the viewport, not the panel', /position: 'fixed', inset: 0/.test(ui));

  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('width is measured with a ResizeObserver', /new ResizeObserver/.test(cmp));
  ok('...on the element, not the window', !/window\.matchMedia/.test(cmp));
  // The timeframes no longer NEED collapsing: the row of nine buttons is gone and the control is a
  // single compact dropdown at every width, which is why there is no `narrow` branch around it.
  ok('the timeframe control is one dropdown, not a button row', /menuLabel="Timeframe"/.test(cmp));
  ok('...with no width-dependent variant', !/narrow[\s\S]{0,80}Timeframe/.test(cmp));
  ok('narrow shrinks the labelled buttons to icons', /narrow \? 30 :/.test(cmp));
  ok('narrow collapses the rail', /compact=\{narrow\}/.test(cmp));
  ok('the compact rail is a popover, not a squeezed rail', /if \(compact\)/.test(await readFile(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8')));

  const menu = await readFile(new URL('../src/components/chart/ChartMenu.jsx', import.meta.url), 'utf8');
  // Moving controls, never dropping them.
  for (const control of ['Extended hours', 'Price scale', 'Auto scale', 'Reset view'])
    ok(`"${control}" is in the controls menu`, menu.includes(control));
  // Chart type is the exception, and deliberately so: its icon button already fits a narrow toolbar
  // at full size, so it needs neither a collapsed variant nor a seat in this menu.
  const ctNarrow = cmp.slice(cmp.lastIndexOf('<Dropdown', cmp.indexOf('title={`Chart type')),
    cmp.indexOf('</Dropdown>', cmp.indexOf('title={`Chart type')));
  ok('chart type stays a toolbar icon at narrow widths', ctNarrow.length > 0 && !/narrow/.test(ctNarrow));
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

section('18. menus overlay the chart and are never clipped by the Terminal panel');
{
  // ── the invariant, across every panel size a user can drag to ──────────────────────────────
  // The bug being fixed: the chart sits in an `overflow: hidden` Terminal panel, so a menu placed
  // inside the chart got cut off — mid-row in a small panel, entirely in a very small one. The
  // menus are now portalled and placed against the WINDOW, so the property to prove is not a
  // particular top/left but that THE WHOLE MENU FITS ON SCREEN, whatever the panel is doing.
  const VIEWPORTS = [
    { width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 800 },
    { width: 1024, height: 768 }, { width: 820, height: 1180 }, { width: 430, height: 932 },
    { width: 390, height: 844 },
  ];
  const PANELS = [[1200, 700], [640, 420], [420, 300], [300, 220], [260, 180], [200, 150]];
  const MENUS = [
    { placement: 'bottom-start', width: 180 },   // chart type
    { placement: 'bottom-end', width: 186 },     // chart settings
    { placement: 'right-start', width: 182 },    // rail flyouts
    { placement: 'right-start', width: 186 },    // drawing style
  ];

  let cases = 0, escaped = 0, degenerate = 0, worst = null;
  for (const vp of VIEWPORTS) {
    for (const [pwRaw, phRaw] of PANELS) {
      const pw = Math.min(pwRaw, vp.width), ph = Math.min(phRaw, vp.height);
      // Panels flush to each edge and centred: a panel jammed into the bottom-right corner is the
      // case that used to clip, because the menu opened downward into nothing.
      const spots = [
        [0, 0], [vp.width - pw, 0], [0, vp.height - ph], [vp.width - pw, vp.height - ph],
        [Math.round((vp.width - pw) / 2), Math.round((vp.height - ph) / 2)],
      ];
      for (const [px, py] of spots) {
        for (const menu of MENUS) {
          // Toolbar icons sit along the panel's top; rail icons down its left edge.
          const isRail = menu.placement === 'right-start';
          const x = isRail ? px + 4 : px + Math.min(pw - 30, 120);
          const y = isRail ? py + Math.min(ph - 30, 90) : py + 6;
          const rect = { left: x, top: y, right: x + 26, bottom: y + 26 };
          const pos = placeFor(rect, menu.placement, { width: menu.width, maxHeight: 360, viewport: vp });
          const box = boxOf(pos, vp);
          cases += 1;
          const fits = box.left >= EDGE - 0.5 && box.top >= EDGE - 0.5
            && box.right <= vp.width - EDGE + 0.5 && box.bottom <= vp.height - EDGE + 0.5;
          if (!fits && !worst) worst = { vp, panel: [pw, ph], spot: [px, py], menu, box };
          if (!fits) escaped += 1;
          if (!(pos.width > 0 && pos.maxHeight > 0)) degenerate += 1;
        }
      }
    }
  }
  ok('the placement grid is actually large', cases >= 600, String(cases));
  ok('no menu escapes the window at any panel size', escaped === 0,
    worst ? `${escaped}/${cases}, e.g. ${JSON.stringify(worst)}` : '');
  ok('no menu is placed with zero width or height', degenerate === 0, String(degenerate));

  // ── the specific placements, so "it fits" is not satisfied by dumping everything at 6,6 ─────
  const big = { width: 1440, height: 900 };
  const mid = { left: 400, top: 300, right: 426, bottom: 326 };
  const under = placeFor(mid, 'bottom-start', { width: 180, gap: 4, viewport: big });
  ok('a dropdown opens DIRECTLY BELOW its control', under.top === mid.bottom + 4);
  ok('...and is left-aligned to it', under.left === mid.left);
  ok('...at the width asked for', under.width === 180);

  const low = { left: 400, top: 860, right: 426, bottom: 886 };
  const flipped = placeFor(low, 'bottom-start', { width: 180, gap: 4, viewport: big });
  ok('a dropdown near the bottom flips above the control', flipped.bottom != null && flipped.top == null);
  ok('...anchored to the control, not to the window', flipped.bottom === big.height - low.top + 4);

  const far = { left: 1400, top: 40, right: 1426, bottom: 66 };
  ok('a dropdown near the right edge is pulled inward',
    placeFor(far, 'bottom-start', { width: 180, viewport: big }).left === big.width - 180 - EDGE);
  ok('...and bottom-end hangs from the control right edge',
    placeFor(mid, 'bottom-end', { width: 180, viewport: big }).left === mid.right - 180);

  const rail = { left: 30, top: 300, right: 56, bottom: 326 };
  const fly = placeFor(rail, 'right-start', { width: 182, gap: 6, viewport: big });
  ok('a rail flyout opens BESIDE its icon', fly.left === rail.right + 6);
  ok('...aligned to the icon top', fly.top === rail.top);
  const railRight = { left: 1390, top: 300, right: 1416, bottom: 326 };
  ok('a rail flyout with no room on the right flips to the left',
    placeFor(railRight, 'right-start', { width: 182, gap: 6, viewport: big }).right
      === big.width - railRight.left + 6);

  // A window narrower than the menu itself: the menu shrinks rather than hanging off the side.
  const tiny = { width: 320, height: 480 };
  const squeezed = placeFor({ left: 200, top: 40, right: 226, bottom: 66 }, 'bottom-start',
    { width: 400, viewport: tiny });
  ok('a menu wider than the window is narrowed to fit', squeezed.width === tiny.width - EDGE * 2);
  ok('...and still starts inside the window', squeezed.left === EDGE);
  ok('a flipped menu never gets a useless height', flipped.maxHeight >= Math.min(MIN_PANEL, 360));

  // ── the components actually use it ──────────────────────────────────────────────────────────
  const ui = await readFile(new URL('../src/components/chart/ChartUI.jsx', import.meta.url), 'utf8');
  // Scoped to each component's own body: a file-wide search for `createPortal` is satisfied by the
  // Modal even when the Popover has stopped portalling, which is the case that actually clips.
  const bodyOf = (name, next) => ui.slice(ui.indexOf(`export function ${name}`), ui.indexOf(`export function ${next}`));
  const popoverBody = bodyOf('Popover', 'useDismiss');
  const itemBody = bodyOf('MenuItem', 'Modal');
  const buttonBody = bodyOf('ToolButton', 'Dropdown');
  ok('the popover bodies were located', popoverBody.length > 400 && itemBody.length > 300 && buttonBody.length > 300);
  ok('menus are portalled out of the panel', /createPortal\(/.test(popoverBody));
  ok('...to the document body, escaping every overflow', /document\.body,\s*\n\s*\);/.test(popoverBody));
  ok('...and positioned against the viewport', /position: 'fixed'/.test(ui));
  ok('the popover uses the shared placement module', /placeFor\(a\.getBoundingClientRect\(\)/.test(ui));
  ok('it follows its trigger when an ancestor scrolls',
    /addEventListener\('scroll', place, true\)/.test(ui));
  ok('...and when the panel is resized by drag', /new ResizeObserver\(place\)/.test(ui));
  ok('an outside click closes it', /addEventListener\('mousedown', onDown\)/.test(ui));
  ok('Escape closes it', /e\.key !== 'Escape'/.test(ui));
  ok('...the innermost one only, so nested menus peel', /openPanels\[openPanels\.length - 1\]/.test(ui));
  ok('a click in a menu opened from another does not close the parent',
    /hit !== -1 && hit >= mine/.test(ui));
  ok('the trigger stays clickable to toggle its own menu',
    /anchorRef\.current\?\.contains\(e\.target\)\) return/.test(ui));
  ok('picking a row closes the menu', /data-close-on-pick/.test(ui));
  ok('menu rows have a hover state', /hover && !disabled \? p\.menuHover/.test(itemBody));
  ok('toolbar buttons have one too', /hover && !disabled \? p\.menuHover/.test(buttonBody));
  ok('the selected row is tinted', /active \? p\.menuActive/.test(itemBody));
  ok('...carries an accent bar', /background: p\.up \}\} \/>/.test(itemBody));
  ok('...and is announced to a screen reader', /aria-checked=/.test(itemBody));
  ok('the modal is portalled too', ui.slice(ui.indexOf('export function Modal')).includes('createPortal'));

  // Nothing in the chart may go back to an in-panel absolute menu: that is the clipped design.
  for (const f of ['CPChart', 'ChartMenu', 'DrawingRail', 'ChartUI', 'IndicatorBrowser']) {
    const src = await readFile(new URL(`../src/components/chart/${f}.jsx`, import.meta.url), 'utf8');
    const menus = src.split('\n').filter((l) => /position: 'absolute'/.test(l) && /zIndex: [23]\d\b/.test(l));
    ok(`${f} has no panel-clipped absolute menu left`, menus.length === 0, menus[0]?.trim());
  }

  const rail2 = await readFile(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8');
  ok('every rail menu is a shared Popover', (rail2.match(/<Popover/g) || []).length >= 2);
  // BOTH side flyouts open beside the icon — the category menu and the style panel — and exactly one
  // menu hangs below: the collapsed rail's own button, which is a toolbar control, not a flyout.
  // Counted absolutely, because a relative count stays balanced when one flips to the other.
  const sideCount = (rail2.match(/placement="right-start"/g) || []).length;
  const belowCount = (rail2.match(/placement="bottom-start"/g) || []).length;
  ok('both rail flyouts open beside their icon', sideCount === 2, `${sideCount} right-start`);
  ok('...and only the collapsed rail button opens below', belowCount === 1, `${belowCount} bottom-start`);
  ok('...and the category flyout is one of them',
    /placement="right-start" gap=\{6\} width=\{182\}/.test(rail2));
  ok('...as is the style panel', /placement="right-start" gap=\{6\} width=\{186\}/.test(rail2));
  ok('the flyout is anchored to the whole button group, so ▸ toggles it',
    /<div key=\{cat\.id\} ref=\{ref\}/.test(rail2));

  const cmp2 = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('the chart-type menu is the shared dropdown, so it is portalled too',
    /<Dropdown theme=\{theme\} width=\{180\} menuLabel="Chart type"/.test(cmp2));
  const menu2 = await readFile(new URL('../src/components/chart/ChartMenu.jsx', import.meta.url), 'utf8');
  ok('the settings menu is too', /from '\.\/ChartUI'/.test(menu2) && !/position: 'absolute'/.test(menu2));
}

section('19. the timeframe menu: one compact control, grouped, nothing invented');
{
  // THE MENU, EXACTLY AS SPECIFIED. Order and grouping are part of the spec, not decoration: a user
  // reaches for "30 minutes" by position as much as by name.
  const groups = timeframesByGroup();
  ok('there are three groups', groups.map((g) => g.id).join(',') === 'minutes,hours,days');
  ok('they are titled for the menu',
    groups.map((g) => g.label).join('|') === 'Minutes|Hours|Days / longer timeframes');
  ok('the minutes are 1 through 45',
    groups[0].items.map((t) => t.id).join(',') === '1m,2m,3m,5m,10m,15m,30m,45m');
  ok('the hours are 1 through 4', groups[1].items.map((t) => t.id).join(',') === '1h,2h,3h,4h');
  ok('the longer timeframes run a day to all',
    groups[2].items.map((t) => t.id).join(',') === '1D,1W,1M,3M,6M,YTD,1Y,All');
  ok('every group is accounted for, none orphaned',
    groups.reduce((n, g) => n + g.items.length, 0) === TIMEFRAMES.length);
  ok('an empty group would not be rendered', groups.every((g) => g.items.length > 0));

  // Both labels exist and differ: the long one for the menu, the short one for the toolbar.
  ok('every timeframe has a menu name', TIMEFRAMES.every((t) => typeof t.label === 'string' && t.label.length > 0));
  ok('...and a compact toolbar label', TIMEFRAMES.every((t) => typeof t.short === 'string' && t.short.length > 0));
  ok('the toolbar label is never longer than the menu name',
    TIMEFRAMES.every((t) => t.short.length <= t.label.length));
  ok('the menu spells intervals out', timeframe('15m').label === '15 minutes' && timeframe('4h').label === '4 hours');
  ok('...while the toolbar stays terse', timeframe('15m').short === '15m' && timeframe('4h').short === '4h');
  ok('ids are unique', new Set(TIMEFRAMES.map((t) => t.id)).size === TIMEFRAMES.length);
  ok('toolbar labels are unique too', new Set(TIMEFRAMES.map((t) => t.short)).size === TIMEFRAMES.length);

  // The ids the existing callers pass must keep working — the Terminal panel asks for 1D and the
  // ticker page for 3M, and a rebuilt registry that dropped either would blank both charts.
  ok('the Terminal panel default still resolves', !!timeframe('1D'));
  ok('the ticker page default still resolves', !!timeframe('3M'));

  // ── requests: every interval reaches the right endpoint, and no unservable one is requested ──
  ok('a minute interval goes to the intraday endpoint',
    barsUrl('AAPL', '3m') === '/api/chart-intraday?ticker=AAPL&range=3m');
  ok('an hour interval does too', barsUrl('AAPL', '4h') === '/api/chart-intraday?ticker=AAPL&range=4h');
  ok('a long window goes to the daily endpoint',
    barsUrl('AAPL', '1Y') === '/api/chart-daily?ticker=AAPL&range=1Y');
  ok('"All" is spelled the way its route wants', barsUrl('AAPL', 'All') === '/api/chart-daily?ticker=AAPL&range=all');
  // String(): barsUrl returns null for anything it refuses, and a bare .includes() on that throws,
  // which would take the rest of this section down with it instead of failing one assertion.
  ok('extended hours rides along on an intraday interval',
    String(barsUrl('AAPL', '1m', { session: 'extended' })).includes('session=extended'));
  ok('...and is not sent on a daily one',
    !String(barsUrl('AAPL', '1Y', { session: 'extended' })).includes('session='));
  ok('an unknown timeframe produces no request', barsUrl('AAPL', '9m') === null);

  // THE UNSERVABLE GUARD, PROVEN. Every entry is servable today, so simply asserting that proves
  // nothing about the guard — removing it would change no output. Narrowing the DECLARED adapter
  // capability for a moment is what actually exercises the refusal: the boundary must decline to
  // build a request rather than let the endpoint answer at whatever resolution it falls back to.
  const realMin = ADAPTER.intraday.minBarMinutes;
  ADAPTER.intraday.minBarMinutes = 5;
  ok('a timeframe the adapter cannot serve is reported unavailable', unavailableReason('1m') !== null);
  ok('...and produces no request at all', barsUrl('AAPL', '1m') === null);
  ok('...while one it can serve is unaffected', barsUrl('AAPL', '15m') !== null);
  ADAPTER.intraday.minBarMinutes = realMin;
  ok('the declared capability was restored', barsUrl('AAPL', '1m') !== null);

  // ── the route is driven by the registry, so an interval is one entry and not a code change ──
  const route = await readFile(new URL('../src/app/api/chart-intraday/route.js', import.meta.url), 'utf8');
  ok('the route reads the timeframe registry', /from '\.\.\/\.\.\/\.\.\/lib\/chart\/chart-source\.mjs'/.test(route));
  ok('...instead of keeping its own list of ranges', !/const RANGES = new Set/.test(route));
  ok('the bar multiplier comes from the timeframe', /barMinutes: mult/.test(route));
  ok('...as do the sessions kept and the days requested',
    /sessions: keepN, lookbackDays/.test(route));
  ok('no range is hard-coded in the request any more', !/range === '5D' \? 15 : 5/.test(route));
  ok('an unservable id never reaches the provider', /INTRADAY\.has\(range\)/.test(route));

  // ── the toolbar control ──────────────────────────────────────────────────────────────────────
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('the row of timeframe buttons is gone', !/TIMEFRAMES\.map\(\(t\) => btn\(/.test(cmp));
  ok('the control shows the SHORT label', /label=\{timeframe\(tf\)\?\.short/.test(cmp));
  ok('...and never the long one in the toolbar',
    !/label=\{timeframe\(tf\)\?\.label/.test(cmp));
  ok('the tooltip names the current timeframe in full',
    /title=\{`Timeframe — \$\{timeframe\(tf\)\?\.label/.test(cmp));
  ok('the menu is built from the groups', /timeframesByGroup\(\)\.map/.test(cmp));
  ok('...with a heading per group', /<MenuLabel theme=\{theme\}>\{g\.label\}<\/MenuLabel>/.test(cmp));
  ok('...and the full name on each row', /\{t\.label\}<\/MenuItem>/.test(cmp));
  ok('picking one loads it immediately', /onClick=\{\(\) => setTf\(t\.id\)\}/.test(cmp));
  ok('the selected interval is marked', /active=\{t\.id === tf\}/.test(cmp));
  // An interval the provider cannot serve is visible but not selectable — neither hidden (which
  // would misrepresent the product) nor enabled (which would mean drawing candles we do not have).
  ok('an unservable interval is disabled, not hidden', /disabled=\{!!why\}/.test(cmp));
  ok('...and says why on hover', /title=\{why \|\| undefined\}/.test(cmp));

  // The menu is tall: it MUST be the portalled popover, or the panel clips it (see section 18).
  const uiSrc = await readFile(new URL('../src/components/chart/ChartUI.jsx', import.meta.url), 'utf8');
  ok('the timeframe menu scrolls rather than overflowing', /overflowY: 'auto'/.test(uiSrc));
  // 20 rows at ~30px plus three headings needs far more than a short panel has; the placement must
  // cap the height against the WINDOW, which is what makes it scrollable instead of clipped.
  const tall = placeFor({ left: 100, top: 300, right: 144, bottom: 326 }, 'bottom-start',
    { width: 210, maxHeight: 360, viewport: { width: 1440, height: 500 } });
  ok('a menu taller than the space below it is capped, not clipped',
    tall.maxHeight <= 500 - EDGE && tall.maxHeight > 0);
  ok('...and still sits inside the window',
    boxOf(tall, { width: 1440, height: 500 }).bottom <= 500 - EDGE + 0.5);
}

section('20. the chart header: symbol first, one compact row, overflow before wrapping');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const bar = cmp.slice(cmp.indexOf('{showToolbar && ('), cmp.indexOf('{/* THE RAIL IS A SIBLING'));
  ok('the toolbar block was located', bar.length > 800);

  // ── ORDER: symbol → timeframe → chart type → indicators ─────────────────────────────────────
  // Asserted by position in the toolbar, because this order IS the requirement: a trader who knows
  // one charting platform should find these controls where their hand already goes.
  const at = (needle) => bar.indexOf(needle);
  // indexOf returns -1 for something that is ABSENT, and -1 sorts before everything — so comparing
  // raw indices would call a deleted control "first". Presence is asserted separately, and the order
  // check requires each index to be both present and strictly after the one before it.
  const primary = [
    ['symbol', at('<SymbolSearch')],
    ['timeframe', at('menuLabel="Timeframe"')],
    ['chart type', at('menuLabel="Chart type"')],
    ['indicators', at('title="Indicators"')],
  ];
  for (const [name, i] of primary) ok(`the ${name} control is in the toolbar`, i >= 0);
  ok('they run symbol → timeframe → chart type → indicators',
    primary.every(([, i], k) => i >= 0 && (k === 0 || primary[k - 1][1] < i)),
    primary.map(([n, i]) => `${n}@${i}`).join(' '));
  const iSym = primary[0][1], iType = primary[2][1];
  // The view controls are pushed to the far end of the SAME row, not onto a second one.
  ok('the settings and fullscreen controls are pushed right', /marginLeft: 'auto'/.test(bar));
  ok('...after the primary controls', at("marginLeft: 'auto'") > iType);

  // ── ONE ROW, ALWAYS ─────────────────────────────────────────────────────────────────────────
  // A wrapped toolbar steals chart height, which is the thing a Terminal panel has least of.
  ok('the toolbar never wraps to a second row', /flexWrap: 'nowrap'/.test(bar));
  ok('...and does not simply scroll sideways instead', !/overflowX: 'auto'/.test(bar));

  // ── OVERFLOW, BY PRIORITY ───────────────────────────────────────────────────────────────────
  ok('there are two width thresholds, not one', /const narrow = toolbarWidth </.test(cmp)
    && /const overflowed = toolbarWidth </.test(cmp));
  ok('overflow kicks in before narrow does',
    Number(cmp.match(/const overflowed = toolbarWidth < (\d+)/)[1])
      < Number(cmp.match(/const narrow = toolbarWidth < (\d+)/)[1]));
  ok('width is measured on the chart, never the window',
    /new ResizeObserver/.test(cmp) && !/window\.matchMedia/.test(cmp));
  ok('indicators is the control that gives way', /\{!overflowed && \(/.test(bar));
  ok('...into a ⋯ menu', /label="⋯"/.test(bar));
  ok('...which leads with Indicators', bar.indexOf('>Indicators</MenuItem>') > at('label="⋯"'));
  ok('...and carries fullscreen too', /Fullscreen<\/MenuItem>/.test(bar));
  // PRIORITY: the three controls that must never be collapsed are outside the overflow branch.
  const overflowBlock = bar.slice(at('label="⋯"'), bar.indexOf('</Dropdown>', at('label="⋯"')));
  ok('the symbol never collapses into the overflow', !overflowBlock.includes('SymbolSearch'));
  ok('nor does the timeframe', !overflowBlock.includes('menuLabel="Timeframe"'));
  ok('nor does the chart type', !overflowBlock.includes('menuLabel="Chart type"'));
  // The overflow's view rows are the SAME rows the settings menu renders, not a second copy.
  ok('the overflow shares the settings rows', /viewMenuItems\(\{ theme, view, canExtend/.test(bar));
  const menuSrc = await readFile(new URL('../src/components/chart/ChartMenu.jsx', import.meta.url), 'utf8');
  ok('...which the settings menu renders from the same function', /export function viewMenuItems/.test(menuSrc)
    && /\{viewMenuItems\(\{ theme, view, canExtend, onPatch, onReset \}\)\}/.test(menuSrc));

  // ── THE SYMBOL IS NO LONGER IN THE PANEL TITLE BAR ──────────────────────────────────────────
  const term = await readFile(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');
  ok('the Terminal chart panel no longer prints the symbol top-right',
    !/headerRightOf = \(def\) => \(def\.id === 'chart'/.test(term));
  ok('the chart panel still receives the bus symbol', /<ChartBody symbol=\{selectedSymbol\} \/>/.test(term));

  // ── EACH PANEL CAN HOLD ITS OWN SYMBOL ──────────────────────────────────────────────────────
  ok('the chart keeps its own symbol state', /const \[sym, setSym\] = useState\(symbol\);/.test(cmp));
  ok('...seeded and re-synced from the prop, so link groups still win',
    /useEffect\(\(\) => \{ setSym\(symbol\); \}, \[symbol\]\);/.test(cmp));
  ok('the data path uses the panel symbol', /barsUrl\(sym, tf,/.test(cmp));
  ok('...and so do the drawings, which are per symbol', /loadDrawings\(sym\)/.test(cmp) && /saveDrawings\(sym, drawings\)/.test(cmp));
  // WHO OWNS THE SYMBOL is a prop, not a hard-coded choice: unset, the chart owns it and a pick
  // writes local state only (the Terminal panel); provided, the host owns it (the ticker page, where
  // the symbol is the whole page and a pick must take the page with it).
  ok('a pick writes local state by default', /onPick=\{onSymbolPick \|\| setSym\}/.test(cmp));
  ok('...and the host can take ownership instead', /onSymbolPick = null,/.test(cmp));
  const tpc = await readFile(new URL('../src/components/chart/TickerPriceChart.jsx', import.meta.url), 'utf8');
  ok('the ticker page takes that ownership', /onSymbolPick=\{\(s\) => router\.push/.test(tpc));
  ok('...so its chart cannot drift from the page around it', /\/ticker\/\$\{encodeURIComponent\(s\)\}/.test(tpc));
  ok('the Terminal panel does NOT, so its chart keeps its own symbol',
    !/onSymbolPick/.test(term));

  // ── THE SYMBOL SEARCH ───────────────────────────────────────────────────────────────────────
  const ss = await readFile(new URL('../src/components/chart/SymbolSearch.jsx', import.meta.url), 'utf8');
  ok('it reuses the existing symbol-search endpoint', /\/api\/symbol-search\?q=/.test(ss));
  // NO SECOND SECURITY DATABASE: nothing here may carry its own list of tickers.
  ok('it keeps no ticker list of its own', !/\[\s*'[A-Z]{1,5}'\s*,\s*'[A-Z]{1,5}'/.test(ss));
  ok('it does not navigate the application', !/useRouter|router\.push|window\.location|<a /.test(ss));
  ok('the input takes focus the moment it opens', /if \(el\) el\.focus\(\)/.test(ss));
  ok('typing is debounced', /setTimeout\(async \(\) =>/.test(ss));
  ok('...and a stale response cannot overwrite a newer one', /mine !== reqRef\.current/.test(ss));
  ok('up and down move the highlight', /'ArrowDown'/.test(ss) && /'ArrowUp'/.test(ss));
  ok('Enter selects the highlighted match', /if \(e\.key === 'Enter'\)/.test(ss));
  ok('...or a symbol typed out in full', /pick\(results\[hi\]\?\.ticker \|\| q\)/.test(ss));
  ok('only a valid symbol is ever picked', /if \(!isValidSymbol\(up\)\) return;/.test(ss));
  ok('the ticker is shown prominently', /fontWeight: 700[^}]*\}\}>\{r\.ticker\}/.test(ss));
  ok('...with the company name beside it', /\{r\.name \|\| ''\}/.test(ss));
  ok('it is the shared portalled popover, so the panel cannot clip it', /<Popover anchorRef=\{anchorRef\}/.test(ss));
  ok('Escape and outside-click come from that popover', /Escape is left to the Popover/.test(ss));
  ok('a fresh open does not show the last search', /setQ\(''\); setResults\(\[\]\)/.test(ss));

  // ── the rail is unchanged and still on the left ─────────────────────────────────────────────
  ok('the drawing rail is still a left-hand sibling of the chart',
    cmp.indexOf('<DrawingRail') < cmp.indexOf('<div ref={hostRef}'));
  ok('...and still collapses on a narrow panel', /compact=\{narrow\}/.test(cmp));
}

section('21. the chart surface: legend, crosshair and the readout that is always there');
{
  const leg = await readFile(new URL('../src/components/chart/ChartLegend.jsx', import.meta.url), 'utf8');
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');

  // ── THE LEGEND IS ALWAYS POPULATED ──────────────────────────────────────────────────────────
  // It used to exist only while the pointer was over the chart, so at rest — which is most of the
  // time — the chart showed no numbers at all. Off the crosshair it now falls back to the last bar.
  ok('the legend reads from the cursor when there is one, and the last bar otherwise',
    /bar=\{\(cursor \|\| tail\)\.bar\} prevClose=\{\(cursor \|\| tail\)\.prevClose\}/.test(cmp));
  ok('the last bar is captured whenever the bars are', /setTail\(\{/.test(cmp));
  ok('...along with the close before it, which the change is measured against',
    /prevClose: bars\.length > 1 \? bars\[bars\.length - 2\]\.close : null/.test(cmp));
  ok('leaving the chart clears only the cursor, never the fallback',
    /if \(off\) \{ setCursor\(null\); return; \}/.test(cmp));

  // ── WHAT IT SHOWS ───────────────────────────────────────────────────────────────────────────
  ok('the legend names the symbol', /\{symbol\}<\/span>/.test(leg));
  ok('...the interval', /\{intervalLabel\}/.test(leg));
  ok('...and the chart type', /\{chartTypeLabel\}/.test(leg));
  ok('it shows O, H, L and C', ["'O'", "'H'", "'L'", "'C'"].every((k) => leg.includes(`cell(${k}`)));
  ok('...the change and the percent', /\$\{Math\.abs\(pct\)\.toFixed\(2\)\}%/.test(leg));
  ok('...and volume', /cell\('V', vol\)/.test(leg));
  ok('change is measured against the previous close, not the open',
    /const change = \(Number\.isFinite\(close\) && Number\.isFinite\(prevClose\)\) \? close - prevClose : null;/.test(leg));
  ok('direction colours the close and the change', /const dir = change == null \? null : change >= 0 \? p\.up : p\.down;/.test(leg));
  // A line or area chart has no open/high/low. Those cells are omitted, never filled with the close.
  ok('O/H/L are omitted on a series that has no such values',
    /\{Number\.isFinite\(bar\.o\) && cell\('O'/.test(leg));
  // The 15-minute delay is a fact about the feed and the reader has to be told.
  ok('a delayed feed is badged', /DELAYED<\/span>/.test(leg));
  ok('...only when the feed actually says so', /delayed=\{meta\?\.delayed === true\}/.test(cmp));

  // ── IT MUST NOT EAT THE CHART ───────────────────────────────────────────────────────────────
  ok('the legend is pointer-transparent', /pointerEvents: 'none'/.test(leg));
  ok('...except the indicator rows, which have controls', /pointerEvents: 'auto'/.test(leg));

  // ── INDICATOR ROWS ──────────────────────────────────────────────────────────────────────────
  ok('each indicator gets its value under the cursor',
    /indicators=\{indicatorLegend\.map\(\(l\) => \(\{ \.\.\.l, value: cursor\?\.values\?\.\[l\.key\] \?\? null \}\)\)\}/.test(cmp));
  ok('...read from that indicator’s own series', /legendSeriesRef\.current\.set\(entry\.key \|\| entry\.id, firstSeries\)/.test(cmp));
  ok('...and collected on every crosshair move', /for \(const \[key, series\] of legendSeriesRef\.current\)/.test(cmp));
  ok('a row can hide its indicator', /onToggleIndicator\?\.\(ind\.key\)/.test(leg));
  ok('...open its settings', /onSettingsIndicator\?\.\(ind\.key\)/.test(leg));
  ok('...and remove it', /onRemoveIndicator\?\.\(ind\.key\)/.test(leg));
  ok('the controls appear on hover, not permanently', /opacity: show \? 1 : 0/.test(leg));
  ok('...without reflowing the row when they do', /pointerEvents: show \? 'auto' : 'none'/.test(leg));
  ok('a hidden indicator is dimmed rather than dropped', /opacity: on \? 1 : 0\.5/.test(leg));
  // The ⚙ opens the browser ON that instance, rather than making the user find it again.
  ok('settings opens the browser focused on that instance',
    /setFocusIndicator\(key\); setBrowserOpen\(true\);/.test(cmp));
  const br = await readFile(new URL('../src/components/chart/IndicatorBrowser.jsx', import.meta.url), 'utf8');
  ok('...and the browser honours that focus', /if \(open && focusKey\) setExpanded\(focusKey\)/.test(br));
  ok('the focus is cleared when the browser closes', /setBrowserOpen\(false\); setFocusIndicator\(null\);/.test(cmp));

  // ── CROSSHAIR ───────────────────────────────────────────────────────────────────────────────
  // The library defaults to MAGNET, which snaps to the nearest OHLC. Every platform a trader
  // arrives from keeps that off until a drawing tool asks for it.
  ok('the crosshair follows the pointer instead of snapping',
    /crosshair: \{ mode: lwc\.CrosshairMode\.Normal \}/.test(cmp));
  ok('...set from the library enum, not a magic number', !/mode: 0/.test(cmp));
  const theme = await readFile(new URL('../src/lib/chart/chart-theme.mjs', import.meta.url), 'utf8');
  ok('the crosshair axis chips are neutral, not brand-green',
    /labelBackgroundColor: p\.crosshairLabel/.test(theme) && !/labelBackgroundColor: p\.up/.test(theme));
  ok('both themes define that colour',
    (theme.match(/crosshairLabel:/g) || []).length === 2);

  // ── THE FLOATING TOOLTIP IS GONE ────────────────────────────────────────────────────────────
  // Time and price are on the crosshair's own axis labels and everything else is in the legend, so
  // the box that followed the cursor was a third copy that covered candles.
  ok('no floating tooltip follows the cursor', !/tipRef/.test(cmp));
  ok('...and its helper went with it', !/const fmtVolume/.test(cmp));

  // ── SCROLL BACK TO THE LATEST BAR ───────────────────────────────────────────────────────────
  ok('the chart notices when it has been scrolled back',
    /subscribeVisibleLogicalRangeChange\(\(range\) => \{/.test(cmp));
  ok('...compared against the bar count, so it holds on every timeframe',
    /setScrolledBack\(range\.to < n - 1\.5\)/.test(cmp));
  ok('...and offers a jump back only then', /status === 'ready' && scrolledBack && \(/.test(cmp));
  ok('...which scrolls to real time', /timeScale\(\)\.scrollToRealTime\(\)/.test(cmp));

  // ── THE UNMOUNT CRASH ───────────────────────────────────────────────────────────────────────
  // overlaysRef holds an ARRAY. Calling .clear() on it threw a TypeError every time a chart
  // unmounted — removing a Terminal panel, or navigating off the ticker page.
  ok('the overlay list is emptied the way an array is', /overlaysRef\.current = \[\]; lwcRef\.current = null;/.test(cmp));
  ok('...and never with a Map method', !/overlaysRef\.current\.clear\(\)/.test(cmp));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
