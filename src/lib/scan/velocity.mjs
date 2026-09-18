// PRICE VELOCITY AND ACCELERATION.
//
// Velocity is how far a symbol moved over a window. Acceleration is whether THIS window's move is
// bigger than the one before it — the difference between "up 2% today" and "up 1.8% in the last five
// minutes after doing +0.3% in the five before that". The second is a reason to look now; the first
// is a table.
//
// WINDOWS ARE DECLARED, NOT ASSUMED. Each one states the observation frequency it needs. A 30-second
// velocity computed from one observation a minute is arithmetic on a number that does not exist, so
// the window declares two observations a minute and is simply off until a provider supplies them.
// The code path is complete and tested against fixtures; only the capability is missing.
//
// Pure. Takes bars and a clock, returns numbers or null.

import { pctChange } from './market-state.mjs';

/**
 * The velocity windows Pit Scan understands.
 *
 * `observationsPerMinute` is what the window needs to be MEANINGFUL, not merely computable: you can
 * always subtract two prices, but a 30-second move measured from minute bars is the one-minute move
 * wearing a smaller label.
 */
export const VELOCITY_WINDOWS = [
  { id: '30s', seconds: 30, label: '30s', requires: { observationsPerMinute: 2, quoteFreshness: 'realtime' } },
  { id: '1m', seconds: 60, label: '1m', requires: { observationsPerMinute: 1 } },
  { id: '2m', seconds: 120, label: '2m', requires: { observationsPerMinute: 1 } },
  { id: '3m', seconds: 180, label: '3m', requires: { observationsPerMinute: 1 } },
  { id: '5m', seconds: 300, label: '5m', requires: { observationsPerMinute: 1 } },
  { id: '10m', seconds: 600, label: '10m', requires: { observationsPerMinute: 1 } },
  { id: '15m', seconds: 900, label: '15m', requires: { observationsPerMinute: 1 } },
  { id: '30m', seconds: 1800, label: '30m', requires: { observationsPerMinute: 1 } },
];

export const WINDOW_BY_ID = new Map(VELOCITY_WINDOWS.map((w) => [w.id, w]));

/**
 * The price at or immediately before a moment.
 *
 * Bars are oldest → newest. Returns null when the window reaches back further than the data goes —
 * which is the honest answer at 09:31 for a 30-minute window, and the thing that stops a symbol's
 * first bar being reported as a 30-minute move.
 */
export function priceAt(bars, atMs) {
  if (!Array.isArray(bars) || !bars.length) return null;
  if (atMs < bars[0].t) return null;
  let found = null;
  for (const b of bars) {
    if (b.t <= atMs) found = b;
    else break;
  }
  return found ? (Number.isFinite(found.c) ? found.c : null) : null;
}

/**
 * Percent move over one window, ending now.
 *
 * `coverage` reports how much of the window the data actually spans, so a caller can tell a real
 * five-minute move from one measured across a two-minute gap in the feed.
 */
export function velocity(bars, window, now) {
  const w = typeof window === 'string' ? WINDOW_BY_ID.get(window) : window;
  if (!w || !Array.isArray(bars) || bars.length < 2) return null;
  const from = now - w.seconds * 1000;

  // ⚠️ STALE IS NOT FLAT.
  //
  // `priceAt` answers "the last price at or before X", so when a feed stops both ends of the window
  // resolve to the SAME final bar and the move comes out as exactly 0%. A scanner that prints 0.00%
  // for a symbol it has heard nothing about is stating a fact it does not have — and 0% is the most
  // dangerous possible wrong answer, because it reads as a calm market rather than as a broken feed.
  //
  // A window with NO observation inside it is unknown. Measured on a replayed disconnect: without
  // this, a feed frozen for fifteen minutes reported 0% on every window shorter than the gap.
  //
  // This also correctly darkens the 30-second window on minute bars — you cannot see half a minute
  // with a one-minute instrument — which is the same thing the capability gate says, now enforced by
  // the arithmetic rather than only by the registry.
  const newest = bars[bars.length - 1]?.t;
  if (!Number.isFinite(newest) || newest < from) return null;

  const start = priceAt(bars, from);
  const end = priceAt(bars, now);
  if (start == null || end == null) return null;
  const span = now - Math.max(bars[0].t, from);
  return {
    window: w.id,
    pct: pctChange(start, end),
    from: start,
    to: end,
    coverage: Math.min(1, span / (w.seconds * 1000)),
  };
}

/**
 * Acceleration: this window against the one immediately before it.
 *
 * Reported as both the DELTA in percentage points and a RATIO, because the two answer different
 * questions — +1.5pp says how much more it is moving, 6× says the move has changed character. The
 * ratio is null when the prior window was flat, since dividing by roughly zero produces a number
 * that looks like a discovery and is noise.
 */
export function acceleration(bars, window, now) {
  const w = typeof window === 'string' ? WINDOW_BY_ID.get(window) : window;
  if (!w) return null;
  const ms = w.seconds * 1000;
  const current = velocity(bars, w, now);
  const prior = velocity(bars, w, now - ms);
  if (!current || !prior || current.pct == null || prior.pct == null) return null;
  // The prior window must exist in the data, not be inferred from its absence.
  if (bars[0].t > now - 2 * ms) return null;

  const delta = current.pct - prior.pct;
  const priorMag = Math.abs(prior.pct);
  const ratio = priorMag >= MIN_PRIOR_PCT ? Math.abs(current.pct) / priorMag : null;

  return {
    window: w.id,
    current: current.pct,
    prior: prior.pct,
    delta,
    ratio,
    // Accelerating means moving FURTHER IN THE SAME DIRECTION, not merely changing. A reversal from
    // -2% to +1% is a bigger delta than +0.3% to +1.8% and is not acceleration of anything.
    accelerating: sameDirection(current.pct, prior.pct) && Math.abs(current.pct) > Math.abs(prior.pct),
    direction: current.pct >= 0 ? 'up' : 'down',
  };
}

/** Below this, the prior window is flat enough that a ratio against it is meaningless. */
export const MIN_PRIOR_PCT = 0.05;

const sameDirection = (a, b) => (a >= 0 && b >= 0) || (a < 0 && b < 0);

/**
 * Every window that can be computed for a symbol right now, given what the provider supports.
 *
 * Windows the feed cannot support are omitted rather than returned as null — a caller iterating the
 * result is then working only with numbers that mean something.
 */
export function velocityProfile(bars, now, caps, availabilityFn) {
  const out = {};
  for (const w of VELOCITY_WINDOWS) {
    if (availabilityFn && !availabilityFn({ requires: w.requires }, caps).available) continue;
    const v = velocity(bars, w, now);
    if (v && v.pct != null) out[w.id] = v;
  }
  return out;
}

/**
 * A move expressed in units of the symbol's own average daily range.
 *
 * THE POINT OF THE WHOLE MODULE. A 1% move in a utility and a 1% move in a biotech are not the same
 * event, and a scanner that treats them alike fills up with the noisiest names on the board every
 * single day. Normalising by ATR is what lets one threshold serve both.
 */
export function normalizedMove(state, window = '1m') {
  if (!state) return null;
  const atr = Number.isFinite(state.atr14) ? state.atr14 : null;
  if (atr == null || atr <= 0) return null;
  const v = velocity(state.bars, window, state.now);
  if (!v || v.pct == null) return null;
  return {
    window,
    pct: v.pct,
    moved: Math.abs(v.to - v.from),
    atr,
    atrShare: Math.abs(v.to - v.from) / atr,
  };
}

/**
 * The log return of a window.
 *
 * Used internally where returns are being summed or compared across very different magnitudes,
 * because simple percentages do not add up and overstate large down moves relative to up ones. Never
 * shown to a trader — the UI always reports the plain percentage they expect.
 */
export function logReturn(bars, window, now) {
  const v = velocity(bars, window, now);
  if (!v || !(v.from > 0) || !(v.to > 0)) return null;
  return Math.log(v.to / v.from);
}

/**
 * Is the latest window continuing the prior move, reversing it, or merely slowing?
 *
 * Deceleration matters as much as acceleration: a move that has stopped expanding is the one to stop
 * chasing, and a scanner that only reports acceleration silently keeps stale names on the screen.
 */
export function momentumPhase(bars, window, now) {
  const a = acceleration(bars, window, now);
  if (!a) return null;
  const sameWay = (a.current >= 0) === (a.prior >= 0);
  if (!sameWay) return { phase: 'reversal', ...a };
  if (Math.abs(a.current) > Math.abs(a.prior)) return { phase: 'accelerating', ...a };
  if (Math.abs(a.current) < Math.abs(a.prior) * DECELERATION_RATIO) return { phase: 'decelerating', ...a };
  return { phase: 'continuation', ...a };
}

/** Below this share of the prior window, the move is fading rather than continuing. */
export const DECELERATION_RATIO = 0.5;
