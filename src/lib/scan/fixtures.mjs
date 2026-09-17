// DETERMINISTIC MARKET SCENARIOS.
//
// The scanner cannot be tested against the market: the market is not reproducible, the interim feed
// is delayed, and the conditions that matter most are rare. So every behaviour is tested against
// hand-built sessions whose outcome is known by construction.
//
// These are FIXTURES, not sample data, and they are never served to a user. Pit Scan renders an
// honest "awaiting a real-time feed" state in production rather than replaying any of this — a
// scanner showing invented movement would be the single most damaging thing this product could do.
//
// Every builder is deterministic: same inputs, same bars, no randomness, no clock of its own.

import { SESSION } from './market-state.mjs';

/** A fixed reference session — a Tuesday, so no weekend edge cases. */
export const DAY = Date.UTC(2024, 4, 7);           // 2024-05-07
const ET_OFFSET_MIN = 4 * 60;                       // EDT is UTC−4 in May

/** Epoch for an ET minute-of-day on the fixture date. */
export const at = (etMinutes) => DAY + (etMinutes + ET_OFFSET_MIN) * 60_000;

/** One bar, with a sane high/low around its open and close. */
export const bar = (etMinutes, open, close, volume = 10_000, pad = 0.02) => ({
  t: at(etMinutes),
  o: open,
  h: Math.max(open, close) + pad,
  l: Math.min(open, close) - pad,
  c: close,
  v: volume,
});

/**
 * A run of bars walking from `from` to `to` in equal steps.
 *
 * Linear on purpose: a scenario whose shape is obvious is one whose expected signals can be reasoned
 * about rather than discovered by running the engine and writing down whatever it said.
 */
export function ramp(startMinute, count, from, to, { volume = 10_000, stepMinutes = 1 } = {}) {
  const out = [];
  if (count <= 0) return out;
  // Each bar opens where the last closed and the final bar closes exactly on `to`, so a scenario's
  // arithmetic is the arithmetic a reader does in their head. The earlier version interpolated over
  // count-1 and left the last close short, which silently moved every window boundary by a bar.
  const step = (to - from) / count;
  for (let i = 0; i < count; i += 1) {
    const open = from + step * i;
    const close = i === count - 1 ? to : from + step * (i + 1);
    out.push(bar(startMinute + i * stepMinutes, open, close, volume));
  }
  return out;
}

/** A run of bars going nowhere, for the quiet stretches a scenario needs around its event. */
export function flat(startMinute, count, price, { volume = 10_000, jitter = 0.01 } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const wobble = (i % 2 === 0 ? jitter : -jitter);
    out.push(bar(startMinute + i, price, price + wobble, volume));
  }
  return out;
}

const OPEN = SESSION.REGULAR_OPEN;
const PRE = SESSION.PREMARKET_OPEN;

/**
 * THE SCENARIOS.
 *
 * Each returns the raw input for buildSymbolState plus `expect`: the signal ids that must fire and
 * the ones that must not. The negatives matter as much as the positives — most of the scanner's
 * value is in what it refuses to report.
 */
export const SCENARIOS = {
  /** Nothing is happening. The most important scenario: it must produce silence. */
  quiet: () => ({
    label: 'Quiet stock',
    now: at(OPEN + 60),
    input: {
      symbol: 'QUIET',
      price: 50,
      prevClose: 50,
      prevHigh: 50.5,
      prevLow: 49.5,
      high20d: 55,
      low20d: 45,
      high52w: 70,
      low52w: 40,
      atr14: 1.2,
      bars: [...flat(OPEN, 60, 50)],
    },
    expect: { fires: [], silent: ['price_acceleration_5m', 'new_session_high', 'prev_day_high_break', 'range_expansion'] },
  }),

  /** +0.3% over five minutes becoming +1.8% over the next five — the brief's own example. */
  acceleration: () => ({
    label: 'Sudden 5-minute acceleration',
    // Placed so the CURRENT five minutes are the fast leg and the PRIOR five are the slow one. The
    // windows are what the signal compares, so a scenario that straddles them proves nothing.
    now: at(OPEN + 34),
    input: {
      symbol: 'ACCEL',
      price: 101.8,
      prevClose: 100,
      prevHigh: 102.5,
      prevLow: 99,
      atr14: 3,
      bars: [
        ...flat(OPEN, 25, 99.7),                 // 09:30–09:54, going nowhere
        ...ramp(OPEN + 25, 5, 99.7, 100),        // 09:55–09:59  +0.30%
        ...ramp(OPEN + 30, 5, 100, 101.8),       // 10:00–10:04  +1.80%
      ],
    },
    expect: { fires: ['price_acceleration_5m'], silent: ['prev_day_high_break'] },
  }),

  /** The same move, running out of steam — must NOT report acceleration. */
  deceleration: () => ({
    label: 'Decelerating move',
    now: at(OPEN + 34),
    input: {
      symbol: 'DECEL',
      price: 101.9,
      prevClose: 100,
      atr14: 3,
      bars: [
        ...flat(OPEN, 25, 100),
        ...ramp(OPEN + 25, 5, 100, 101.8),       // the big move first  +1.80%
        ...ramp(OPEN + 30, 5, 101.8, 101.9),     // then almost nothing +0.10%
      ],
    },
    expect: { fires: [], silent: ['price_acceleration_5m'] },
  }),

  /** Through the pre-market high and holding above it. */
  premarketBreak: () => ({
    label: 'Premarket high breakout',
    now: at(OPEN + 20),
    input: {
      symbol: 'PMB',
      price: 12.6,
      prevClose: 11,
      prevHigh: 11.4,
      atr14: 0.8,
      bars: [
        ...flat(PRE + 120, 30, 12.2),            // premarket, high about 12.23
        ...flat(OPEN, 12, 12.1),
        ...ramp(OPEN + 12, 8, 12.1, 12.6),       // takes it and holds
      ],
    },
    expect: { fires: ['premarket_high_break'], silent: [] },
  }),

  /** Pokes through the pre-market high by a cent and comes straight back. Must NOT report a break. */
  failedPremarketBreak: () => ({
    label: 'Failed premarket breakout',
    now: at(OPEN + 20),
    input: {
      symbol: 'PMF',
      price: 12.05,
      prevClose: 11,
      atr14: 0.8,
      bars: [
        ...flat(PRE + 120, 30, 12.2),
        ...flat(OPEN, 10, 12.1),
        bar(OPEN + 10, 12.1, 12.24),             // one bar through
        ...flat(OPEN + 11, 9, 12.05),            // and back below
      ],
    },
    expect: { fires: [], silent: ['premarket_high_break'], invalidates: ['premarket_high_break'] },
  }),

  /**
   * Through the premarket high by a wide margin, but only ONE bar old.
   *
   * Distance alone would call this a breakout. It is the case that proves ACCEPTANCE — through by
   * enough AND held — is what the signal requires, rather than merely being above the number.
   */
  premarketOneBar: () => ({
    label: 'Premarket high, one bar through',
    now: at(OPEN + 11),
    input: {
      symbol: 'PM1',
      price: 12.9,
      prevClose: 11,
      atr14: 0.8,
      bars: [
        ...flat(PRE + 120, 30, 12.2),            // premarket high about 12.23
        ...flat(OPEN, 10, 12.1),
        bar(OPEN + 10, 12.1, 12.9),              // one bar, well through, not yet held
      ],
    },
    expect: { fires: [], silent: ['premarket_high_break'] },
  }),

  /** Above the 5-minute opening range, after it has finished forming. */
  openingRangeBreak: () => ({
    label: 'Opening range breakout',
    now: at(OPEN + 25),
    input: {
      symbol: 'ORB',
      price: 20.9,
      prevClose: 20,
      atr14: 0.9,
      bars: [
        ...flat(OPEN, 5, 20.3),                  // the range: roughly 20.29–20.33
        ...flat(OPEN + 5, 10, 20.3),
        ...ramp(OPEN + 15, 10, 20.35, 20.9),
      ],
    },
    expect: { fires: ['opening_range_break_5m'], silent: [] },
  }),

  /** The same shape at 09:32 — the range has NOT finished, so nothing may fire. */
  openingRangeTooEarly: () => ({
    label: 'Opening range still forming',
    now: at(OPEN + 2),
    input: {
      symbol: 'ORE',
      price: 21.5,
      prevClose: 20,
      atr14: 0.9,
      bars: [bar(OPEN, 20.3, 20.4), bar(OPEN + 1, 20.4, 21.5)],
    },
    expect: { fires: [], silent: ['opening_range_break_5m', 'opening_range_break_15m'] },
  }),

  /** Strong while the market is flat — relative strength, with benchmarks supplied. */
  relativeStrength: () => ({
    label: 'Relative-strength divergence',
    now: at(OPEN + 40),
    input: {
      symbol: 'RS',
      price: 30.9,
      prevClose: 30,
      atr14: 1,
      bars: [...flat(OPEN, 30, 30), ...ramp(OPEN + 30, 10, 30, 30.9)],
    },
    benchmarks: {
      SPY: { symbol: 'SPY', bars: [...flat(OPEN, 40, 500)] },
      QQQ: { symbol: 'QQQ', bars: [...flat(OPEN, 40, 440)] },
    },
    expect: { fires: ['relative_strength'], silent: [] },
  }),

  /** A quiet coil then a sharp expansion out of it. */
  compressionExpansion: () => ({
    label: 'Compression then expansion',
    now: at(OPEN + 45),
    input: {
      symbol: 'COIL',
      price: 15.6,
      prevClose: 15,
      atr14: 0.7,
      bars: [
        ...flat(OPEN, 27, 15.0, { jitter: 0.005 }),   // very tight
        ...ramp(OPEN + 27, 3, 15.0, 15.6),            // and out
      ],
    },
    expect: { fires: ['compression_expansion'], silent: [] },
  }),

  /** Several things true at once — the stacking case the product is built around. */
  stacked: () => ({
    label: 'Multiple simultaneous signals',
    now: at(OPEN + 34),
    input: {
      symbol: 'STACK',
      price: 26.5,
      prevClose: 22,
      prevHigh: 23,
      high20d: 24,
      high52w: 25,
      atr14: 1.1,
      bars: [
        ...flat(PRE + 200, 20, 24.5),            // premarket high about 24.53
        ...flat(OPEN, 25, 24.2),
        ...ramp(OPEN + 25, 5, 24.2, 24.8),       // slow leg
        ...ramp(OPEN + 30, 5, 24.8, 26.5),       // fast leg
      ],
    },
    benchmarks: {
      SPY: { symbol: 'SPY', bars: [...flat(OPEN, 40, 500)] },
      QQQ: { symbol: 'QQQ', bars: [...flat(OPEN, 40, 440)] },
    },
    expect: {
      fires: ['premarket_high_break', 'prev_day_high_break', 'high_20d', 'high_52w', 'price_acceleration_5m'],
      silent: [],
    },
  }),

  /** Yesterday's high is unknown. The break must be UNDETERMINABLE, not a break of zero. */
  missingPrevHigh: () => ({
    label: 'Missing previous-day high',
    now: at(OPEN + 30),
    input: {
      symbol: 'NOPREV',
      price: 40,
      prevClose: 38,
      prevHigh: null,
      atr14: 1,
      bars: [...flat(OPEN, 20, 39), ...ramp(OPEN + 20, 10, 39, 40)],
    },
    expect: { fires: [], silent: ['prev_day_high_break'] },
  }),

  /** Volume present but single-venue. Every volume signal must stay dark. */
  singleVenueVolume: () => ({
    label: 'Single-venue volume',
    now: at(OPEN + 40),
    input: {
      symbol: 'PARTVOL',
      price: 18,
      prevClose: 17,
      avgVolume: 1_000_000,
      volume: 9_000_000,
      volumeQuality: 'single-venue',
      atr14: 0.6,
      bars: [...flat(OPEN, 40, 17.8, { volume: 400_000 })],
    },
    expect: { fires: [], silent: ['rvol_elevated', 'volume_spike', 'volume_acceleration', 'volume_confirmed_breakout'] },
  }),

  /** A stale symbol: the feed stopped. Nothing may change state on stale data. */
  staleFeed: () => ({
    label: 'Stale feed',
    now: at(OPEN + 120),
    input: {
      symbol: 'STALE',
      price: 55,
      prevClose: 54,
      atr14: 1,
      bars: [...flat(OPEN, 20, 55)],           // last bar is 100 minutes old
    },
    expect: { fires: [], silent: ['price_acceleration_5m', 'price_velocity_1m'] },
  }),
};

export const SCENARIO_IDS = Object.keys(SCENARIOS);

/** Build every scenario once — what the test suite iterates. */
export const allScenarios = () => SCENARIO_IDS.map((id) => ({ id, ...SCENARIOS[id]() }));

/**
 * A synthetic session of past volume, for testing time-of-day baselines.
 *
 * Shaped like a real day — heavy at the open, quiet in the middle — because a flat profile would let
 * a naive full-day average pass the same tests a time-of-day baseline does, which would make the
 * test prove nothing.
 */
export function volumeSession({ scale = 1 } = {}) {
  const out = [];
  for (let m = OPEN; m < SESSION.REGULAR_CLOSE; m += 1) {
    const fromOpen = m - OPEN;
    const shape = fromOpen < 30 ? 3 : fromOpen > 330 ? 2 : 1;   // open heavy, close heavy, midday light
    out.push({ etMinutes: m, volume: 10_000 * shape * scale });
  }
  return out;
}
