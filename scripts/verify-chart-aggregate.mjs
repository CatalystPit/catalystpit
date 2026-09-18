// LONG TIMEFRAMES ARE CANDLE INTERVALS, NOT WINDOWS.
//
// "1M" means one candle per calendar month over the security's whole history. It used to mean "the
// last month, drawn in daily candles", which is a different chart with the same label — about
// twenty-one candles where there should be one.
//
// This suite pins the arithmetic of the fold and the semantics of the registry. Every fixture is a
// literal series with a known answer, so nothing here depends on a provider, a clock or a zone.
//
// Run: node scripts/verify-chart-aggregate.mjs

import { aggregateBars, bucketStart, partsOf, PERIODS } from '../src/lib/chart/chart-aggregate.mjs';
import { timeframe, normalizeBars, barsUrl, isServable, DEFAULT_TIMEFRAME, TIMEFRAMES, isIntraday, supportsExtendedHours } from '../src/lib/chart/chart-source.mjs';
import { computeIndicator } from '../src/lib/chart/chart-indicators.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const bar = (date, o, h, l, c, v = 100) => ({ time: date, open: o, high: h, low: l, close: c, volume: v });

console.log('\n=== which calendar period a date belongs to ===');
{
  ok('a date is read off the characters, not through a Date', JSON.stringify(partsOf('2024-03-07')) === '{"y":2024,"m":3,"d":7}');
  ok('month buckets to its own first day', bucketStart('2024-03-07', 'month') === '2024-03-01');
  ok('year buckets to January 1st', bucketStart('2024-03-07', 'year') === '2024-01-01');
  // Calendar quarters: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec.
  const q = (d) => bucketStart(d, 'quarter');
  ok('Jan, Feb, Mar all fall in Q1', q('2024-01-31') === '2024-01-01' && q('2024-02-29') === '2024-01-01' && q('2024-03-31') === '2024-01-01');
  ok('Apr, May, Jun all fall in Q2', q('2024-04-01') === '2024-04-01' && q('2024-06-30') === '2024-04-01');
  ok('Jul, Aug, Sep all fall in Q3', q('2024-07-01') === '2024-07-01' && q('2024-09-30') === '2024-07-01');
  ok('Oct, Nov, Dec all fall in Q4', q('2024-10-01') === '2024-10-01' && q('2024-12-31') === '2024-10-01');
  // THE ZONE TRAP: 2024-01-01 parsed as a Date west of UTC is 2023-12-31, and January's candle
  // would join December's.
  ok('the first of January stays in January', bucketStart('2024-01-01', 'month') === '2024-01-01'
    && bucketStart('2024-01-01', 'year') === '2024-01-01');
  ok('the last of December stays in December', bucketStart('2024-12-31', 'month') === '2024-12-01'
    && bucketStart('2024-12-31', 'year') === '2024-01-01');
  ok('an unreadable date belongs to no period', bucketStart('not-a-date', 'month') === null && bucketStart(null, 'month') === null);
  ok('an unknown period is refused', bucketStart('2024-03-07', 'fortnight') === null);
  ok('the period vocabulary is exactly month/quarter/year', [...PERIODS].sort().join(',') === 'month,quarter,year');
}

console.log('\n=== monthly OHLCV ===');
{
  const bars = [
    bar('2024-01-02', 10, 12,  9, 11, 1000),
    bar('2024-01-15', 11, 15,  8, 14, 2000),   // the month's high AND its low
    bar('2024-01-31', 14, 14, 13, 13, 3000),
    bar('2024-02-01', 13, 20, 12, 19, 4000),
  ];
  const out = aggregateBars(bars, 'month');
  ok('one candle per month', out.length === 2, JSON.stringify(out.map((b) => b.time)));
  const jan = out[0];
  ok('OPEN is the first bar\'s open', jan.open === 10, String(jan.open));
  ok('HIGH is the maximum high', jan.high === 15, String(jan.high));
  ok('LOW is the minimum low', jan.low === 8, String(jan.low));
  ok('CLOSE is the last bar\'s close', jan.close === 13, String(jan.close));
  ok('VOLUME is the sum', jan.volume === 6000, String(jan.volume));
  ok('the candle is stamped with its period', jan.time === '2024-01-01', jan.time);
  // Not sampled, not averaged — the two failure modes the spec names.
  ok('the close is NOT the first close, and not a mean', jan.close !== 11 && jan.close !== (11 + 14 + 13) / 3);
  ok('February is its own candle', out[1].time === '2024-02-01' && out[1].open === 13 && out[1].close === 19);
}

console.log('\n=== quarterly OHLCV, on the calendar quarter ===');
{
  const bars = [
    bar('2024-01-02', 10, 11,  9, 10, 100),
    bar('2024-02-15', 10, 18,  7, 12, 200),
    bar('2024-03-28', 12, 13, 11, 13, 300),   // still Q1
    bar('2024-04-01', 13, 14, 12, 14, 400),   // Q2 begins
  ];
  const out = aggregateBars(bars, 'quarter');
  ok('Jan-Mar collapse into one candle', out.length === 2, JSON.stringify(out.map((b) => b.time)));
  ok('Q1 opens at January\'s open', out[0].open === 10);
  ok('Q1 closes at March\'s close', out[0].close === 13);
  ok('Q1 spans February\'s extremes', out[0].high === 18 && out[0].low === 7);
  ok('Q1 volume is the quarter\'s total', out[0].volume === 600, String(out[0].volume));
  ok('April starts Q2', out[1].time === '2024-04-01');
  // The boundary that matters: March 31 and April 1 must not share a candle.
  const edge = aggregateBars([bar('2024-03-31', 1, 1, 1, 1), bar('2024-04-01', 2, 2, 2, 2)], 'quarter');
  ok('March 31 and April 1 are different quarters', edge.length === 2, JSON.stringify(edge.map((b) => b.time)));
}

console.log('\n=== yearly OHLCV ===');
{
  const bars = [
    bar('2022-06-01', 50, 60, 40, 55, 10),
    bar('2022-12-30', 55, 70, 30, 65, 20),
    bar('2023-01-03', 65, 66, 64, 66, 30),
    bar('2023-12-29', 66, 90, 20, 80, 40),
  ];
  const out = aggregateBars(bars, 'year');
  ok('one candle per year', out.length === 2);
  ok('2022 opens at its first open and closes at its last close', out[0].open === 50 && out[0].close === 65);
  ok('2022 spans the year\'s extremes', out[0].high === 70 && out[0].low === 30);
  ok('2022 volume is the year\'s total', out[0].volume === 30);
  ok('2023 is separate', out[1].time === '2023-01-01' && out[1].close === 80 && out[1].high === 90);
  // Dec 31 / Jan 1 is the boundary a naive rolling window gets wrong.
  const edge = aggregateBars([bar('2023-12-31', 1, 1, 1, 1), bar('2024-01-01', 2, 2, 2, 2)], 'year');
  ok('December 31 and January 1 are different years', edge.length === 2, JSON.stringify(edge.map((b) => b.time)));
}

console.log('\n=== partial periods are real candles, not defects ===');
{
  // An issuer that IPO'd mid-month: the first candle covers only the days it traded.
  const ipo = aggregateBars([bar('2024-03-19', 20, 25, 19, 24, 500), bar('2024-03-20', 24, 26, 23, 25, 600)], 'month');
  ok('the IPO month is one partial candle', ipo.length === 1 && ipo[0].time === '2024-03-01');
  ok('it opens at the first trade, not at the month\'s start', ipo[0].open === 20 && ipo[0].close === 25);
  ok('and sums only the days that traded', ipo[0].volume === 1100);

  // The current month, still filling. It must grow rather than being withheld or padded.
  const partial = [bar('2024-05-01', 10, 11, 9, 10, 10), bar('2024-05-02', 10, 12, 10, 11, 20)];
  const before = aggregateBars(partial, 'month');
  const after = aggregateBars([...partial, bar('2024-05-03', 11, 15, 11, 14, 30)], 'month');
  ok('the current month stays one candle as days arrive', before.length === 1 && after.length === 1);
  ok('and updates in place', after[0].close === 14 && after[0].high === 15 && after[0].volume === 60,
    JSON.stringify(after[0]));
  ok('its open never moves', before[0].open === after[0].open);
}

console.log('\n=== gaps, leap days and missing volume ===');
{
  // Holidays and weekends: a month simply has fewer constituent bars. Nothing is manufactured.
  const sparse = aggregateBars([bar('2024-07-01', 5, 6, 4, 5), bar('2024-07-31', 5, 9, 3, 8)], 'month');
  ok('missing trading days do not create candles', sparse.length === 1 && sparse[0].high === 9 && sparse[0].low === 3);

  // A month with no data at all yields no candle — it is not a flat bar at the previous close.
  const skipped = aggregateBars([bar('2024-01-10', 1, 1, 1, 1), bar('2024-03-10', 2, 2, 2, 2)], 'month');
  ok('a month with no trading has no candle', skipped.length === 2
    && skipped.map((b) => b.time).join() === '2024-01-01,2024-03-01', JSON.stringify(skipped.map((b) => b.time)));

  // 2024 is a leap year; 2023 is not.
  ok('February 29 belongs to February', bucketStart('2024-02-29', 'month') === '2024-02-01');
  const leap = aggregateBars([bar('2024-02-28', 1, 2, 1, 2, 7), bar('2024-02-29', 2, 5, 2, 4, 11)], 'month');
  ok('the leap day is folded into its month', leap.length === 1 && leap[0].close === 4 && leap[0].volume === 18);
  ok('the leap day closes February, not March', leap[0].time === '2024-02-01');

  // Volume: absent must stay absent. Zero would assert that nothing traded.
  const noVol = aggregateBars([{ time: '2024-01-02', open: 1, high: 2, low: 1, close: 2, volume: null },
    { time: '2024-01-03', open: 2, high: 3, low: 2, close: 3, volume: null }], 'month');
  ok('no reported volume stays null, never 0', noVol[0].volume === null, String(noVol[0].volume));
  const someVol = aggregateBars([{ time: '2024-01-02', open: 1, high: 2, low: 1, close: 2, volume: null },
    { time: '2024-01-03', open: 2, high: 3, low: 2, close: 3, volume: 500 }], 'month');
  ok('a partially reported month sums what it has', someVol[0].volume === 500, String(someVol[0].volume));

  // A bar missing a price is dropped rather than repaired — it must not corrupt the period.
  const broken = aggregateBars([bar('2024-01-02', 10, 12, 9, 11, 100),
    { time: '2024-01-03', open: null, high: 99, low: 0, close: null, volume: 5 }], 'month');
  ok('an unusable bar cannot set the period\'s high or low', broken[0].high === 12 && broken[0].low === 9);
  ok('nor its volume', broken[0].volume === 100);
}

console.log('\n=== the series Lightweight Charts requires ===');
{
  const many = [];
  for (let y = 2020; y <= 2024; y++) for (let m = 1; m <= 12; m++) {
    many.push(bar(`${y}-${String(m).padStart(2, '0')}-05`, 1, 2, 0.5, 1.5, 10));
    many.push(bar(`${y}-${String(m).padStart(2, '0')}-20`, 1.5, 3, 1, 2, 20));
  }
  for (const period of ['month', 'quarter', 'year']) {
    const out = aggregateBars(many, period);
    const times = out.map((b) => b.time);
    ok(`${period}: strictly ascending`, times.every((t, i) => i === 0 || times[i - 1] < t), period);
    ok(`${period}: no duplicate timestamps`, new Set(times).size === times.length);
  }
  ok('60 months fold to 60 monthly candles', aggregateBars(many, 'month').length === 60);
  ok('…to 20 quarterly candles', aggregateBars(many, 'quarter').length === 20);
  ok('…and to 5 yearly candles', aggregateBars(many, 'year').length === 5);
  // Every input bar is accounted for exactly once.
  const totalVol = many.reduce((s, b) => s + b.volume, 0);
  for (const period of ['month', 'quarter', 'year']) {
    ok(`${period}: no volume is lost or double-counted`,
      aggregateBars(many, period).reduce((s, b) => s + b.volume, 0) === totalVol);
  }
}

console.log('\n=== the registry now says interval, not window ===');
{
  for (const [id, period, seconds] of [['1M', 'month', 2592000], ['3M', 'quarter', 7776000], ['1Y', 'year', 31536000]]) {
    const tf = timeframe(id);
    ok(`${id} is an aggregated interval`, tf.kind === 'aggregated' && tf.aggregate === period, JSON.stringify(tf));
    ok(`${id} asks for the full history`, tf.request.range === 'all' && tf.window === 'all', JSON.stringify(tf.request));
    ok(`${id} is one candle wide, not one day`, tf.barSeconds === seconds, String(tf.barSeconds));
    ok(`${id} is servable today`, isServable(id));
    ok(`${id} requests the daily endpoint with range=all`, barsUrl('AAPL', id) === '/api/chart-daily?ticker=AAPL&range=all', String(barsUrl('AAPL', id)));
    ok(`${id} is not intraday and has no extended hours`, !isIntraday(id) && !supportsExtendedHours(id));
  }
  // The windows that remain windows.
  for (const [id, range] of [['6M', '6M'], ['YTD', 'YTD'], ['All', 'all']]) {
    const tf = timeframe(id);
    ok(`${id} is still a daily window`, tf.kind === 'daily' && tf.barSeconds === 86400 && !tf.aggregate, JSON.stringify(tf));
    ok(`${id} still requests its own range`, tf.request.range === range);
  }
  // Shorter intervals must be untouched.
  for (const [id, seconds, sessions] of [['1m', 60, 1], ['5m', 300, 1], ['15m', 900, 5], ['1h', 3600, 20], ['4h', 14400, 60], ['1D', 300, 1], ['1W', 1800, 5]]) {
    const tf = timeframe(id);
    ok(`${id} is unchanged`, tf.kind === 'intraday' && tf.barSeconds === seconds && tf.window.sessions === sessions,
      JSON.stringify({ kind: tf.kind, barSeconds: tf.barSeconds, window: tf.window }));
  }
  ok('the default is a daily window, not a 20-year quarterly chart',
    timeframe(DEFAULT_TIMEFRAME).kind === 'daily', DEFAULT_TIMEFRAME);
  ok('every registry entry is still servable', TIMEFRAMES.every((t) => isServable(t.id)),
    TIMEFRAMES.filter((t) => !isServable(t.id)).map((t) => t.id).join(', '));
}

console.log('\n=== normalizeBars folds at the provider boundary ===');
{
  // The daily endpoint's actual shape: `candles` keyed on a date string.
  const payload = { candles: [
    { date: '2024-01-02', open: 10, high: 12, low: 9, close: 11, volume: 1000 },
    { date: '2024-01-31', open: 11, high: 14, low: 8, close: 13, volume: 2000 },
    { date: '2024-02-01', open: 13, high: 20, low: 12, close: 19, volume: 3000 },
  ], meta: { source: 'tiingo', delayed: false } };

  const monthly = normalizeBars(payload, '1M');
  ok('1M returns one candle per month', monthly.bars.length === 2, JSON.stringify(monthly.bars.map((b) => b.time)));
  ok('…with the month\'s OHLCV', monthly.bars[0].open === 10 && monthly.bars[0].high === 14
    && monthly.bars[0].low === 8 && monthly.bars[0].close === 13 && monthly.bars[0].volume === 3000,
    JSON.stringify(monthly.bars[0]));
  ok('…and reports the aggregated bar width', monthly.meta.barSeconds === 2592000, String(monthly.meta.barSeconds));

  const quarterly = normalizeBars(payload, '3M');
  ok('3M folds the same payload into one quarter', quarterly.bars.length === 1 && quarterly.bars[0].close === 19);

  const yearly = normalizeBars(payload, '1Y');
  ok('1Y folds it into one year', yearly.bars.length === 1 && yearly.bars[0].open === 10 && yearly.bars[0].volume === 6000);

  // A window timeframe must NOT be folded.
  const sixM = normalizeBars(payload, '6M');
  ok('6M is left as daily candles', sixM.bars.length === 3 && sixM.bars[0].time === '2024-01-02',
    JSON.stringify(sixM.bars.map((b) => b.time)));

  // Out-of-order and duplicate input still yields a clean series.
  const messy = { candles: [
    { date: '2024-02-01', open: 13, high: 20, low: 12, close: 19, volume: 3000 },
    { date: '2024-01-02', open: 10, high: 12, low: 9, close: 11, volume: 1000 },
    { date: '2024-01-02', open: 10, high: 13, low: 9, close: 12, volume: 1500 },
  ] };
  const fixed = normalizeBars(messy, '1M');
  ok('unsorted input still folds correctly', fixed.bars.map((b) => b.time).join() === '2024-01-01,2024-02-01');
  ok('a duplicated day is counted once', fixed.bars[0].volume === 1500, String(fixed.bars[0].volume));
}

console.log('\n=== indicators read the aggregated candles ===');
{
  // 26 monthly candles, rising by 1 a month, built from two daily bars each.
  const daily = [];
  for (let i = 0; i < 26; i++) {
    const y = 2022 + Math.floor(i / 12), m = (i % 12) + 1, base = 100 + i;
    daily.push({ date: `${y}-${String(m).padStart(2, '0')}-05`, open: base, high: base + 1, low: base - 1, close: base, volume: 10 });
    daily.push({ date: `${y}-${String(m).padStart(2, '0')}-20`, open: base, high: base + 2, low: base - 2, close: base, volume: 10 });
  }
  const monthly = normalizeBars({ candles: daily }, '1M').bars;
  ok('the fixture really is 26 monthly candles', monthly.length === 26, String(monthly.length));

  const ctx = { intraday: false, sessionKey: null };
  const { plots } = computeIndicator('sma', monthly, { length: 20 }, ctx);
  const sma = plots[0].data;
  // SMA 20 over MONTHLY candles: the first value appears on the 20th month and averages 20 months.
  ok('SMA 20 emits its first value on the 20th monthly candle', sma.length === 26 - 20 + 1, String(sma.length));
  ok('SMA 20 is stamped on a monthly timestamp', sma[0].time === monthly[19].time, String(sma[0].time));
  const expected = Array.from({ length: 20 }, (_, k) => 100 + k).reduce((a, b) => a + b, 0) / 20;
  ok('SMA 20 averages 20 MONTHS, not 20 days', Math.abs(sma[0].value - expected) < 1e-9,
    `${sma[0].value} vs ${expected}`);
  // The tell-tale of the old bug: computing on daily bars would have produced ~52 points.
  ok('it did not compute on the underlying daily bars', sma.length !== daily.length - 20 + 1);

  const rsi = computeIndicator('rsi', monthly, { length: 14 }, ctx).plots[0].data;
  ok('RSI 14 consumes 14 monthly candles', rsi.length === 26 - 14, String(rsi.length));
  ok('RSI is stamped on monthly timestamps', monthly.some((b) => b.time === rsi[0].time));

  // And on quarters and years, the same rule.
  const quarterly = normalizeBars({ candles: daily }, '3M').bars;
  const qsma = computeIndicator('sma', quarterly, { length: 4 }, ctx).plots[0].data;
  ok('SMA 4 on 3M averages 4 QUARTERS', qsma.length === quarterly.length - 4 + 1 && qsma[0].time === quarterly[3].time,
    `${quarterly.length} quarterly candles`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
