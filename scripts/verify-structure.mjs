// Market Structure — regression suite.
//
// The two claims that matter most, and the ones a synthetic fixture can prove:
//   NO FUTURE LEAKAGE. A pivot is not knowable until its right shoulder prints, and everything
//     downstream — levels, zones, touch counts — respects the asOf boundary.
//   ZONES ARE REAL PRICE RANGES derived from real levels, scaled to the security, and never
//     an arbitrary band with reasons found inside it.
//
// Run: node scripts/verify-structure.mjs

import {
  aggregateBars, buildTimeframes, completedOnly, weekStart, monthStart, nextPeriodStart,
  periodKey, atr, TIMEFRAMES,
} from '../src/lib/structure/bars.mjs';
import { findSwings, swingsAsOf, deriveTrend, touchHistory, structuralEvents, TREND } from '../src/lib/structure/swings.mjs';
import { sma, smaAt, maSlope, movingAverages, maStructure, MA_SETS } from '../src/lib/structure/moving-averages.mjs';
import { candidateLevels, zoneUnit, prominence, LEVEL_KIND, ZONE_MIN_PCT, ZONE_MAX_PCT } from '../src/lib/structure/levels.mjs';
import { clusterLevels, buildZones, describeZone, selectZones, priceRelationship, MAJOR_CRITERIA, PRICE_STATE } from '../src/lib/structure/zones.mjs';
import { marketStructure, timeframeStructure, describeAlignment, ALIGNMENT } from '../src/lib/structure/engine.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── fixtures ─────────────────────────────────────────────────────────────────
// Weekdays only, starting Monday 2024-01-01.
function weekdays(n, from = '2024-01-01') {
  const out = []; let t = Date.parse(`${from}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t); const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}
const bar = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });

// A deterministic zig-zag: rises to 120, falls to 90, rises to 130.
function zigzag(dates) {
  const path = [];
  const legs = [[100, 120], [120, 90], [90, 130]];
  const per = Math.floor(dates.length / legs.length);
  for (const [a, b] of legs) {
    for (let i = 0; i < per; i++) path.push(a + ((b - a) * i) / per);
  }
  while (path.length < dates.length) path.push(path[path.length - 1]);
  return dates.map((d, i) => {
    const c = path[i];
    return bar(d, c, c + 1, c - 1, c);
  });
}

// ── 1. bar aggregation ───────────────────────────────────────────────────────
sec('BAR AGGREGATION');

check('weekStart returns the Monday', weekStart('2024-01-03') === '2024-01-01');
check('weekStart of a Monday is itself', weekStart('2024-01-01') === '2024-01-01');
check('weekStart of a Sunday is the Monday BEFORE it',
  weekStart('2024-01-07') === '2024-01-01', weekStart('2024-01-07'));
check('monthStart returns the first', monthStart('2024-03-17') === '2024-03-01');
check('nextPeriodStart weekly advances 7 days', nextPeriodStart('2024-01-03', 'weekly') === '2024-01-08');
check('nextPeriodStart monthly advances a month', nextPeriodStart('2024-03-17', 'monthly') === '2024-04-01');
check('nextPeriodStart rolls the year', nextPeriodStart('2024-12-05', 'monthly') === '2025-01-01');
check('periodKey groups by week', periodKey('2024-01-04', 'weekly') === '2024-01-01');

{
  // One full week: Mon 1st … Fri 5th of Jan 2024.
  const d = [
    bar('2024-01-01', 10, 12, 9, 11), bar('2024-01-02', 11, 15, 10, 14),
    bar('2024-01-03', 14, 16, 8, 9), bar('2024-01-04', 9, 13, 7, 12),
    bar('2024-01-05', 12, 14, 11, 13),
  ];
  const [w] = aggregateBars(d, 'weekly', { asOf: '2024-01-20' });
  check('weekly open is the FIRST session open', w.open === 10);
  check('weekly high is the max session high', w.high === 16);
  check('weekly low is the min session low', w.low === 7);
  check('weekly close is the LAST session close', w.close === 13);
  check('weekly volume is the sum', w.volume === 5000);
  check('weekly bar is dated by its period key', w.date === '2024-01-01');
  check('weekly bar records its last session', w.lastSession === '2024-01-05');
  check('weekly bar counts its sessions', w.sessions === 5);
}
{
  // A holiday-shortened week folds without inventing the missing session.
  const d = [bar('2024-01-01', 10, 12, 9, 11), bar('2024-01-03', 11, 13, 10, 12)];
  const [w] = aggregateBars(d, 'weekly', { asOf: '2024-01-20' });
  check('a short week is not padded', w.sessions === 2);
  check('a short week still aggregates correctly', w.open === 10 && w.close === 12 && w.high === 13);
}
{
  const d = weekdays(40).map((x, i) => bar(x, 100 + i, 101 + i, 99 + i, 100 + i));
  const weekly = aggregateBars(d, 'weekly', { asOf: d[d.length - 1].date });
  const last = weekly[weekly.length - 1];
  check('the forming period is flagged incomplete', last.complete === false);
  check('earlier periods are complete', weekly[0].complete === true);
  check('completedOnly drops the forming bar',
    completedOnly(weekly).length === weekly.length - 1);
  check('completeness is CALENDAR-based, not data-based',
    // asOf well past the data: every period is then complete.
    aggregateBars(d, 'weekly', { asOf: '2030-01-01' }).every((b) => b.complete));
}
check('an empty series aggregates to nothing', aggregateBars([], 'weekly').length === 0);
check('an unknown timeframe yields nothing', aggregateBars([bar('2024-01-01', 1, 1, 1, 1)], 'hourly').length === 0);
check('buildTimeframes returns all three',
  Object.keys(buildTimeframes(weekdays(30).map((x) => bar(x, 1, 2, 0.5, 1.5)))).join(',') === 'daily,weekly,monthly');

// ── 2. no future leakage ─────────────────────────────────────────────────────
sec('POINT IN TIME — NO FUTURE LEAKAGE');

{
  const dates = weekdays(60);
  const bars = zigzag(dates);
  const sw = findSwings(bars, { width: 3 });
  check('swings are found', sw.length > 0);
  check('every pivot confirms AFTER the bar it sits on',
    sw.every((s) => s.confirmedAt > s.date));
  check('confirmation is exactly width bars later',
    sw.every((s) => {
      const i = bars.findIndex((b) => b.date === s.date);
      return bars[i + 3]?.date === s.confirmedAt;
    }));
  check('the final width bars can never confirm',
    sw.every((s) => bars.findIndex((b) => b.date === s.date) < bars.length - 3));

  // THE LEAKAGE TEST: at the pivot's own date it must not yet be visible.
  const p = sw[0];
  check('a pivot is NOT visible on its own bar',
    swingsAsOf(sw, p.date).every((s) => s.date !== p.date));
  check('a pivot IS visible once confirmed',
    swingsAsOf(sw, p.confirmedAt).some((s) => s.date === p.date));
  check('asOf before everything yields nothing',
    swingsAsOf(sw, '2020-01-01').length === 0);
  check('asOf after everything yields all',
    swingsAsOf(sw, '2030-01-01').length === sw.length);
}
{
  // Touch history must stop at the boundary.
  const dates = weekdays(40);
  const bars = dates.map((d, i) => bar(d, 100, 101, i === 20 ? 90 : 99, 100));
  const before = touchHistory(bars, 90, 1, { side: 'support', asOf: dates[10] });
  const after = touchHistory(bars, 90, 1, { side: 'support', asOf: dates[30] });
  check('touches before the event are not counted early', before.touches === 0);
  check('touches are counted once they have happened', after.touches === 1);
}

// ── 3. trend ─────────────────────────────────────────────────────────────────
sec('TREND FROM SWING SEQUENCE');

const mkSwing = (kind, price, i) => ({ kind, price, date: `d${i}`, confirmedAt: `d${i + 3}`, index: i });
check('higher highs and higher lows is an uptrend',
  deriveTrend([mkSwing('swing_low', 90, 1), mkSwing('swing_high', 110, 2), mkSwing('swing_low', 95, 3), mkSwing('swing_high', 120, 4)]).trend === TREND.UP);
check('lower highs and lower lows is a downtrend',
  deriveTrend([mkSwing('swing_high', 120, 1), mkSwing('swing_low', 95, 2), mkSwing('swing_high', 110, 3), mkSwing('swing_low', 90, 4)]).trend === TREND.DOWN);
check('a higher high with a lower low is a RANGE, not an uptrend',
  deriveTrend([mkSwing('swing_high', 110, 1), mkSwing('swing_low', 95, 2), mkSwing('swing_high', 120, 3), mkSwing('swing_low', 90, 4)]).trend === TREND.RANGE);
check('too few swings is insufficient-history',
  deriveTrend([mkSwing('swing_high', 110, 1)]).trend === TREND.UNKNOWN);
check('the trend states its evidence',
  deriveTrend([mkSwing('swing_low', 90, 1), mkSwing('swing_high', 110, 2), mkSwing('swing_low', 95, 3), mkSwing('swing_high', 120, 4)]).reasons.length >= 2);
check('the trend discloses which pivot it is anchored on',
  deriveTrend([mkSwing('swing_low', 90, 1), mkSwing('swing_high', 110, 2), mkSwing('swing_low', 95, 3), mkSwing('swing_high', 120, 4)]).asOfPivot === 'd4');

// ── 4. moving averages ───────────────────────────────────────────────────────
sec('MOVING AVERAGES BY TIMEFRAME');

check('daily uses 20/50/200', MA_SETS.daily.map((m) => m.period).join(',') === '20,50,200');
check('weekly uses 10/30/40', MA_SETS.weekly.map((m) => m.period).join(',') === '10,30,40');
check('monthly uses 10/20', MA_SETS.monthly.map((m) => m.period).join(',') === '10,20');
check('there is NO 200-month average', !MA_SETS.monthly.some((m) => m.period === 200));

{
  const b = weekdays(30).map((d, i) => bar(d, 100, 100, 100, 100 + i));
  check('sma averages the closes', sma(b, 10) === (100 + 20 + 100 + 29) / 2 - 0 ? true : Math.abs(sma(b, 10) - 124.5) < 0.001);
  check('sma is null when history is short', sma(b, 100) === null);
  check('an average is NEVER approximated from fewer bars', sma(b.slice(0, 5), 20) === null);
  check('smaAt computes at an arbitrary index', Math.abs(smaAt(b, 5, 9) - 107) < 0.001);
  check('a rising series has a rising slope', maSlope(b, 5, { lookback: 10 })?.direction === 'rising');
  const mas = movingAverages(b, 'daily');
  check('unavailable averages are reported, not omitted',
    mas.length === 3 && mas.some((m) => !m.available && m.reason.includes('200')));
  check('available averages carry price relation',
    mas.find((m) => m.period === 20)?.priceVs?.above === true);
}

// ── 5. levels ────────────────────────────────────────────────────────────────
sec('CANDIDATE LEVELS');

{
  const dates = weekdays(120);
  const bars = zigzag(dates);
  const levels = candidateLevels(bars, 'daily', { price: bars[bars.length - 1].close });
  check('levels are produced', levels.length > 0);
  check('levels carry their timeframe', levels.every((l) => l.timeframe === 'daily'));
  check('levels carry a confirmation date', levels.every((l) => l.confirmedAt));
  check('levels carry a real price', levels.every((l) => Number.isFinite(l.price)));
  check('levels are sorted by price', levels.every((l, i) => i === 0 || levels[i - 1].price <= l.price));
  check('moving averages appear as levels', levels.some((l) => l.kind === LEVEL_KIND.MOVING_AVERAGE));
  check('a swing high price closed above becomes a PRIOR BREAKOUT',
    levels.some((l) => l.kind === LEVEL_KIND.PRIOR_BREAKOUT));
  check('every level has a human label', levels.every((l) => typeof l.label === 'string' && l.label.length));
}
check('prominence is measured in ATR units',
  prominence([bar('a', 1, 10, 0, 5), bar('b', 1, 20, 0, 5), bar('c', 1, 10, 0, 5)], 1, LEVEL_KIND.SWING_HIGH, 2) === 5);

// ── 6. zone width scales with the security ───────────────────────────────────
sec('ZONE WIDTH SCALES WITH THE SECURITY');

{
  const cheap = weekdays(60).map((d, i) => bar(d, 7, 7.2, 6.8, 7 + (i % 3) * 0.05));
  const rich = weekdays(60).map((d, i) => bar(d, 500, 515, 485, 500 + (i % 3) * 3));
  const uCheap = zoneUnit(cheap, 7);
  const uRich = zoneUnit(rich, 500);
  check('a $7 stock gets a small dollar unit', uCheap < 1, String(uCheap));
  check('a $500 stock gets a large dollar unit', uRich > 5, String(uRich));
  check('the unit is NOT a fixed dollar amount', uCheap !== uRich);
  // The percentage floor and ceiling.
  const flat = weekdays(60).map((d) => bar(d, 100, 100, 100, 100));
  check('a zero-range series still gets the percentage floor',
    Math.abs(zoneUnit(flat, 100) - 100 * ZONE_MIN_PCT) < 0.001);
  const wild = weekdays(60).map((d, i) => bar(d, 10, 30, 1, 10 + (i % 2) * 5));
  check('an extreme-range series is capped at the percentage ceiling',
    zoneUnit(wild, 10) <= 10 * ZONE_MAX_PCT + 0.0001);
}

// ── 7. clustering ────────────────────────────────────────────────────────────
sec('CLUSTERING');

const lv = (price, timeframe = 'daily', extra = {}) => ({
  price, timeframe, kind: LEVEL_KIND.SWING_LOW, confirmedAt: '2024-01-10',
  touches: 1, prominence: 0.5, label: 'confirmed swing low', ...extra,
});
{
  const unit = 10;
  const groups = clusterLevels([lv(100), lv(101), lv(102), lv(130)], unit);
  check('nearby levels join one cluster', groups[0].components.length === 3, String(groups[0].components.length));
  check('a distant level starts a new cluster', groups.length === 2);
  check('a cluster cannot exceed the width ceiling',
    clusterLevels([lv(100), lv(103), lv(106), lv(109), lv(112)], unit)
      .every((g) => g.high - g.low <= unit * 1.0 + 1e-9));
  check('clustering is deterministic',
    JSON.stringify(clusterLevels([lv(102), lv(100), lv(101)], unit))
    === JSON.stringify(clusterLevels([lv(100), lv(101), lv(102)], unit)));
  check('no levels means no clusters', clusterLevels([], unit).length === 0);
}
{
  // The zone IS the span of its components — not an invented band around a guess.
  const z = describeZone({ components: [lv(100), lv(108)], low: 100, high: 108 }, { unit: 10, price: 120, side: 'support' });
  check('zone low is the lowest component', z.low === 100);
  check('zone high is the highest component', z.high === 108);
  check('zone carries a midpoint', z.mid === 104);
  check('zone reports its width', z.width === 8);
  check('zone reports distance to the NEAR edge', z.distance === 12);
  check('zone reports distance as a percentage', Math.abs(z.distancePct - 10) < 0.05);
  check('zone preserves every component', z.components.length === 2);
  check('zone states its reasons in words', z.reasons.length === 2 && z.reasons[0].includes('Daily'));
  check('a single-level cluster still gets a width',
    describeZone({ components: [lv(100)], low: 100, high: 100 }, { unit: 10, price: 110, side: 'support' }).width > 0);
  // A zone is a REGION. Two levels at an identical price must not print as "$344.57–$344.57".
  const flat = describeZone({ components: [lv(344.57, 'daily'), lv(344.57, 'weekly')], low: 344.57, high: 344.57 },
    { unit: 7.7, price: 336, side: 'resistance' });
  check('identically-priced components still produce a real range', flat.width > 0, String(flat.width));
  check('the padded zone is centred on the level', Math.abs(flat.mid - 344.57) < 0.001);
  // Touches are the best-evidenced component, not the sum — the same reaction seen by two
  // timeframes is one reaction.
  const shared = describeZone({ components: [lv(100, 'daily', { touches: 50 }), lv(100.2, 'weekly', { touches: 49 })], low: 100, high: 100.2 },
    { unit: 10, price: 120, side: 'support' });
  check('touches are not double-counted across timeframes', shared.touches === 50, String(shared.touches));
}

// ── 8. multi-timeframe and MAJOR ─────────────────────────────────────────────
sec('MULTI-TIMEFRAME AND MAJOR');

{
  const z = describeZone({
    components: [lv(100, 'daily'), lv(100.5, 'weekly'), lv(101, 'monthly')], low: 100, high: 101,
  }, { unit: 10, price: 110, side: 'support' });
  check('a zone knows its timeframes', z.timeframes.length === 3);
  check('a zone flags multi-timeframe', z.multiTimeframe === true);
  check('timeframes are ordered highest first', z.timeframes[0] === 'monthly');
  check('multi-timeframe counts toward MAJOR', z.majorCriteria.includes(MAJOR_CRITERIA.MULTI_TIMEFRAME));
  check('higher-timeframe counts toward MAJOR', z.majorCriteria.includes(MAJOR_CRITERIA.HIGHER_TIMEFRAME));
  check('MAJOR is reached by named criteria', z.major === true && z.majorCriteria.length >= 2);
}
{
  const z = describeZone({ components: [lv(100, 'daily')], low: 100, high: 100 }, { unit: 10, price: 110, side: 'support' });
  check('a lone daily level is NOT major', z.major === false);
  check('a non-major zone still lists any criteria it met', Array.isArray(z.majorCriteria));
}
check('MAJOR is never a numeric score',
  !Object.values(MAJOR_CRITERIA).some((c) => /\d/.test(c)));

{
  // Distant levels must NOT merge just because they come from different timeframes.
  const groups = clusterLevels([lv(100, 'daily'), lv(160, 'monthly')], 10);
  check('distant cross-timeframe levels stay separate', groups.length === 2);
}
{
  const zones = [
    describeZone({ components: [lv(105, 'daily')], low: 105, high: 105 }, { unit: 10, price: 110, side: 'support' }),
    describeZone({ components: [lv(90, 'weekly'), lv(91, 'monthly')], low: 90, high: 91 }, { unit: 10, price: 110, side: 'support' }),
  ];
  const sel = selectZones(zones);
  // Narrow clusters are padded into bands, so assertions are on the COMPONENTS rather than on the
  // padded edges — the components are what the zone is made of and what a reader is shown.
  check('nearest is the closest zone', sel.nearest.components[0].price === 105, String(sel.nearest.high));
  check('major can be farther than nearest',
    sel.major.components.map((c) => c.price).join(',') === '90,91', String(sel.major.high));
  check('majorIsNearest is false when they differ', sel.majorIsNearest === false);
  check('major is NULL rather than manufactured when nothing qualifies',
    selectZones([zones[0]]).major === null);
}

// ── 9. support and resistance never overlap ──────────────────────────────────
sec('SUPPORT AND RESISTANCE DO NOT OVERLAP');

{
  const levels = [lv(90), lv(91), lv(105), lv(106), lv(120)];
  const { support, resistance, inside } = buildZones(levels, { price: 100, unit: 5 });
  check('support zones are below price', support.every((z) => z.high < 100));
  check('resistance zones are above price', resistance.every((z) => z.low > 100));
  check('no support zone overlaps a resistance zone',
    support.every((s) => resistance.every((r) => s.high < r.low)));
  check('nearest support is the highest below',
    support[0].components.map((c) => c.price).join(',') === '90,91');
  check('nearest resistance is the lowest above',
    resistance[0].components.map((c) => c.price).join(',') === '105,106');
  check('nothing is reported as inside when price is in a gap', inside === null);
}
{
  // Price sitting INSIDE a band is reported once, not as two overlapping zones.
  const { support, resistance, inside } = buildZones([lv(99), lv(100.5)], { price: 100, unit: 5 });
  check('a band containing price is reported as inside', inside !== null);
  check('the inside band is not duplicated into support', support.length === 0);
  check('the inside band is not duplicated into resistance', resistance.length === 0);
}

// ── 10. price relationship ───────────────────────────────────────────────────
sec('PRICE RELATIONSHIP');

// Components wide enough that no padding applies, so the edges under test are the real ones.
const zone = describeZone({ components: [lv(93), lv(96)], low: 93, high: 96 }, { unit: 5, price: 100, side: 'support' });
check('price well above a support zone is clear',
  priceRelationship(zone, { price: 130, recentBars: [] }).state === PRICE_STATE.CLEAR);
check('price just above is approaching',
  priceRelationship(zone, { price: 96.5, recentBars: [] }).state === PRICE_STATE.APPROACHING);
check('price within the band is inside',
  priceRelationship(zone, { price: 95.5, recentBars: [] }).state === PRICE_STATE.INSIDE);
check('price below the band is broken',
  priceRelationship(zone, { price: 90, recentBars: [] }).state === PRICE_STATE.BROKEN);
check('HOLDING requires evidence of an actual test',
  priceRelationship(zone, { price: 99, recentBars: [bar('x', 97, 98, 95.5, 97)] }).state === PRICE_STATE.HOLDING);
check('without a test it is not called holding',
  priceRelationship(zone, { price: 99, recentBars: [bar('x', 99, 100, 98.5, 99)] }).state !== PRICE_STATE.HOLDING);
check('a null zone yields no relationship', priceRelationship(null, { price: 100 }) === null);

// ── 11. timeframes stay independent ──────────────────────────────────────────
sec('TIMEFRAMES REMAIN INDEPENDENT');

check('all three timeframes uptrending is bullish alignment',
  describeAlignment({
    daily: { available: true, trend: TREND.UP }, weekly: { available: true, trend: TREND.UP },
    monthly: { available: true, trend: TREND.UP },
  }).state === ALIGNMENT.BULLISH);
check('a daily pullback under a higher-timeframe uptrend is named as such',
  describeAlignment({
    daily: { available: true, trend: TREND.DOWN }, weekly: { available: true, trend: TREND.UP },
    monthly: { available: true, trend: TREND.UP },
  }).state === ALIGNMENT.LONG_BULL_SHORT_WEAK);
check('monthly up against weekly down is a conflict',
  describeAlignment({
    daily: { available: true, trend: TREND.RANGE }, weekly: { available: true, trend: TREND.DOWN },
    monthly: { available: true, trend: TREND.UP },
  }).state === ALIGNMENT.CONFLICT);
check('disagreements are listed explicitly',
  describeAlignment({
    daily: { available: true, trend: TREND.DOWN }, weekly: { available: true, trend: TREND.UP },
    monthly: { available: true, trend: TREND.UP },
  }).conflicts.length >= 1);
check('alignment keeps each timeframe visible',
  Object.keys(describeAlignment({
    daily: { available: true, trend: TREND.UP }, weekly: { available: true, trend: TREND.UP },
    monthly: { available: true, trend: TREND.UP },
  }).trends).join(',') === 'daily,weekly,monthly');
check('one timeframe alone is insufficient',
  describeAlignment({ daily: { available: true, trend: TREND.UP }, weekly: { available: false }, monthly: { available: false } }).state === ALIGNMENT.UNKNOWN);
check('there is NO combined technical score',
  !('score' in describeAlignment({
    daily: { available: true, trend: TREND.UP }, weekly: { available: true, trend: TREND.UP },
    monthly: { available: true, trend: TREND.UP },
  })));

// ── 12. the whole engine ─────────────────────────────────────────────────────
sec('ENGINE');

{
  const dates = weekdays(900, '2021-01-01');
  const bars = dates.map((d, i) => {
    const c = 100 + 40 * Math.sin(i / 60) + i * 0.05;
    return bar(d, c, c + 2, c - 2, c);
  });
  const s = marketStructure(bars, { asOf: dates[dates.length - 1] });
  check('the engine produces structure', s.available === true);
  check('all three timeframes are present', !!(s.daily && s.weekly && s.monthly));
  check('each timeframe has its own trend',
    [s.daily, s.weekly, s.monthly].every((t) => typeof t.trend === 'string'));
  check('the engine returns a current price', Number.isFinite(s.currentPrice));
  check('multiTimeframe zones exist', Array.isArray(s.multiTimeframe.support.all));
  check('zones carry actual price ranges',
    s.multiTimeframe.support.nearest == null
    || (Number.isFinite(s.multiTimeframe.support.nearest.low)
      && Number.isFinite(s.multiTimeframe.support.nearest.high)));
  check('the methodology is stamped', s.methodology === 'structure_v1');
  check('there is no overall score at the top level', !('score' in s));
}
check('too little history is refused, not guessed',
  marketStructure([bar('2024-01-01', 1, 1, 1, 1)]).available === false);
check('an unusable price series produces no structure',
  marketStructure(weekdays(900, '2021-01-01').map((d) => bar(d, 10, 11, 9, 10)),
    { priceQuality: { usable: false, reason: 'too_many_breaks' } }).available === false);
check('a timeframe without enough bars says so',
  timeframeStructure([], 'monthly', {}).available === false);

// ── 13. the guards that only a targeted fixture can prove ────────────────────
sec('GUARD DETAIL');

{
  // A FLAT SHELF IS NOT THREE PIVOTS. Strict comparison is what stops every bar of a plateau
  // qualifying and filling the level list with duplicates of one shelf.
  const shelf = [1, 2, 3, 3, 3, 2, 1].map((h, i) => bar(`2024-01-0${i + 1}`, h, h, h - 1, h));
  const sw = findSwings(shelf, { width: 2 });
  check('a flat shelf produces no swing highs', sw.filter((s) => s.kind === 'swing_high').length === 0,
    JSON.stringify(sw.map((s) => s.kind)));
  const peak = [1, 2, 5, 2, 1, 0, 1].map((h, i) => bar(`2024-02-0${i + 1}`, h, h, h - 1, h));
  check('a genuine peak still confirms',
    findSwings(peak, { width: 2 }).some((s) => s.kind === 'swing_high' && s.price === 5));
}
{
  // A bar that CLOSES through a level has broken it, not touched it. Counting it as a touch makes a
  // level that has been decisively lost look well defended.
  const b = [
    bar('2024-01-01', 95, 96, 89, 95),   // reaches 90, closes back above -> touch
    bar('2024-01-02', 95, 96, 89, 85),   // reaches 90, closes through    -> break
  ];
  const h = touchHistory(b, 90, 1, { side: 'support' });
  check('a close back above the level is a touch', h.touches === 1, JSON.stringify(h));
  check('a close through the level is a break, not a touch', h.breaks === 1, JSON.stringify(h));
}
{
  // The percentage FLOOR, exercised with a real but tiny ATR — a mega-cap whose daily range is a
  // rounding error against its price would otherwise get a zone narrower than the spread.
  const tiny = weekdays(60).map((d) => bar(d, 1000, 1000.25, 999.75, 1000));
  const u = zoneUnit(tiny, 1000);
  check('a tiny ATR is lifted to the percentage floor',
    Math.abs(u - 1000 * ZONE_MIN_PCT) < 0.0001, String(u));
}
{
  // The JOIN distance is a separate constraint from the width ceiling: two levels can be well
  // inside the maximum width and still be too far apart to be the same area.
  const groups = clusterLevels([lv(100), lv(106)], 10);   // gap 6 > join 3.5, width 6 < max 10
  check('levels too far apart do not merge even when the width would allow it',
    groups.length === 2, String(groups.length));
}
{
  // MAJOR needs TWO named criteria. One is not a finding.
  const one = describeZone({ components: [lv(100, 'daily', { touches: 5 })], low: 100, high: 100 },
    { unit: 10, price: 120, side: 'support' });
  check('a zone meeting one criterion is NOT major', one.major === false, JSON.stringify(one.majorCriteria));
  check('the criterion it did meet is still reported', one.majorCriteria.length === 1);

  // With several qualifying-for-nothing zones, major stays null rather than picking one.
  const zs = [
    describeZone({ components: [lv(105, 'daily')], low: 105, high: 105 }, { unit: 10, price: 120, side: 'support' }),
    describeZone({ components: [lv(95, 'daily')], low: 95, high: 95 }, { unit: 10, price: 120, side: 'support' }),
  ];
  check('major is null when NO zone qualifies, even with several to choose from',
    selectZones(zs).major === null);
}
{
  const single = describeZone({ components: [lv(100, 'daily'), lv(101, 'daily')], low: 100, high: 101 },
    { unit: 10, price: 120, side: 'support' });
  check('a single-timeframe zone is not flagged multi-timeframe', single.multiTimeframe === false);
  check('a single-timeframe zone lists one timeframe', single.timeframes.length === 1);
}
{
  // Structure is built from COMPLETED bars. The forming period is returned separately so a live
  // surface can show it, and must never be inside the bar count structure was derived from.
  const dates = weekdays(400, '2022-01-03');
  const bars = dates.map((d, i) => { const c = 100 + i * 0.1; return bar(d, c, c + 1, c - 1, c); });
  const t = timeframeStructure(aggregateBars(bars, 'weekly', { asOf: dates[dates.length - 1] }),
    'weekly', { asOf: dates[dates.length - 1] });
  const all = aggregateBars(bars, 'weekly', { asOf: dates[dates.length - 1] });
  check('the forming bar is excluded from the structure bar count',
    t.bars === all.filter((b) => b.complete).length && t.bars < all.length);
  check('the forming bar is still reported separately', t.currentBar !== null);
  check('the last structural bar is a completed one', t.lastBar.complete === true);
}
{
  // TREND IS READ FROM RECENT SWINGS. A series whose only pivots are ancient must not be given a
  // confident trend off them — this is the MSFT monthly shape, where structure long predates the
  // tape. Old zig-zag, then a long monotonic stretch with no pivots at all.
  const dates = weekdays(400, '2022-01-03');
  const bars = dates.map((d, i) => {
    const c = i < 100 ? 100 + 20 * Math.sin(i / 4) : 100 + (i - 100) * 0.02;
    return bar(d, c, c + 0.5, c - 0.5, c);
  });
  const t = timeframeStructure(aggregateBars(bars, 'daily', { asOf: dates[dates.length - 1] }),
    'daily', { asOf: dates[dates.length - 1] });
  check('a trend is NOT asserted from pivots outside the recency window',
    t.trend === TREND.UNKNOWN, `${t.trend} / swings=${t.swings.count}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
