// SWING STRUCTURE AND TREND. PURE: no DB, no network, no clock of its own.
//
// ── A PIVOT IS NOT KNOWN WHEN IT HAPPENS ────────────────────────────────────
//
// THE single most common way technical analysis leaks the future. A swing high at bar i is only
// identifiable once `width` bars to its RIGHT have printed lower highs — so it becomes knowable at
// bar i + width, not at bar i. Every pivot here therefore carries two dates:
//
//   date         the bar the extreme actually occurred on   (where it is drawn)
//   confirmedAt  the bar at which it became identifiable    (when it may be used)
//
// Research and any point-in-time reconstruction filter on confirmedAt. Drawing uses date. Conflating
// them produces a backtest that knows tomorrow's high today, which is the classic way a support
// engine "works" historically and fails live.
//
// ── TREND IS THE SEQUENCE, NOT AN INDICATOR ─────────────────────────────────
//
// Higher highs with higher lows is an uptrend. Lower highs with lower lows is a downtrend. Anything
// else is a range. This is deliberately structural rather than a moving-average crossover: MAs are
// reported separately as their own evidence, and folding them in here would make "trend" a blended
// number nobody can argue with.

import { TIMEFRAMES } from './bars.mjs';

export const TREND = Object.freeze({
  UP: 'uptrend',
  DOWN: 'downtrend',
  RANGE: 'range',
  UNKNOWN: 'insufficient-history',
});

/**
 * Confirmed swing pivots, oldest first.
 *
 * A bar is a swing high when its high is the strict maximum of the window [i-width, i+width].
 * Strictness matters: on a flat shelf every bar would otherwise qualify and the level list would
 * fill with duplicates of the same shelf.
 *
 * The final `width` bars can never be confirmed — by construction, their right shoulder has not
 * printed. They are excluded rather than provisionally included.
 */
export function findSwings(bars, { width = 3 } = {}) {
  const b = Array.isArray(bars) ? bars : [];
  const out = [];
  if (b.length < width * 2 + 1) return out;

  for (let i = width; i < b.length - width; i++) {
    const hi = b[i].high, lo = b[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      if (b[j].high >= hi) isHigh = false;
      if (b[j].low <= lo) isLow = false;
      if (!isHigh && !isLow) break;
    }
    // The confirming bar is `width` bars to the right — that is the moment the shoulder completed.
    const confirm = b[i + width];
    if (isHigh) {
      out.push({
        kind: 'swing_high', price: hi, date: b[i].date, confirmedAt: confirm.date,
        index: i, barsToConfirm: width,
      });
    }
    if (isLow) {
      out.push({
        kind: 'swing_low', price: lo, date: b[i].date, confirmedAt: confirm.date,
        index: i, barsToConfirm: width,
      });
    }
  }
  return out;
}

/** Only pivots identifiable by `asOf`. The point-in-time filter; everything research uses goes through it. */
export function swingsAsOf(swings, asOf) {
  if (!asOf) return swings;
  const cut = String(asOf).slice(0, 10);
  return (swings || []).filter((s) => String(s.confirmedAt) <= cut);
}

/**
 * Trend from the sequence of confirmed pivots.
 *
 * Reads the last two highs and last two lows. Both must agree: a higher high with a lower low is a
 * broadening range, not an uptrend, and calling it one is how a trend label survives a market that
 * has already turned.
 *
 * Returns the evidence alongside the verdict, because "uptrend" with no visible reason is exactly
 * the kind of unarguable output this codebase refuses to ship.
 */
export function deriveTrend(swings, { minSwings = 4 } = {}) {
  const highs = (swings || []).filter((s) => s.kind === 'swing_high');
  const lows = (swings || []).filter((s) => s.kind === 'swing_low');
  if (highs.length + lows.length < minSwings || highs.length < 2 || lows.length < 2) {
    return { trend: TREND.UNKNOWN, reasons: ['not enough confirmed swings'], highs: highs.length, lows: lows.length };
  }

  const h1 = highs[highs.length - 1], h0 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1], l0 = lows[lows.length - 2];
  const higherHigh = h1.price > h0.price;
  const higherLow = l1.price > l0.price;
  const lowerHigh = h1.price < h0.price;
  const lowerLow = l1.price < l0.price;

  const reasons = [];
  let trend = TREND.RANGE;
  if (higherHigh && higherLow) {
    trend = TREND.UP;
    reasons.push(`higher high ${fmt(h0.price)} → ${fmt(h1.price)}`, `higher low ${fmt(l0.price)} → ${fmt(l1.price)}`);
  } else if (lowerHigh && lowerLow) {
    trend = TREND.DOWN;
    reasons.push(`lower high ${fmt(h0.price)} → ${fmt(h1.price)}`, `lower low ${fmt(l0.price)} → ${fmt(l1.price)}`);
  } else {
    reasons.push(
      higherHigh ? `higher high ${fmt(h0.price)} → ${fmt(h1.price)}` : `lower high ${fmt(h0.price)} → ${fmt(h1.price)}`,
      higherLow ? `higher low ${fmt(l0.price)} → ${fmt(l1.price)}` : `lower low ${fmt(l0.price)} → ${fmt(l1.price)}`,
    );
  }
  // ── THE CONFIRMATION LAG IS DISCLOSED, NOT HIDDEN ──
  //
  // A pivot needs `width` bars to its right before it exists, so the newest structural information
  // is always absent from this verdict. On MSFT monthly that is real and large: the last confirmed
  // pivot is the June 2026 low at 349.20, since when price has run to 517 — a move that may well
  // have ended the downtrend, but cannot confirm a higher low for two more months.
  //
  // The label stays rule-bound, because bending it to fit recent price is how a trend definition
  // stops being a definition. What the reader gets instead is the date it is AS OF, so they can see
  // for themselves that the tape has moved on.
  const newest = [h1, l1].reduce((a, b) => (a.index >= b.index ? a : b));
  return {
    trend, reasons,
    lastHigh: h1, prevHigh: h0, lastLow: l1, prevLow: l0,
    highs: highs.length, lows: lows.length,
    asOfPivot: newest.date,
    pivotConfirmedAt: newest.confirmedAt,
    pivotIndex: newest.index,
  };
}

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');

/**
 * Structural events since a swing was set: breakouts, breakdowns, reclaims and failed breaks.
 *
 * All decided on CLOSES, never on wicks. An intraday poke through a level that closes back inside
 * is precisely what a failed break is, and treating the poke as a break would invert the reading.
 *
 * `lookback` bounds how far back events are reported so a decade-old breakout is not "recent".
 */
export function structuralEvents(bars, swings, { lookback = 40, failWithin = 3 } = {}) {
  const b = Array.isArray(bars) ? bars : [];
  if (b.length < 2) return [];
  const from = Math.max(1, b.length - lookback);
  const events = [];

  for (let i = from; i < b.length; i++) {
    const bar = b[i];
    // Only levels already confirmed BEFORE this bar can be broken by it.
    const priorHighs = swings.filter((s) => s.kind === 'swing_high' && s.confirmedAt < bar.date);
    const priorLows = swings.filter((s) => s.kind === 'swing_low' && s.confirmedAt < bar.date);

    const nearestHigh = priorHighs.filter((s) => s.price > b[i - 1].close)
      .sort((x, y) => x.price - y.price)[0];
    if (nearestHigh && bar.close > nearestHigh.price) {
      events.push({
        kind: 'breakout', level: nearestHigh.price, date: bar.date,
        of: nearestHigh.date, detail: `close ${fmt(bar.close)} above swing high ${fmt(nearestHigh.price)}`,
      });
    }
    const nearestLow = priorLows.filter((s) => s.price < b[i - 1].close)
      .sort((x, y) => y.price - x.price)[0];
    if (nearestLow && bar.close < nearestLow.price) {
      events.push({
        kind: 'breakdown', level: nearestLow.price, date: bar.date,
        of: nearestLow.date, detail: `close ${fmt(bar.close)} below swing low ${fmt(nearestLow.price)}`,
      });
    }
  }

  // A break that is undone within `failWithin` bars was a failure, not a break. Re-labelled rather
  // than deleted, because "failed breakout" is itself a structural fact worth reporting.
  const byDate = new Map(b.map((x, i) => [x.date, i]));
  for (const e of events) {
    const i = byDate.get(e.date);
    if (i == null) continue;
    const after = b.slice(i + 1, i + 1 + failWithin);
    if (!after.length) continue;
    if (e.kind === 'breakout' && after.some((x) => x.close < e.level)) {
      e.kind = 'failed_breakout';
      e.detail += ` — closed back below within ${failWithin} bars`;
    } else if (e.kind === 'breakdown' && after.some((x) => x.close > e.level)) {
      e.kind = 'reclaim';
      e.detail += ` — reclaimed within ${failWithin} bars`;
    }
  }
  return events;
}

/**
 * How many times price has reacted at a level, and when it last did.
 *
 * A TOUCH is a bar whose range reaches into the tolerance band without the CLOSE going through it —
 * price went there and did not stay. A bar that closes clean through is a break, not a touch, and
 * counting it would let a level that has been decisively lost look well-defended.
 */
export function touchHistory(bars, price, tolerance, { side = 'support', asOf = null } = {}) {
  const b = Array.isArray(bars) ? bars : [];
  const cut = asOf ? String(asOf).slice(0, 10) : null;
  let touches = 0, lastTouch = null, firstTouch = null, breaks = 0;
  for (const bar of b) {
    if (cut && bar.date > cut) break;
    const reached = side === 'support' ? bar.low <= price + tolerance : bar.high >= price - tolerance;
    if (!reached) continue;
    const through = side === 'support' ? bar.close < price - tolerance : bar.close > price + tolerance;
    if (through) { breaks++; continue; }
    touches++;
    if (!firstTouch) firstTouch = bar.date;
    lastTouch = bar.date;
  }
  return { touches, breaks, firstTouch, lastTouch };
}

/** The pivot width a timeframe uses, from the registry. */
export const widthFor = (timeframe) => TIMEFRAMES[timeframe]?.pivotWidth ?? 3;
