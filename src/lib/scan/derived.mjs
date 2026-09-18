// THE DERIVED ROW — where the engine's calculations reach the table.
//
// Every function this file calls already existed and was already tested. What did not exist was the
// wiring: `runCycle` built rows out of raw state fields only, so ten of the twenty-three columns the
// capability layer declared available on a capable feed read `undefined`, and eleven filter fields
// with them. `velocityProfile()` and `relativeStrengthProfile()` were called by nothing but tests.
//
// So this module computes nothing new. It assembles what the engine already knows into the ONE shape
// the columns, the filters and the Finviz-style dropdowns read — see field-map.mjs for the single
// registry that says where each one looks.
//
// THREE RULES, and they are the whole reason this is a separate module rather than inline code:
//
//   UNKNOWN IS NULL, NEVER ZERO. A missing RVOL is not an RVOL of zero; a symbol with no benchmark is
//   not a symbol with no divergence. Filters treat null as "does not match", which is correct, and
//   would treat 0 as "matches RVOL < 1", which is a lie about a symbol we could not measure.
//
//   CAPABILITY GATES THE CALCULATION, not just the display. A window the feed cannot observe is
//   absent from the profile rather than computed from data too coarse to support it.
//
//   NOTHING IS INVENTED. Where the engine has no implementation the field is absent and field-map
//   marks it unsupported, which is a different statement from "null because the market is unknown".
//
// Pure and synchronous, like the rest of the engine.

import { velocityProfile, momentumPhase, VELOCITY_WINDOWS } from './velocity.mjs';
import { relativeStrength, relativeStrengthProfile } from './relative-strength.mjs';
import { cumulativeRvol, intervalRvol, BUCKET_MINUTES } from './volume-baseline.mjs';
import {
  sessionVwap, openingRange, OPENING_RANGE_MINUTES, premarketProfile, dayLocation,
  etMinutesOf, pctChange,
} from './market-state.mjs';
import { signalAvailability } from './market-capabilities.mjs';
import { SECTOR_ETF } from './relative-strength.mjs';

/** The symbol's sector proxy, from the classification screener_stocks already stores. */
const sectorBenchmark = (s) => s?.sectorEtf || (s?.sector ? SECTOR_ETF[s.sector] : null) || null;

const num = (v) => (Number.isFinite(v) ? v : null);

/** What counts as a volume spike, in RVOL terms. One number, stated once, used by field and signal. */
export const VOLUME_SPIKE_RVOL = 3;

/** Percentage distance from a level, unsigned — "how far away", which is what the filters ask. */
export function distancePct(price, level) {
  const p = num(price), l = num(level);
  if (p == null || l == null || l === 0) return null;
  return Math.abs((p - l) / l) * 100;
}

/**
 * Which side of VWAP, and whether it was just taken.
 *
 * `reclaim` and `loss` need the PREVIOUS side to be meaningful, and the engine is stateless between
 * cycles, so they are derived from the bar series rather than from memory: the last bar that closed
 * on the other side. Without bars the answer is the side only — never a guessed transition.
 */
export function vwapState(state, vwap) {
  const price = num(state?.price);
  const v = num(vwap);
  if (price == null || v == null) return null;
  const side = price >= v ? 'above' : 'below';
  const bars = state?.regularBars || [];
  // Walk back for the most recent close on the opposite side. If the symbol has been on this side
  // for the whole session there is no crossing to report.
  let crossed = false;
  for (let i = bars.length - 1; i >= 0 && i >= bars.length - 30; i--) {
    const c = num(bars[i]?.c);
    if (c == null) continue;
    if ((side === 'above' && c < v) || (side === 'below' && c >= v)) { crossed = true; break; }
    // A run of same-side closes longer than a couple of bars means this is not a fresh cross.
    if (bars.length - 1 - i >= 2) break;
  }
  return { side, transition: crossed ? (side === 'above' ? 'reclaim' : 'loss') : null, vwap: v, distancePct: distancePct(price, v) };
}

/** Where price sits against yesterday's range. */
export function prevDayState(state) {
  const p = num(state?.price), h = num(state?.prevHigh), l = num(state?.prevLow);
  if (p == null) return null;
  if (h != null && p > h) return 'above_high';
  if (l != null && p < l) return 'below_low';
  if (h != null && l != null) return 'inside';
  return null;
}

/** At the session's own extreme — within a hair, since an exact tick match is rare. */
export function sessionExtremeState(state, tolerancePct = 0.05) {
  const p = num(state?.price), h = num(state?.sessionHigh), l = num(state?.sessionLow);
  if (p == null) return null;
  if (h != null && distancePct(p, h) != null && distancePct(p, h) <= tolerancePct && p >= h * (1 - tolerancePct / 100)) return 'high';
  if (l != null && distancePct(p, l) != null && distancePct(p, l) <= tolerancePct && p <= l * (1 + tolerancePct / 100)) return 'low';
  return null;
}

/**
 * Which opening range has been taken out, if any.
 *
 * The LONGEST broken range wins, because breaking the 30-minute range implies breaking the 1-minute
 * one and reporting the smaller is the less interesting truth. A range still forming is not a range.
 */
export function openingRangeState(state) {
  const p = num(state?.price);
  if (p == null) return null;
  let best = null;
  for (const m of OPENING_RANGE_MINUTES) {
    const r = openingRange(state, m);
    if (!r || r.high == null || r.low == null) continue;
    if (p > r.high) best = `break_${m}`;
    else if (p < r.low && (m === 5 || m === 15)) best = `down_${m}`;
  }
  return best;
}

/** Premarket level state, from the premarket extremes the state already isolates. */
export function premarketLevelState(state) {
  const p = num(state?.price), h = num(state?.premarketHigh), l = num(state?.premarketLow);
  if (p == null) return null;
  if (h != null && p > h) return 'above_high';
  if (l != null && p < l) return 'below_low';
  return null;
}

/**
 * RVOL, and the one rule that matters more than the number.
 *
 * METHODOLOGY COMPATIBILITY IS CHECKED BEFORE THE DIVISION. A realtime numerator from a single venue
 * divided by a consolidated historical baseline produces a number that looks like RVOL, is wrong by
 * the venue's market share, and is wrong in the direction that makes everything look quiet. When the
 * two methodologies do not match the answer is NULL — never a scaled guess, never a silent compare.
 *
 * `baseline.methodology` is what the baseline was built from; `state.volumeQuality` is what the live
 * number is. Both are strings the provider adapter sets and nothing downstream reinterprets.
 */
export function rvolState(state, baseline, now) {
  if (!baseline || !state) return { cumulative: null, interval: null, incompatible: false };
  const live = state.volumeQuality || null;
  const hist = baseline.methodology || null;
  // Unknown on either side is not an assumption of compatibility.
  if (!live || !hist || live !== hist) {
    return { cumulative: null, interval: null, incompatible: true, liveMethodology: live, baselineMethodology: hist };
  }
  const etm = etMinutesOf(now ?? state.now ?? Date.now());
  if (etm == null) return { cumulative: null, interval: null, incompatible: false };
  const cum = cumulativeRvol(baseline, etm, num(state.volume));
  const iv = intervalRvol(baseline, etm, num(state.intervalVolume));
  return {
    cumulative: cum ? cum.rvol : null,
    interval: iv ? iv.rvol : null,
    incompatible: false,
    bucketMinutes: baseline.bucketMinutes ?? BUCKET_MINUTES,
  };
}

/**
 * Volume acceleration: this interval's volume against the recent run rate.
 *
 * Not RVOL — it needs no historical baseline and therefore no methodology match, because both sides
 * come from the SAME live series. That is why it is available on a feed where RVOL is dark.
 */
export function volumeAcceleration(state) {
  const bars = state?.regularBars || [];
  if (bars.length < 6) return null;
  const vol = (b) => num(b?.v);
  const recent = vol(bars[bars.length - 1]);
  if (recent == null) return null;
  const priors = [];
  for (let i = bars.length - 6; i < bars.length - 1; i++) { const v = vol(bars[i]); if (v != null) priors.push(v); }
  if (priors.length < 3) return null;
  const mean = priors.reduce((a, b) => a + b, 0) / priors.length;
  if (!(mean > 0)) return null;
  return recent / mean;
}

/** Range expansion: the latest bar's range against the recent average. */
export function rangeExpansion(state) {
  const bars = state?.regularBars || [];
  if (bars.length < 6) return null;
  const range = (b) => { const h = num(b?.h), l = num(b?.l); return (h != null && l != null) ? h - l : null; };
  const cur = range(bars[bars.length - 1]);
  if (cur == null) return null;
  const priors = [];
  for (let i = bars.length - 6; i < bars.length - 1; i++) { const r = range(bars[i]); if (r != null) priors.push(r); }
  if (priors.length < 3) return null;
  const mean = priors.reduce((a, b) => a + b, 0) / priors.length;
  if (!(mean > 0)) return null;
  return cur / mean;
}

/** ATR as a percentage of price — the volatility filter's unit. */
export function atrPct(state) {
  const a = num(state?.atr14), p = num(state?.price);
  return (a != null && p != null && p > 0) ? (a / p) * 100 : null;
}

/**
 * Everything derived, for one symbol, in the shape the registry reads.
 *
 * `benchmarks` and `baseline` are supplied per symbol by the caller — the engine never reaches for a
 * global, which is what lets a whole market be replayed deterministically in a test.
 */
export function deriveRow(state, { capabilities, benchmarks = {}, baseline = null, now } = {}) {
  if (!state) return null;
  const at = now ?? state.now ?? Date.now();

  // Velocity: capability-gated per window, so a 30-second column stays absent on a minute-bar feed
  // rather than being computed from data that cannot support it.
  const velocity = velocityProfile(state.bars, at, capabilities, signalAvailability);

  // Acceleration over the 5-minute window — the phase the dropdown's four options name.
  const phase = momentumPhase(state.bars, '5m', at);

  // sessionVwap returns a NUMBER, not a wrapper — reading .vwap off it silently produced undefined.
  const vwap = sessionVwap(state, { requireConsolidated: true });
  const vws = vwapState(state, vwap);
  const rvol = rvolState(state, baseline, at);
  const pm = premarketProfile(state);
  const rs = relativeStrength(state, benchmarks, { window: '5m', now: at });
  const rsAll = relativeStrengthProfile(state, benchmarks, { window: '5m', now: at });

  // Per-benchmark spreads, so "vs SPY" and "vs QQQ" are separate filters rather than one "strongest".
  const bySymbol = {};
  for (const r of rsAll) bySymbol[r.benchmark] = r.spread;

  return {
    velocity,
    accel5m: phase ? phase.phase : null,
    vwap: num(vwap),
    vwapState: vws,
    // The dropdown asks one question — above, below, reclaimed, lost — so the transition wins when
    // there is one, because "reclaimed VWAP" is the more specific truth than "above VWAP".
    vwapSide: vws ? (vws.transition ?? vws.side) : null,
    rvol: rvol.cumulative,
    rvolInterval: rvol.interval,
    rvolIncompatible: rvol.incompatible === true,
    // A spike is a THRESHOLD ON RVOL, not a separate measurement — derived from the same number so
    // the two can never disagree, and null (not false) when RVOL itself is unknown.
    volSpike: rvol.cumulative == null ? null : rvol.cumulative >= VOLUME_SPIKE_RVOL,
    volAccel: volumeAcceleration(state),
    rangeExpansion: rangeExpansion(state),
    atrPct: atrPct(state),
    prevDayLevel: prevDayState(state),
    sessionExtreme: sessionExtremeState(state),
    openingRange: openingRangeState(state),
    pmLevel: premarketLevelState(state),
    pmHighDistance: distancePct(state.price, state.premarketHigh),
    pmChange: pm ? pm.changePct : null,
    pmVolume: num(state.premarketVolume),
    dayLocation: dayLocation(state),
    relativeStrength: rs,
    relativeStrengthAll: rsAll,
    rsSpy: bySymbol.SPY ?? null,
    rsQqq: bySymbol.QQQ ?? null,
    rsSector: sectorBenchmark(state) ? (bySymbol[sectorBenchmark(state)] ?? null) : null,
    // The tag travels WITH the row, so a reader and a downstream consumer can both see what kind of
    // volume the numbers were built from. The engine used to drop it.
    volumeQuality: state.volumeQuality || null,
  };
}

export { VELOCITY_WINDOWS };
