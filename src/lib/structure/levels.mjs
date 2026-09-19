// CANDIDATE LEVELS — the actual technical references a zone is built from. PURE.
//
// ── THE LEVELS CREATE THE ZONE, NEVER THE REVERSE ───────────────────────────
//
// Nothing here starts with a range and looks for reasons inside it. Every candidate is a real
// structural reference with a date attached: a confirmed swing, a level price broke through and
// came back to, a moving average. Zones are whatever falls out of clustering those. That ordering
// is what makes the output explainable — a zone can always name the four prices that made it.
//
// ── A LEVEL'S ROLE DEPENDS ON WHERE PRICE IS, ITS IDENTITY DOES NOT ─────────
//
// A swing high above price is resistance. The same swing high, once price closes above it and comes
// back, is support — that is the prior-breakout retest every trader watches. So `kind` records what
// the level structurally IS and role is decided later against current price, rather than freezing a
// level as "resistance" on the day it formed and mislabelling it forever after.

import { findSwings, swingsAsOf, touchHistory, widthFor } from './swings.mjs';
import { movingAverages } from './moving-averages.mjs';
import { atr } from './bars.mjs';

export const LEVEL_KIND = Object.freeze({
  SWING_HIGH: 'swing_high',
  SWING_LOW: 'swing_low',
  PRIOR_BREAKOUT: 'prior_breakout',     // a swing high price closed above — support on retest
  PRIOR_BREAKDOWN: 'prior_breakdown',   // a swing low price closed below — resistance on retest
  MOVING_AVERAGE: 'moving_average',
});

/** Human phrasing per kind, used verbatim in zone reasons so the UI invents no wording. */
const KIND_LABEL = {
  swing_high: 'confirmed swing high',
  swing_low: 'confirmed swing low',
  prior_breakout: 'prior breakout level',
  prior_breakdown: 'prior breakdown level',
  moving_average: 'moving average',
};

/**
 * How far a pivot stands out from the bars around it, in ATR units.
 *
 * A swing low that barely dips below its neighbours is noise; one that stands two ranges clear of
 * them is structure. Measured in ATR so it compares across securities, and kept as a PROPERTY
 * rather than folded into a score — section 5 of the brief forbids inventing weights, and this is
 * evidence a reader can check, not a multiplier.
 */
export function prominence(bars, index, kind, unit) {
  if (!unit || !bars[index]) return null;
  const w = 10;
  const from = Math.max(0, index - w), to = Math.min(bars.length - 1, index + w);
  let extreme = kind === LEVEL_KIND.SWING_HIGH ? -Infinity : Infinity;
  for (let i = from; i <= to; i++) {
    if (i === index) continue;
    extreme = kind === LEVEL_KIND.SWING_HIGH
      ? Math.max(extreme, bars[i].high)
      : Math.min(extreme, bars[i].low);
  }
  if (!Number.isFinite(extreme)) return null;
  const dist = kind === LEVEL_KIND.SWING_HIGH
    ? bars[index].high - extreme
    : extreme - bars[index].low;
  return Math.round((dist / unit) * 100) / 100;
}

/**
 * Every candidate level a timeframe contributes.
 *
 * `asOf` is the point-in-time boundary: only pivots CONFIRMED by then, only touches up to then.
 * Passing it is what makes a historical reconstruction honest; omitting it means "now".
 */
export function candidateLevels(bars, timeframe, { asOf = null, price = null, maxAgeBars = 260 } = {}) {
  const b = Array.isArray(bars) ? bars : [];
  if (b.length < 10) return [];
  const unit = atr(b, 14);
  if (!unit) return [];
  const width = widthFor(timeframe);
  const swings = swingsAsOf(findSwings(b, { width }), asOf);
  const last = b[b.length - 1];
  const current = price ?? Number(last.close);
  // Touch tolerance is a fraction of range: a "touch" is price arriving in the neighbourhood, not
  // hitting a number to the cent.
  const touchTol = unit * 0.35;

  const out = [];
  const cutoffIndex = Math.max(0, b.length - maxAgeBars);

  for (const s of swings) {
    // Ancient pivots are not levels anyone is watching. Bounded rather than unbounded so the zone
    // list stays about live structure.
    if (s.index < cutoffIndex) continue;

    const side = s.kind === LEVEL_KIND.SWING_HIGH ? 'resistance' : 'support';
    const hist = touchHistory(b, s.price, touchTol, { side, asOf });

    // Did price later close decisively through it? Then its ROLE has flipped and its kind says so.
    const after = b.slice(s.index + 1);
    const closedAbove = after.some((x) => x.close > s.price + touchTol);
    const closedBelow = after.some((x) => x.close < s.price - touchTol);
    let kind = s.kind;
    if (s.kind === LEVEL_KIND.SWING_HIGH && closedAbove) kind = LEVEL_KIND.PRIOR_BREAKOUT;
    if (s.kind === LEVEL_KIND.SWING_LOW && closedBelow) kind = LEVEL_KIND.PRIOR_BREAKDOWN;

    out.push({
      timeframe, kind, price: round(s.price),
      date: s.date, confirmedAt: s.confirmedAt,
      touches: hist.touches, breaks: hist.breaks,
      firstTouch: hist.firstTouch, lastTouch: hist.lastTouch,
      prominence: prominence(b, s.index, s.kind, unit),
      barsAgo: b.length - 1 - s.index,
      label: KIND_LABEL[kind],
    });
  }

  // Moving averages are levels too, and they MOVE — carried with their slope so a zone can say
  // "rising 50DMA" rather than pretending it is a fixed shelf.
  for (const ma of movingAverages(b, timeframe)) {
    if (!ma.available || ma.value == null) continue;
    const side = ma.value <= current ? 'support' : 'resistance';
    const hist = touchHistory(b, ma.value, touchTol, { side, asOf });
    out.push({
      timeframe, kind: LEVEL_KIND.MOVING_AVERAGE, price: round(ma.value),
      date: last.date, confirmedAt: last.date,
      touches: hist.touches, breaks: hist.breaks,
      firstTouch: hist.firstTouch, lastTouch: hist.lastTouch,
      prominence: null,
      barsAgo: 0,
      maLabel: ma.label, maSlope: ma.slope?.direction ?? null,
      label: ma.slope?.direction && ma.slope.direction !== 'flat'
        ? `${ma.slope.direction} ${ma.label}`
        : ma.label,
    });
  }

  return out.sort((a, b2) => a.price - b2.price);
}

/**
 * The volatility unit every zone width is quoted in.
 *
 * ALWAYS THE DAILY ATR, even for weekly and monthly levels. A zone is a price region a trader acts
 * against in the next few sessions, so its width should reflect how far this security moves in a
 * day — weekly ATR would produce zones several times wider and a $500 name would get a $40 band
 * that is true of everything and useful for nothing.
 *
 * The percentage floor exists for mega-caps whose ATR is a rounding error against their price, and
 * the percentage cap for penny names whose ATR can exceed their own price.
 */
export const ZONE_ATR_FRACTION = 0.35;       // how close two levels must be to join one zone
export const ZONE_MAX_ATR = 1.0;             // the widest a single zone may become
export const ZONE_MIN_PCT = 0.0015;          // 0.15% of price — the floor for very low-volatility names
export const ZONE_MAX_PCT = 0.06;            // 6% of price — the ceiling for very high-volatility names

export function zoneUnit(dailyBars, price) {
  const a = atr(dailyBars, 14);
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const floor = p * ZONE_MIN_PCT;
  const ceil = p * ZONE_MAX_PCT;
  const base = a && a > 0 ? a : floor;
  return Math.min(Math.max(base, floor), ceil);
}

const round = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
export { KIND_LABEL };
