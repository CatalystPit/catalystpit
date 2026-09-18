// PROVIDER READINESS: what the scanner does with a feed that is partial, late, dirty or absent.
//
// verify-scan.mjs proves the signals compute the right answer from clean data. This suite is about
// the other half — the half that decides whether Catalyst Pit can be trusted when the feed is less
// than perfect, which is every real feed.
//
// Nothing here makes a network call or needs a vendor credential. Every scenario is constructed from
// timestamps, so a whole trading day is replayed deterministically.
//
// THE RULE BEING ENFORCED THROUGHOUT: an unknown is null, never zero and never false. A scanner that
// reports 0% on a dead feed, or a session high that belongs to yesterday, is not a scanner with a
// small bug — it is a scanner that tells a trader something untrue at the moment they are acting.
//
// Run: node scripts/verify-scan-provider.mjs

import {
  buildSymbolState, normalizeBars, sessionVwap, openingRange, etDateKey, etMinutesOf,
} from '../src/lib/scan/market-state.mjs';
import { velocity } from '../src/lib/scan/velocity.mjs';
import { cumulativeRvol, intervalRvol, buildVolumeBaseline, baselineStatus, MIN_SESSIONS } from '../src/lib/scan/volume-baseline.mjs';
import {
  INTERIM_PROVIDER, FULL_PROVIDER, NO_PROVIDER, describeProvider,
  signalAvailability, partitionSignals, FRESHNESS,
} from '../src/lib/scan/market-capabilities.mjs';
import { SIGNALS, SIGNAL_BY_ID } from '../src/lib/scan/signals.mjs';
import { runCycle } from '../src/lib/scan/engine.mjs';
import { createLifecycleStore } from '../src/lib/scan/lifecycle.mjs';
import { availableColumns } from '../src/lib/scan/columns.mjs';
import { FIELDS, matchesCondition, evaluateFilterSet, condition } from '../src/lib/scan/filters.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// 2026-09-17 is a Thursday. 14:00Z = 10:00 ET, half an hour into the regular session.
const NOW = Date.parse('2026-09-17T14:00:00Z');
const YESTERDAY = Date.parse('2026-09-16T14:00:00Z');
const bar = (t, o, h, l, c, v = 1000) => ({ t, o, h, l, c, v });
const minsBefore = (ms, n) => ms - n * 60_000;

console.log('\n=== a session is a DAY and a time of day, not a time of day ===');
{
  // The bug this pins: bars are filtered by minute-of-day, and 09:35 happened yesterday too.
  const state = buildSymbolState({
    symbol: 'X', price: 100,
    bars: [
      bar(Date.parse('2026-09-16T13:35:00Z'), 480, 500, 470, 495),   // YESTERDAY 09:35 ET
      bar(Date.parse('2026-09-17T13:35:00Z'), 99, 101, 98, 100),     // TODAY 09:35 ET
      bar(Date.parse('2026-09-17T14:00:00Z'), 100, 102, 99, 100),    // TODAY 10:00 ET
    ],
  }, { now: NOW });
  ok('yesterday does not set today\'s session high', state.sessionHigh === 102, String(state.sessionHigh));
  ok('yesterday does not set today\'s session low', state.sessionLow === 98, String(state.sessionLow));
  ok('only today\'s regular bars are kept', state.regularBars.length === 2, String(state.regularBars.length));
  ok('the opening range is today\'s', openingRange(state, 15)?.high === 101, JSON.stringify(openingRange(state, 15)));
  // VWAP over two sessions is not a price anyone traded against.
  ok('VWAP is a session figure, not a two-day figure',
    Math.abs(sessionVwap({ ...state, volumeQuality: 'consolidated' }) - 100.03) < 0.1,
    String(sessionVwap({ ...state, volumeQuality: 'consolidated' })));
}
{
  const state = buildSymbolState({
    symbol: 'X', price: 50,
    bars: [
      bar(Date.parse('2026-09-16T12:00:00Z'), 70, 75, 69, 70, 100),  // YESTERDAY 08:00 ET premarket
      bar(Date.parse('2026-09-17T12:00:00Z'), 50, 51, 49, 50, 200),  // TODAY 08:00 ET premarket
    ],
  }, { now: NOW });
  ok('yesterday does not set today\'s premarket high', state.premarketHigh === 51, String(state.premarketHigh));
  ok('yesterday does not set today\'s premarket low', state.premarketLow === 49, String(state.premarketLow));
  ok('premarket volume is not summed across days', state.premarketVolume === 200, String(state.premarketVolume));
}
{
  ok('the ET date key is the ET day, not the UTC day',
    // 2026-09-17T01:00Z is still 2026-09-16 in New York.
    etDateKey(Date.parse('2026-09-17T01:00:00Z')) === '2026-09-16', etDateKey(Date.parse('2026-09-17T01:00:00Z')));
  ok('and rolls over at ET midnight, not UTC midnight',
    etDateKey(Date.parse('2026-09-17T05:00:00Z')) === '2026-09-17');
}

console.log('\n=== a dirty feed: duplicates, out-of-order, corrections ===');
{
  const b1 = bar(minsBefore(NOW, 2), 100, 100, 100, 100, 500);
  const b2 = bar(minsBefore(NOW, 1), 101, 101, 101, 101, 500);
  const b3 = bar(NOW, 102, 102, 102, 102, 500);

  // A websocket reconnect replays bars that already arrived.
  const dup = normalizeBars([b1, b2, b2, b3, b3, b3]);
  ok('a replayed bar is not a second bar', dup.length === 3, String(dup.length));
  ok('duplicates do not double-count volume in VWAP',
    sessionVwap({ ...buildSymbolState({ symbol: 'X', price: 102, bars: [b1, b2, b2, b3, b3] }, { now: NOW }), volumeQuality: 'consolidated' })
    === sessionVwap({ ...buildSymbolState({ symbol: 'X', price: 102, bars: [b1, b2, b3] }, { now: NOW }), volumeQuality: 'consolidated' }));

  // A late bar arriving after its successor.
  const shuffled = buildSymbolState({ symbol: 'X', price: 102, bars: [b3, b1, b2] }, { now: NOW });
  const inOrder = buildSymbolState({ symbol: 'X', price: 102, bars: [b1, b2, b3] }, { now: NOW });
  ok('bars are ordered before anything reads them',
    shuffled.bars.map((b) => b.t).join() === inOrder.bars.map((b) => b.t).join());
  ok('an out-of-order delivery produces the SAME velocity as an ordered one',
    JSON.stringify(velocity(shuffled.bars, '2m', NOW)) === JSON.stringify(velocity(inOrder.bars, '2m', NOW)),
    JSON.stringify(velocity(shuffled.bars, '2m', NOW)));

  // A provider re-sending a minute is correcting it.
  const corrected = normalizeBars([bar(NOW, 1, 1, 1, 1, 100), bar(NOW, 2, 2, 2, 2, 900)]);
  ok('a corrected bar supersedes the original', corrected.length === 1 && corrected[0].c === 2 && corrected[0].v === 900,
    JSON.stringify(corrected));
  ok('a bar with no usable timestamp is dropped', normalizeBars([{ c: 1 }, { t: 'x' }, bar(NOW, 1, 1, 1, 1)]).length === 1);
  ok('a missing bar list is not an error', normalizeBars(undefined).length === 0 && normalizeBars(null).length === 0);
}

console.log('\n=== volume methodology: partial venue must never masquerade as consolidated ===');
{
  const base = {
    symbol: 'X', price: 100, volume: 1_000_000,
    bars: [bar(minsBefore(NOW, 1), 100, 100, 100, 100, 500), bar(NOW, 100, 100, 100, 100, 500)],
  };
  ok('volume quality travels with the number',
    buildSymbolState({ ...base, volumeQuality: 'single-venue' }, { now: NOW }).volumeQuality === 'single-venue');
  ok('an unstated quality is unknown, not assumed consolidated',
    buildSymbolState(base, { now: NOW }).volumeQuality === null);

  // VWAP is the sharpest case: people act on "reclaimed VWAP".
  for (const q of ['single-venue', 'delayed', null]) {
    const st = buildSymbolState({ ...base, volumeQuality: q }, { now: NOW });
    ok(`VWAP is withheld on ${q || 'unknown'} volume`, sessionVwap(st) === null, String(sessionVwap(st)));
  }
  ok('VWAP is computed on consolidated volume',
    Number.isFinite(sessionVwap(buildSymbolState({ ...base, volumeQuality: 'consolidated' }, { now: NOW }))));

  // The four volume signals each refuse to run on non-consolidated volume, whatever the caps claim.
  const volumeSignals = ['rvol_elevated', 'volume_spike', 'volume_acceleration', 'volume_confirmed_breakout'];
  for (const id of volumeSignals) {
    const sig = SIGNAL_BY_ID.get(id);
    ok(`${id} declares it needs consolidated volume`, sig?.requires?.consolidatedVolume === true);
  }
  const store = createLifecycleStore();
  const partial = buildSymbolState({ ...base, volumeQuality: 'single-venue', prevHigh: 90, high20d: 95 }, { now: NOW });
  const out = runCycle({ symbolStates: [partial], capabilities: FULL_PROVIDER, store, now: NOW });
  const fired = new Set((out.rows[0]?.signals || []).map((s) => s.id));
  for (const id of volumeSignals) {
    // Even on a feed that CLAIMS consolidated volume, a symbol whose own volume is single-venue
    // must not produce a volume signal. The capability says what the feed can do; the quality tag
    // says what this number actually is, and the stricter of the two wins.
    ok(`${id} does not fire on a single-venue number`, !fired.has(id));
  }
}

console.log('\n=== RVOL refuses to invent a baseline ===');
{
  const session = (vols) => vols.map((v, i) => ({ etMinutes: 570 + i, volume: v }));
  const enough = Array.from({ length: MIN_SESSIONS }, () => session([100, 100, 100, 100, 100]));
  const tooFew = Array.from({ length: MIN_SESSIONS - 1 }, () => session([100, 100, 100, 100, 100]));

  ok(`fewer than ${MIN_SESSIONS} sessions yields no baseline`, buildVolumeBaseline(tooFew) === null);
  const baseline = buildVolumeBaseline(enough);
  ok('enough sessions yields a baseline', baseline !== null);
  ok('a missing baseline is a null RVOL, NOT 1.0', cumulativeRvol(null, 575, 500) === null);
  ok('a missing baseline is a null interval RVOL', intervalRvol(null, 575, 500) === null);
  ok('an unknown volume is a null RVOL', cumulativeRvol(baseline, 570, undefined) === null);
  ok('a time of day with no history is a null RVOL', cumulativeRvol(baseline, 60, 500) === null);
  ok('a real comparison produces a number', Number.isFinite(cumulativeRvol(baseline, 570, 500)?.rvol));
  // The reason a blank is blank, in words a panel can print.
  ok('the panel is told WHY there is no baseline',
    baselineStatus(null, { intradayVolumeHistory: false }).reason.includes('intraday volume history'));
  ok('and told when it is only a history shortage',
    baselineStatus(null, { intradayVolumeHistory: true }).reason.includes(String(MIN_SESSIONS)));
}

console.log('\n=== a stale feed ===');
{
  // Bars stopped arriving 20 minutes ago, mid-session. The last price is known; the CURRENT one is not.
  const stale = buildSymbolState({
    symbol: 'X', price: 102,
    bars: [bar(minsBefore(NOW, 25), 100, 100, 100, 100), bar(minsBefore(NOW, 20), 102, 102, 102, 102)],
  }, { now: NOW });
  const v = velocity(stale.bars, '5m', NOW);
  // CLOSED. This was pinned as a known gap: with no staleness guard a dead feed reported a confident
  // 0% move, which renders as "0.00%" — a calm market — rather than as "no data". `velocity()` now
  // refuses a window that contains no observation at all. Kept as an assertion so it cannot regress.
  ok('a stale feed reports UNKNOWN, not a flat 0%', v === null, JSON.stringify(v));
  // The guard is about ABSENCE, not about age: a longer window that still contains observations is
  // measured normally, with `coverage` reporting how much of it the data actually spans.
  const series = [];
  for (let i = 40; i >= 20; i--) series.push(bar(minsBefore(NOW, i), 100, 100, 100, 100 + (40 - i) * 0.1));
  ok('...while a longer window that still contains observations is measured',
    velocity(series, '30m', NOW) !== null);
  ok('...and the window shorter than the gap is still unknown', velocity(series, '5m', NOW) === null);
  // What DOES hold: nothing derived from the missing data is invented.
  ok('a stale feed does not invent a session high beyond its bars', stale.sessionHigh === 102);
}

console.log('\n=== the five volume cases, as capability descriptors ===');
{
  const caseOf = (label, over) => ({ label, caps: describeProvider({ id: label, historicalDaily: true, ...over }) });
  const CASES = [
    caseOf('A realtime consolidated', { streaming: true, quoteFreshness: FRESHNESS.REALTIME, observationsPerMinute: 60, minBarSeconds: 1, liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true }),
    caseOf('B realtime broad-not-consolidated', { streaming: true, quoteFreshness: FRESHNESS.REALTIME, observationsPerMinute: 60, minBarSeconds: 1, liveVolume: true, consolidatedVolume: false, intradayVolumeHistory: true }),
    caseOf('C realtime single venue', { streaming: true, quoteFreshness: FRESHNESS.REALTIME, observationsPerMinute: 60, minBarSeconds: 1, liveVolume: true, consolidatedVolume: false }),
    caseOf('D delayed consolidated', { quoteFreshness: FRESHNESS.DELAYED, observationsPerMinute: 1, minBarSeconds: 60, liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true }),
    caseOf('E no realtime volume', { streaming: true, quoteFreshness: FRESHNESS.REALTIME, observationsPerMinute: 60, minBarSeconds: 1, liveVolume: false }),
  ];
  const rvolOn = (caps) => signalAvailability(SIGNAL_BY_ID.get('rvol_elevated'), caps).available;
  ok('A: RVOL is available on realtime consolidated volume', rvolOn(CASES[0].caps));
  ok('B: RVOL is OFF when volume is not consolidated', !rvolOn(CASES[1].caps));
  ok('C: RVOL is OFF on a single venue', !rvolOn(CASES[2].caps));
  ok('D: RVOL is available on delayed consolidated volume', rvolOn(CASES[3].caps));
  ok('E: RVOL is OFF with no live volume', !rvolOn(CASES[4].caps));
  // Case D is the one worth stating out loud: the volume methodology is sound, so RVOL is honest;
  // it is the PRICE signals that must go dark, and they do.
  ok('D: fast price signals are OFF on a delayed feed',
    !signalAvailability(SIGNAL_BY_ID.get('price_velocity_1m'), CASES[3].caps).available);
  ok('C: the volume COLUMN is still offered on a single-venue feed [known gap]',
    availableColumns(CASES[2].caps, signalAvailability).some((c) => c.id === 'volume'));
}

console.log('\n=== no capability means dark, with a reason — never a wrong number ===');
{
  const { enabled, disabled } = partitionSignals(SIGNALS, INTERIM_PROVIDER);
  ok('the interim feed lights some signals', enabled.length > 0);
  ok('and darkens the rest', disabled.length > 0);
  ok('every dark signal explains itself', disabled.every((s) => typeof s.unavailable === 'string' && s.unavailable.length > 5));
  ok('no signal is both enabled and disabled',
    !enabled.some((e) => disabled.some((d) => d.id === e.id)));

  const none = partitionSignals(SIGNALS, NO_PROVIDER);
  ok('with no provider at all, nothing claims to work', none.enabled.length === 0, String(none.enabled.length));
  ok('and every signal says what it is waiting for', none.disabled.length === SIGNALS.length);

  const full = partitionSignals(SIGNALS, FULL_PROVIDER);
  ok('on a capable feed every signal comes alive — they are gated, not broken',
    full.disabled.length === 0, JSON.stringify(full.disabled.map((d) => d.id)));

  // A requirement key that does not exist in the vocabulary would silently be ignored, making the
  // signal always-available. That is the failure that would quietly reintroduce fabricated output.
  const vocab = new Set(Object.keys(describeProvider({})));
  const unknown = [];
  for (const s of SIGNALS) for (const k of Object.keys(s.requires || {})) if (!vocab.has(k)) unknown.push(`${s.id}.${k}`);
  ok('no signal requires a capability that does not exist', unknown.length === 0, unknown.join(', '));
}

console.log('\n=== an unknown never satisfies a filter ===');
{
  const row = { symbol: 'X', price: 10, float: null, rvol: undefined, signals: [] };
  ok('a null float does not match "float below 20M"', !matchesCondition(row, condition('float', 'lt', [20e6])));
  ok('a null float does not match "float above 20M"', !matchesCondition(row, condition('float', 'gt', [20e6])));
  ok('a null float does not match "is not 5"', !matchesCondition(row, condition('float', 'neq', [5])));
  ok('an undefined RVOL does not match "RVOL below 1"', !matchesCondition(row, condition('rvol', 'lt', [1])));
  ok('a known value still matches', matchesCondition(row, condition('price', 'lt', [20])));
  ok('NaN is treated as unknown', !matchesCondition({ ...row, price: NaN }, condition('price', 'gt', [0])));

  // A screen must not quietly run with half its criteria removed.
  const set = { conditions: [condition('price', 'gt', [5]), condition('rvol', 'gt', [3])] };
  const res = evaluateFilterSet([{ symbol: 'A', price: 10, rvol: 9 }], set, INTERIM_PROVIDER);
  ok('an unsupported condition is reported back to the caller', res.unsupported.length === 1, JSON.stringify(res.unsupported));
  ok('the report names the capability it needs', /volume/i.test(res.unsupported[0].reason), res.unsupported[0].reason);
  ok('and the applied count reflects what actually ran', res.applied === 1);
}

console.log('\n=== what the engine does NOT yet populate (characterization, not approval) ===');
{
  // This list is the work between "a provider is connected" and "Pit Scan is live". Every id here is
  // a column or filter the capability layer declares AVAILABLE on a capable feed, while the engine
  // emits no value for it — so it would render as a dash and filter as "never matches".
  //
  // THIS LIST MUST SHRINK TO EMPTY BEFORE PIT SCAN GOES LIVE. It exists so it cannot silently grow.
  const bars = [];
  for (let i = 30; i >= 0; i--) {
    const p = 100 + (30 - i) * 0.2;
    bars.push(bar(minsBefore(NOW, i), p, p + 0.3, p - 0.3, p, 10_000));
  }
  const state = buildSymbolState({
    symbol: 'X', price: 106, prevClose: 99, prevHigh: 101, prevLow: 98, bars,
    volume: 500_000, volumeQuality: 'consolidated', bid: 105.98, ask: 106.02,
    marketCap: 5e9, float: 2e7, sector: 'Technology', high20d: 104, atr14: 1.2,
  }, { now: NOW });
  const out = runCycle({ symbolStates: [state], capabilities: FULL_PROVIDER, store: createLifecycleStore(), now: NOW });
  const row = out.rows[0];
  ok('a fully-populated symbol does produce a row', !!row);

  // CLOSED. This list was ten columns long — every velocity window, RVOL and relative strength read
  // `undefined` because runCycle never assembled them. `deriveRow()` now wires the calculations that
  // already existed, and the assertion is inverted: the list must stay EMPTY.
  //
  // `undefined` and `null` are different verdicts here and the distinction is the whole point. Null
  // means the market input is unknown right now (no baseline, no benchmark); undefined means nobody
  // wired the field, which is a bug rather than a fact about the market.
  const offered = availableColumns(FULL_PROVIDER, signalAvailability)
    .filter((c) => c.format !== null && typeof c.read === 'function');
  const empty = offered.filter((c) => c.read(row) === undefined).map((c) => c.id).sort();
  ok('NO offered column reads undefined on a fully capable feed', empty.length === 0, JSON.stringify(empty));
  ok('...and the board really does offer the full set', offered.length >= 20, String(offered.length));

  // The same, from the filter side.
  const emptyFields = Object.values(FIELDS)
    .filter((f) => !f.requiresFor && signalAvailability({ requires: f.requires }, FULL_PROVIDER).available)
    .filter((f) => f.read(row) === undefined).map((f) => f.id).sort();
  ok('NO available filter field reads undefined', emptyFields.length === 0, JSON.stringify(emptyFields));

  // What the engine DOES populate, so a regression would be caught.
  for (const k of ['price', 'changePct', 'gapPct', 'volume', 'dollarVolume', 'marketCap', 'float', 'spreadPct']) {
    ok(`the engine populates ${k}`, row[k] !== undefined);
  }
  // CLOSED. The tag now travels WITH the row, so a reader and a downstream consumer can both see
  // what kind of volume the numbers were built from — which is the input to the RVOL methodology
  // rule, and was previously dropped on the floor between the state and the row.
  ok('the row carries the volume-quality tag the state carries',
    row.volumeQuality === 'consolidated' && state.volumeQuality === 'consolidated');
}

console.log('\n=== session boundaries ===');
{
  const at = (iso) => etMinutesOf(Date.parse(iso));
  ok('04:00 ET is premarket', at('2026-09-17T08:00:00Z') === 240);
  ok('09:30 ET is the open', at('2026-09-17T13:30:00Z') === 570);
  ok('16:00 ET is the close', at('2026-09-17T20:00:00Z') === 960);
  // Premarket levels must survive the open — they are what the morning is traded against.
  //
  // The premarket range here deliberately STRADDLES the regular one (high 110 > 106, low 99 < 104):
  // that is the ordinary gap-up, and it is the only arrangement in which a leak is visible. A fixture
  // whose premarket high sits inside the session range cannot tell the two rules apart.
  const state = buildSymbolState({
    symbol: 'X', price: 105,
    bars: [
      bar(Date.parse('2026-09-17T12:00:00Z'), 100, 110, 99, 102, 900),   // 08:00 ET premarket
      bar(Date.parse('2026-09-17T13:45:00Z'), 104, 106, 104, 105, 900),  // 09:45 ET regular
    ],
  }, { now: NOW });
  ok('the premarket high is still there at 10:00', state.premarketHigh === 110, String(state.premarketHigh));
  ok('and it is NOT part of the session high', state.sessionHigh === 106, String(state.sessionHigh));
  ok('nor is the premarket low part of the session low', state.sessionLow === 104, String(state.sessionLow));
  ok('premarket volume excludes the regular session', state.premarketVolume === 900, String(state.premarketVolume));
  ok('the opening range is still forming at 09:45, so it is null',
    openingRange(buildSymbolState({ symbol: 'X', price: 105, bars: state.bars },
      { now: Date.parse('2026-09-17T13:45:00Z') }), 30) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
