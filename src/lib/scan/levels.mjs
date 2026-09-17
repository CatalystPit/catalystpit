// LEVEL INTERACTION.
//
// A price crossing a number is not a breakout. Every scanner that treats it as one produces the same
// useless output: the same symbol reported forty times as it chops either side of its pre-market
// high by a cent. What a trader wants to know is whether the level was TAKEN — moved through by a
// meaningful distance and held — or merely touched and rejected.
//
// So a level interaction is described, not asserted. These primitives answer:
//
//   throughPct     how far past the level, as a percentage — a cent through a $200 stock is noise
//   barsBeyond     how long it has stayed there, which is what separates a poke from acceptance
//   accepted       through by enough, for long enough
//   rejected       went through and came back — a failed break, which is itself information
//   reclaimed      was below, is now above, having been above earlier in the session
//
// Pure, and deliberately ignorant of WHICH level it is looking at: the same logic serves the
// pre-market high, yesterday's low, the opening range and the 52-week high, so those signals differ
// only in which number they hand it.

const n = (v) => (Number.isFinite(v) ? v : null);

/** Percentage distance from a level to a price, signed in the direction of travel. */
export function throughPct(level, price, side = 'up') {
  const l = n(level);
  const p = n(price);
  if (l == null || p == null || l === 0) return null;
  const raw = ((p - l) / Math.abs(l)) * 100;
  return side === 'down' ? -raw : raw;
}

/**
 * How many consecutive most-recent bars closed beyond the level.
 *
 * Counted from the newest backwards and stopping at the first bar that did not, because what matters
 * is whether it is beyond the level NOW and has been continuously — not whether it managed it once
 * twenty minutes ago.
 */
export function barsBeyond(bars, level, side = 'up') {
  const l = n(level);
  if (l == null || !Array.isArray(bars) || !bars.length) return 0;
  let count = 0;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const c = n(bars[i].c);
    if (c == null) break;
    const beyond = side === 'up' ? c > l : c < l;
    if (!beyond) break;
    count += 1;
  }
  return count;
}

/** Did any bar in the list trade through the level, even if it closed back inside? */
export function everTraded(bars, level, side = 'up') {
  const l = n(level);
  if (l == null || !Array.isArray(bars)) return false;
  for (const b of bars) {
    const v = side === 'up' ? n(b.h) : n(b.l);
    if (v == null) continue;
    if (side === 'up' ? v > l : v < l) return true;
  }
  return false;
}

/** How far past the level the furthest print got — the extent of the attempt. */
export function maxExcursion(bars, level, side = 'up') {
  const l = n(level);
  if (l == null || !Array.isArray(bars) || !bars.length) return null;
  let best = null;
  for (const b of bars) {
    const v = side === 'up' ? n(b.h) : n(b.l);
    if (v == null) continue;
    if (best == null || (side === 'up' ? v > best : v < best)) best = v;
  }
  return best == null ? null : throughPct(l, best, side);
}

/** Defaults for what counts as "meaningfully through" and "held". */
export const ACCEPTANCE = {
  minThroughPct: 0.15,   // a cent through a $200 stock is not a breakout
  minBars: 2,            // and one bar poking through is not acceptance
};

/**
 * The full description of how a price is interacting with one level.
 *
 * Returns null — not a neutral object — when the level itself is unknown. A level we do not have is
 * not a level at zero, and this is the guard that stops a missing previous-day high reading as a
 * breakout of nothing.
 */
export function levelInteraction(state, level, { side = 'up', acceptance = ACCEPTANCE } = {}) {
  const l = n(level);
  const price = n(state?.price);
  if (l == null || l === 0 || price == null) return null;

  const bars = state.regularBars?.length ? state.regularBars : (state.bars || []);
  const through = throughPct(l, price, side);
  const beyond = barsBeyond(bars, l, side);
  const touched = everTraded(bars, l, side);
  const isBeyond = side === 'up' ? price > l : price < l;

  return {
    level: l,
    price,
    side,
    throughPct: through,
    barsBeyond: beyond,
    maxExcursionPct: maxExcursion(bars, l, side),
    // BEYOND is the raw fact. ACCEPTED is the judgement, and the two are kept apart so a caller can
    // choose: Pit Scan wants acceptance, a Custom Scanner filter may legitimately want the raw fact.
    beyond: isBeyond,
    accepted: isBeyond && through != null && through >= acceptance.minThroughPct && beyond >= acceptance.minBars,
    // A FAILED BREAK is not a non-event. Trading through and closing back inside is one of the more
    // informative things a level can do, and the engine surfaces it rather than staying silent.
    rejected: !isBeyond && touched,
    touched,
  };
}

/**
 * Has price crossed back to the correct side of a level it was previously on the wrong side of?
 *
 * The distinction from a plain break is the history: a reclaim requires the symbol to have been
 * ABOVE earlier, lost the level, and taken it back. Without that, every gap-up "reclaims" VWAP.
 */
export function reclaimed(bars, level, { side = 'up', lookback = 30 } = {}) {
  const l = n(level);
  if (l == null || !Array.isArray(bars) || bars.length < 3) return false;
  const window = bars.slice(-lookback);
  const last = n(window[window.length - 1]?.c);
  if (last == null) return false;
  const nowBeyond = side === 'up' ? last > l : last < l;
  if (!nowBeyond) return false;

  // Walk back: there must be a bar on the wrong side, and before THAT one on the right side.
  let sawWrongSide = false;
  for (let i = window.length - 2; i >= 0; i -= 1) {
    const c = n(window[i].c);
    if (c == null) continue;
    const beyond = side === 'up' ? c > l : c < l;
    if (!sawWrongSide) { if (!beyond) sawWrongSide = true; continue; }
    if (beyond) return true;
  }
  return false;
}

/** A simple crossing between the previous bar and now — the raw transition, without judgement. */
export function justCrossed(bars, level, side = 'up') {
  const l = n(level);
  if (l == null || !Array.isArray(bars) || bars.length < 2) return false;
  const prev = n(bars[bars.length - 2].c);
  const last = n(bars[bars.length - 1].c);
  if (prev == null || last == null) return false;
  return side === 'up' ? (prev <= l && last > l) : (prev >= l && last < l);
}
