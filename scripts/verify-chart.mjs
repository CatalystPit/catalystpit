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
import { sma, ema, vwap, INDICATORS, availableIndicators } from '../src/lib/chart/chart-indicators.mjs';

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

section('8. the indicator seam is a real interface, not a promise');
{
  const bars = Array.from({ length: 30 }, (_, i) => ({
    time: i + 1, open: 10 + i, high: 11 + i, low: 9 + i, close: 10 + i, volume: 100,
  }));
  const s = sma(bars, { length: 5 });
  ok('SMA starts only once it has a full window', s.length === bars.length - 4);
  ok('SMA of a ramp is the middle value', Math.abs(s[0].value - 12) < 1e-9, String(s[0].value));
  ok('SMA carries the bar time', s[0].time === 5);
  ok('SMA of too-short input is empty', sma(bars.slice(0, 3), { length: 5 }).length === 0);

  const e = ema(bars, { length: 5 });
  ok('EMA is produced', e.length === bars.length - 4);
  ok('EMA tracks a rising series upward', e[e.length - 1].value > e[0].value);

  // VWAP must RESET each session, or it is not VWAP.
  const two = [
    { time: 1, high: 10, low: 10, close: 10, open: 10, volume: 100 },
    { time: 2, high: 20, low: 20, close: 20, open: 20, volume: 100 },
    { time: 3, high: 40, low: 40, close: 40, open: 40, volume: 100 },
  ];
  const cont = vwap(two);
  const perSession = vwap(two, { sessionKey: (b) => (b.time <= 2 ? 'd1' : 'd2') });
  ok('continuous VWAP averages across everything', Math.abs(cont[2].value - 23.333) < 0.01, String(cont[2].value));
  ok('session VWAP resets at the boundary', Math.abs(perSession[2].value - 40) < 1e-9, String(perSession[2].value));
  ok('VWAP with no volume returns nothing, not a flat line',
    vwap(two.map((b) => ({ ...b, volume: 0 }))).length === 0);

  ok('the registry exposes the implemented three', Object.keys(INDICATORS).sort().join() === 'ema,sma,vwap');
  ok('every registry entry declares its pane',
    Object.values(INDICATORS).every((i) => i.pane === 'price' || i.pane === 'separate'));
  ok('every registry entry is callable', Object.values(INDICATORS).every((i) => typeof i.compute === 'function'));
  ok('VWAP is offered on intraday', availableIndicators({ intraday: true }).some((i) => i.id === 'vwap'));
  ok('VWAP is NOT offered on daily', !availableIndicators({ intraday: false }).some((i) => i.id === 'vwap'));
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
