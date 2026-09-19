// CANDIDATE MODEL — current condition, separate from confirmed swing structure.
//
// Lives in research/ until it survives validation. If the stability numbers do not hold up it is
// deleted rather than shipped.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// Not a score. Condition is decided by counting NAMED BOOLEAN CRITERIA and requiring a threshold,
// exactly the pattern the zone engine uses for MAJOR — the criteria met are returned so a reader
// can check each one. No weights, no blending, no tuning against forward returns.
//
// ── AVOIDING DOUBLE COUNTING ────────────────────────────────────────────────
//
// Confirmed structure is the SEQUENCE of pivots: were the last two highs lower, were the last two
// lows lower. Condition deliberately uses evidence that sequence does not contain:
//
//   price vs mid MA      where price sits now, which the sequence never asks
//   mid MA slope         the direction of the average, not of the pivots
//   price vs long MA     the longer-horizon position
//   momentum             realised change over a fixed lookback
//   reclaim / loss       price vs the LEVEL of the most recent pivot
//
// The last one deserves its justification: it reads swing PRICES, which structure also reads. But
// the facts are different and can disagree — "the last two highs were lower" (sequence) and "price
// is now above the most recent high" (level) are simultaneously true during exactly the recovery
// this work exists to describe. Using the level is not re-using the sequence.
//
// Momentum and MA slope are correlated by construction, which is why the threshold is a majority of
// five rather than a sum: two correlated criteria cannot carry a verdict alone.

export const CONDITION = Object.freeze({
  BULLISH: 'bullish',
  BEARISH: 'bearish',
  NEUTRAL: 'neutral',
  UNKNOWN: 'unknown',
});

export const STATE = Object.freeze({
  CONFIRMED_UP: 'confirmed-uptrend',
  CONFIRMED_DOWN: 'confirmed-downtrend',
  RANGE: 'range',
  BULLISH_TRANSITION: 'bullish-transition',
  BEARISH_TRANSITION: 'bearish-transition',
  UNKNOWN: 'insufficient-history',
});

/**
 * Which averages and lookbacks each timeframe uses.
 *
 * The same sets the engine already quotes, so condition never introduces a number the rest of the
 * product does not show. Momentum lookback is roughly one year of that timeframe.
 */
export const CONDITION_INPUTS = Object.freeze({
  daily: { midMa: 50, longMa: 200, momentum: 126, slopeLookback: 20 },
  weekly: { midMa: 30, longMa: 40, momentum: 26, slopeLookback: 8 },
  monthly: { midMa: 10, longMa: 20, momentum: 12, slopeLookback: 4 },
});

/** A slope smaller than this is flat, not a direction. */
export const FLAT_SLOPE = 0.002;
/** Of the five criteria, how many must agree before condition is called. */
export const CONDITION_THRESHOLD = 4;

/**
 * The five criteria, evaluated one at a time and returned by name.
 *
 * `smaAt` is injected so this file stays free of imports the research harness would have to mirror.
 */
export function conditionState(bars, i, timeframe, trend, { smaAt }) {
  const cfg = CONDITION_INPUTS[timeframe];
  if (!cfg || !bars[i]) return { condition: CONDITION.UNKNOWN, met: [], bull: 0, bear: 0 };
  const close = bars[i].close;

  const mid = smaAt(bars, cfg.midMa, i);
  const long = smaAt(bars, cfg.longMa, i);
  const midPrev = smaAt(bars, cfg.midMa, i - cfg.slopeLookback);
  const then = bars[i - cfg.momentum]?.close;

  // Any missing input makes the verdict unavailable rather than partial — four of five criteria is
  // the threshold, so evaluating on three would silently lower the bar.
  if (mid == null || long == null || midPrev == null || !(then > 0)) {
    return { condition: CONDITION.UNKNOWN, met: [], bull: 0, bear: 0 };
  }

  const slope = (mid - midPrev) / midPrev;
  const mom = (close - then) / then;

  const bullish = [], bearish = [];
  if (close > mid) bullish.push(`above ${cfg.midMa}-period MA`); else bearish.push(`below ${cfg.midMa}-period MA`);
  if (close > long) bullish.push(`above ${cfg.longMa}-period MA`); else bearish.push(`below ${cfg.longMa}-period MA`);
  if (slope > FLAT_SLOPE) bullish.push(`${cfg.midMa}-period MA rising`);
  else if (slope < -FLAT_SLOPE) bearish.push(`${cfg.midMa}-period MA falling`);
  if (mom > 0) bullish.push(`${cfg.momentum}-bar momentum positive`); else bearish.push(`${cfg.momentum}-bar momentum negative`);

  // The structural disruptor: price beyond the most recent confirmed pivot LEVEL.
  if (trend.lastHigh && close > trend.lastHigh.price) bullish.push('reclaimed last confirmed swing high');
  if (trend.lastLow && close < trend.lastLow.price) bearish.push('lost last confirmed swing low');

  // ── THE STRUCTURAL DISRUPTOR IS MANDATORY ──
  //
  // Measured, not assumed. Counting five criteria with no required one produced transition runs
  // with a median of 2 bars on weekly and 1.5 on monthly, 63% of them lasting three bars or fewer —
  // noise wearing a label. The cause is diagnosable: price oscillating across the mid MA toggles the
  // count between 4 and 3, flipping the verdict with it.
  //
  // The fix is not a higher threshold, it is the right definition. A TRANSITION means the prior
  // structure has been DISRUPTED, and the disruption is a discrete structural event: price closing
  // beyond the most recent confirmed pivot. Without it, "above its averages inside a downtrend" is a
  // pullback rally, which is not a transition and should not be called one.
  const reclaimed = !!(trend.lastHigh && close > trend.lastHigh.price);
  const lost = !!(trend.lastLow && close < trend.lastLow.price);

  let condition = CONDITION.NEUTRAL;
  if (reclaimed && bullish.length >= CONDITION_THRESHOLD && bullish.length > bearish.length) {
    condition = CONDITION.BULLISH;
  } else if (lost && bearish.length >= CONDITION_THRESHOLD && bearish.length > bullish.length) {
    condition = CONDITION.BEARISH;
  }

  return {
    condition,
    met: condition === CONDITION.BULLISH ? bullish : condition === CONDITION.BEARISH ? bearish : [],
    bull: bullish.length, bear: bearish.length,
    disruptor: { reclaimed, lost },
  };
}

/**
 * Structure and condition combined into one state.
 *
 * BOTH FIELDS REMAIN AVAILABLE SEPARATELY. This is a convenience for surfaces that want a single
 * word; it never replaces the two facts that produced it.
 *
 * A transition is only ever declared when condition CONTRADICTS a confirmed directional structure.
 * A range with bullish condition stays a range: calling every improving range a bullish transition
 * would fire constantly and mean nothing.
 */
export function combinedState(structure, condition) {
  if (structure === 'insufficient-history' || condition === CONDITION.UNKNOWN) return STATE.UNKNOWN;
  if (structure === 'uptrend') {
    return condition === CONDITION.BEARISH ? STATE.BEARISH_TRANSITION : STATE.CONFIRMED_UP;
  }
  if (structure === 'downtrend') {
    return condition === CONDITION.BULLISH ? STATE.BULLISH_TRANSITION : STATE.CONFIRMED_DOWN;
  }
  return STATE.RANGE;
}
