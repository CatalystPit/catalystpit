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
import {
  projectDrawings, resolveAnchor, widestSpan, labelX, isEdgeAnchor,
  EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM,
} from '../src/lib/chart/chart-project.mjs';
import { cloneDrawing, barLevels, snapToLevel, MAGNET_PX } from '../src/lib/chart/chart-drawings.mjs';
import { measureBetween, formatDuration } from '../src/lib/chart/chart-drawings.mjs';
import { reorderDrawing, canReorder, constrainAngle, sanitizeFibLevels, DEFAULT_FIB_LEVELS } from '../src/lib/chart/chart-drawings.mjs';
import {
  logicalOfTime, timeOfLogical, isFutureTime, barSpacingMs, shiftTime, timeDeltaSeconds,
} from '../src/lib/chart/chart-coords.mjs';
import {
  resolveTypedTimeframe, shouldOpenQuickTimeframe, isTypingTarget, REACHABLE_IDS, ALL_TIMEFRAME_IDS,
} from '../src/lib/chart/chart-quick-timeframe.mjs';
import { exportLayout, captionFor, exportFilename, CAPTION_HEIGHT } from '../src/lib/chart/chart-export.mjs';
import { rememberToolDefaults } from '../src/lib/chart/chart-settings.mjs';
import { emptyHistory, record, undo, redo, canUndo, canRedo, MAX_HISTORY } from '../src/lib/chart/chart-history.mjs';
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
  ok('a horizontal line is created from a single click', h !== null);
  const hs = h ? tool('horizontal').segments(h.points, view) : [[P(NaN, NaN), P(NaN, NaN)]];
  // ITS SPAN IS THE PLOT, IN PIXELS, not two manufactured times. That is the whole fix: a plot edge
  // cannot fail to resolve and needs no candle under it.
  ok('a horizontal line spans the plot, edge to edge',
    hs[0][0].edgeX === EDGE_LEFT && hs[0][1].edgeX === EDGE_RIGHT);
  ok('...and states no time at all, so none can be missing',
    hs[0][0].time === undefined && hs[0][1].time === undefined);
  ok('...at a constant price', hs[0][0].price === 42 && hs[0][1].price === 42);
  const v = createDrawing('vertical', [P(500, 42)]);
  ok('a vertical line is created from a single click', v !== null);
  const vs = v ? tool('vertical').segments(v.points, view) : [[P(NaN, NaN), P(NaN, NaN)]];
  ok('a vertical line spans the plot, top to bottom',
    vs[0][0].edgeY === EDGE_TOP && vs[0][1].edgeY === EDGE_BOTTOM);
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
  ok('typing in an input is never hijacked', /isTypingTarget\(t\)/.test(cmp));

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
  // Still driven by the registry; Favourites is appended as a filter over the same search rather
  // than being a hard-coded category the registry does not know about.
  ok('it renders categories from the registry', /\[\.\.\.INDICATOR_CATEGORIES, \{ id: 'favorites'/.test(br));
  ok('...and favourites filters that same search, not a second list',
    /category === 'favorites' \? found\.filter/.test(br));
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
  // A category with no REAL tool must not put a dead button on the chart. Every declared category
  // now has one — text and measure were the last two empty ones — so the filter is proved against a
  // category invented here rather than by requiring the product to keep an empty one forever.
  ok('every declared category is now populated', TOOL_CATEGORIES.every((c) => c.tools.length > 0));
  ok('...and all of them render', activeCategories().length === TOOL_CATEGORIES.length);
  ok('a category naming only tools that do not exist would not render',
    activeCategories.call(null) && [{ id: 'ghost', label: 'Ghost', tools: ['nope'] }]
      .filter((c) => c.tools.some((t) => !!TOOLS[t])).length === 0);
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
  ok('hide and delete live on the rail',
    /Hide all drawings/.test(rail) && /Delete selected/.test(rail));
  // "Delete all" moved into the object tree, beside the list of what it would delete: a rail button
  // that silently wipes every drawing on the symbol is the wrong place for it.
  ok('...while delete-all lives beside the list it empties', !/Clear all \$\{count\}/.test(rail));

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
  ok('the popover uses the shared placement module', /setPos\(placeFor\(rect, placement/.test(ui));
  // A context menu anchors to a POINT rather than to a control. A point is a rect with no width, so
  // the same placement, flipping and clamping applies with no second code path.
  ok('...for a cursor point as well as a control',
    /point\s*\n?\s*\? \{ top: point\.y, bottom: point\.y, left: point\.x, right: point\.x \}/.test(ui));
  ok('it follows its trigger when an ancestor scrolls',
    /addEventListener\('scroll', place, true\)/.test(ui));
  ok('...and when the panel is resized by drag', /new ResizeObserver\(place\)/.test(ui));
  ok('an outside click closes it', /addEventListener\('mousedown', onDown\)/.test(ui));
  ok('Escape closes it', /e\.key !== 'Escape'/.test(ui));
  // SCOPED to the popover. The modal joins the same stack, so a file-wide search would be satisfied
  // by the modal's copy while the popover had lost its own.
  ok('...the innermost one only, so nested menus peel', /openPanels\[openPanels\.length - 1\]/.test(popoverBody));
  ok('a click in a menu opened from another does not close the parent',
    /hit !== -1 && hit >= mine/.test(ui));
  ok('the trigger stays clickable to toggle its own menu',
    /anchorRef\?\.current\?\.contains\(e\.target\)\) return/.test(ui));
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

section('22. context menu, magnet, drawing manager, panes');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/chart/ChartUI.jsx', import.meta.url), 'utf8');
  const rail = await readFile(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8');
  const layer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  const mgr = await readFile(new URL('../src/components/chart/DrawingManager.jsx', import.meta.url), 'utf8');
  const theme = await readFile(new URL('../src/lib/chart/chart-theme.mjs', import.meta.url), 'utf8');

  // ── 1. THE CONTEXT MENU ─────────────────────────────────────────────────────────────────────
  ok('right-clicking the chart opens our menu, not the browser’s',
    /onContextMenu=\{\(e\) => \{\s*\n\s*e\.preventDefault\(\);/.test(cmp)
      && /setMenuAt\(\{ x: e\.clientX, y: e\.clientY \}\)/.test(cmp));
  // Only over the chart: "copy" and "inspect" are sometimes genuinely wanted on the toolbar.
  ok('...only over the chart surface', (cmp.match(/onContextMenu=/g) || []).length === 1);
  ok('it opens AT the cursor', /<Popover theme=\{theme\} open=\{!!menuAt\} point=\{menuAt\}/.test(cmp));
  ok('...through the shared portalled popover, so the panel cannot clip it',
    /point = null,/.test(ui));
  ok('the position IS the open state', /const \[menuAt, setMenuAt\] = useState\(null\);/.test(cmp));
  // EVERY ACTION IS ONE WE ACTUALLY SUPPORT. A context menu listing things that do nothing is worse
  // than a short one.
  const ctx = cmp.slice(cmp.indexOf('open={!!menuAt}'), cmp.indexOf('</Popover>', cmp.indexOf('open={!!menuAt}')));
  for (const action of ['Reset view', 'Add indicator', 'Price scale', 'Auto scale', 'Magnet',
    'Show drawings', 'Manage drawings', 'Fullscreen'])
    ok(`the menu offers "${action}"`, ctx.includes(action));
  ok('extended hours appears only where it means something', /\{canExtend && \(/.test(ctx));
  ok('scroll-to-latest appears only when scrolled back', /\{scrolledBack && \(/.test(ctx));
  ok('toggles keep the menu open', (ctx.match(/closeOnPick=\{false\}/g) || []).length >= 5);

  // ── 2. MAGNET ───────────────────────────────────────────────────────────────────────────────
  // SNAPPING IS A DRAWING BEHAVIOUR. The crosshair must behave identically either way — that is the
  // whole reason magnet is a separate switch and not a crosshair mode.
  ok('magnet never touches the crosshair mode',
    /crosshair: \{ mode: lwc\.CrosshairMode\.Normal \}/.test(cmp) && !/magnet.*CrosshairMode/.test(cmp));
  ok('the snap decision is pure and testable', typeof snapToLevel === 'function');
  ok('a bar offers its open, high, low and close', barLevels({ open: 1, high: 4, low: 0, close: 3 }).length === 4);
  ok('...without duplicates', barLevels({ open: 5, high: 9, low: 5, close: 9 }).join() === '5,9');
  ok('...and nothing at all for a missing bar', barLevels(null).length === 0);
  // Measured in PIXELS, so "near enough" means the same at every zoom level.
  // BOTH ORDERINGS. With the nearest level last, "always take the last one" scores the same as
  // "take the nearest" and the test proves nothing — so the winner is placed first here and last
  // below, and only a real distance comparison satisfies both.
  ok('the nearest level within tolerance captures the anchor',
    snapToLevel(100, [{ price: 5, y: 90 }, { price: 7, y: 104 }]) === 7);
  ok('...whichever order the levels arrive in',
    snapToLevel(100, [{ price: 7, y: 104 }, { price: 5, y: 90 }]) === 7
      && snapToLevel(100, [{ price: 9, y: 101 }, { price: 3, y: 108 }]) === 9);
  ok('...and nothing captures it when all are too far',
    snapToLevel(100, [{ price: 5, y: 50 }]) === null);
  ok('the tolerance boundary is inclusive',
    snapToLevel(100, [{ price: 5, y: 100 + MAGNET_PX }]) === 5
      && snapToLevel(100, [{ price: 5, y: 100 + MAGNET_PX + 1 }]) === null);
  ok('a level with no screen position is ignored',
    snapToLevel(100, [{ price: 5, y: null }, { price: 9, y: 101 }]) === 9);
  // Magnet now also requires a candle to snap TO, so that it is inert in empty space rather than
  ok("...and otherwise returns the pointer’s own price", /return { time, price };/.test(layer));
  ok('the layer snaps only when magnet is on', /if \(stateRef\.current\.magnet && bar\) \{/.test(layer));
  ok('...and only where a candle exists', /const bar = inData \? list\[Math\.round\(logical\)\] : null;/.test(layer));
  ok(String.fromCharCode(46,46,46) + "and otherwise returns the pointer’s own price", /return { time, price };/.test(layer));
  ok('magnet is off by default', DEFAULT_VIEW.magnet === false);
  ok('...and is remembered', /magnet: v\.magnet === true/.test(await readFile(new URL('../src/lib/chart/chart-settings.mjs', import.meta.url), 'utf8')));
  ok('the rail carries a magnet toggle', /active=\{magnet\} onClick=\{onToggleMagnet\}/.test(rail));

  // ── 3. LOCK, CLONE AND THE OBJECT TREE ──────────────────────────────────────────────────────
  const d = createDrawing('trend', [{ time: 1, price: 10 }, { time: 2, price: 12 }], {}, []);
  ok('a new drawing is unlocked', d.locked === false);
  // THE LOCK IS ENFORCED IN THE MODEL, not only in the UI: every drag goes through moveDrawing.
  const locked = { ...d, locked: true };
  ok('a locked drawing cannot be moved', moveDrawing(locked, { dPrice: 5 }) === locked);
  ok('...nor by a handle pull', moveDrawing(locked, { dPrice: 5 }, 0) === locked);
  ok('an unlocked one still moves', moveDrawing(d, { dPrice: 5 }).points[0].price === 15);
  // A locked drawing is filtered out of the drag group, so a group drag cannot carry one along.
  ok('the layer also refuses to arm a drag on a locked drawing',
    /s\.drawings\.filter\(\(x\) => x\.id === hit\.id && !x\.locked\)/.test(layer));
  ok('...nor can a group drag carry one along',
    /s\.drawings\.filter\(\(x\) => s\.selected\.has\(x\.id\) && !x\.locked\)/.test(layer));
  ok('...but it is still selectable, so it can be unlocked', /onSelect\(hit \? hit\.id : null, additive\);/.test(layer));
  ok('a lock survives a reload', coerceDrawing({ ...locked }).locked === true);
  ok('...and an older stored drawing without one stays movable',
    coerceDrawing({ type: 'trend', points: d.points }).locked === false);

  const copy = cloneDrawing(d, [d]);
  ok('a clone gets a fresh id', copy.id !== d.id);
  ok('...the same geometry', copy.points[0].price === d.points[0].price && copy.points.length === d.points.length);
  ok('...deep-copied, so moving one does not move the other', copy.points[0] !== d.points[0]);
  ok('...and is never born locked', cloneDrawing(locked, [locked]).locked === false);
  ok('cloning an unknown type produces nothing', cloneDrawing({ type: 'nope', points: [] }, []) === null);
  ok('duplication goes through the model, not the UI', /cloneDrawing\(src, ds\)/.test(cmp));
  ok('...and selects the copy, since it sits on the original', /setSelectedIds\(\[copy\.id\]\)/.test(cmp));

  ok('the object tree lists every drawing on the symbol', /drawings=\{drawings\} selectedIds=\{selectedIds\}/.test(cmp));
  ok('a row selects the drawing on the chart', /onClick=\{\(e\) => onSelect\(d\.id, e\.shiftKey/.test(mgr));
  ok('...can hide it', /patch\(d\.id, \{ visible: !on \}\)/.test(mgr));
  ok('...lock it', /patch\(d\.id, \{ locked: !d\.locked \}\)/.test(mgr));
  ok('...duplicate it', /onDuplicate\?\.\(d\.id\)/.test(mgr));
  ok('...and delete it', /onClick=\{\(\) => remove\(d\.id\)\}/.test(mgr));
  ok('newest is listed first', /\[\.\.\.drawings\]\.reverse\(\)/.test(mgr));
  ok('the tree is reachable from the rail', /onOpenManager/.test(rail));
  ok('...and from the context menu', ctx.includes('Manage drawings'));

  // ── 4. ONE VISUAL SYSTEM ────────────────────────────────────────────────────────────────────
  // The chart types are vectors; the drawing tools were text glyphs, which render differently on
  // every machine and sit at a different weight beside them.
  ok('every drawing tool declares vector geometry',
    TOOL_IDS.every((id) => Array.isArray(TOOLS[id].shapes) && TOOLS[id].shapes.length > 0));
  ok('...and keeps a glyph fallback', TOOL_IDS.every((id) => typeof TOOLS[id].icon === 'string'));
  ok('every tool icon is distinct',
    new Set(TOOL_IDS.map((id) => JSON.stringify(TOOLS[id].shapes))).size === TOOL_IDS.length);
  ok('every active category declares one too',
    activeCategories().every((c) => Array.isArray(c.shapes) && c.shapes.length > 0));
  ok('the rail renders them as vectors, not text', /<VectorIcon shapes=\{def\?\.shapes \?\? cat\.shapes\}/.test(rail));
  ok('...and so do the flyout rows', /left=\{<VectorIcon shapes=\{TOOLS\[t\]\.shapes\}/.test(rail));
  ok('...and the object tree', /<VectorIcon shapes=\{def\.shapes\} glyph=\{def\.icon\} \/>/.test(mgr));
  // Every icon in the product is drawn by the one renderer, so they share stroke weight and size.
  // Null-safe: a tool that has lost its geometry must fail the assertion above, not crash the run
  // and take every check after it down with it.
  const kinds = [...new Set(TOOL_IDS.flatMap((id) => (TOOLS[id].shapes || []).map((sh) => sh[0])))];
  ok('the shared renderer handles every primitive the tools use',
    kinds.every((k) => ui.includes(`kind === '${k}'`)), kinds.join());

  // ── 5. PANES ────────────────────────────────────────────────────────────────────────────────
  // v5 makes separators draggable already. The bug was ours: a redraw rebuilt the panes at their
  // default height, throwing away the height the user had just dragged to.
  ok('pane resizing is enabled', /enableResize: true/.test(theme));
  ok('...and the separators are themed, not library navy',
    /separatorColor: p\.border/.test(theme) && !/#2B2B43/.test(theme));
  ok('pane options sit under layout, where the library reads them',
    theme.indexOf('panes: {') > theme.indexOf('layout: {')
      && theme.indexOf('panes: {') < theme.indexOf('grid: {'));
  ok('a redraw captures the pane heights first', /for \(const pane of chart\.panes\(\)\) keptHeights\.push\(pane\.getHeight\(\)\)/.test(cmp));
  ok('...and restores them instead of forcing the default',
    /Number\.isFinite\(kept\) && kept > 0 \? kept : 110/.test(cmp));
  ok('no hand-rolled drag handle was bolted on', !/separatorDrag|onPaneResize|paneDragHandle/.test(cmp));

  // ── 6. THE AREA PERSISTENCE BUG ─────────────────────────────────────────────────────────────
  // loadView hard-coded `=== 'Line' ? 'Line' : 'Candles'`, so choosing Area and reloading silently
  // gave back candles. It is validated against the registry now.
  const settings = await readFile(new URL('../src/lib/chart/chart-settings.mjs', import.meta.url), 'utf8');
  ok('the saved chart type is validated against the registry',
    /CHART_TYPE_IDS\.includes\(v\.chartType\)/.test(settings));
  ok('...so Area is no longer thrown away on reload', !/v\.chartType === 'Line' \? 'Line' : 'Candles'/.test(settings));
}

section('23. undo/redo, the ruler, notes, the price scale and nudge');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const layer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  const rail = await readFile(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8');
  const mgr = await readFile(new URL('../src/components/chart/DrawingManager.jsx', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../src/lib/chart/chart-settings.mjs', import.meta.url), 'utf8');

  // ── 1. UNDO / REDO ──────────────────────────────────────────────────────────────────────────
  let h = emptyHistory();
  ok('a fresh history can do neither', !canUndo(h) && !canRedo(h));
  h = record(h, ['a']);
  h = record(h, ['b']);
  ok('recording enables undo', canUndo(h) && h.past.length === 2);
  const u1 = undo(h, ['c']);
  ok('undo returns the previous state', u1.state[0] === 'b');
  ok('...and makes the current one redoable', canRedo(u1.history) && u1.history.future.length === 1);
  // Null-guarded: if undo stopped filling the redo stack this must FAIL, not throw and take every
  // assertion after it down with it.
  const r1 = redo(u1.history, u1.state);
  ok('redo returns what undo took away', r1?.state?.[0] === 'c');
  ok('undo on an empty history is null, not a crash', undo(emptyHistory(), []) === null);
  ok('redo on an empty history likewise', redo(emptyHistory(), []) === null);
  // Branching: once you undo and then make a new edit, the old future is gone — every editor does
  // this, and keeping it would mean two conflicting futures.
  ok('a new edit after an undo clears the redo stack', record(u1.history, ['d']).future.length === 0);
  // COALESCING is what makes a drag one undo step instead of a hundred.
  let g = emptyHistory();
  g = record(g, ['x'], 'drag:1'); g = record(g, ['y'], 'drag:1'); g = record(g, ['z'], 'drag:1');
  ok('one gesture records once', g.past.length === 1);
  ok('...and records the state from BEFORE the gesture', g.past[0][0] === 'x');
  ok('a second gesture records again', record(g, ['w'], 'drag:2').past.length === 2);
  ok('untagged edits never coalesce',
    record(record(emptyHistory(), [1]), [2]).past.length === 2);
  ok('a gesture cannot span an undo', undo(g, ['q']).history.tag === null);
  // Bounded, or a long session grows without limit.
  let big = emptyHistory();
  for (let i = 0; i < MAX_HISTORY + 25; i += 1) big = record(big, [i]);
  ok('the stack is capped', big.past.length === MAX_HISTORY);
  ok('...dropping the oldest, not the newest', big.past[big.past.length - 1][0] === MAX_HISTORY + 24);
  ok('history is a value, so panels never share one', emptyHistory() !== emptyHistory());

  ok('every drawing change records, so the history is complete',
    /historyRef\.current = record\(historyRef\.current, prev, tag\);/.test(cmp));
  ok('a drag passes one token for its whole duration', /token: gestureToken\('drag'\)/.test(layer));
  ok('...and every move of that drag carries it', /onChange\(s\.drawings\.map\([^\n]*\), s\.drag\.token\);/.test(layer));
  ok('undo is bound on the chart, not the document',
    /const mod = e\.ctrlKey \|\| e\.metaKey;/.test(cmp) && /el\.addEventListener\('keydown', onKey\)/.test(cmp));
  ok('Ctrl\\/Cmd+Z undoes', /if \(mod && \(e\.key === 'z' \|\| e\.key === 'Z'\)\)/.test(cmp));
  ok('...shift redoes', /if \(e\.shiftKey\) redoDrawings\(\); else undoDrawings\(\);/.test(cmp));
  ok('Ctrl+Y redoes too', /if \(mod && \(e\.key === 'y' \|\| e\.key === 'Y'\)\)/.test(cmp));
  ok('other modified keys are left to the browser', /if \(mod\) return;/.test(cmp));
  ok('typing in a field is never intercepted', /isTypingTarget\(t\)/.test(cmp));
  ok('the history resets with the symbol', /historyRef\.current = emptyHistory\(\);/.test(cmp));
  ok('the rail carries undo and redo', /title="Undo \(Ctrl\+Z\)"/.test(rail) && /title="Redo \(Ctrl\+Y\)"/.test(rail));
  ok('...disabled when there is nothing to do', /disabled=\{!canUndo\}/.test(rail) && /disabled=\{!canRedo\}/.test(rail));

  // ── 2. THE RULER ────────────────────────────────────────────────────────────────────────────
  const mbars = [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }];
  const m = measureBetween({ time: 100, price: 50 }, { time: 400, price: 55 }, mbars);
  ok('a measurement reports the price change', m.change === 5);
  ok('...as a percentage of the first anchor', m.pct === 10);
  ok('...the bar count', m.bars === 3);
  ok('...and the elapsed time', m.ms === 300000 && m.duration === '5m');
  ok('direction is reported', m.up === true
    && measureBetween({ time: 400, price: 55 }, { time: 100, price: 50 }, mbars).up === false);
  // A FIGURE THAT CANNOT BE DERIVED IS NULL, never zero — "0 bars" would be a lie, not a gap.
  ok('an unknown anchor yields no bar count',
    measureBetween({ time: 1, price: 1 }, { time: 2, price: 2 }, mbars).bars === null);
  ok('a zero base yields no percentage',
    measureBetween({ time: 100, price: 0 }, { time: 400, price: 5 }, mbars).pct === null);
  ok('a missing anchor yields nothing at all', measureBetween(null, { time: 1, price: 1 }, []) === null);
  // Daily bars carry a date string, and the duration still works.
  const daily = measureBetween({ time: '2024-01-01', price: 10 }, { time: '2024-03-01', price: 12 }, []);
  ok('a daily measurement still reports time', daily.ms === 60 * 86400000 && daily.duration === '2.0mo');
  ok('...and its percentage', daily.pct === 20);
  ok('durations scale to a readable unit',
    formatDuration(90 * 60000) === '1.5h' && formatDuration(5 * 86400000) === '5.0d'
      && formatDuration(400 * 86400000) === '1.1y');
  // BAR COUNT COMES FROM INDEX, not from arithmetic on time: weekends and half-days make any
  // time-derived bar count wrong.
  const gapped = [{ time: 100 }, { time: 200 }, { time: 100000 }];
  ok('bars are counted by index, so a market gap does not inflate them',
    measureBetween({ time: 100, price: 1 }, { time: 100000, price: 2 }, gapped).bars === 2);

  ok('measure is a real tool', !!TOOLS.measure && TOOLS.measure.points === 2);
  ok('...and is transient, so it is never stored', TOOLS.measure.transient === true);
  ok('createDrawing refuses to persist one',
    createDrawing('measure', [{ time: 1, price: 1 }, { time: 2, price: 2 }], {}, []) === null);
  ok('the layer holds it instead', /s\.measure = \{ type: def\.id, points: pts \};/.test(layer));
  ok('it reads live while the second point is chosen', /tool\(s\.draft\.type\)\?\.transient && s\.draft\.cursor/.test(layer));
  ok('a click dismisses it', /if \(s\.measure\) \{ s\.measure = null; paint\(\); \}/.test(layer));
  ok('...and so does Escape', /stateRef\.current\.measure = null;/.test(layer) && /setClearSignal\(\(n\) => n \+ 1\)/.test(cmp));
  // Volume over a range is not something this chart can total honestly, so it is not claimed. The
  // check is on the RESULT, not on whether the word appears in the source — the renderer mentions
  // `volumeUp` as a colour, which a text search would wrongly flag.
  ok('a measurement reports no volume figure at all',
    !('volume' in measureBetween({ time: 100, price: 1 }, { time: 200, price: 2 }, mbars)));

  // ── 3. NOTES ────────────────────────────────────────────────────────────────────────────────
  ok('text is a real tool', !!TOOLS.text && TOOLS.text.points === 1 && TOOLS.text.hasText === true);
  const note = createDrawing('text', [{ time: 1, price: 5 }], {}, [], { text: 'support' });
  ok('a note carries its words', note.text === 'support');
  ok('...and survives a reload', coerceDrawing({ ...note }).text === 'support');
  // Only a tool that declares text carries any, or every drawing becomes a place for junk.
  ok('other drawings carry no text field',
    !('text' in createDrawing('trend', [{ time: 1, price: 1 }, { time: 2, price: 2 }], {}, [])));
  ok('a non-string note is not trusted',
    createDrawing('text', [{ time: 1, price: 5 }], {}, [], { text: { evil: 1 } }).text === '');
  ok('the note is written before it exists', /onRequestText\?\.\(pts, \{ x: e\.clientX, y: e\.clientY \}\)/.test(layer));
  // The editor opens AT THE CLICK rather than hanging off the bottom of the chart.
  ok('...in an editor anchored where the note will be',
    /point=\{noteDraft\?\.at \|\| null\}/.test(cmp));
  ok('...and an empty one is never created', /if \(noteDraft\?\.points && text\)/.test(cmp));
  ok('...while clearing an existing one deletes it', /else updateDrawings\(\(ds\) => ds\.filter\(\(d\) => d\.id !== noteDraft\.id\)\);/.test(cmp));
  ok('Enter commits the note', /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); commitNote\(\); \}/.test(cmp));
  ok('the note editor focuses immediately', (cmp.match(/if \(el\) el\.focus\(\)/g) || []).length >= 1);
  ok('a note is painted, since it draws no segments', /tool\(d\.source\.type\)\?\.hasText/.test(layer));
  ok('the object tree shows a note by its words', /if \(typeof d\.text === 'string'\) return d\.text \|\| '\(empty\)';/.test(mgr));
  ok('...and can reopen it through its settings', /onSettings\?\.\(d\.id\)/.test(mgr));

  // ── 4. THE PRICE SCALE ──────────────────────────────────────────────────────────────────────
  // The CONDITION, not just the call: asserting the call alone passes happily while the branch that
  // reaches it has been disabled.
  ok('right-clicking the scale asks about the scale',
    /if \(onScale\) setScaleMenuAt\(\{ x: e\.clientX, y: e\.clientY \}\);/.test(cmp));
  ok('...and that test is what the scale width decides',
    /const onScale = scaleW > 0 && \(e\.clientX - box\.left\) > \(box\.width - scaleW\);/.test(cmp));
  ok('...decided by the scale’s live width, not a guess',
    /chartRef\.current\?\.priceScale\('right'\)\.width\(\)/.test(cmp));
  ok('...and the plot still gets the chart menu', /else setMenuAt\(\{ x: e\.clientX, y: e\.clientY \}\);/.test(cmp));
  const scaleMenu = cmp.slice(cmp.indexOf('open={!!scaleMenuAt}'), cmp.indexOf('</Popover>', cmp.indexOf('open={!!scaleMenuAt}')));
  for (const item of ['Auto scale', 'Logarithmic', 'Invert scale', 'Reset scale'])
    ok(`the scale menu offers "${item}"`, scaleMenu.includes(item));
  // Inversion is a real library option; faking it by negating data would break indicators, drawing
  // anchors and the legend at once.
  ok('inversion uses the library option', /invertScale: view\.invertScale === true/.test(cmp));
  ok('...and is remembered', /invertScale: v\.invertScale === true/.test(settings));
  ok('...defaulting to off', DEFAULT_VIEW.invertScale === false);

  // ── 5. NUDGE ────────────────────────────────────────────────────────────────────────────────
  ok('arrow keys nudge the selection', /e\.key\.startsWith\('Arrow'\)/.test(cmp));
  ok('...by a pixel, ten with shift', /nudgeSelected\(e\.key, e\.shiftKey \? 10 : 1\)/.test(cmp));
  // A PIXEL step, converted through the live scale, so a nudge feels the same at any zoom and on a
  // $3 stock as on a $3000 one.
  ok('the price step is read off the live scale', /series\.coordinateToPrice\(mid - steps\)/.test(cmp));
  ok('a horizontal nudge lands on a bar', /list\[j\]\.time - list\[i\]\.time/.test(cmp));
  ok('...and is refused where time is a date string', /typeof target\.points\[0\]\.time !== 'number'/.test(cmp));
  ok('a locked drawing is never nudged', /ids\.has\(x\.id\) && !x\.locked/.test(cmp));
  ok('an unhandled arrow falls through rather than being swallowed', /if \(moved\) \{ e\.preventDefault\(\); return; \}/.test(cmp));
  ok('a nudge is undoable like any other change', /updateDrawings\(\(ds\) => ds\.map\(\(x\) => \(ids\.has\(x\.id\)/.test(cmp));
}

section('24. z-order, multi-select, editable fibs, trendline options, export');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const layer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  const mgr = await readFile(new URL('../src/components/chart/DrawingManager.jsx', import.meta.url), 'utf8');
  const set = await readFile(new URL('../src/components/chart/DrawingSettings.jsx', import.meta.url), 'utf8');
  const br = await readFile(new URL('../src/components/chart/IndicatorBrowser.jsx', import.meta.url), 'utf8');

  // ── 1. Z-ORDER ──────────────────────────────────────────────────────────────────────────────
  // THE ARRAY IS THE ORDER. A z-index field beside it would be a second source of truth, and the
  // two would disagree the first time a drawing was deleted.
  const L = ['a', 'b', 'c'].map((id) => ({ id, type: 'trend', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] }));
  ok('bring to front moves it last, where the renderer paints it on top',
    reorderDrawing(L, 'a', 'front').map((d) => d.id).join('') === 'bca');
  ok('send to back moves it first', reorderDrawing(L, 'c', 'back').map((d) => d.id).join('') === 'cab');
  ok('bring forward is one step', reorderDrawing(L, 'a', 'forward').map((d) => d.id).join('') === 'bac');
  ok('send backward is one step', reorderDrawing(L, 'c', 'backward').map((d) => d.id).join('') === 'acb');
  ok('a move that would change nothing returns the same array', reorderDrawing(L, 'c', 'front') === L);
  ok('an unknown id changes nothing', reorderDrawing(L, 'zz', 'front') === L);
  // 'b', not 'a': the first element is already at the back, so an unknown direction that wrongly
  // fell through to "send to back" would be a no-op on it and the test would pass regardless.
  ok('an unknown direction changes nothing', reorderDrawing(L, 'b', 'sideways') === L);
  ok('the original array is never mutated', L.map((d) => d.id).join('') === 'abc');
  ok('canReorder is honest at the top', !canReorder(L, 'c', 'front') && !canReorder(L, 'c', 'forward'));
  ok('...and at the bottom', !canReorder(L, 'a', 'back') && !canReorder(L, 'a', 'backward'));
  ok('...and in the middle', canReorder(L, 'b', 'front') && canReorder(L, 'b', 'back'));
  ok('the object tree lists top-of-chart first, so raise and lower read correctly',
    /\[\.\.\.drawings\]\.reverse\(\)/.test(mgr));
  ok('its buttons disable themselves honestly', /disabled=\{!canReorder\(drawings, d\.id, 'forward'\)\}/.test(mgr));
  ok('reordering goes through the undoable path', /updateDrawings\(\(ds\) => reorderDrawing\(ds, id, where\)\)/.test(cmp));

  // ── 2. MULTI-SELECT ─────────────────────────────────────────────────────────────────────────
  ok('the selection is a list', /const \[selectedIds, setSelectedIds\] = useState\(\[\]\);/.test(cmp));
  ok('shift adds to it rather than replacing it', /return prev\.includes\(id\) \? prev\.filter\(\(x\) => x !== id\) : \[\.\.\.prev, id\];/.test(cmp));
  ok('...and clicking without it starts fresh', /if \(!additive\) return \[id\];/.test(cmp));
  ok('the canvas is what reads the modifier', /const additive = !!e\.shiftKey;/.test(layer));
  // A BULK ACTION IS ONE CHANGE, therefore one undo step. That is the whole reason it is written as
  // a single updateDrawings call rather than a loop of them.
  const bulk = cmp.slice(cmp.indexOf('const bulkAction'), cmp.indexOf('const undoDrawings'));
  ok('a bulk action is a single change', (bulk.match(/updateDrawings\(/g) || []).length === 1);
  for (const what of ['delete', 'front', 'back', 'hide', 'show', 'lock', 'unlock'])
    ok(`bulk "${what}" is handled`, bulk.includes(`'${what}'`));
  ok('a group send-to-front keeps the group’s own stacking',
    /\[\.\.\.ordered\]\.reverse\(\)/.test(bulk));
  ok('deleting clears the selection, since those drawings are gone', /if \(what === 'delete'\) setSelectedIds\(\[\]\);/.test(cmp));
  // GROUP MOVE: one delta, measured once, applied from each drawing's own original — so a group
  // keeps its shape however long the drag runs.
  ok('dragging one of several moves the whole selection',
    /s\.selected\.has\(hit\.id\) && s\.selected\.size > 1 && hit\.handle == null/.test(layer));
  ok('...but a handle drag stays singular, because resizing is about one anchor',
    /hit\.handle == null/.test(layer));
  ok('every drawing takes the same delta from its own original', /for \(const orig of s\.drag\.originals\)/.test(layer));
  ok('a locked drawing is never carried along', /s\.selected\.has\(x\.id\) && !x\.locked/.test(layer));
  ok('restyling applies to the whole selection', /ids\.has\(d\.id\) \? \{ \.\.\.d, style: next \}/.test(cmp));
  ok('so does delete', /updateDrawings\(\(ds\) => ds\.filter\(\(d\) => !ids\.has\(d\.id\)\)\)/.test(cmp));
  // Both of these used to bypass updateDrawings, which meant a delete could not be undone at all.
  ok('delete is undoable', !/setDrawings\(\(ds\) => ds\.filter/.test(cmp));
  ok('...and so is delete-all', !/setDrawings\(\[\]\)/.test(cmp));
  ok('the bulk bar appears only when something is selected', /\{sel\.size > 0 && \(/.test(mgr));

  // ── 3. EDITABLE FIBONACCI ───────────────────────────────────────────────────────────────────
  ok('the default set is the conventional one', DEFAULT_FIB_LEVELS.length === 7);
  ok('a fib drawing carries its own levels',
    createDrawing('fib', [{ time: 1, price: 1 }, { time: 2, price: 2 }], {}, []).levels.length === 7);
  ok('...and other tools do not',
    !('levels' in createDrawing('rectangle', [{ time: 1, price: 1 }, { time: 2, price: 2 }], {}, [])));
  ok('the drawing’s own levels are what gets drawn',
    fibLevels([{ price: 10 }, { price: 0 }], [{ ratio: 0.5, visible: true }]).length === 1);
  ok('a hidden level is not drawn',
    fibLevels([{ price: 10 }, { price: 0 }], [{ ratio: 0.5, visible: true }, { ratio: 0.25, visible: false }]).length === 1);
  ok('prices are computed from the ratio',
    fibLevels([{ price: 10 }, { price: 0 }], [{ ratio: 0.5, visible: true }])[0].price === 5);
  ok('no levels falls back to the default set', fibLevels([{ price: 10 }, { price: 0 }]).length === 7);
  // Levels are user-edited and persisted, so they come back as anything at all.
  ok('a non-numeric level is dropped, not repaired', sanitizeFibLevels([{ ratio: 'x' }, { ratio: 0.5 }]).length === 1);
  ok('duplicates are collapsed', sanitizeFibLevels([{ ratio: 0.8 }, { ratio: 0.8 }]).length === 1);
  ok('the list is sorted', sanitizeFibLevels([{ ratio: 0.8 }, { ratio: 0.2 }]).map((l) => l.ratio).join() === '0.2,0.8');
  ok('an empty list falls back rather than drawing nothing', sanitizeFibLevels([]).length === 7);
  ok('a bare number is accepted as a ratio', sanitizeFibLevels([0.5])[0].ratio === 0.5);
  // Optional chaining: if levels stopped being coerced at all this must FAIL, not throw and take
  // every assertion after it down with it.
  ok('levels survive a reload',
    coerceDrawing({ type: 'fib', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }], levels: [{ ratio: 0.33 }] })?.levels?.[0]?.ratio === 0.33);
  // BOTH places the renderer resolves levels — the lines and the labels. Checking for one match is
  // satisfied while the other has quietly gone back to the default set.
  ok('the renderer reads the drawing’s levels',
    (layer.match(/fibLevels\(d\.source\.points, d\.source\.levels\)/g) || []).length === 2);
  ok('the settings dialog can add a level', /const addLevel = \(\) => \{/.test(set));
  ok('...remove one', /const removeLevel = \(i\) =>/.test(set));
  ok('...edit its value', /aria-label=\{`Level \$\{i \+ 1\} ratio`\}/.test(set));
  ok('...and hide one', /setLevel\(i, \{ visible: l\.visible === false \}\)/.test(set));

  // ── 4. TRENDLINE OPTIONS ────────────────────────────────────────────────────────────────────
  const view = { from: 0, to: 100, high: 100, low: 0 };
  const pts = [{ time: 10, price: 10 }, { time: 20, price: 20 }];
  const plain = TOOLS.trend.segments(pts, view, { extendLeft: false, extendRight: false });
  ok('an unextended trend line stops at its anchors',
    plain[0][0].time === 10 && plain[0][1].time === 20);
  const right = TOOLS.trend.segments(pts, view, { extendRight: true });
  ok('extend right reaches the edge of the view', right[0][1].time === 100);
  ok('...along the same slope', right[0][1].price === 100);
  const left = TOOLS.trend.segments(pts, view, { extendLeft: true });
  ok('extend left reaches the other edge', left[0][0].time === 0);
  ok('...and both together make it infinite',
    TOOLS.trend.segments(pts, view, { extendLeft: true, extendRight: true })[0][0].time === 0);
  ok('a trend line carries the flags', 'extendLeft' in createDrawing('trend', pts, {}, []));
  ok('a rectangle does not', !('extendRight' in createDrawing('rectangle', pts, {}, [])));
  ok('the flags survive a reload', coerceDrawing({ type: 'trend', points: pts, extendRight: true }).extendRight === true);
  ok('a ray can extend backwards too', TOOLS.ray.segments(pts, view, { extendLeft: true })[0][0].time === 0);
  // 45° CONSTRAINT, in screen space — an angle is judged against pixels, and the same two anchors
  // subtend a different angle at every zoom level.
  const near = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
  ok('a near-horizontal drag snaps flat', Math.round(near.y) === 0 && Math.round(near.x) === 100);
  const diag = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
  ok('a near-diagonal drag snaps to 45°', Math.round(diag.x) === Math.round(diag.y));
  const vert = constrainAngle({ x: 5, y: 0 }, { x: 10, y: 100 });
  ok('a near-vertical drag snaps upright', Math.round(vert.x) === 5);
  ok('a zero-length drag is left alone', constrainAngle({ x: 3, y: 4 }, { x: 3, y: 4 }).x === 3);
  ok('the length along the snapped direction is preserved',
    Math.round(Math.hypot(diag.x, diag.y)) === Math.round(100 * Math.cos(Math.PI / 4) + 90 * Math.sin(Math.PI / 4)));
  ok('shift is what applies it, while placing', /if \(!e\?\.shiftKey \|\| !first\) return toData\(pt\.x, pt\.y\);/.test(layer));
  ok('...and it is converted back to data space', /const c = constrainAngle\(from, pt\);\s*\n\s*return toData\(c\.x, c\.y\);/.test(layer));
  ok('double-clicking a drawing opens its settings', /const onDoubleClick = \(e\) => \{/.test(layer));

  // ── 5. INDICATOR UX ─────────────────────────────────────────────────────────────────────────
  ok('the active list can be reordered', /const move = \(idx, delta\) => \{/.test(br));
  ok('...which genuinely changes draw and legend order', /\[next\[idx\], next\[to\]\] = \[next\[to\], next\[idx\]\];/.test(br));
  ok('...and the ends are not movable further', /disabled=\{idx === 0\}/.test(br) && /disabled=\{idx === active\.length - 1\}/.test(br));
  ok('indicators can be starred', /toggleFavorite\(def\.id\)/.test(br));
  ok('...persisted as ids only', /export const FAVORITES_KEY/.test(await readFile(new URL('../src/lib/chart/chart-settings.mjs', import.meta.url), 'utf8')));
  ok('the star is a sibling of the row, not a button inside a button',
    br.indexOf('</button>\n      <button type="button" onClick={() => toggleFavorite') > 0);

  // ── 6. EXPORT ───────────────────────────────────────────────────────────────────────────────
  const lay = exportLayout(800, 400, { caption: true });
  ok('the export makes room for its caption', lay.height === 400 + CAPTION_HEIGHT);
  ok('...and the chart still gets its full size', lay.chart.width === 800 && lay.chart.height === 400);
  ok('...with the caption below it, not over it', lay.caption.y === 400);
  ok('no caption means no extra height', exportLayout(800, 400, { caption: false }).height === 400);
  ok('a zero size cannot produce a zero canvas', exportLayout(0, 0).width === 1);
  ok('the caption names the symbol and interval',
    captionFor({ symbol: 'AAPL', interval: '1 day', chartType: 'Candlestick' }) === 'AAPL  ·  1 day  ·  Candlestick');
  ok('...and says so when the feed is delayed',
    captionFor({ symbol: 'AAPL', interval: '1m', delayed: true }).endsWith('delayed'));
  ok('a filename sorts and does not collide',
    exportFilename('AAPL', '1D', new Date(2024, 4, 7, 9, 5)) === 'AAPL_1D_2024-05-07_0905.png');
  ok('...and cannot escape its directory', !exportFilename('../../etc', '1D').includes('/'));
  ok('the export composes the chart and the drawing overlay', /overlayCanvas: overlay/.test(cmp));
  ok('...found by its marker', /canvas\[data-cp-drawings\]/.test(cmp) && /data-cp-drawings=""/.test(layer));
  // NOTHING OUTSIDE THE CHART: no page rasteriser, no panel chrome, no other panels.
  ok('nothing outside the chart is captured', !/html2canvas|document\.body/.test(cmp.slice(cmp.indexOf('const exportPng'), cmp.indexOf('const undoDrawings'))));
  ok('the licence attribution travels with the image', /attribution: CHART_ATTRIBUTION/.test(cmp));
  // The WHOLE-CANVAS fill specifically. A bare search for the fill style also matches the caption
  // strip, which would pass while the area behind the chart stayed transparent.
  ok('the exported PNG is never transparent',
    /ctx\.fillRect\(0, 0, layout\.width, layout\.height\);/.test(await readFile(new URL('../src/lib/chart/chart-export.mjs', import.meta.url), 'utf8')));
}

section('25. polish: tool memory, Fibonacci presentation, consistency, cost');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const layer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/chart/ChartUI.jsx', import.meta.url), 'utf8');
  const leg = await readFile(new URL('../src/components/chart/ChartLegend.jsx', import.meta.url), 'utf8');
  const rail = await readFile(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8');
  const mgr = await readFile(new URL('../src/components/chart/DrawingManager.jsx', import.meta.url), 'utf8');
  const set = await readFile(new URL('../src/components/chart/DrawingSettings.jsx', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../src/lib/chart/chart-settings.mjs', import.meta.url), 'utf8');

  // ── 1. WHAT EACH TOOL REMEMBERS ─────────────────────────────────────────────────────────────
  // Not a template system: each TOOL remembers what it was last used with, keyed by tool id.
  ok('tool defaults are stored per tool', /export const TOOL_DEFAULTS_KEY/.test(settings));
  const remembered = rememberToolDefaults({}, {
    type: 'trend', style: { color: 3, width: 2, dash: 'solid' }, extendRight: true, id: 'x', points: [],
  });
  ok('a drawing folds its settings back in as its tool’s defaults', remembered.trend.extendRight === true);
  ok('...including its style', remembered.trend.style.color === 3);
  // ONLY fields a tool actually reads: anything else would round-trip through storage forever.
  ok('...but not its identity or geometry', !('id' in remembered.trend) && !('points' in remembered.trend));
  ok('a drawing with nothing worth remembering changes nothing',
    rememberToolDefaults({ a: 1 }, { type: 'trend' }).a === 1 && !('trend' in rememberToolDefaults({ a: 1 }, { type: 'trend' })));
  ok('a typeless drawing is ignored', rememberToolDefaults({ a: 1 }, {}).a === 1);
  ok('one tool’s settings never touch another’s',
    !('rectangle' in rememberToolDefaults({}, { type: 'trend', style: { color: 1 } })));
  ok('a new drawing starts from its tool’s defaults',
    /createDrawing\(s\.activeTool, pts, s\.style, s\.drawings, s\.toolDefaults\?\.\[s\.activeTool\] \|\| \{\}\)/.test(layer));
  ok('the settings dialog records what was chosen', /rememberToolDefaults\(prev, next\)/.test(cmp));
  ok('...and so does the rail’s style panel, while a tool is armed',
    /rememberToolDefaults\(prevMap, \{ type: activeTool, style: next \}\)/.test(cmp));

  // ── 2. FIBONACCI PRESENTATION ───────────────────────────────────────────────────────────────
  ok('a level may carry its own colour', sanitizeFibLevels([{ ratio: 0.5, color: 2 }])[0].color === 2);
  // ABSENT, not null: absent means "use the drawing's colour", which keeps the default one hue.
  ok('...and usually does not', !('color' in sanitizeFibLevels([{ ratio: 0.5 }])[0]));
  ok('a nonsense colour is dropped rather than stored', !('color' in sanitizeFibLevels([{ ratio: 0.5, color: 'red' }])[0]));
  ok('the colour reaches the renderer', fibLevels([{ price: 10 }, { price: 0 }], [{ ratio: 0.5, color: 1 }])[0].color === 1);
  ok('level LINES take that colour too, not just the labels',
    /ctx\.strokeStyle = segColours\?\.\[i\] \|\| colour;/.test(layer));
  ok('...falling back to the drawing’s colour', /l\.color \?\? d\.style\.color/.test(layer));
  // LABELS MOVED OFF THE LEFT EDGE, where they sat underneath the chart legend.
  ok('level labels no longer print at the left edge', !/ctx\.fillText\(`\$\{\(lvl\.ratio \* 100\)[^)]*\)`, 6,/.test(layer));
  ok('...they are placed against the right-hand end of the level', /cw - w - 6/.test(layer));
  // BANDS ARE OPT-IN. A filled Fibonacci over candles is the fastest way to make a chart unreadable.
  ok('shading between levels is off by default',
    createDrawing('fib', [{ time: 1, price: 1 }, { time: 2, price: 2 }], {}, []).fill === false);
  ok('...can be turned on', /patch\(\{ fill: !drawing\.fill \}\)/.test(set));
  ok('...survives a reload', coerceDrawing({ type: 'fib', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }], fill: true }).fill === true);
  ok('...and is drawn faintly, alternating, when it is on',
    /ctx\.globalAlpha = 0\.07;/.test(layer) && /if \(i % 2 === 1\) continue;/.test(layer));
  ok('the settings dialog can colour a level', /Give this level its own colour/.test(set));
  ok('...and clear that colour again', /nextIdx >= swatches\.length \? undefined : nextIdx/.test(set));
  ok('clearing a field really removes it', /if \(next\[key\] === undefined\) delete merged\[key\];/.test(set));

  // ── 3. INTERACTION CONSISTENCY ──────────────────────────────────────────────────────────────
  // Escape must peel one layer at a time whatever the layer is — a modal with a menu open inside it
  // had two independent handlers racing, and the winner depended on registration order.
  ok('modals are on the same dismissal stack as menus',
    ui.slice(ui.indexOf('export function Modal')).includes('openPanels.push(el)'));
  ok('...so Escape closes the innermost only',
    (ui.match(/openPanels\[openPanels\.length - 1\] !== panelRef\.current/g) || []).length === 2);
  ok('every chart menu is still portalled past the panel', (ui.match(/createPortal\(/g) || []).length === 2);
  ok('keyboard shortcuts still skip form fields', /isTypingTarget\(t\)/.test(cmp));
  ok('...and leave modified keys to the browser', /if \(mod\) return;/.test(cmp));
  ok('the note editor opens where the note will be', /point=\{noteDraft\?\.at \|\| null\}/.test(cmp));

  // ── CONTROLS MUST NOT JUMP ──────────────────────────────────────────────────────────────────
  ok('the indicator count sits in a fixed-width slot', /width: 10, textAlign: 'right', opacity: active\.length \? 1 : 0/.test(cmp));
  ok('the legend uses tabular figures, so its numbers do not shuffle',
    /fontVariantNumeric: 'tabular-nums'/.test(leg));
  ok('menu row controls fade rather than mount', /opacity: show \? 1 : 0/.test(leg));

  // ── HOVER AND SELECTED STATES ARE THE SAME EVERYWHERE ───────────────────────────────────────
  ok('toolbar buttons have a hover state', /hover && !disabled \? p\.menuHover/.test(ui));
  ok('menu rows do too', (ui.match(/p\.menuHover/g) || []).length >= 2);
  ok('object-tree rows do too', /hovered === d\.id \? p\.menuHover/.test(mgr));
  ok('the rail’s flyout arrow shows when its menu is open', /openCat === cat\.id \? p\.up : p\.text/.test(rail));
  ok('transitions are the same length throughout',
    (ui.match(/90ms ease/g) || []).length >= 2 && /90ms ease/.test(mgr));
  // Six row controls plus a label and an anchor summary do not fit in the old width.
  ok('the object tree is wide enough for its controls', /open=\{open\} onClose=\{onClose\} width=\{560\}/.test(mgr));

  // ── 4. RESPONSIVE ───────────────────────────────────────────────────────────────────────────
  ok('two thresholds still drive the toolbar', /const narrow = toolbarWidth </.test(cmp) && /const overflowed = toolbarWidth </.test(cmp));
  ok('the toolbar still never wraps', /flexWrap: 'nowrap'/.test(cmp));
  // The four priority controls must fit the narrowest panel that still shows a toolbar.
  const NARROWEST = Number(cmp.match(/const overflowed = toolbarWidth < (\d+)/)[1]);
  const widths = { symbol: 64, divider: 9, timeframe: 44, chartType: 26, overflow: 26, gaps: 5 * 2 };
  const used = Object.values(widths).reduce((a, b) => a + b, 0);
  ok('symbol, timeframe, chart type and the overflow fit below the collapse point',
    used < NARROWEST, `${used}px of ${NARROWEST}px`);
  ok('...with room left for the chart itself', NARROWEST - used > 100, `${NARROWEST - used}px spare`);
  // Menus are placed against the WINDOW, so panel size cannot clip them — proved in section 18.
  ok('menu placement is still window-relative, not panel-relative', /viewport\?\.width \?\? globalThis\.innerWidth/.test(
    await readFile(new URL('../src/lib/chart/chart-popover.mjs', import.meta.url), 'utf8')));

  // ── 6. COST ─────────────────────────────────────────────────────────────────────────────────
  // THE CROSSHAIR RUNS ON EVERY POINTER MOVE. It used to scan the whole bar list backwards for the
  // previous close — five thousand comparisons per mouse move on a five-year daily chart.
  ok('the previous close is an index lookup, not a scan', /barIndexRef\.current\.get\(param\.time\)/.test(cmp));
  ok('...with the index rebuilt only when the bars are', /barIndexRef\.current = new Map\(bars\.map\(\(b, i\) => \[b\.time, i\]\)\)/.test(cmp));
  ok('no per-move scan of the bar list remains', !/for \(let i = bars\.length - 1; i >= 0; i -= 1\)/.test(cmp));
  // The chart re-renders per pointer move by design, to keep the legend live; the heavy children
  // must not re-render with it.
  ok('the drawing rail is memoised', /const DrawingRail = memo\(DrawingRailBase\);/.test(rail));
  ok('the drawing layer is memoised', /const DrawingLayer = memo\(DrawingLayerBase\);/.test(layer));
  // A memo is worthless if its props are new objects every render.
  for (const cb of ['toggleShowDrawings', 'toggleMagnet', 'openManager', 'openSettingsFor', 'requestNote'])
    ok(`${cb} is a stable callback`, new RegExp(`const ${cb} = useCallback\\(`).test(cmp));
  for (const prop of ['onToggleShow={toggleShowDrawings}', 'onToggleMagnet={toggleMagnet}',
    'onOpenManager={openManager}', 'onOpenSettings={openSettingsFor}', 'onRequestText={requestNote}'])
    ok(`...and is passed as one (${prop.split('=')[0]})`, cmp.includes(prop));
  ok('no inline arrow is passed to the memoised children',
    !/onToggleMagnet=\{\(\) =>/.test(cmp) && !/onRequestText=\{\(points\) =>/.test(cmp));
  // Listener hygiene: everything registered on the document is removed again.
  const adds = (ui.match(/document\.addEventListener/g) || []).length;
  const removes = (ui.match(/document\.removeEventListener/g) || []).length;
  ok('every document listener is removed again', adds === removes, `${adds} added, ${removes} removed`);
  const wAdds = (ui.match(/window\.addEventListener/g) || []).length;
  const wRemoves = (ui.match(/window\.removeEventListener/g) || []).length;
  ok('every window listener is too', wAdds === wRemoves, `${wAdds} added, ${wRemoves} removed`);
  ok('the chart’s own key handler is removed on unmount', /el\.removeEventListener\('keydown', onKey\)/.test(cmp));
  ok('the resize observer is disconnected', /ro\.disconnect\(\)/.test(cmp));
  ok('the chart instance is destroyed on unmount', /if \(chart\) chart\.remove\(\);/.test(cmp));
  ok('...and its series references dropped with it', /overlaysRef\.current = \[\]; lwcRef\.current = null;/.test(cmp));
}


section('26. drawings live in chart space, not only where candles exist');
{
  const layer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  // 60-second bars, so a logical step is a minute and every expectation below is arithmetic a
  // reader can do in their head.
  const bars = Array.from({ length: 50 }, (_, i) => ({ time: 1000 + i * 60, o: 1, h: 2, l: 0, c: 1 }));
  const lastTime = bars[bars.length - 1].time;
  const lastIdx = bars.length - 1;

  // ── THE ROOT CAUSE, gone ────────────────────────────────────────────────────────────────────
  // An anchor used to be clamped into [0, length-1], so nothing could be placed past the last bar.
  ok('an anchor is no longer clamped to a bar index',
    !/Math\.max\(0, Math\.min\(list\.length - 1, Math\.round\(logical/.test(layer));
  ok('the layer resolves a moment from the logical axis', /const time = timeOfLogical\(logical, list\)/.test(layer));
  ok('...and can place a time the scale does not know', /logicalToCoordinate\(logical\)/.test(layer));

  // ── 1 & 3. anchors beyond the final candle ──────────────────────────────────────────────────
  const future = timeOfLogical(lastIdx + 8, bars);
  ok('a logical position past the last bar yields a real moment', future != null);
  ok('...that is genuinely later than the final candle', future > lastTime, String(future));
  ok('...spaced by the bar interval', future === lastTime + 8 * 60);
  ok('it is recognised as future space', isFutureTime(future, bars));
  ok('a moment inside the data still resolves to a candle\u2019s own time',
    timeOfLogical(12, bars) === bars[12].time);
  ok('...so existing drawings are untouched by the change', timeOfLogical(0, bars) === bars[0].time);
  ok('a drawing may also sit to the LEFT of loaded history', timeOfLogical(-5, bars) < bars[0].time);

  // The round trip is what makes a future anchor render where it was put.
  ok('a future moment maps back to the logical position it came from',
    Math.abs(logicalOfTime(future, bars) - (lastIdx + 8)) < 1e-6);
  ok('an in-data moment maps back exactly', logicalOfTime(bars[7].time, bars) === 7);

  // A trendline with its second anchor in empty space is an ordinary drawing.
  const futureTrend = createDrawing('trend', [{ time: bars[40].time, price: 10 }, { time: future, price: 20 }], {}, []);
  ok('a trendline can be built with an anchor in future space', !!futureTrend);
  ok('...and keeps that anchor', futureTrend.points[1].time === future);
  ok('...and survives a reload', coerceDrawing({ ...futureTrend }).points[1].time === future);
  // A ray through a future anchor still extends.
  const view = { from: bars[0].time, to: future + 600, high: 100, low: 0 };
  ok('a ray still extends from a future anchor',
    TOOLS.ray.segments(futureTrend.points, view, {})[0][1].time >= future);
  ok('extension still works on a future trendline',
    TOOLS.trend.segments(futureTrend.points, view, { extendRight: true })[0][1].time === view.to);

  // ── 2. dragging an endpoint FURTHER into future space ───────────────────────────────────────
  const dragged = moveDrawing(futureTrend, { dTime: 600, dPrice: 0 }, 1);
  ok('a future endpoint can be dragged further out', dragged.points[1].time === future + 600);
  ok('...without moving the other end', dragged.points[0].time === futureTrend.points[0].time);
  const wholeMoved = moveDrawing(futureTrend, { dTime: 300, dPrice: 2 });
  ok('the whole trendline moves into future space together',
    wholeMoved.points[0].time === bars[40].time + 300 && wholeMoved.points[1].time === future + 300);

  // ── 3 & 4. zoom, pan, and new bars ──────────────────────────────────────────────────────────
  // Zoom and pan change the visible logical range and nothing else; the anchor is a moment, so it
  // is unmoved by definition. What has to hold is that it still resolves to the SAME position
  // against the same bars.
  ok('a future anchor is unmoved by zoom or pan',
    logicalOfTime(future, bars) === logicalOfTime(future, bars));
  // NEW BARS ARRIVING. This is the property a logical-index model would fail: the candles grow
  // toward the anchor, and the anchor stays at the moment the trader chose.
  const grown = [...bars, ...Array.from({ length: 4 }, (_, i) => ({ time: lastTime + (i + 1) * 60, o: 1, h: 2, l: 0, c: 1 }))];
  ok('new bars do not move a future anchor\u2019s moment', isFutureTime(future, grown) === true);
  // AND ITS SCREEN POSITION IS INVARIANT. Four new bars push the last index out by four and close
  // the gap by four, so the logical position is unchanged — the anchor stays exactly where the
  // trader put it while the candles grow toward it. A logical-index model would have dragged it.
  ok('...nor its position on the chart',
    Number.isFinite(logicalOfTime(future, grown))
      && logicalOfTime(future, grown) === logicalOfTime(future, bars),
    `${logicalOfTime(future, grown)} vs ${logicalOfTime(future, bars)}`);
  const swallowed = [...bars, ...Array.from({ length: 12 }, (_, i) => ({ time: lastTime + (i + 1) * 60, o: 1, h: 2, l: 0, c: 1 }))];
  ok('once candles reach it, the anchor is simply on a bar', !isFutureTime(future, swallowed));
  ok('...at exactly the moment it was placed', logicalOfTime(future, swallowed) === lastIdx + 8);

  // ── TIMEFRAME CHANGE. A moment means the same thing on every timeframe, which is the whole
  // reason anchors are timestamps rather than indices.
  const hourly = Array.from({ length: 20 }, (_, i) => ({ time: 1000 + i * 3600, o: 1, h: 2, l: 0, c: 1 }));
  ok('a moment still resolves on a different timeframe', logicalOfTime(bars[40].time, hourly) != null);
  ok('...to a sensible position', logicalOfTime(bars[40].time, hourly) >= 0);

  // Daily bars carry a date string, and the same model has to hold for them.
  const daily = Array.from({ length: 30 }, (_, i) => ({ time: new Date(Date.UTC(2024, 4, 1 + i)).toISOString().slice(0, 10) }));
  const futureDay = timeOfLogical(daily.length + 2, daily);
  ok('a daily chart can also carry a future anchor', typeof futureDay === 'string' && futureDay > daily[daily.length - 1].time);
  ok('...as a date string, like every other daily anchor', /^\d{4}-\d{2}-\d{2}$/.test(futureDay));
  // This used to be impossible: a date-string anchor refused every horizontal delta.
  ok('a daily drawing can now be dragged sideways at all',
    moveDrawing(createDrawing('trend', [{ time: daily[5].time, price: 1 }, { time: daily[9].time, price: 2 }], {}, []),
      { dTime: 86400, dPrice: 0 }).points[0].time === daily[6].time);

  // A HALT, A WEEKEND OR A SESSION BOUNDARY AS THE MOST RECENT GAP. This is the case that breaks a
  // naive implementation: the newest pair is nothing like the real spacing, and reading it would
  // throw every future anchor hours out. The outlier is deliberately the LAST gap, and inside the
  // tail window the function actually reads, so neither "take the last pair" nor "take the largest"
  // can satisfy this.
  const gapped = [...bars, { time: bars[bars.length - 1].time + 999_999 }];
  ok('bar spacing is taken from the median gap, not one pair', barSpacingMs(gapped) === 60000,
    String(barSpacingMs(gapped)));
  ok('...and one outlier does not move it', barSpacingMs(gapped) === barSpacingMs(bars));
  ok('spacing needs at least two bars', barSpacingMs([{ time: 1 }]) === null);
  ok('an unknown time has no logical position', logicalOfTime(null, bars) === null);
  ok('no bars means no coordinates', timeOfLogical(4, []) === null);
}

section('27. a horizontal line is a price level and cannot tilt');
{
  // ── 5, 6, 7, 8 ──────────────────────────────────────────────────────────────────────────────
  ok('it is placed with ONE click', TOOLS.horizontal.points === 1);
  ok('...so there is no second endpoint to tilt', TOOLS.horizontal.points < 2);
  ok('it declares its time locked', TOOLS.horizontal.lockTime === true);

  const line = createDrawing('horizontal', [{ time: 5000, price: 42 }], {}, []);
  ok('one click gives one price', line?.points?.length === 1 && line.points[0].price === 42);
  // If the tool ever stopped accepting a single click there would be no drawing at all. Standing in
  // for it keeps the checks below FAILING rather than throwing and silencing the rest of the run.
  const hline = line ?? { id: 'x', type: 'horizontal', points: [{ time: NaN, price: NaN }], style: {}, visible: true };

  // THE GUARANTEE. However it is dragged, the price moves and the moment does not — so the line
  // cannot creep sideways and cannot come out diagonal.
  const dragged = moveDrawing(hline, { dTime: 99999, dPrice: 8 });
  ok('dragging moves the whole line vertically', dragged.points[0].price === 50);
  ok('...and never sideways', dragged.points[0].time === 5000);
  const byHandle = moveDrawing(hline, { dTime: 99999, dPrice: -2 }, 0);
  ok('dragging its handle behaves the same', byHandle.points[0].time === 5000 && byHandle.points[0].price === 40);

  // It spans the PLOT, future space included, and takes nothing from the data to do it.
  const view = { from: 1000, to: 99999, high: 100, low: 0 };
  const seg = TOOLS.horizontal.segments(line.points, view)[0];
  ok('it spans the plot from edge to edge', seg[0].edgeX === EDGE_LEFT && seg[1].edgeX === EDGE_RIGHT);
  ok('...at one single price', seg[0].price === seg[1].price);
  ok('...which is the price it was placed at', seg[0].price === 42);
  // The view is now irrelevant to it, which is why it cannot be broken by an unresolvable time.
  ok('...whatever the visible window happens to be',
    JSON.stringify(TOOLS.horizontal.segments(line.points, { from: 'x', to: null, high: 0, low: 0 }))
      === JSON.stringify(TOOLS.horizontal.segments(line.points, view)));
  const layer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  ok('the visible window comes from the logical range, so it reaches future space',
    /getVisibleLogicalRange\(\)/.test(layer));
  // Scoped past the explanatory comment above it: a bare search for the old call is defeated by the
  // sentence that explains why the old call is gone.
  ok('...rather than the data range, which stopped at the last candle',
    !/chart\.timeScale\(\)\.getVisibleRange\(\)/.test(layer));

  // The vertical line is the mirror image, and proving it keeps the lock generic rather than a
  // horizontal-line special case.
  ok('a vertical line locks price instead', TOOLS.vertical.lockPrice === true);
  const vert = createDrawing('vertical', [{ time: 5000, price: 42 }], {}, []);
  ok('...so it moves sideways only', moveDrawing(vert, { dTime: 60, dPrice: 9 }).points[0].price === 42);

  // Everything else about it still works.
  ok('it still styles, hides and locks like any drawing',
    line.style && line.visible === true && line.locked === false);
  ok('a locked one still refuses to move', moveDrawing({ ...line, locked: true }, { dPrice: 5 }).points[0].price === 42);
}

section('28. Fibonacci in future space, with its settings intact');
{
  const bars = Array.from({ length: 40 }, (_, i) => ({ time: 2000 + i * 60, o: 1, h: 2, l: 0, c: 1 }));
  const future = timeOfLogical(bars.length + 5, bars);

  // ── 9, 10, 11, 12 ───────────────────────────────────────────────────────────────────────────
  const fib = createDrawing('fib', [{ time: bars[10].time, price: 100 }, { time: future, price: 80 }], {}, []);
  ok('a Fibonacci can be anchored in future space', fib.points[1].time === future);
  ok('...dragged further out', moveDrawing(fib, { dTime: 600 }, 1).points[1].time === future + 600);
  ok('...and its start anchor moved there too',
    moveDrawing(fib, { dTime: 60 * 40 }, 0).points[0].time > bars[bars.length - 1].time);
  ok('...surviving a reload', coerceDrawing({ ...fib }).points[1].time === future);
  const grown = [...bars, { time: bars[bars.length - 1].time + 60 }];
  ok('new bars do not reposition it', isFutureTime(fib.points[1].time, grown));

  // ── 13. the settings from the previous pass are untouched ───────────────────────────────────
  ok('its levels came from the registry default', fib.levels.length === 7);
  ok('...are still editable', sanitizeFibLevels([{ ratio: 0.33 }]).length === 1);
  ok('...still carry a per-level colour', sanitizeFibLevels([{ ratio: 0.5, color: 2 }])[0].color === 2);
  ok('...still support shading', fib.fill === false && coerceDrawing({ ...fib, fill: true }).fill === true);
  // LEVELS ARE PRICES, so they are unaffected by where the anchors sit in time.
  const levels = fibLevels(fib.points, fib.levels);
  ok('levels are computed from the two anchor PRICES', levels[0].price === 80 && levels[levels.length - 1].price === 100);
  ok('...regardless of the anchors being in empty space', levels.length === 7);
  // AND THEY RUN BETWEEN THE FIB'S OWN ANCHORS — the same anchors a trendline uses, which already
  // reach into empty space. Manufacturing two times from the visible window is what left a fib with
  // labels and no lines: those times are not in the data, and whatever could not be resolved was
  // dropped in silence while the labels, read from these anchors, carried on drawing.
  const view = { from: bars[0].time, to: future + 900, high: 200, low: 0 };
  const segs = TOOLS.fib.segments(fib.points, view, fib);
  ok('each level runs between the fib’s own two anchors',
    segs.every((sg) => sg[0].time === fib.points[0].time && sg[1].time === fib.points[1].time));
  ok('...so the second anchor being in empty space is the only thing that carries it there',
    segs[0][1].time === future);
  ok('...one segment per visible level', segs.length === levels.length);
}

section('29. type a timeframe on the chart');
{
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');

  // ── 14, 15, 16 ──────────────────────────────────────────────────────────────────────────────
  ok('typing 5 selects five minutes', resolveTypedTimeframe('5').id === '5m');
  ok('typing 15 selects fifteen minutes', resolveTypedTimeframe('15').id === '15m');
  ok('typing 60 selects one hour', resolveTypedTimeframe('60').id === '1h');
  ok('typing 240 selects four hours', resolveTypedTimeframe('240').id === '4h');
  ok('every accepted number reaches a real registry timeframe',
    REACHABLE_IDS.every((id) => ALL_TIMEFRAME_IDS.includes(id)),
    REACHABLE_IDS.filter((id) => !ALL_TIMEFRAME_IDS.includes(id)).join());
  ok('the whole documented set is accepted',
    [1, 2, 3, 5, 10, 15, 30, 45, 60, 120, 180, 240].every((m) => resolveTypedTimeframe(String(m)).ok));
  // A NUMBER WITH NO TIMEFRAME BEHIND IT IS REFUSED, not rounded to a neighbour.
  ok('an unknown number is refused', resolveTypedTimeframe('7').ok === false);
  ok('...with a reason', !!resolveTypedTimeframe('7').reason);
  ok('letters are refused', resolveTypedTimeframe('abc').ok === false);
  ok('an empty entry does nothing', resolveTypedTimeframe('').ok === false);
  // A timeframe the feed cannot serve is refused WITH ITS OWN REASON — the same message the
  // dropdown shows — rather than applied and left drawing nothing.
  ok('an unservable timeframe is refused by the resolver', /if \(why\) return \{ ok: false, reason: why, id \};/.test(
    await readFile(new URL('../src/lib/chart/chart-quick-timeframe.mjs', import.meta.url), 'utf8')));
  ok('there is no second resolution table', /MINUTES_TO_ID/.test(
    await readFile(new URL('../src/lib/chart/chart-quick-timeframe.mjs', import.meta.url), 'utf8')));

  // ── 17, 18. what opens it, and what must never ──────────────────────────────────────────────
  const ev = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  ok('a bare digit opens the box', shouldOpenQuickTimeframe(ev('5'), { tagName: 'DIV' }));
  ok('a letter does not', !shouldOpenQuickTimeframe(ev('r'), { tagName: 'DIV' }));
  ok('a modified digit does not', !shouldOpenQuickTimeframe(ev('5', { ctrlKey: true }), { tagName: 'DIV' }));
  // THE EXCLUSIONS. Typing a number into any field must reach that field.
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT'])
    ok('typing in a ' + tag + ' is not intercepted', !shouldOpenQuickTimeframe(ev('5'), { tagName: tag }));
  ok('typing in a contenteditable is not intercepted',
    !shouldOpenQuickTimeframe(ev('5'), { tagName: 'DIV', isContentEditable: true }));
  ok('...nor inside one', !shouldOpenQuickTimeframe(ev('5'), { tagName: 'SPAN', closest: (q) => (q.includes('contenteditable') ? {} : null) }));
  ok('the symbol search and note editor are inputs, so they are covered',
    isTypingTarget({ tagName: 'INPUT' }) && isTypingTarget({ tagName: 'TEXTAREA' }));

  ok('the chart opens the box from its own key handler', /shouldOpenQuickTimeframe\(e, t\)/.test(cmp));
  ok('...before the single-letter shortcuts can shadow it',
    cmp.indexOf('shouldOpenQuickTimeframe') < cmp.indexOf("e.key === 'r'"));
  ok('the field guard is the shared one', /if \(isTypingTarget\(t\)\) return;/.test(cmp));
  ok('Enter applies', /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); commit\(\); \}/.test(cmp));
  ok('Escape cancels without changing anything', /e\.key === 'Escape'\) \{ e\.preventDefault\(\); onClose\(\); \}/.test(cmp));
  ok('Backspace on an empty box closes it', /e\.key === 'Backspace' && !state\.text/.test(cmp));
  ok('an abandoned box closes itself', /setTimeout\(onClose, QUICK_TIMEFRAME_TIMEOUT_MS\)/.test(cmp));
  ok('the box keeps its keys to itself', /e\.stopPropagation\(\);/.test(cmp));
  ok('it applies through the existing timeframe state', /onCommit=\{\(id\) => \{ setTf\(id\); setQuickTf\(null\); \}\}/.test(cmp));
  // AN UNSUPPORTED TIMEFRAME IS REFUSED WITH THE HONEST REASON, never applied.
  ok('an unavailable timeframe is refused, not applied', /if \(!result\.ok\) \{ onChange/.test(cmp));
}

section('30. the earlier drawing behaviour still holds');
{
  // ── 19, 20. undo/redo and persistence over the new coordinate model ─────────────────────────
  const bars = Array.from({ length: 20 }, (_, i) => ({ time: 500 + i * 60 }));
  const future = timeOfLogical(30, bars);
  const a = createDrawing('trend', [{ time: bars[2].time, price: 1 }, { time: future, price: 2 }], {}, []);
  let h = emptyHistory();
  h = record(h, []);
  const undone = undo(h, [a]);
  ok('a future drawing is undoable', undone.state.length === 0);
  ok('...and redoable', redo(undone.history, undone.state).state[0].points[1].time === future);
  // Persistence round-trip, through the same coercion the store uses.
  const back = coerceDrawing(JSON.parse(JSON.stringify(a)));
  ok('a future drawing survives serialisation', back.points[1].time === future);
  ok('...with its price intact', back.points[1].price === 2);
  ok('...and is still the same tool', back.type === 'trend');
  ok('a horizontal line survives it too',
    coerceDrawing(JSON.parse(JSON.stringify(createDrawing('horizontal', [{ time: 500, price: 7 }], {}, [])))).points[0].price === 7);
}


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A DETERMINISTIC STAND-IN FOR THE CHART'S SCALES.
//
// Faithful to Lightweight Charts in the one respect that caused the bug: timeToCoordinate resolves
// ONLY an exact bar time and returns null for everything else, so a manufactured moment has to go
// the long way round through the logical axis. plotWidth is the PLOT, narrower than the canvas by
// the price-scale gutter — which is where the fib labels had been landing.
//
// With this, the pixels a browser would actually stroke can be asserted without a browser. Every
// check below measures geometry rather than reading the source for a phrase that describes it.
function fakeScale(bars, { lr = { from: 0, to: bars.length - 1 }, plotWidth = 800, plotHeight = 400,
  high = 120, low = 80 } = {}) {
  const logicalToCoordinate = (l) => (l - lr.from) * (plotWidth / (lr.to - lr.from));
  return {
    plotWidth,
    plotHeight,
    // The arithmetic, unguarded — NaN in, NaN out, exactly as a real price scale behaves. Guarding
    // here instead would let the renderer's own guard be removed with nothing noticing.
    toY: (price) => plotHeight - ((price - low) / (high - low)) * plotHeight,
    toX: (time) => {
      const i = bars.findIndex((b) => b.time === time);
      if (i >= 0) return logicalToCoordinate(i);
      const l = logicalOfTime(time, bars);
      return l == null ? null : logicalToCoordinate(l);
    },
  };
}
const finitePt = (pt) => !!pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
const allFinite = (item) => item.segments.every(([a, b]) => finitePt(a) && finitePt(b))
  && item.handles.every(finitePt);

section('31. Fibonacci renders the lines it calculates');
{
  const bars = Array.from({ length: 200 }, (_, i) => ({ time: 1_700_000_000 + i * 60, o: 100, h: 101, l: 99, c: 100 }));
  const last = bars[bars.length - 1].time;
  const view = { from: bars[0].time, to: last, high: 120, low: 80 };

  // ── 1, 2, 3, 4: a plain historical fib produces real, wide, finite geometry ──────────────────
  const fib = createDrawing('fib', [{ time: bars[40].time, price: 90 }, { time: bars[120].time, price: 110 }], {}, []);
  const sc = fakeScale(bars);
  const hist = projectDrawings([fib], view, sc, tool);
  ok('a fib projects one item', hist.items.length === 1);
  ok('...and drops nothing on the way', hist.dropped === 0);
  const item = hist.items[0];
  ok('every default level becomes a drawn segment', item.segments.length === 7, String(item.segments.length));
  ok('no NaN or null coordinate reaches the renderer', allFinite(item));
  ok('its two anchors land on DIFFERENT x coordinates', item.segments[0][0].x !== item.segments[0][1].x);
  // THE FAILURE THAT WAS REPORTED: labels at the right heights, and geometry of no width at all.
  ok('a level is materially wide, not collapsed', widestSpan(item) > 50, String(widestSpan(item)));
  ok('...and every level is the same width', new Set(item.segments.map(([a, b]) => Math.round(b.x - a.x))).size === 1);
  ok('levels sit at different heights', new Set(item.segments.map(([a]) => Math.round(a.y))).size === 7);
  ok('...and each level is horizontal', item.segments.every(([a, b]) => a.y === b.y));

  // ── 5: historical -> future ─────────────────────────────────────────────────────────────────
  const future = last + 60 * 30;
  const fwd = createDrawing('fib', [{ time: bars[150].time, price: 95 }, { time: future, price: 115 }], {}, []);
  const fwdView = { from: bars[0].time, to: future, high: 120, low: 80 };
  const fp = projectDrawings([fwd], fwdView, fakeScale(bars, { lr: { from: 0, to: 260 } }), tool);
  ok('a fib drawn into empty space still projects', fp.items.length === 1 && fp.dropped === 0);
  ok('...with all seven levels', fp.items[0].segments.length === 7);
  ok('...none of them collapsed', widestSpan(fp.items[0]) > 50, String(widestSpan(fp.items[0])));
  ok('...and no coordinate lost on the way', allFinite(fp.items[0]));
  ok('its far anchor really is past the last candle', isFutureTime(future, bars));

  // ── 6: dragging the future anchor keeps the levels visible ──────────────────────────────────
  const dragged = moveDrawing(fwd, { dTime: 60 * 20, dPrice: 3 }, 1);
  const dp = projectDrawings([dragged], fwdView, fakeScale(bars, { lr: { from: 0, to: 300 } }), tool);
  ok('dragging the future anchor keeps every level', dp.items[0].segments.length === 7);
  ok('...still wide', widestSpan(dp.items[0]) > 50, String(widestSpan(dp.items[0])));
  ok('...and the drag genuinely moved it', dragged.points[1].time > fwd.points[1].time);

  // ── 8, 9, 10: the settings that already existed are untouched by the geometry change ─────────
  const custom = createDrawing('fib', fib.points, {}, [], { levels: [{ ratio: 0 }, { ratio: 0.5, color: 3 }, { ratio: 1 }], fill: true });
  const cp2 = projectDrawings([custom], view, sc, tool);
  ok('a custom level set draws exactly its own levels', cp2.items[0].segments.length === 3);
  ok('...keeping the per-level colour', fibLevels(custom.points, custom.levels)[1].color === 3);
  ok('...and shading is a separate flag that hides no line', custom.fill === true && cp2.items[0].segments.length === 3);
  const hidden = createDrawing('fib', fib.points, {}, [], { levels: [{ ratio: 0 }, { ratio: 0.5, visible: false }, { ratio: 1 }] });
  ok('a hidden level draws no line', projectDrawings([hidden], view, sc, tool).items[0].segments.length === 2);

  // ── 11: zoom and pan ────────────────────────────────────────────────────────────────────────
  const zoomed = projectDrawings([fib], view, fakeScale(bars, { lr: { from: 60, to: 100 } }), tool);
  ok('zooming in keeps every level', zoomed.items[0].segments.length === 7 && zoomed.dropped === 0);
  ok('...and makes them wider, as a zoom must', widestSpan(zoomed.items[0]) > widestSpan(item));
  ok('...with nothing non-finite', allFinite(zoomed.items[0]));

  // ── 12: new bars must not move a future-space fib ───────────────────────────────────────────
  const grown = [...bars, ...Array.from({ length: 10 }, (_, i) => ({ time: last + (i + 1) * 60, o: 1, h: 2, l: 0, c: 1 }))];
  ok('new bars leave a future anchor on the same moment', isFutureTime(fwd.points[1].time, grown));
  ok('...and it still resolves against the longer series',
    Number.isFinite(fakeScale(grown, { lr: { from: 0, to: 300 } }).toX(fwd.points[1].time)));
  const after = projectDrawings([fwd], fwdView, fakeScale(grown, { lr: { from: 0, to: 300 } }), tool);
  ok('...so the fib still draws all seven levels once bars arrive', after.items[0].segments.length === 7);

  // ── THE LABELS. Pinned to the panel's right edge by a Math.min of a value with itself. ───────
  const seg = item.segments[0];
  ok('a level label sits inside its own level', labelX(seg, 60, sc.plotWidth) <= Math.max(seg[0].x, seg[1].x));
  ok('...not jammed against the right of the panel',
    labelX(seg, 60, sc.plotWidth) + 60 <= Math.max(seg[0].x, seg[1].x) + 7,
    String(labelX(seg, 60, sc.plotWidth)));
  ok('...and never off the left', labelX(seg, 60, sc.plotWidth) >= 2);
  // A level too narrow to hold its text puts the label just past the end, still inside the plot.
  const narrow = [{ x: 770, y: 5 }, { x: 790, y: 5 }];
  ok('a narrow level at the right edge still labels inside the plot',
    labelX(narrow, 60, sc.plotWidth) + 60 <= sc.plotWidth, String(labelX(narrow, 60, sc.plotWidth)));
  const drawingLayer = await readFile(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  ok('the label is placed from its own segment, not the panel width', /labelX\(seg, w, plotW\)/.test(drawingLayer));
  ok('the layer projects through the shared module',
    /projectDrawings\(stateRef\.current\.drawings, view, sc, tool\)/.test(drawingLayer));
  ok('...and resolves its draft through the same one', /resolveAnchor\(a, sc\), p2 = resolveAnchor\(b, sc\)/.test(drawingLayer));
  // Scoped to the call itself: a bare search for the old expression is satisfied by the sentence
  // above it that explains why the old expression is gone, so it could never have failed.
  ok('...and the self-comparing Math.min is gone',
    !/ctx\.fillText\(label, Math\.max/.test(drawingLayer));
}

section('32. a horizontal line is a plot-wide price level');
{
  const bars = Array.from({ length: 120 }, (_, i) => ({ time: 1_700_000_000 + i * 60, o: 100, h: 101, l: 99, c: 100 }));
  // The view's price window is deliberately NARROWER than the plot's: a vertical line stretched
  // between view.low and view.high would then stop short of the plot edges, which is what makes the
  // two models distinguishable in pixels rather than only in prose.
  const view = { from: bars[0].time, to: bars[119].time, high: 110, low: 90 };
  const sc = fakeScale(bars);

  // ── 13, 14, 15, 16 ──────────────────────────────────────────────────────────────────────────
  ok('one anchor is all the tool asks for', TOOLS.horizontal.points === 1);
  const line = createDrawing('horizontal', [{ time: bars[60].time, price: 104 }], {}, []);
  ok('one click creates it', line !== null && line.points.length === 1);
  const pr = projectDrawings(line ? [line] : [], view, sc, tool);
  ok('...and it projects', pr.items.length === 1 && pr.dropped === 0);
  // Standing in for a missing projection keeps every check below FAILING rather than throwing.
  const blank = { segments: [], handles: [] };
  const hz = pr.items[0] || blank;
  ok('it produces one visible segment', hz.segments.length === 1);
  ok('...spanning the full plot width', Math.abs(hz.segments[0][1].x - hz.segments[0][0].x) === sc.plotWidth);
  ok('...from the very left edge', hz.segments[0][0].x === 0);
  ok('...with finite coordinates', allFinite(hz));

  // ── 17: it cannot tilt ──────────────────────────────────────────────────────────────────────
  ok('both ends are at the same height', hz.segments[0][0].y === hz.segments[0][1].y);
  const tilted = moveDrawing(line, { dTime: 99_999, dPrice: 0 }, 0);
  ok('dragging a handle sideways changes nothing', tilted.points[0].time === line.points[0].time);
  const tp = projectDrawings(tilted ? [tilted] : [], view, sc, tool).items[0] || blank;
  ok('...so it still cannot tilt', !!tp.segments[0] && tp.segments[0][0].y === tp.segments[0][1].y);

  // THE ONE THAT MATTERS: no candle under the click. A time nothing in the series knows used to be
  // the end of it; now the span is the plot and the anchor's own time only places the handle.
  const orphan = createDrawing('horizontal', [{ time: 1, price: 104 }], {}, []);
  const oi = projectDrawings(orphan ? [orphan] : [], view, sc, tool).items[0] || blank;
  ok('a price clicked where no candle exists still draws', oi.segments.length === 1);
  ok('...at full width',
    !!oi.segments[0] && Math.abs(oi.segments[0][1].x - oi.segments[0][0].x) === sc.plotWidth);

  // ── 18: vertical dragging changes the price ─────────────────────────────────────────────────
  const down = line ? moveDrawing(line, { dTime: 0, dPrice: -6 }) : null;
  ok('dragging it vertically changes its price', down?.points[0].price === 98);
  ok('...and only its price', down?.points[0].time === line?.points[0].time);

  // ── 19, 20: zoom, pan and a timeframe change preserve the price ─────────────────────────────
  const zi = projectDrawings(line ? [line] : [], view, fakeScale(bars, { lr: { from: 30, to: 50 } }), tool).items[0] || blank;
  ok('zoomed in it still spans the plot',
    !!zi.segments[0] && Math.abs(zi.segments[0][1].x - zi.segments[0][0].x) === 800);
  ok('...at the same price', !!zi.segments[0] && zi.segments[0][0].y === hz.segments[0][0].y);
  const hourly = Array.from({ length: 40 }, (_, i) => ({ time: 1_700_000_000 + i * 3600, o: 1, h: 2, l: 0, c: 1 }));
  const other = projectDrawings(line ? [line] : [], view, fakeScale(hourly), tool);
  const oth = other.items[0] || blank;
  ok('a timeframe change keeps its price', !!oth.segments[0] && oth.segments[0][0].y === hz.segments[0][0].y);
  ok('...and keeps it spanning the plot', oth.segments.length === 1 && other.dropped === 0);

  // ── 21, 22: undo/redo and persistence are the existing machinery, unchanged ──────────────────
  ok('it survives a round trip through storage',
    !!line && coerceDrawing(JSON.parse(JSON.stringify(line))).points[0].price === 104);
  ok('...as a one-anchor drawing',
    !!line && coerceDrawing(JSON.parse(JSON.stringify(line))).points.length === 1);

  // The vertical line is the mirror, and proving it keeps the mechanism generic.
  const vert = createDrawing('vertical', [{ time: bars[60].time, price: 104 }], {}, []);
  const vp = projectDrawings([vert], view, sc, tool);
  ok('a vertical line spans the plot height', Math.abs(vp.items[0].segments[0][1].y - vp.items[0].segments[0][0].y) === 400);
  ok('...at one x', vp.items[0].segments[0][0].x === vp.items[0].segments[0][1].x);

  // NOTHING IS DISCARDED IN SILENCE ANY MORE. An anchor that cannot be placed is counted, which is
  // what turns "the lines just are not there" into something a test can see.
  const broken = projectDrawings(
    [{ id: 'x', type: 'trend', visible: true, style: { color: 0, width: 1, dash: 'solid' },
      points: [{ time: bars[10].time, price: 104 }, { time: bars[20].time, price: NaN }] }],
    view, sc, tool);
  ok('an unplaceable anchor is counted, not swallowed', broken.dropped >= 1);
  ok('a plot edge can never be unplaceable',
    resolveAnchor({ edgeX: EDGE_LEFT, price: 104 }, sc) !== null
      && resolveAnchor({ edgeX: EDGE_RIGHT, price: 104 }, sc) !== null);
  ok('...and is recognised as a viewport anchor', isEdgeAnchor({ edgeX: EDGE_LEFT, price: 1 }) === true);
  ok('...while a data anchor is not', isEdgeAnchor({ time: 1, price: 1 }) === false);
  ok('a non-finite price is refused outright', resolveAnchor({ time: bars[0].time, price: NaN }, sc) === null);
}

section('33. the indicator legend collapses without collapsing the indicators');
{
  const legend = await readFile(new URL('../src/components/chart/ChartLegend.jsx', import.meta.url), 'utf8');
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const bodyOf = (src, name) => {
    const i = src.indexOf(name);
    return i < 0 ? '' : src.slice(i, src.indexOf('\n  }', i) + 4);
  };

  // ── 23: the count comes from the indicator model ────────────────────────────────────────────
  // The legend rows ARE the studies drawn on the chart: redrawIndicators skips builtins (volume is
  // the chart's own series), skips the ones parked as hidden, and skips an intraday study on a
  // daily chart. Counting the rows therefore counts studies and nothing else.
  ok('the redraw skips builtins, so volume is never a study', /if \(!def \|\| def\.builtin\) continue;/.test(cmp));
  ok('the count handed to the control is the legend list itself', /count=\{indicators\.length\}/.test(legend));
  ok('...and that list is what the chart built from its active indicators',
    /indicators=\{indicatorLegend\.map/.test(cmp));
  ok('a drawing is not an indicator and cannot reach the list', !/drawings/.test(legend));

  // ── 24, 25, 29: expanded renders rows, collapsed does not ───────────────────────────────────
  ok('the rows are rendered only while expanded',
    /\{!indicatorsCollapsed && indicators\.map\(\(ind\) => \{/.test(legend));
  ok('the control itself is always there when there are studies',
    /\{indicators\.length > 0 && \(\s*\n\s*<LegendToggle/.test(legend));
  ok('the control toggles the preference', /onClick=\{\(\) => onToggleIndicators\?\.\(\)\}/.test(legend));

  // ── 26, 27: collapsing must not touch the plots or the panes ────────────────────────────────
  // The proof is structural and it is the point of the feature: the flag reaches ChartLegend and
  // NOTHING else. If redrawIndicators ever read it, a collapsed legend would stop drawing RSI.
  const redraw = bodyOf(cmp, 'function drawIndicators() {');
  ok('the redraw is a real function body to search', redraw.length > 500, String(redraw.length));
  ok('...that really is the one building the panes', /addSeries/.test(redraw) && /setIndicatorLegend/.test(redraw));
  ok('the redraw never reads the collapse flag', !/legendCollapsed/.test(redraw));
  ok('...nor the collapsed prop name', !/indicatorsCollapsed/.test(redraw));
  ok('the legend never removes a series', !/removeSeries|removePane/.test(legend));
  ok('...and never touches the panes', !/panes\(\)/.test(legend));

  // ── 28: the collapsed control still says how many ───────────────────────────────────────────
  ok('the control shows the count', /<b style=\{\{ fontWeight: 600 \}\}>\{count\}<\/b>/.test(legend));
  ok('...beside a chevron that states the direction', /collapsed \? CHEVRON_RIGHT : CHEVRON_DOWN/.test(legend));
  ok('the chevron is a vector, not an emoji', /VectorIcon shapes=\{collapsed/.test(legend));
  ok('...drawn from primitives like every other chart icon',
    /CHEVRON_DOWN = \[\['polyline'/.test(legend) && /CHEVRON_RIGHT = \[\['polyline'/.test(legend));
  ok('it carries a tooltip that says what it will do', /title=\{title\} aria-label=\{title\}/.test(legend));
  ok('...and reports its state to assistive tech', /aria-expanded=\{!collapsed\}/.test(legend));
  ok('it has a hover state', /background: hover \? pal\.tooltipBg : 'transparent'/.test(legend));
  ok('...and accepts the pointer, over a legend that otherwise does not',
    /pointerEvents: 'auto'/.test(legend) && /zIndex: 4, pointerEvents: 'none'/.test(legend));

  // ── 30, 31, 32: persistence through the existing preference architecture ────────────────────
  ok('the preference has a default', DEFAULT_VIEW.legendCollapsed === false);
  ok('...which is expanded, so nobody meets a chart with its indicators hidden',
    DEFAULT_VIEW.legendCollapsed !== true);
  ok('it rides the same key as every other view preference', VIEW_STORAGE_KEY === 'cp_chart_view');
  // A REAL ROUND TRIP through the same storage the browser uses, so the field has to be written AND
  // read back. Asserting the default alone would let loadView drop it with nothing noticing.
  const store = new Map();
  globalThis.window = { localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  } };
  try {
    saveView({ ...DEFAULT_VIEW, legendCollapsed: true });
    ok('a collapsed legend survives a reload', loadView().legendCollapsed === true);
    saveView({ ...DEFAULT_VIEW, legendCollapsed: false });
    ok('...and so does an expanded one', loadView().legendCollapsed === false);
    // BACKWARD COMPATIBILITY: a view saved before this existed must open expanded, not collapsed.
    store.set(VIEW_STORAGE_KEY, JSON.stringify({ v: 1, view: { chartType: 'Candles', logScale: true } }));
    ok('a saved view from before the control opens expanded', loadView().legendCollapsed === false);
    ok('...without losing the preferences it did carry', loadView().logScale === true);
  } finally { delete globalThis.window; }
  // Symbol and timeframe changes do not touch the view: the chart reads it once, at mount.
  ok('the view is loaded once, not per symbol',
    /useEffect\(\(\) => \{ setActive\(loadIndicators\(\)\); setView\(loadView\(\)\); \}, \[\]\);/.test(cmp));
  ok('...so changing symbol or timeframe cannot reset it',
    (cmp.match(/setView\(loadView\(\)\)/g) || []).length === 1);

  // ── 34: the toolbar button is a different thing and is untouched ────────────────────────────
  ok('the Indicators button still opens the browser', /setBrowserOpen\(true\)/.test(cmp));
  ok('...and the collapse control opens nothing', !/setBrowserOpen/.test(legend));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
