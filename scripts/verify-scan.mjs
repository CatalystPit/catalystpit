// PIT SCAN — the provider-independent scanner foundation, verified without a market.
//
//   node scripts/verify-scan.mjs
//
// The scanner cannot be tested against live data: the market is not reproducible, the interim feed is
// delayed, and the conditions that matter most are rare. So every behaviour is proved against the
// deterministic sessions in src/lib/scan/fixtures.mjs, whose outcomes are known by construction.
//
// THE MOST IMPORTANT ASSERTIONS IN THIS FILE ARE THE NEGATIVE ONES. A scanner that reports a
// breakout that did not happen, or an RVOL computed from volume it does not have, is worse than no
// scanner — so a large share of what follows checks that the engine stays SILENT.

import {
  FRESHNESS, CAPABILITIES, CAPABILITY_KEYS, REQUIREABLE, describeProvider, signalAvailability,
  partitionSignals, requirementKeysUsed, freshnessAtLeast,
  INTERIM_PROVIDER, FULL_PROVIDER, NO_PROVIDER,
} from '../src/lib/scan/market-capabilities.mjs';
import {
  buildSymbolState, sessionPhase, openingRange, sessionVwap, pctChange, etMinutesOf,
  SESSION, premarketProfile, dayLocation,
} from '../src/lib/scan/market-state.mjs';
import {
  velocity, acceleration, priceAt, normalizedMove, momentumPhase, logReturn,
  VELOCITY_WINDOWS, MIN_PRIOR_PCT,
} from '../src/lib/scan/velocity.mjs';
import {
  levelInteraction, throughPct, barsBeyond, reclaimed, justCrossed, ACCEPTANCE,
} from '../src/lib/scan/levels.mjs';
import {
  buildVolumeBaseline, cumulativeRvol, intervalRvol, median, mad, baselineStatus, MIN_SESSIONS,
} from '../src/lib/scan/volume-baseline.mjs';
import {
  advance, createLifecycleStore, TRANSITIONS, LIFECYCLE_DEFAULTS,
} from '../src/lib/scan/lifecycle.mjs';
import { SIGNALS, SIGNAL_BY_ID, SIGNAL_IDS, CATEGORIES } from '../src/lib/scan/signals.mjs';
import { runCycle, evaluateSymbol, rankOf } from '../src/lib/scan/engine.mjs';
import { createPulse, PULSE_FILTERS, pulseLabel, MAX_EVENTS } from '../src/lib/scan/pulse.mjs';
import {
  FIELDS, OPERATORS, condition, matchesCondition, evaluateFilterSet, conditionAvailability,
  describeCondition,
} from '../src/lib/scan/filters.mjs';
import { PRESETS, presetAvailability, normalizeUserPreset } from '../src/lib/scan/presets.mjs';
import { COLUMNS, DEFAULT_COLUMNS, availableColumns, resolveLayout } from '../src/lib/scan/columns.mjs';
import {
  outcomeFor, summarize, splitSample, walkForward, liftOver, HORIZONS,
} from '../src/lib/scan/research.mjs';
import {
  contextBadge, newsContext, insiderContext, earningsContext, composeEnrichment, FRESH_NEWS_MINUTES,
} from '../src/lib/scan/enrichment.mjs';
import { allScenarios, SCENARIOS, at, bar, flat, ramp, volumeSession, DAY } from '../src/lib/scan/fixtures.mjs';
import { readFileSync } from 'node:fs';
import { relativeStrength, benchmarksFor, SECTOR_ETF } from '../src/lib/scan/relative-strength.mjs';
import { LIVE_FIELDS, liveFieldsWithAvailability } from '../src/lib/scan/scanner-fields.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
/**
 * The same assertion, for a check whose subject might THROW.
 *
 * A test that throws takes down every assertion after it, which turns one broken thing into a silent
 * run. Anything calling into code a regression could break outright goes through here instead, so the
 * failure is one line rather than an empty report.
 */
const okTry = (name, fn, detail = '') => {
  let value = false;
  try { value = fn(); } catch (e) { return ok(name, false, detail || `threw: ${e.message}`); }
  return ok(name, value, detail);
};
const okTryAsync = async (name, fn, detail = '') => {
  try { return ok(name, await fn(), detail); } catch (e) { return ok(name, false, detail || `threw: ${e.message}`); }
};
const section = (s) => console.log('\n' + s);

// A state built the way the engine builds one, for a scenario.
const stateOf = (sc) => buildSymbolState(sc.input, { now: sc.now });

// Run one scenario through the REAL engine on a fully capable feed, so a signal that is dark on the
// interim provider is still proved to work.
function runScenario(sc, { caps = FULL_PROVIDER, baseline = null } = {}) {
  const store = createLifecycleStore();
  const benchmarks = {};
  for (const [sym, b] of Object.entries(sc.benchmarks || {})) {
    benchmarks[sym] = buildSymbolState(b, { now: sc.now });
  }
  return runCycle({
    symbolStates: [stateOf(sc)],
    capabilities: caps,
    store,
    now: sc.now,
    benchmarks,
    baselines: baseline ? { [sc.input.symbol]: baseline } : {},
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. provider capabilities are declared, never assumed');
{
  ok('the vocabulary is closed', CAPABILITY_KEYS.length >= 15);
  ok('every requirement a signal uses is a real capability',
    requirementKeysUsed(SIGNALS).every((k) => REQUIREABLE.has(k)),
    requirementKeysUsed(SIGNALS).filter((k) => !REQUIREABLE.has(k)).join());
  // AN UNKNOWN CAPABILITY IS AN ABSENT ONE. There is no "assume yes" anywhere, because guessing
  // wrong produces a fabricated signal.
  const empty = describeProvider({});
  ok('an undescribed provider has nothing', CAPABILITY_KEYS
    .filter((k) => k !== 'quoteFreshness')
    .every((k) => empty[k] === false || empty[k] === 0));
  ok('a garbage claim is not believed', describeProvider({ liveVolume: 'yes' }).liveVolume === false);
  ok('freshness is ordered', freshnessAtLeast('realtime', 'delayed') && !freshnessAtLeast('delayed', 'realtime'));
  ok('an unknown freshness satisfies nothing', !freshnessAtLeast(null, 'eod'));

  // The interim feed, described honestly.
  ok('the interim provider is delayed', INTERIM_PROVIDER.quoteFreshness === FRESHNESS.DELAYED);
  ok('...does not stream', INTERIM_PROVIDER.streaming === false);
  ok('...and has no consolidated volume', INTERIM_PROVIDER.consolidatedVolume === false);
  ok('...nor a quote', INTERIM_PROVIDER.bidAsk === false);
  ok('...nor time-of-day volume history', INTERIM_PROVIDER.intradayVolumeHistory === false);

  const need = { requires: { consolidatedVolume: true } };
  ok('a signal needing what we lack is unavailable', !signalAvailability(need, INTERIM_PROVIDER).available);
  ok('...with a reason a trader can read',
    /consolidated volume/.test(signalAvailability(need, INTERIM_PROVIDER).reason || ''));
  ok('...and available on a capable feed', signalAvailability(need, FULL_PROVIDER).available);
  // A FINER bar is a SMALLER number, so this comparison is the one most likely to be written backwards.
  ok('a finer bar than the provider serves is unavailable',
    !signalAvailability({ requires: { minBarSeconds: 1 } }, INTERIM_PROVIDER).available);
  ok('...and a coarser one is fine',
    signalAvailability({ requires: { minBarSeconds: 60 } }, INTERIM_PROVIDER).available);
  ok('nothing at all is available with no provider',
    !signalAvailability({ requires: { historicalDaily: true } }, NO_PROVIDER).available);
}

section('2. every volume signal is dark on the interim feed');
{
  const { enabled, disabled } = partitionSignals(SIGNALS, INTERIM_PROVIDER);
  const volume = SIGNALS.filter((s) => s.category === 'volume');
  ok('there are volume signals to gate', volume.length >= 4);
  // THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE. RVOL is what traders size on, and single-venue
  // delayed prints would misstate it by an unknown multiple.
  ok('not one of them is enabled', volume.every((s) => !enabled.some((e) => e.id === s.id)));
  ok('...and each says why', volume.every((s) => {
    const d = disabled.find((x) => x.id === s.id);
    return d && /volume/.test(d.unavailable || '');
  }));
  ok('the quote-dependent signal is dark too', !enabled.some((s) => s.id === 'wide_spread'));
  ok('VWAP is dark, since it needs consolidated volume',
    !enabled.some((s) => s.id === 'vwap_reclaim') && !enabled.some((s) => s.id === 'vwap_loss'));
  // ...but the level work that settled daily data genuinely supports IS live.
  ok('daily-level breaks are live', enabled.some((s) => s.id === 'high_52w'));
  ok('premarket levels are live', enabled.some((s) => s.id === 'premarket_high_break'));
  ok('every signal comes alive on a capable feed',
    partitionSignals(SIGNALS, FULL_PROVIDER).disabled.length === 0,
    partitionSignals(SIGNALS, FULL_PROVIDER).disabled.map((d) => d.id).join());
  ok('nothing at all runs with no provider', partitionSignals(SIGNALS, NO_PROVIDER).enabled.length === 0);
}

section('3. the normalized state, and what it refuses to guess');
{
  const sc = SCENARIOS.premarketBreak();
  const st = stateOf(sc);
  ok('premarket bars are separated from the session', st.premarketBars.length > 0 && st.regularBars.length > 0);
  // Folding premarket into the session high is the classic way a scanner reports a breakout that
  // never happened: almost every gap-up opens below its own premarket high. Proved on a symbol that
  // stays BELOW its overnight range all session — using the breakout scenario would pass either way,
  // since there the session genuinely does take the premarket high out.
  const faded = buildSymbolState({
    symbol: 'FADE',
    bars: [...flat(SESSION.PREMARKET_OPEN + 120, 10, 20), ...flat(SESSION.REGULAR_OPEN, 10, 15)],
  }, { now: at(SESSION.REGULAR_OPEN + 10) });
  ok('the session high excludes premarket', faded.sessionHigh < faded.premarketHigh,
    `${faded.sessionHigh} vs ${faded.premarketHigh}`);
  ok('...and the premarket high is the overnight one', Math.abs(faded.premarketHigh - 20.03) < 0.05);
  ok('the premarket high is the premarket high', Math.abs(st.premarketHigh - 12.22) < 0.05, String(st.premarketHigh));
  ok('the gap is measured open against yesterday', st.gapPct != null);
  ok('phases are classified', sessionPhase(SESSION.REGULAR_OPEN) === 'regular'
    && sessionPhase(SESSION.PREMARKET_OPEN) === 'premarket'
    && sessionPhase(SESSION.REGULAR_CLOSE) === 'afterhours'
    && sessionPhase(0) === 'closed');
  ok('the clock is the market’s, not the reader’s', etMinutesOf(at(SESSION.REGULAR_OPEN)) === SESSION.REGULAR_OPEN);

  // NULL IS UNKNOWN, everywhere.
  const bare = buildSymbolState({ symbol: 'X' }, { now: at(600) });
  ok('an empty symbol yields nulls, not zeros',
    bare.prevHigh === null && bare.high52w === null && bare.volume === null && bare.atr14 === null);
  ok('a missing price is null', bare.price === null);
  ok('an unknown halt status stays unknown', bare.haltStatus === null);
  ok('no symbol is no state', buildSymbolState({}) === null);

  // A spread needs BOTH sides and a sane book.
  const crossed = buildSymbolState({ symbol: 'X', price: 10, bid: 10.05, ask: 9.95 }, { now: at(600) });
  ok('a crossed book yields no spread', crossed.spread === null && crossed.spreadPct === null);
  const oneSided = buildSymbolState({ symbol: 'X', price: 10, bid: 9.99 }, { now: at(600) });
  ok('a one-sided book yields no spread', oneSided.spread === null);

  ok('percent change refuses a zero base', pctChange(0, 5) === null);
  ok('...and an unknown one', pctChange(null, 5) === null);
}

section('4. the opening range will not be broken before it exists');
{
  const early = SCENARIOS.openingRangeTooEarly();
  ok('a forming range has no levels', openingRange(stateOf(early), 5) === null);
  const done = SCENARIOS.openingRangeBreak();
  const or = openingRange(stateOf(done), 5);
  ok('a finished range has both', or && or.high != null && or.low != null);
  ok('...and is marked complete', or.complete === true);
  ok('a range longer than the session so far is null', openingRange(stateOf(done), 390) === null);
  ok('a nonsense range length is null', openingRange(stateOf(done), 0) === null);
}

section('5. VWAP is refused without consolidated volume');
{
  const sc = SCENARIOS.premarketBreak();
  const st = buildSymbolState({ ...sc.input, volumeQuality: 'single-venue' }, { now: sc.now });
  // A VWAP from one venue's prints is not the VWAP anyone is trading against, and "reclaimed VWAP"
  // is a line people act on.
  ok('single-venue volume yields no VWAP', sessionVwap(st) === null);
  const good = buildSymbolState({ ...sc.input, volumeQuality: 'consolidated' }, { now: sc.now });
  ok('consolidated volume yields one', sessionVwap(good) != null);
  ok('...and the caller may waive the requirement explicitly',
    sessionVwap(st, { requireConsolidated: false }) != null);
}

section('6. velocity, acceleration, and what cannot be computed');
{
  const bars = [...flat(570, 10, 100), ...ramp(580, 10, 100, 102)];
  const now = at(589);
  const v = velocity(bars, '5m', now);
  ok('a window measures its own span', v && v.pct > 0);
  ok('a window reaching past the data is null', velocity(bars, '30m', now) === null);
  ok('an unknown window is null', velocity(bars, '7m', now) === null);
  ok('one bar is not a velocity', velocity([bar(570, 100, 100)], '1m', now) === null);
  ok('a price before the data is unknown', priceAt(bars, DAY) === null);

  // ACCELERATION IS DIRECTIONAL. A reversal is a bigger delta than the brief's example and is not
  // acceleration of anything.
  const accelSc = SCENARIOS.acceleration();
  const a = acceleration(accelSc.input.bars, '5m', accelSc.now);
  ok('the brief’s example accelerates', a && a.accelerating === true, JSON.stringify(a && { c: a.current, p: a.prior }));
  ok('...from roughly +0.3% to roughly +1.8%', a && a.prior < 0.6 && a.current > 1.3, `${a?.prior} -> ${a?.current}`);
  const decel = SCENARIOS.deceleration();
  ok('a fading move does not', acceleration(decel.input.bars, '5m', decel.now)?.accelerating === false);
  const reversal = [...flat(570, 6, 100), ...ramp(576, 5, 100, 98), ...ramp(581, 5, 98, 99)];
  ok('a reversal is not acceleration', acceleration(reversal, '5m', at(585))?.accelerating !== true);
  ok('a flat prior window yields no ratio',
    acceleration([...flat(570, 12, 100), ...ramp(582, 4, 100, 101)], '5m', at(585))?.ratio == null);
  ok('acceleration needs two full windows', acceleration([...flat(580, 6, 100)], '5m', at(585)) === null);

  ok('momentum phases are named',
    momentumPhase(accelSc.input.bars, '5m', accelSc.now)?.phase === 'accelerating');
  ok('...including deceleration', momentumPhase(decel.input.bars, '5m', decel.now)?.phase === 'decelerating');
  ok('log returns exist for internal use', Number.isFinite(logReturn(bars, '5m', now)));

  // ATR NORMALISATION — the reason one threshold can serve a utility and a biotech.
  const st = buildSymbolState({ symbol: 'X', atr14: 2, bars, price: 102 }, { now });
  const nm = normalizedMove(st, '5m');
  ok('a move is expressed in the symbol’s own range', nm && nm.atrShare > 0);
  ok('no ATR means no normalised move',
    normalizedMove(buildSymbolState({ symbol: 'X', bars, price: 102 }, { now }), '5m') === null);

  // THE 30-SECOND WINDOW: architected, and off until a feed observes fast enough.
  const w30 = VELOCITY_WINDOWS.find((w) => w.id === '30s');
  ok('a 30-second window exists', !!w30);
  ok('...and needs more than one observation a minute', w30.requires.observationsPerMinute >= 2);
  ok('...so it is unavailable on the interim feed',
    !signalAvailability({ requires: w30.requires }, INTERIM_PROVIDER).available);
  ok('...and available on a streaming one',
    signalAvailability({ requires: w30.requires }, FULL_PROVIDER).available);
}

section('7. a level is taken, not touched');
{
  const level = 100;
  const held = [...flat(570, 3, 99), bar(573, 99, 100.5), bar(574, 100.5, 100.6), bar(575, 100.6, 100.7)];
  const st = buildSymbolState({ symbol: 'X', price: 100.7, bars: held }, { now: at(575) });
  const i = levelInteraction(st, level, { side: 'up' });
  ok('through and held is acceptance', i.accepted === true);
  ok('...and it counts the bars', i.barsBeyond >= 2);
  ok('...and the distance', i.throughPct > 0);

  const poke = [...flat(570, 3, 99), bar(573, 99, 100.05), ...flat(574, 3, 99.5)];
  const st2 = buildSymbolState({ symbol: 'X', price: 99.5, bars: poke }, { now: at(576) });
  const i2 = levelInteraction(st2, level, { side: 'up' });
  // A one-tick poke is NOT a breakout, and the failure is itself reported.
  ok('a poke is not acceptance', i2.accepted === false);
  ok('...it is a rejection', i2.rejected === true);
  ok('...and the attempt is measured', i2.maxExcursionPct > 0);

  // Through by a wide margin, but only ONE bar old. Distance alone would call this acceptance, so
  // this is what proves the dwell requirement is doing work.
  const oneBar = [...flat(570, 4, 99), bar(574, 99, 101)];
  const stDwell = buildSymbolState({ symbol: 'X', price: 101, bars: oneBar }, { now: at(574) });
  ok('one bar through is not yet acceptance', levelInteraction(stDwell, level, { side: 'up' }).accepted === false);
  const twoBars = [...flat(570, 4, 99), bar(574, 99, 101), bar(575, 101, 101.2)];
  const stHeld = buildSymbolState({ symbol: 'X', price: 101.2, bars: twoBars }, { now: at(575) });
  ok('...and two bars is', levelInteraction(stHeld, level, { side: 'up' }).accepted === true);

  const tiny = [...flat(570, 3, 99.99), bar(573, 99.99, 100.01), bar(574, 100.01, 100.01)];
  const st3 = buildSymbolState({ symbol: 'X', price: 100.01, bars: tiny }, { now: at(574) });
  ok('a cent through a $100 stock is not acceptance',
    levelInteraction(st3, level, { side: 'up' }).accepted === false);

  // A LEVEL WE DO NOT KNOW IS NOT A LEVEL AT ZERO.
  ok('an unknown level yields nothing', levelInteraction(st, null, { side: 'up' }) === null);
  ok('a zero level yields nothing', levelInteraction(st, 0, { side: 'up' }) === null);
  ok('an unknown price yields nothing',
    levelInteraction(buildSymbolState({ symbol: 'X' }, { now: at(574) }), 100) === null);

  ok('through-distance is signed by side', throughPct(100, 101, 'up') > 0 && throughPct(100, 99, 'down') > 0);
  ok('bars beyond stops at the first bar inside', barsBeyond(poke, level, 'up') === 0);
  ok('a crossing is detected', justCrossed([bar(1, 99, 99.5), bar(2, 99.5, 100.5)], 100, 'up'));
  ok('...and is not the same as being above', !justCrossed([bar(1, 101, 101), bar(2, 101, 102)], 100, 'up'));

  // A RECLAIM NEEDS HISTORY: above, lost, retaken. Without it every gap-up "reclaims" VWAP.
  const reclaim = [bar(1, 101, 101), bar(2, 101, 99), bar(3, 99, 99), bar(4, 99, 101)];
  ok('a reclaim requires having been above first', reclaimed(reclaim, 100, { side: 'up' }) === true);
  ok('...so a first-bar gap-up is not one',
    reclaimed([bar(1, 99, 99), bar(2, 99, 101), bar(3, 101, 102)], 100, { side: 'up' }) === false);
  // Never lost the level at all — the case that separates "reclaimed" from "has been above".
  ok('...and neither is never having lost it',
    reclaimed([bar(1, 101, 101), bar(2, 101, 101.5), bar(3, 101.5, 102)], 100, { side: 'up' }) === false);
}

section('8. RVOL is time-of-day aware, and robust');
{
  ok('the median is the middle', median([1, 2, 3, 4, 100]) === 3);
  ok('an empty set has no median', median([]) === null);
  ok('the deviation is robust', mad([10, 10, 10, 10, 1000]) === 0);

  const sessions = Array.from({ length: 15 }, () => volumeSession());
  const baseline = buildVolumeBaseline(sessions);
  ok('a baseline builds from enough sessions', !!baseline);
  ok('too few sessions is no baseline', buildVolumeBaseline(sessions.slice(0, 3)) === null);
  ok('...and says why', /sessions/.test(baselineStatus(null, FULL_PROVIDER).reason || ''));
  ok('no history capability is no baseline at all',
    baselineStatus(baseline, INTERIM_PROVIDER).ready === false);

  // THE WHOLE POINT: volume is not evenly distributed, so a flat fraction of a daily average is wrong.
  const open = baseline.cumulative.get(570);
  const midday = baseline.cumulative.get(720);
  ok('the baseline knows the open is heavier', open.median > 0 && midday.median > open.median);

  const r = cumulativeRvol(baseline, 570, open.median * 3);
  ok('three times normal reads as 3×', Math.abs(r.rvol - 3) < 0.01);
  ok('...and is dimensioned in robust terms', r.z !== undefined);
  // A MISSING BASELINE MUST NOT BECOME AN RVOL OF 1.
  ok('no baseline is no RVOL', cumulativeRvol(null, 570, 1000) === null);
  ok('an hour with no history is no RVOL', cumulativeRvol(baseline, 60, 1000) === null);
  ok('unknown volume is no RVOL', cumulativeRvol(baseline, 570, null) === null);
  ok('interval RVOL works the same way', intervalRvol(baseline, 570, baseline.interval.get(570).median * 4).rvol > 3.9);

  // One extraordinary session must not destroy the reference.
  const withOutlier = [...sessions, volumeSession({ scale: 500 })];
  const robust = buildVolumeBaseline(withOutlier);
  ok('a single blowout session does not move the median',
    Math.abs(robust.cumulative.get(570).median - open.median) < 0.001);
}

section('9. STATE and EVENT are different things');
{
  const store = createLifecycleStore();
  const t0 = at(600);
  const on = { active: true, direction: 'up', detail: 'up', values: { x: 1 } };
  const off = { active: false };

  let rec = store.get('X', 'sig', t0);
  const first = advance(rec, on, { now: t0 });
  ok('becoming true is an event', first.event != null && first.transition === TRANSITIONS.ACTIVATED);
  ok('...and records when', first.record.triggeredAt === t0);

  // STAYING true publishes NOTHING. This is what stops Pit Pulse repeating itself every second.
  const second = advance(first.record, on, { now: t0 + 1000 });
  ok('staying true is not an event', second.event === null && second.transition === TRANSITIONS.SUSTAINED);
  const third = advance(second.record, on, { now: t0 + 60_000 });
  ok('...still not, a minute later', third.event === null);
  ok('...and the trigger time does not move', third.record.triggeredAt === t0);

  const ended = advance(third.record, off, { now: t0 + 120_000 });
  ok('ending is a transition', ended.transition === TRANSITIONS.DEACTIVATED);
  ok('...but not a published event', ended.event === null);

  // COOLDOWN: chopping either side of a level must not republish on every crossing.
  const chop = advance(ended.record, on, { now: t0 + 121_000 });
  ok('an immediate re-fire is suppressed', chop.event === null);
  ok('...though the state is active again', chop.record.active === true);
  const later = advance(ended.record, on, { now: t0 + 120_000 + LIFECYCLE_DEFAULTS.cooldownSeconds * 1000 + 1000 });
  ok('...and it may fire again once the cooldown passes', later.event != null);

  // UNDETERMINABLE IS NOT FALSE. A feed hiccup must not publish "no longer above its high".
  okTry('missing data changes nothing', () => {
    const h = advance(third.record, null, { now: t0 + 61_000 });
    return h.transition === null && h.event === null;
  });
  okTry('...and holds the previous state', () => advance(third.record, null, { now: t0 + 61_000 }).record.active === true);
  const stale = advance(third.record, null, { now: t0 + 60_000 + LIFECYCLE_DEFAULTS.ttlSeconds * 1000 + 1000 });
  ok('...until it is simply too old', stale.transition === TRANSITIONS.EXPIRED);

  // A FAILED BREAK IS INFORMATION.
  const failed = advance({ ...ended.record, fires: 1 }, { active: false, invalidated: true }, { now: t0 + 130_000 });
  ok('a failure publishes once', failed.event != null && failed.transition === TRANSITIONS.INVALIDATED);

  // DWELL: a state may be required to persist before it counts at all.
  const dwell = advance(store.get('Y', 'sig', t0), on, { now: t0, config: { minActiveSeconds: 30 } });
  ok('a dwell requirement delays the event', dwell.event === null);
  const dwelt = advance(dwell.record, on, { now: t0 + 31_000, config: { minActiveSeconds: 30 } });
  ok('...until it has persisted', dwelt.event != null);

  ok('a store prunes what ended long ago', (() => {
    const s = createLifecycleStore();
    s.set({ symbol: 'Z', signalId: 'a', active: false, deactivatedAt: t0 });
    s.prune(t0 + 7200_000);
    return s.size() === 0;
  })());
}

section('10. every scenario behaves exactly as constructed');
{
  for (const sc of allScenarios()) {
    const result = runScenario(sc);
    const fired = new Set(result.rows[0]?.signals?.map((s) => s.id) || []);
    for (const id of sc.expect.fires) {
      ok(`${sc.label}: fires ${id}`, fired.has(id), [...fired].join() || 'nothing fired');
    }
    // THE NEGATIVES. Most of the scanner's value is in what it refuses to report.
    for (const id of sc.expect.silent) {
      ok(`${sc.label}: stays silent on ${id}`, !fired.has(id));
    }
  }

  // The quiet stock is the one that must produce nothing at all.
  const quiet = runScenario(SCENARIOS.quiet());
  ok('a quiet stock produces no row', quiet.rows.length === 0, JSON.stringify(quiet.rows[0]?.signals));
  ok('...and no events', quiet.events.length === 0);
}

section('11. signal stacking, ranking, and why a symbol is on the screen');
{
  const result = runScenario(SCENARIOS.stacked());
  const row = result.rows[0];
  // Guarded: if the stacked scenario stopped producing a row at all, every check below would throw
  // and the rest of the run would be silent.
  ok('the stacked scenario produces a row', !!row);
  if (!row) throw new Error('stacked scenario produced no row');
  ok('a symbol can carry several signals at once', row.signals.length >= 4, String(row.signals.length));
  ok('each one explains itself', row.signals.every((s) => typeof s.detail === 'string' && s.detail.length > 8));
  ok('each one is timestamped', row.signals.every((s) => Number.isFinite(s.since)));
  ok('each one names its category', row.signals.every((s) => !!CATEGORIES[s.category]));
  ok('they are ordered newest first', row.signals.every((s, i, a) => i === 0 || a[i - 1].since >= s.since));

  // NO BLACK BOX. The rank is the sum of the weights of what is true and nothing else, so a reader
  // can reconstruct it from the badges on the row.
  ok('the rank is reconstructible from the row',
    row.rank === row.signals.reduce((t, s) => t + s.weight, 0));
  ok('more corroboration outranks less',
    rankOf([{ weight: 5 }, { weight: 3 }]) > rankOf([{ weight: 2 }]));
  ok('nothing in the row is an unexplained score',
    !('score' in row) && !('pitScore' in row) && !('pressure' in row));

  const single = runScenario(SCENARIOS.acceleration());
  ok('a one-signal symbol ranks below a stacked one', single.rows[0].rank < row.rank);
}

section('12. the engine refuses to invent, whatever the feed omits');
{
  // A missing previous-day high must be UNDETERMINABLE, not a break of zero.
  const missing = runScenario(SCENARIOS.missingPrevHigh());
  const fired = new Set(missing.rows[0]?.signals?.map((s) => s.id) || []);
  ok('a missing level fires nothing', !fired.has('prev_day_high_break'));

  // Volume present, but single-venue.
  const partial = runScenario(SCENARIOS.singleVenueVolume());
  const pf = new Set(partial.rows[0]?.signals?.map((s) => s.id) || []);
  ok('single-venue volume fires no volume signal',
    !['rvol_elevated', 'volume_spike', 'volume_acceleration', 'volume_confirmed_breakout'].some((id) => pf.has(id)));

  // The same symbol on the interim feed: the volume signals are not merely quiet, they are ABSENT.
  const interim = runScenario(SCENARIOS.singleVenueVolume(), { caps: INTERIM_PROVIDER });
  ok('...and on the interim feed they are not even enabled',
    !interim.enabledSignals.some((id) => id.startsWith('volume') || id === 'rvol_elevated'));
  ok('the disabled list explains each one', interim.disabledSignals.every((d) => !!d.reason));

  // A throwing signal must not lose the symbol.
  const boom = { id: 'boom', label: 'Boom', category: 'momentum', requires: {}, evaluate() { throw new Error('x'); } };
  const runBoom = () => runCycle({
    symbolStates: [stateOf(SCENARIOS.stacked())],
    capabilities: FULL_PROVIDER, store: createLifecycleStore(), now: SCENARIOS.stacked().now,
    registry: [boom, ...SIGNALS],
    benchmarks: {},
  });
  okTry('a broken signal does not take the cycle down', () => runBoom().rows.length === 1);
  okTry('...and does not itself fire', () => !runBoom().rows[0].signals.some((s) => s.id === 'boom'));
}

section('12b. a signal that depends on its peers sees what the same pass decided');
{
  // volume_confirmed_breakout is the only signal that reads others, and it must run AFTER them.
  // Without the ordering it would silently never confirm anything, which no other test would catch.
  const sessions = Array.from({ length: 15 }, () => volumeSession());
  const baseline = buildVolumeBaseline(sessions);
  const sc = SCENARIOS.stacked();
  const nowM = 570 + 34;
  const input = {
    ...sc.input,
    volumeQuality: 'consolidated',
    // Comfortably above the time-of-day median, so RVOL clears its threshold.
    volume: baseline.cumulative.get(Math.floor(nowM / 5) * 5).median * 6,
  };
  const store = createLifecycleStore();
  const bench = {};
  for (const [sym, b] of Object.entries(sc.benchmarks)) bench[sym] = buildSymbolState(b, { now: sc.now });
  const res = runCycle({
    symbolStates: [buildSymbolState(input, { now: sc.now })],
    capabilities: FULL_PROVIDER, store, now: sc.now, benchmarks: bench,
    baselines: { [input.symbol]: baseline },
  });
  const fired = new Set(res.rows[0]?.signals?.map((s) => s.id) || []);
  ok('a breakout is found', [...fired].some((id) => SIGNAL_BY_ID.get(id)?.category === 'breakout'));
  ok('RVOL is elevated', fired.has('rvol_elevated'));
  ok('...so the breakout is volume-confirmed', fired.has('volume_confirmed_breakout'), [...fired].join());
  const confirm = res.rows[0].signals.find((s) => s.id === 'volume_confirmed_breakout');
  ok('...and says which breakout it confirmed', !!confirm?.values?.confirms);
  ok('...naming a signal that really fired', fired.has(confirm.values.confirms));
}

section('13. relative strength is measured over the same window');
{
  const sc = SCENARIOS.relativeStrength();
  const st = stateOf(sc);
  const bench = {};
  for (const [sym, b] of Object.entries(sc.benchmarks)) bench[sym] = buildSymbolState(b, { now: sc.now });
  const rs = relativeStrength(st, bench, { window: '5m', now: sc.now });
  ok('a strong symbol against a flat market diverges', rs && rs.spread > 0);
  ok('the strongest divergence is the one reported', ['SPY', 'QQQ'].includes(rs.benchmark));
  // A BENCHMARK WE COULD NOT MEASURE IS NOT A BENCHMARK OF ZERO.
  ok('no benchmark data is undeterminable, not strength', relativeStrength(st, {}, { now: sc.now }) === null);
  ok('a benchmark without bars is skipped',
    relativeStrength(st, { SPY: buildSymbolState({ symbol: 'SPY' }, { now: sc.now }) }, { now: sc.now }) === null);
  ok('the market benchmarks are always included', benchmarksFor(null).join() === 'SPY,QQQ');
  ok('...plus a sector proxy when the sector is known', benchmarksFor('Technology').includes('XLK'));
  ok('every sector maps to a real ETF', Object.values(SECTOR_ETF).every((e) => /^[A-Z]{3,4}$/.test(e)));
}

section('14. Pit Pulse: a bounded tape that does not repeat itself');
{
  const pulse = createPulse({ max: 5 });
  const mk = (i, sym = 'AAA') => ({
    id: `${sym}:sig:activated:${i}`, symbol: sym, signalId: 'sig', category: 'breakout',
    transition: TRANSITIONS.ACTIVATED, at: at(600) + i * 1000, label: 'PM high break',
  });
  pulse.push([mk(1), mk(2), mk(3)]);
  ok('events land on the tape', pulse.size() === 3);
  ok('the same event twice is ignored', pulse.push([mk(1)]) === 0);
  pulse.push([mk(4), mk(5), mk(6), mk(7)]);
  ok('the tape is bounded', pulse.size() === 5);
  ok('...keeping the newest', pulse.list()[0].at === at(600) + 7000);
  ok('it is newest-first', pulse.list().every((e, i, a) => i === 0 || a[i - 1].at >= e.at));

  pulse.push([{ ...mk(8), category: 'momentum' }]);
  ok('it filters by category', pulse.list({ category: 'momentum' }).length === 1);
  ok('...and by symbol', pulse.list({ symbol: 'AAA' }).length > 0);
  ok('an unknown category yields nothing', pulse.list({ category: 'nope' }).length === 0);

  // Endings are not news; failures are.
  pulse.push([{ ...mk(9), transition: TRANSITIONS.DEACTIVATED }]);
  ok('endings are hidden by default', !pulse.list().some((e) => e.transition === TRANSITIONS.DEACTIVATED));
  ok('...but can be asked for', pulse.list({ includeEndings: true }).some((e) => e.transition === TRANSITIONS.DEACTIVATED));
  const failTape = createPulse();
  failTape.push([{ ...mk(1), transition: TRANSITIONS.INVALIDATED }]);
  ok('a failed break is shown', failTape.list().length === 1);
  ok('...and labelled as a failure', /FAILED/.test(pulseLabel(failTape.list()[0])));

  ok('the filters cover every signal category',
    Object.keys(CATEGORIES).every((c) => PULSE_FILTERS.some((f) => f.id === c)));
  ok('...plus the intelligence categories',
    ['news', 'insider', 'congress'].every((c) => PULSE_FILTERS.some((f) => f.id === c)));
  ok('the symbol drill-down is the chart-marker source', typeof pulse.forSymbol === 'function');
}

section('15. Custom Scanner is the same engine, driven by the trader');
{
  const rows = runScenario(SCENARIOS.stacked()).rows;
  const set = { conditions: [condition('signalCount', 'gte', [2])] };
  ok('a filter set selects rows', evaluateFilterSet(rows, set, FULL_PROVIDER).rows.length === 1);
  ok('an unmet filter selects none',
    evaluateFilterSet(rows, { conditions: [condition('price', 'gt', [10_000])] }, FULL_PROVIDER).rows.length === 0);

  // AN UNKNOWN VALUE NEVER MATCHES — not for `lt`, not for anything.
  const noFloat = [{ symbol: 'X', float: null, signals: [] }];
  ok('a missing value matches no operator',
    evaluateFilterSet(noFloat, { conditions: [condition('float', 'lt', [1e9])] }, FULL_PROVIDER).rows.length === 0);

  // A CONDITION THE FEED CANNOT SUPPORT IS REPORTED, not silently dropped.
  const rvolSet = { conditions: [condition('rvol', 'gte', [3])] };
  const run = evaluateFilterSet(rows, rvolSet, INTERIM_PROVIDER);
  ok('an unsupported condition is reported', run.unsupported.length === 1);
  ok('...with a reason', /volume/.test(run.unsupported[0]?.reason || ''));
  ok('...and is not applied', run.applied === 0);
  ok('...and is supported on a capable feed',
    evaluateFilterSet(rows, rvolSet, FULL_PROVIDER).unsupported.length === 0);

  // Signal conditions inherit the requirements of the signal they name.
  ok('a signal condition inherits its signal’s requirements',
    !conditionAvailability(condition('hasSignal', 'isTrue', ['rvol_elevated']), INTERIM_PROVIDER).available);
  ok('...and is available when that signal is',
    conditionAvailability(condition('hasSignal', 'isTrue', ['high_52w']), INTERIM_PROVIDER).available);

  ok('every field reads without throwing', Object.values(FIELDS).every((f) => {
    try { f.read({ signals: [], context: null }, 'x'); return true; } catch { return false; }
  }));
  ok('every operator has an arity', Object.values(OPERATORS).every((o) => Number.isInteger(o.arity)));
  ok('conditions describe themselves', /Price/.test(describeCondition(condition('price', 'gt', [5]))));
  ok('an unknown field describes itself honestly', /Unknown/.test(describeCondition({ field: 'nope' })));
}

section('16. presets are ordinary filter sets, and say when they cannot run');
{
  ok('there are built-in screens', PRESETS.length >= 6);
  ok('every preset is expressible in the shared field vocabulary',
    PRESETS.every((p) => p.conditions.every((c) => !!FIELDS[c.field])),
    PRESETS.flatMap((p) => p.conditions.filter((c) => !FIELDS[c.field]).map((c) => `${p.id}:${c.field}`)).join());
  ok('every preset names its columns', PRESETS.every((p) => Array.isArray(p.columns) && p.columns.length));
  ok('a volume preset cannot run on the interim feed',
    presetAvailability(PRESETS.find((p) => p.id === 'volume_ignition'), INTERIM_PROVIDER).available === false);
  ok('...and says why', !!presetAvailability(PRESETS.find((p) => p.id === 'volume_ignition'), INTERIM_PROVIDER).reason);
  ok('a breakout preset can', presetAvailability(PRESETS.find((p) => p.id === 'fresh_breakouts'), INTERIM_PROVIDER).available);
  ok('every preset runs on a capable feed', PRESETS.every((p) => presetAvailability(p, FULL_PROVIDER).available));

  // A saved screen is validated against the SAME registry, so it cannot hold a condition the engine
  // does not understand and quietly stop filtering.
  const saved = normalizeUserPreset({ label: 'Mine', conditions: [condition('price', 'gt', [5]), { field: 'nope' }] });
  ok('a user preset keeps what is valid', saved.conditions.length === 1);
  ok('...and is named', saved.label === 'Mine');
  ok('an unnamed preset is refused', normalizeUserPreset({ conditions: [] }) === null);
}

section('17. the table offers only columns the feed can fill');
{
  const avail = availableColumns(INTERIM_PROVIDER, signalAvailability).map((c) => c.id);
  ok('the essentials are always there', ['symbol', 'price', 'changePct', 'signals'].every((id) => avail.includes(id)));
  // NOT ALL AT ONCE: twenty-eight columns is a spreadsheet, not a scanner.
  ok('the defaults are a readable handful', DEFAULT_COLUMNS.length <= 8);
  ok('every default is a real column', DEFAULT_COLUMNS.every((id) => COLUMNS.some((c) => c.id === id)));
  ok('RVOL is not offered without the volume to compute it', !avail.includes('rvol'));
  ok('the 30-second column is not offered on a one-a-minute feed', !avail.includes('vel_30s'));
  ok('...and is on a streaming one', availableColumns(FULL_PROVIDER, signalAvailability).map((c) => c.id).includes('vel_30s'));
  ok('a saved layout drops what the feed cannot fill',
    !resolveLayout(['symbol', 'rvol', 'price'], INTERIM_PROVIDER, signalAvailability).includes('rvol'));
  ok('...and keeps the rest', resolveLayout(['symbol', 'rvol', 'price'], INTERIM_PROVIDER, signalAvailability).includes('price'));
  ok('an unknown column in a saved layout is ignored',
    !resolveLayout(['symbol', 'nope'], INTERIM_PROVIDER, signalAvailability).includes('nope'));
  ok('an empty layout falls back to the defaults',
    resolveLayout([], INTERIM_PROVIDER, signalAvailability).length > 0);
}

section('18. Catalyst Pit intelligence enriches, and never triggers');
{
  const now = at(600);
  ok('fresh news is attached', newsContext({ headline: 'x', publishedAt: now - 6 * 60_000 }, now).ageMinutes === 6);
  // Beyond a couple of hours it is background on the company, not an explanation of a live move.
  ok('stale news is not', newsContext({ headline: 'x', publishedAt: now - (FRESH_NEWS_MINUTES + 10) * 60_000 }, now) === null);
  ok('undated news is not', newsContext({ headline: 'x' }, now) === null);
  ok('insider buying is attached', insiderContext({ lastBuyAt: now - 3 * 86_400_000 }, now).daysAgo === 3);
  ok('...and old insider buying is not', insiderContext({ lastBuyAt: now - 200 * 86_400_000 }, now) === null);
  ok('upcoming earnings are attached', earningsContext({ nextAt: now + 2 * 86_400_000 }, now).inDays === 2);
  ok('distant earnings are not', earningsContext({ nextAt: now + 60 * 86_400_000 }, now) === null);

  ok('the badge prefers the freshest thing', contextBadge({ news: { ageMinutes: 5 }, insider: { daysAgo: 2 } }).kind === 'news');
  ok('no intelligence is no badge', contextBadge({}) === null);

  // ENRICHMENT NEVER CAUSES A SYMBOL TO APPEAR — price and volume do that.
  const quiet = runScenario(SCENARIOS.quiet());
  ok('a quiet stock with news still does not appear', quiet.rows.length === 0);
  ok('no signal reads the context', SIGNALS.every((s) => !/context/.test(String(s.evaluate))));

  // One dark source must not cost the trader the scanner.
  await okTryAsync('a failing source is skipped, not fatal', async () => {
    const composed = await composeEnrichment([
      async () => new Map([['AAA', { news: { headline: 'ok' } }]]),
      async () => { throw new Error('down'); },
    ], ['AAA']);
    return composed.get('AAA')?.news?.headline === 'ok';
  });
}

section('19. the research harness can prove a signal does nothing');
{
  const t = at(600);
  const bars = [...flat(600, 5, 100), ...ramp(605, 30, 100, 103)];
  const event = { id: 'e1', symbol: 'X', signalId: 'sig', at: t, direction: 'up' };
  const o = outcomeFor(event, bars, { horizons: [5, 15] });
  ok('an outcome measures forward return', o.forward.m5 > 0);
  ok('...from the price at the event, not a better one', Math.abs(o.entry - 100) < 0.2);
  ok('...and reports excursions', o.mfe >= 0 && o.mae <= 0);
  // A HORIZON THE DATA DOES NOT REACH IS NULL, never zero — that is how a sample gets biased toward
  // "no effect" without anyone noticing.
  ok('an unreached horizon is null', outcomeFor(event, bars, { horizons: [600] }).forward.m600 === null);
  ok('an event after the data yields nothing', outcomeFor({ ...event, at: t + 10 * 86_400_000 }, bars) === null);
  // A short signal that falls has done well.
  const shortO = outcomeFor({ ...event, direction: 'down' }, bars, { horizons: [15] });
  ok('direction is respected', shortO.forward.m15 < 0);

  // SKEWED ON PURPOSE. With a symmetric sample the median and the mean are the same number and the
  // assertion below would pass either way — which is exactly how a mean sneaks back in.
  const outcomes = Array.from({ length: 40 }, (_, i) => ({
    at: t + i * 60_000,
    forward: { m15: i === 39 ? 500 : (i % 2 ? 1 : -0.5) },
    mfe: 2, mae: -1, continued: i % 2 === 1, failed: i % 2 === 0,
  }));
  const s = summarize(outcomes, { horizons: [15] });
  const mean = outcomes.map((o) => o.forward.m15).reduce((a, b) => a + b, 0) / outcomes.length;
  ok('a summary uses the median, not the mean',
    s.byHorizon.m15.median != null && Math.abs(s.byHorizon.m15.median - mean) > 1,
    `median ${s.byHorizon.m15.median} vs mean ${mean.toFixed(2)}`);
  ok('...so one outlier cannot carry it', s.byHorizon.m15.median < 2);
  ok('...and reports a hit rate', s.byHorizon.m15.hitRate === 0.5);
  // BELOW THE MINIMUM, NOTHING IS CONCLUDED.
  ok('a small sample concludes nothing', summarize(outcomes.slice(0, 5)).sufficient === false);
  ok('...and a large one does', s.sufficient === true);

  // THE SAMPLE DISCIPLINE. Splitting by time, never at random, because a random split leaks regime.
  const { train, test } = splitSample(outcomes);
  ok('the split is chronological', train.every((a) => test.every((b) => a.at <= b.at)));
  ok('...and both halves are used', train.length > 0 && test.length > 0);
  const folds = walkForward(outcomes, { folds: 3 });
  ok('walk-forward folds train before they test',
    folds.length === 3 && folds.every((f) => f.train.every((a) => f.test.every((b) => a.at <= b.at))));

  // THE ONLY QUESTION WORTH ASKING: did this moment differ from an arbitrary one?
  const lift = liftOver(outcomes, outcomes.map((o2) => ({ ...o2, forward: { m15: 0 } })), { horizon: 15 });
  ok('lift over a baseline is computed', lift && lift.lift === lift.signal);
  ok('no baseline is no conclusion', liftOver(outcomes, [], { horizon: 15 }) === null);
  ok('the horizons are the decision horizons', HORIZONS.includes(5) && HORIZONS.includes(30));
}

section('20. one cycle serves every product');
{
  const sc = SCENARIOS.stacked();
  const store = createLifecycleStore();
  const bench = {};
  for (const [sym, b] of Object.entries(sc.benchmarks || {})) bench[sym] = buildSymbolState(b, { now: sc.now });
  const first = runCycle({
    symbolStates: [stateOf(sc)], capabilities: FULL_PROVIDER, store, now: sc.now, benchmarks: bench,
  });
  ok('one pass yields both rows and events', first.rows.length === 1 && first.events.length > 0);
  ok('the rows are the table', first.rows[0].signals.length > 0);
  ok('the events are the tape', first.events.every((e) => e.transition === TRANSITIONS.ACTIVATED));
  ok('the cycle states what is enabled', first.enabledSignals.length > 0);
  ok('...and what is not, with reasons', Array.isArray(first.disabledSignals));

  // A SECOND PASS OVER UNCHANGED DATA MUST PUBLISH NOTHING. This is the property that keeps the tape
  // readable, and it holds because lifecycle owns it rather than each signal.
  const second = runCycle({
    symbolStates: [stateOf(sc)], capabilities: FULL_PROVIDER, store, now: sc.now + 1000, benchmarks: bench,
  });
  ok('re-running publishes no new events', second.events.length === 0, String(second.events.length));
  ok('...but the row is still there', second.rows.length === 1);
  ok('...with the original trigger times', second.rows[0].signals.every((s) => s.since <= sc.now));

  // Ordering is by corroboration, and ties break on recency.
  const many = runCycle({
    symbolStates: [stateOf(SCENARIOS.stacked()), stateOf(SCENARIOS.acceleration())],
    capabilities: FULL_PROVIDER, store: createLifecycleStore(), now: sc.now, benchmarks: bench,
  });
  ok('rows are ranked', many.rows.length === 2 && many.rows[0].rank >= many.rows[1].rank);

  // SCALE: the work is per symbol and the capability check is per cycle, not per symbol.
  const universe = Array.from({ length: 300 }, (_, i) =>
    buildSymbolState({ ...SCENARIOS.quiet().input, symbol: `S${i}` }, { now: sc.now }));
  const t0 = Date.now();
  const big = runCycle({ symbolStates: universe, capabilities: FULL_PROVIDER, store: createLifecycleStore(), now: sc.now });
  const ms = Date.now() - t0;
  ok('three hundred symbols evaluate quickly', ms < 2000, `${ms}ms`);
  ok('...and a quiet universe produces no rows', big.rows.length === 0);
}

section('21. the Custom Scanner vocabulary: Finviz on the surface, the engine underneath');
{
  const dailySrc = readFileSync(new URL('../src/lib/screener-filters.js', import.meta.url), 'utf8');
  const live = liveFieldsWithAvailability(INTERIM_PROVIDER, signalAvailability);

  // ONE SHAPE, TWO SOURCES. The panel renders both from one list, so a live field must look exactly
  // like a daily one — a second dialect would mean a second UI.
  ok('every live field has a label, category and type',
    Object.values(live).every((x) => x.label && x.category && x.type));
  ok('every live field offers dropdown presets',
    Object.values(live).every((x) => Array.isArray(x.opts) && x.opts.length >= 2),
    Object.entries(live).filter(([, x]) => !(x.opts || []).length).map(([k]) => k).join());
  ok('every preset carries the condition it sets',
    Object.values(live).every((x) => x.opts.every((o) => o && o.label && o.cond && typeof o.cond === 'object')));
  ok('...in the same shape the daily filters already use',
    Object.values(live).every((x) => x.opts.every((o) => ['min', 'max', 'eq'].some((k) => k in o.cond))));
  // A collision would mean one field silently shadowing another in the merged menu. Checked against
  // the daily registry's own declarations rather than by importing it, since that module needs the
  // database layer to load.
  const dailyKeys = new Set([...dailySrc.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s/gm)].map((m) => m[1]));
  ok('the daily registry was read', dailyKeys.size > 40, String(dailyKeys.size));
  ok('a merged vocabulary has no key collisions',
    Object.keys(live).every((k) => !dailyKeys.has(k)),
    Object.keys(live).filter((k) => dailyKeys.has(k)).join());
  ok('the categories a trader scans are all present',
    ['Momentum', 'Volume', 'Structure', 'Premarket', 'Relative Strength', 'Volatility', 'Liquidity', 'Catalyst']
      .every((c) => Object.values(live).some((x) => x.category === c)));

  // CAPABILITY GATING. None of the market-dependent ones can run on the interim feed.
  const marketFields = Object.entries(live).filter(([, x]) => Object.keys(x.requires).length);
  ok('every market-dependent live field is unavailable on the interim feed',
    marketFields.every(([, x]) => x.available === false),
    marketFields.filter(([, x]) => x.available).map(([k]) => k).join());
  ok('...and each says which capability it needs',
    marketFields.every(([, x]) => typeof x.unavailableReason === 'string' && x.unavailableReason.length > 6));
  ok('the 30-second window demands more than the one-minute one',
    live.vel30s.available === false
      && JSON.stringify(live.vel30s.requires) !== JSON.stringify(live.vel1m.requires));
  ok('RVOL needs time-of-day history, not merely volume', live.rvol.requires.intradayVolumeHistory === true);
  ok('VWAP needs consolidated volume', live.vwapSide.requires.consolidatedVolume === true);
  ok('the spread filter needs a quote', live.spreadPct.requires.bidAsk === true);
  // The intelligence filters read our OWN data, so they are usable today.
  ok('Catalyst Pit intelligence filters need no market capability',
    live.newsAge.available === true && live.hasInsiderBuy.available === true);

  // EVERYTHING COMES ALIVE on a capable feed — proving they are gated, not broken.
  const full = liveFieldsWithAvailability(FULL_PROVIDER, signalAvailability);
  ok('every live field is available on a capable feed',
    Object.values(full).every((x) => x.available === true),
    Object.entries(full).filter(([, x]) => !x.available).map(([k]) => k).join());

  // THE DAILY SCANNER MUST NOT BREAK. A live field has no column, so it must never reach the SQL
  // builder even if a saved scan carries one.
  // THE GUARD. A live field has no column to compile against, so buildConds must refuse it — and the
  // `live` flag is what it keys on. Both halves are asserted: the flag on every live field, and the
  // guard that reads it.
  ok('every live field is marked live', Object.values(live).every((x) => x.live === true));
  ok('the SQL builder skips live fields', /if \(f\.live\) continue;/.test(dailySrc));
  ok('...after it has already skipped unavailable ones',
    dailySrc.indexOf('if (!f || !f.available || !cond) continue;') < dailySrc.indexOf('if (f.live) continue;'));
  ok('no daily field declares itself live', !/^\s{2}[a-zA-Z0-9]+:.*live: true/m.test(dailySrc));

  // Presets are professional values, not round numbers for their own sake.
  ok('RVOL presets run from 1 to 20',
    live.rvol.opts[0].cond.min === 1 && live.rvol.opts[live.rvol.opts.length - 1].cond.min === 20);
  ok('movement presets cover both directions',
    live.vel5m.opts.some((o) => o.cond.min > 0) && live.vel5m.opts.some((o) => o.cond.max < 0));
  ok('news-age presets are minutes, freshest first',
    live.newsAge.opts[0].cond.max === 5
      && live.newsAge.opts.every((o, i, arr) => i === 0 || arr[i - 1].cond.max <= o.cond.max));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
