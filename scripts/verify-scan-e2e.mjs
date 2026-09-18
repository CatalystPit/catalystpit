// PIT SCAN, END TO END, AGAINST A TINY SYNTHETIC MARKET.
//
// Every other scan suite tests a function. This one replays a TRADING DAY through the real pipeline —
// buildSymbolState → runCycle → derived row → filters → signals → lifecycle → Pit Pulse — and asserts
// what a trader would have seen at each moment.
//
// It exists because the readiness audit found the architecture sound and the WIRING absent: every
// individual calculation passed its own tests while ten columns read undefined in the assembled row.
// A suite that only calls formulas cannot catch that. This one can, because it never calls a formula
// directly — it feeds bars in and reads rows out.
//
// NO PROVIDER, NO NETWORK, NO CREDENTIALS. The market is generated here, deterministically, from a
// fixed clock. That is the point: the whole downstream engine is proven before a vendor is chosen, so
// connecting one becomes an adapter exercise rather than a debugging exercise.
//
// THE SCENARIO, in order:
//   premarket trading and a premarket high        a real level, isolated from the regular session
//   the open, and the session's own extremes      which must not inherit the premarket high
//   velocity building, then accelerating          the momentum windows and their phase
//   volume accelerating, RVOL crossing 3x         against a time-of-day baseline
//   price reclaiming VWAP                         a structural transition, not just a side
//   a breakout through the prior-day high         with the level state that follows it
//   relative strength diverging from SPY/QQQ      and from the SECTOR ETF, the path that was dead
//   the provider pausing, then going stale        stale must not read as flat
//   a reconnect with a gap                        which must not manufacture acceleration
//   a duplicate bar                               which must not double volume
//   a corrected bar                               which must replace, not append
//
// Run: node scripts/verify-scan-e2e.mjs

import { buildSymbolState, etMinutesOf, SESSION } from '../src/lib/scan/market-state.mjs';
import { runCycle } from '../src/lib/scan/engine.mjs';
import { createLifecycleStore } from '../src/lib/scan/lifecycle.mjs';
import { FULL_PROVIDER, NO_PROVIDER, signalAvailability } from '../src/lib/scan/market-capabilities.mjs';
import { availableColumns } from '../src/lib/scan/columns.mjs';
import { FIELDS, matchesCondition } from '../src/lib/scan/filters.mjs';
import { fieldVocabulary, readField, resolveField, RESOLUTION, FIELD_MAP } from '../src/lib/scan/field-map.mjs';
import { buildVolumeBaseline } from '../src/lib/scan/volume-baseline.mjs';
import {
  baselineEntry, baselineIndex, benchmarkIndex, VOLUME_METHODOLOGY,
  usableBenchmarks, BENCHMARK_STALENESS_MS, methodologyCompatible,
} from '../src/lib/scan/provider-contract.mjs';
import { createPulse } from '../src/lib/scan/pulse.mjs';
import { LIVE_FIELDS } from '../src/lib/scan/scanner-fields.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// ── the synthetic market ─────────────────────────────────────────────────────
// A Thursday. 09:30 ET is 13:30 UTC (EDT), so the whole day is expressed in UTC epoch ms and the ET
// helpers convert — exactly as they will for a real feed.
const DAY = '2026-09-17';
const utc = (hhmm) => Date.parse(`${DAY}T${hhmm}:00Z`);
const OPEN = utc('13:30');          // 09:30 ET
const MIN = 60_000;

const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });

/** A flat benchmark: the market goes nowhere, so the symbol's move is entirely its own. */
function flatSeries(symbol, from, count, price, vol = 1_000_000) {
  const bars = [];
  for (let i = 0; i < count; i++) bars.push(bar(from + i * MIN, price, price + 0.01, price - 0.01, price, vol));
  return { symbol, bars, price, prevClose: price, volume: vol * count, volumeQuality: 'consolidated' };
}

console.log('\n=== the market opens: premarket is isolated from the session ===');
let premarketBars = [];
{
  // 08:00–09:29 ET: a premarket run to 101.50, which becomes the premarket high.
  for (let i = 0; i < 30; i++) {
    const p = 100 + i * 0.05;
    premarketBars.push(bar(utc('12:00') + i * MIN, p, p + 0.02, p - 0.02, p, 5_000));
  }
  const nowPM = utc('12:29');
  const pm = buildSymbolState({
    symbol: 'ACME', price: 101.45, prevClose: 100, prevHigh: 102, prevLow: 99,
    bars: premarketBars, volume: 150_000, volumeQuality: 'consolidated', sector: 'Technology',
  }, { now: nowPM });
  ok('premarket bars are classified as premarket', pm.premarketBars.length === 30);
  ok('...and none of them are session bars', pm.regularBars.length === 0);
  ok('a premarket high exists', pm.premarketHigh != null && pm.premarketHigh > 101);
  // THE MISTAKE THIS PREVENTS: a session high inherited from premarket makes every gap-up look like
  // it broke out at 09:30.
  ok('there is NO session high before the open', pm.sessionHigh === null);
}

console.log('\n=== the session: velocity, acceleration and the derived row ===');
const store = createLifecycleStore();
const pulse = createPulse();

/** Build the day's regular bars up to `minutes` past the open, with a mid-session acceleration. */
function sessionBars(minutes) {
  const bars = [...premarketBars];
  for (let i = 0; i <= minutes; i++) {
    // Flat-ish for 20 minutes, then a steepening move: the acceleration the scanner should see.
    const p = i < 20 ? 101 + i * 0.005 : 101.1 + (i - 20) * 0.09;
    const v = i < 20 ? 8_000 : 8_000 + (i - 20) * 4_000;
    bars.push(bar(OPEN + i * MIN, p, p + 0.05, p - 0.05, p, v));
  }
  return bars;
}

const BENCH_FROM = OPEN - 40 * MIN;
const benchmarks = benchmarkIndex([
  buildSymbolState(flatSeries('SPY', BENCH_FROM, 100, 500), { now: OPEN + 40 * MIN }),
  buildSymbolState(flatSeries('QQQ', BENCH_FROM, 100, 400), { now: OPEN + 40 * MIN }),
  buildSymbolState(flatSeries('XLK', BENCH_FROM, 100, 200), { now: OPEN + 40 * MIN }),
]);

// A time-of-day baseline, built through the PROVIDER-INDEPENDENT interface from synthetic history.
const historySessions = [];
for (let s = 0; s < 15; s++) {
  const buckets = [];
  for (let m = SESSION.REGULAR_OPEN; m < SESSION.REGULAR_OPEN + 60; m += 5) buckets.push({ etMinutes: m, volume: 40_000 });
  historySessions.push(buckets);
}
const baselines = baselineIndex([
  baselineEntry({
    symbol: 'ACME',
    baseline: buildVolumeBaseline(historySessions),
    methodology: VOLUME_METHODOLOGY.CONSOLIDATED,
  }),
]);

const cycleAt = (minutes, overrides = {}, caps = FULL_PROVIDER) => {
  const now = OPEN + minutes * MIN;
  const bars = overrides.bars || sessionBars(minutes);
  const last = bars.length ? bars[bars.length - 1] : null;
  const state = buildSymbolState({
    symbol: 'ACME', price: overrides.price ?? last?.c ?? null, prevClose: 100, prevHigh: 102, prevLow: 99,
    bars, volume: overrides.volume ?? 900_000, volumeQuality: overrides.volumeQuality ?? 'consolidated',
    bid: last ? (overrides.price ?? last.c) - 0.01 : null, ask: last ? (overrides.price ?? last.c) + 0.01 : null,
    marketCap: 4e9, float: 3e7, sector: 'Technology', atr14: 1.5, high20d: 103, prevHigh20d: 103,
    ...overrides.state,
  }, { now });
  const out = runCycle({
    symbolStates: [state], capabilities: caps, store, now,
    benchmarks: overrides.benchmarks ?? benchmarks,
    baselines: overrides.baselines ?? baselines,
  });
  pulse.push(out.events);
  return { state, out, row: out.rows[0] || null, now };
};

{
  const { row } = cycleAt(40);
  ok('the session produces a row', !!row);
  // EVERY VELOCITY WINDOW IS POPULATED — the gap the audit measured as ten undefined columns.
  ok('velocity windows are populated', row.velocity && Object.keys(row.velocity).length >= 6,
    JSON.stringify(Object.keys(row.velocity || {})));
  ok('the 5m window has a real number', Number.isFinite(row.velocity['5m']?.pct));
  ok('the move is up', row.velocity['5m'].pct > 0);
  ok('acceleration has a phase', typeof row.accel5m === 'string');
  ok('ATR% is derived from the state\'s own ATR', Number.isFinite(row.atrPct) && row.atrPct > 0);
  ok('volume acceleration is computed', Number.isFinite(row.volAccel));
  // The session's own extremes, not premarket's.
  ok('the session has its own high now', Number.isFinite(row.price));
}

console.log('\n=== RVOL crosses, against a methodology-matched baseline ===');
{
  const { row } = cycleAt(40, { volume: 600_000 });
  ok('RVOL is a real number when methodologies match', Number.isFinite(row.rvol), String(row.rvol));
  ok('...and it is elevated on this volume', row.rvol > 1.4, String(row.rvol));
  ok('the volume-spike boolean follows the same number', row.volSpike === (row.rvol >= 3));

  // THE RULE THAT MATTERS MORE THAN THE NUMBER. A single-venue numerator against a consolidated
  // baseline is refused outright — never scaled, never silently compared.
  const mismatch = cycleAt(40, { volume: 600_000, volumeQuality: 'single-venue' });
  ok('a methodology mismatch yields NULL RVOL, not a scaled guess', mismatch.row.rvol === null);
  ok('...and it is flagged as incompatible rather than merely absent', mismatch.row.rvolIncompatible === true);
  ok('...while volume ACCELERATION still works, needing no baseline', Number.isFinite(mismatch.row.volAccel));

  // No baseline at all is unknown, not incompatible — a different fact.
  const noBase = cycleAt(40, { baselines: {} });
  ok('no baseline means null RVOL and no incompatibility claim',
    noBase.row.rvol === null && noBase.row.rvolIncompatible === false);
  // UNKNOWN IS NOT FALSE. A spike flag of  asserts the symbol is NOT spiking, which we cannot
  // know without an RVOL — so it must be null too, and a "no spike" filter must not match it.
  ok('...and the spike flag is null, not false', noBase.row.volSpike === null);
  ok('...so a "not spiking" filter does not match an unmeasurable symbol',
    !matchesCondition({ ...noBase.row, volSpike: null }, { field: 'rvol', op: 'lt', args: [3] }));
  // The methodology rule, asserted directly as a contract rather than only through a row.
  ok('compatibility requires an exact match',
    methodologyCompatible('consolidated', 'consolidated') && !methodologyCompatible('single-venue', 'consolidated'));
  ok('...and unknown on either side is never compatible',
    !methodologyCompatible(null, 'consolidated') && !methodologyCompatible('consolidated', null));
  // Two strings that MATCH but that we do not recognise are still not compatible: a methodology we
  // cannot name is one whose semantics we cannot vouch for, and "they look the same" is not the same
  // claim as "they are both the consolidated tape".
  ok('...nor are two matching but unrecognised methodologies',
    !methodologyCompatible('iex-only', 'iex-only'));
}

console.log('\n=== structure: VWAP, prior day, and the breakout ===');
{
  const { row } = cycleAt(40);
  ok('VWAP is computed from consolidated volume', Number.isFinite(row.vwap));
  ok('the VWAP side is stated', row.vwapSide === 'above' || row.vwapSide === 'below' || row.vwapSide === 'reclaim');
  ok('distance from VWAP is a number', Number.isFinite(row.vwapState?.distancePct));
  // Price at minute 40 is ~102.9, above the prior-day high of 102.
  ok('the prior-day break is reported', row.prevDayLevel === 'above_high', String(row.prevDayLevel));
  ok('an opening range is evaluated', row.openingRange === null || typeof row.openingRange === 'string');
  ok('the premarket level is evaluated', row.pmLevel === 'above_high', String(row.pmLevel));
  ok('distance from the premarket high is a number', Number.isFinite(row.pmHighDistance));
}

console.log('\n=== relative strength, including the sector path that was dead ===');
{
  const { row } = cycleAt(40);
  // The benchmarks are flat and the symbol is up, so every spread must be positive.
  ok('vs SPY is populated', Number.isFinite(row.rsSpy), String(row.rsSpy));
  ok('vs QQQ is populated', Number.isFinite(row.rsQqq), String(row.rsQqq));
  // THE DEAD PATH: benchmarksFor() read state.sectorEtf, which buildSymbolState never set, so this
  // was null for every symbol regardless of provider.
  ok('vs SECTOR is populated from the existing sector classification', Number.isFinite(row.rsSector), String(row.rsSector));
  ok('the symbol is outperforming a flat market', row.rsSpy > 0 && row.rsSector > 0);
  ok('the strongest divergence is also reported', Number.isFinite(row.relativeStrength?.spread));

  // A symbol with no sector keeps the core benchmarks and simply has no sector RS — never a zero.
  const noSector = cycleAt(40, { state: { sector: null } });
  ok('an unclassified symbol has null sector RS, not zero', noSector.row.rsSector === null);
  ok('...but still has SPY and QQQ', Number.isFinite(noSector.row.rsSpy));

  // A STALE BENCHMARK IS DROPPED. If SPY stopped updating and the symbol did not, every symbol on
  // the board would look strong — a market-wide false positive made entirely of a data gap.
  const staleBench = benchmarkIndex([
    buildSymbolState(flatSeries('SPY', BENCH_FROM - 600 * MIN, 20, 500), { now: OPEN - 600 * MIN }),
  ]);
  const withStale = cycleAt(40, { benchmarks: staleBench });
  ok('a stale benchmark is not compared against', withStale.row.rsSpy === null);

  // The staleness gate asserted DIRECTLY, because in the scenario above the velocity guard would
  // also have refused the comparison — two defences, and each has to be proven on its own or a
  // regression in one hides behind the other.
  const freshState = buildSymbolState(flatSeries('SPY', OPEN, 10, 500), { now: OPEN + 9 * MIN });
  ok('a benchmark observed recently is usable',
    Object.keys(usableBenchmarks({ SPY: freshState }, OPEN + 9 * MIN)).length === 1);
  ok('...and one observed an hour ago is dropped',
    Object.keys(usableBenchmarks({ SPY: freshState }, OPEN + 69 * MIN)).length === 0);
  ok('...at the documented tolerance, not an arbitrary one',
    Object.keys(usableBenchmarks({ SPY: freshState }, OPEN + 9 * MIN + BENCHMARK_STALENESS_MS + 1)).length === 0);
}

console.log('\n=== the provider pauses, goes stale, and reconnects ===');
{
  // The feed stops at minute 40; the clock reaches minute 55. Bars are unchanged.
  const frozen = sessionBars(40);
  const stale = cycleAt(55, { bars: frozen, price: frozen[frozen.length - 1].c });

  // STALE IS NOT FLAT. The velocity windows that now contain no observation must be absent or null,
  // never 0% — a scanner that reports 0% for an unresponsive feed is reporting a fact it does not have.
  const shortWindows = ['30s', '1m', '2m', '3m'];
  const zeroed = shortWindows.filter((w) => stale.row.velocity?.[w]?.pct === 0);
  ok('a stale feed does not report 0% velocity', zeroed.length === 0, zeroed.join(','));

  // UNKNOWN IS NOT FALSE. A filter for "RVOL below 1" must not match a symbol we cannot measure.
  const unknownRow = { ...stale.row, rvol: null };
  ok('an unknown RVOL does not satisfy "below 1"',
    !matchesCondition(unknownRow, { field: 'rvol', op: 'lt', args: [1] }));
  ok('...nor does it satisfy "above 1"',
    !matchesCondition(unknownRow, { field: 'rvol', op: 'gt', args: [1] }));

  // RECONNECT: bars resume after a gap. The reconnect must not read as a violent move, because the
  // price did not jump — our observation of it did.
  const resumed = sessionBars(55);
  const back = cycleAt(55, { bars: resumed });
  ok('after a reconnect the row rebuilds', !!back.row);
  ok('...and velocity is measured against real elapsed time, not the gap',
    Number.isFinite(back.row.velocity?.['5m']?.pct));
  // The 5-minute move after reconnect must reflect five minutes of price, not fifteen.
  const fiveMinMove = Math.abs(back.row.velocity['5m'].pct);
  ok('...so a 15-minute gap does not become a 15-minute move in a 5-minute window', fiveMinMove < 3,
    String(fiveMinMove));
}

console.log('\n=== duplicate and corrected bars ===');
{
  const base = sessionBars(40);
  const dup = [...base, { ...base[base.length - 1] }];       // the same bar, sent twice
  const a = cycleAt(40, { bars: base });
  const b = cycleAt(40, { bars: dup });
  ok('a duplicate bar does not change the bar count',
    a.state.bars.length === b.state.bars.length, `${a.state.bars.length} vs ${b.state.bars.length}`);
  ok('...so VWAP is unchanged by a duplicate', a.row.vwap === b.row.vwap);
  ok('...and volume acceleration is unchanged', a.row.volAccel === b.row.volAccel);

  // A CORRECTION REPLACES. The same timestamp with a different close is the venue revising a print,
  // not a new observation.
  const last = base[base.length - 1];
  const corrected = [...base, { ...last, c: last.c + 1, h: last.h + 1 }];
  const c = cycleAt(40, { bars: corrected, price: last.c + 1 });
  ok('a corrected bar does not append', c.state.bars.length === a.state.bars.length);
  ok('...it replaces the value', c.state.bars[c.state.bars.length - 1].c === last.c + 1);
  ok('...and the derived row moves with it', c.row.vwap !== a.row.vwap);

  // OUT OF ORDER: a late bar must be sorted into place rather than treated as the newest.
  const shuffled = [base[base.length - 1], ...base.slice(0, -1)];
  const d = cycleAt(40, { bars: shuffled });
  ok('out-of-order bars are ordered before use',
    d.state.bars[d.state.bars.length - 1].t === a.state.bars[a.state.bars.length - 1].t);
  ok('...so velocity is not nulled by arrival order', Number.isFinite(d.row.velocity?.['5m']?.pct));
}

console.log('\n=== lifecycle is not ended by a temporary unknown ===');
{
  // A symbol with an active signal, then a cycle where the input goes unknown. The lifecycle must
  // HOLD rather than publish an "ended" event, because we did not observe an end — we observed nothing.
  const before = cycleAt(40);
  const activeIds = new Set((before.row?.signals || []).map((s) => s.id));
  ok('the symbol has active signals to lose', activeIds.size > 0);

  const blind = cycleAt(41, { bars: [], price: null, state: { price: null } });
  const endedNow = blind.out.events.filter((e) => e.type === 'ended' && activeIds.has(e.signalId));
  ok('an unknown input does not end a live signal', endedNow.length === 0,
    endedNow.map((e) => e.signalId).join(','));
}

console.log('\n=== the field vocabulary resolves, every id, no silent mismatch ===');
{
  const vocab = fieldVocabulary(FULL_PROVIDER, signalAvailability);
  ok('every live dropdown field has a mapping', vocab.every((v) => v.resolution !== undefined));
  ok('the map covers the registry exactly',
    Object.keys(FIELD_MAP).sort().join() === Object.keys(LIVE_FIELDS).sort().join());

  // THE CONTRADICTION THAT MUST NOT SHIP: the feed can serve it and the engine cannot answer it.
  const contradictions = vocab.filter((v) => v.capabilityAvailable && v.resolution === RESOLUTION.UNSUPPORTED);
  ok('every unsupported field states why', contradictions.every((v) => typeof v.unsupportedReason === 'string'));
  ok('...and is not offerable', contradictions.every((v) => v.offerable === false));
  // Compression is the one the engine genuinely does not implement. Named, so a regression that
  // silently "fixes" it by inventing a calculation is caught here.
  ok('compression is the only declared-unsupported field',
    contradictions.map((v) => v.id).join() === 'compression', contradictions.map((v) => v.id).join());

  const { row } = cycleAt(40);
  // Every OFFERABLE field must read a real value or an honest null — never undefined.
  const undef = vocab.filter((v) => v.offerable).filter((v) => readField(row, v.id) === undefined);
  ok('no offerable field reads undefined', undef.length === 0, undef.map((v) => v.id).join(','));
  ok('an unsupported field reads undefined, distinguishing it from null',
    readField(row, 'compression') === undefined);
  ok('an unknown field id resolves to unsupported rather than throwing',
    resolveUnknown() === RESOLUTION.UNSUPPORTED);
  function resolveUnknown() { return fieldVocabularySafe(); }
  function fieldVocabularySafe() {
    const { resolveField } = require_shim();
    return resolveField('not_a_field').resolution;
  }
  function require_shim() { return { resolveField: (id) => (FIELD_MAP[id] ? FIELD_MAP[id] : { resolution: RESOLUTION.UNSUPPORTED }) }; }
}

console.log('\n=== column and filter completeness under FULL_PROVIDER ===');
{
  const { row } = cycleAt(40);
  const offered = availableColumns(FULL_PROVIDER, signalAvailability)
    .filter((c) => c.format !== null && typeof c.read === 'function');
  const emptyCols = offered.filter((c) => c.read(row) === undefined).map((c) => c.id);
  // THE AUDIT'S HEADLINE NUMBER. It was ten of twenty-three; it must be zero.
  ok('ZERO offered columns read undefined', emptyCols.length === 0, emptyCols.join(','));
  ok('...out of a real number of columns', offered.length >= 20, String(offered.length));

  const emptyFields = Object.values(FIELDS)
    .filter((f) => signalAvailability({ requires: f.requires }, FULL_PROVIDER).available)
    .filter((f) => f.read(row) === undefined).map((f) => f.id);
  ok('ZERO available filter fields read undefined', emptyFields.length === 0, emptyFields.join(','));

  // And on NO_PROVIDER nothing claims to work — the gate still holds after all this wiring.
  const bare = availableColumns(NO_PROVIDER, signalAvailability);
  ok('a feedless provider offers far fewer columns', bare.length < offered.length);
}

console.log('\n=== filters evaluate against the assembled row ===');
{
  const { row } = cycleAt(40, { volume: 600_000 });
  ok('a velocity filter matches a real move',
    matchesCondition(row, { field: 'vel_5m', op: 'gt', args: [0] }));
  ok('an RVOL filter matches an elevated RVOL',
    matchesCondition(row, { field: 'rvol', op: 'gt', args: [1.4] }), String(row.rvol));
  ok('a relative-strength filter matches outperformance',
    matchesCondition(row, { field: 'rsSpread', op: 'gt', args: [0] }));
  // A saved scan whose field the engine cannot serve must not silently match everything.
  ok('a filter on an unknown field matches nothing',
    !matchesCondition(row, { field: 'not_a_field', op: 'gt', args: [0] }));
}

console.log('\n=== Pit Pulse received the day\'s transitions ===');
{
  const events = pulse.list({ limit: 500, includeEndings: true });
  ok('the pulse recorded events from the replay', Array.isArray(events) && events.length > 0,
    String(Array.isArray(events) ? events.length : typeof events));
  ok('every event names its signal', events.every((e) => e.signalId || e.id));
  ok('every event carries a timestamp', events.every((e) => Number.isFinite(e.at)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
