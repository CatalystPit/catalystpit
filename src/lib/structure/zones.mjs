// SUPPORT AND RESISTANCE ZONES — actual price ranges. PURE.
//
// The output of this file is the thing a trader reads: "$481.80–$485.00, 1.2% below, weekly swing
// low plus a daily prior breakout plus the rising 50DMA". A label without a number ("near support")
// is not an answer to the question being asked.
//
// ── WIDTH SCALES WITH THE SECURITY, NEVER A FIXED DOLLAR BAND ───────────────
//
// A $6 stock and a $600 stock cannot share a width. Clustering distance and maximum zone width are
// both quoted in ATR, floored and capped as a percentage of price so the arithmetic stays sane at
// both extremes. A zone is then literally the span of the levels that formed it — no padding is
// invented around them, because the components ARE the evidence.
//
// ── CLUSTERING MUST NOT SWALLOW THE CHART ───────────────────────────────────
//
// Left unconstrained, chaining "each level is close to the next" merges half a year of structure
// into one $40 band that is true of everything and actionable for nothing. Two constraints prevent
// it: a gap limit between ADJACENT levels, and a hard ceiling on total zone width that splits a
// cluster rather than letting it grow.
//
// ── MAJOR IS A LIST OF REASONS, NOT A SCORE ─────────────────────────────────
//
// Section 5 and 6 of the brief forbid invented weights, and they are right to: "Monthly = 3" is a
// number nobody can argue with and nobody validated. A zone is MAJOR when it meets named structural
// criteria, and it reports WHICH ones it met. Whether higher-timeframe levels genuinely behave
// differently is a research question, answered by the durability harness — not assumed here.

import { LEVEL_KIND } from './levels.mjs';

/** Named, checkable criteria. A zone reports which it satisfied; nothing is multiplied together. */
export const MAJOR_CRITERIA = Object.freeze({
  HIGHER_TIMEFRAME: 'higher-timeframe level (weekly or monthly)',
  MULTI_TIMEFRAME: 'levels from two or more timeframes converge here',
  REPEATED_REACTIONS: 'price has reacted here repeatedly',
  PROMINENT_SWING: 'formed by a prominent swing',
  LONG_PERSISTENCE: 'has been respected over a long period',
});

export const MAJOR_MIN_CRITERIA = 2;        // a zone must satisfy at least this many to be MAJOR
export const REPEATED_TOUCH_MIN = 3;
export const PROMINENT_ATR = 1.5;
export const PERSISTENCE_DAYS = 180;

/**
 * Group nearby levels into zones.
 *
 * `unit` is the volatility unit from levels.zoneUnit(). Levels arrive sorted by price; a new zone
 * starts whenever the gap to the previous level exceeds the join distance, or whenever adding the
 * level would push the zone past its maximum width.
 */
export function clusterLevels(levels, unit, { joinFraction = 0.35, maxWidthAtr = 1.0 } = {}) {
  const src = (Array.isArray(levels) ? levels : [])
    .filter((l) => Number.isFinite(l.price))
    .sort((a, b) => a.price - b.price);
  if (!src.length || !unit) return [];

  const join = unit * joinFraction;
  const maxWidth = unit * maxWidthAtr;
  const zones = [];
  let cur = null;

  for (const lvl of src) {
    if (!cur) { cur = { components: [lvl], low: lvl.price, high: lvl.price }; continue; }
    const gap = lvl.price - cur.components[cur.components.length - 1].price;
    const wouldBe = lvl.price - cur.low;
    if (gap <= join && wouldBe <= maxWidth) {
      cur.components.push(lvl);
      cur.high = lvl.price;
    } else {
      zones.push(cur);
      cur = { components: [lvl], low: lvl.price, high: lvl.price };
    }
  }
  if (cur) zones.push(cur);
  return zones;
}

/**
 * Turn a raw cluster into the canonical zone object.
 *
 * A single-level cluster still needs a WIDTH — a zone is a region, and one swing low is not a line
 * price respects to the cent. It is given a band of half the join distance either side, which is
 * the same tolerance that decided nothing else belonged with it.
 */
export function describeZone(cluster, { unit, price, side }) {
  const comps = cluster.components;
  const half = unit * 0.3;
  let low = cluster.low, high = cluster.high;
  // A zone needs WIDTH. Padding only single-component clusters was not enough: two levels at the
  // SAME price (AAPL's daily and weekly swing highs both at 344.57) produced a zero-width band
  // printed as "$344.57–$344.57", which is a line pretending to be a region. Any cluster narrower
  // than the minimum is widened around its midpoint instead.
  const minWidth = half * 2;
  if (high - low < minWidth) {
    const mid0 = (low + high) / 2;
    low = mid0 - half; high = mid0 + half;
  }

  const timeframes = [...new Set(comps.map((c) => c.timeframe))];
  // MAX, not sum. The same reaction is observed by every timeframe that sees the level, so summing
  // across daily + weekly double-counts it — AAPL's 317.40 zone reported "99 touches" for what is
  // one shared history. The best-evidenced component is the honest figure.
  const touches = comps.reduce((s, c) => Math.max(s, c.touches || 0), 0);
  const maxProminence = comps.reduce((m, c) => Math.max(m, c.prominence ?? 0), 0);
  const dates = comps.map((c) => c.confirmedAt).filter(Boolean).sort();
  const firstSeen = dates[0] ?? null;
  const lastTouch = comps.map((c) => c.lastTouch).filter(Boolean).sort().pop() ?? null;
  const persistenceDays = firstSeen && lastTouch
    ? Math.round((Date.parse(lastTouch) - Date.parse(firstSeen)) / 86_400_000) : 0;

  // ── the MAJOR criteria, evaluated one at a time and reported by name ──
  const met = [];
  if (timeframes.some((t) => t === 'weekly' || t === 'monthly')) met.push(MAJOR_CRITERIA.HIGHER_TIMEFRAME);
  if (timeframes.length >= 2) met.push(MAJOR_CRITERIA.MULTI_TIMEFRAME);
  if (touches >= REPEATED_TOUCH_MIN) met.push(MAJOR_CRITERIA.REPEATED_REACTIONS);
  if (maxProminence >= PROMINENT_ATR) met.push(MAJOR_CRITERIA.PROMINENT_SWING);
  if (persistenceDays >= PERSISTENCE_DAYS) met.push(MAJOR_CRITERIA.LONG_PERSISTENCE);

  const mid = (low + high) / 2;
  const p = Number(price);
  // Distance is measured to the NEAR EDGE — the price at which the zone starts to matter — with the
  // midpoint carried alongside, since which one a reader wants depends on how they trade.
  const nearEdge = side === 'support' ? high : low;
  const distance = Math.abs(p - nearEdge);

  return {
    side,
    low: round(low), high: round(high), mid: round(mid),
    width: round(high - low),
    widthPct: round(((high - low) / p) * 100, 2),
    currentPrice: round(p),
    distance: round(distance),
    distancePct: round((distance / p) * 100, 2),
    distanceToMid: round(Math.abs(p - mid)),
    distanceToMidPct: round((Math.abs(p - mid) / p) * 100, 2),
    timeframes: timeframes.sort((a, b) => TF_ORDER[b] - TF_ORDER[a]),
    multiTimeframe: timeframes.length >= 2,
    touches,
    prominence: maxProminence || null,
    firstSeen, lastTouch, persistenceDays,
    major: met.length >= MAJOR_MIN_CRITERIA,
    majorCriteria: met,
    // The component levels, preserved in full. This is what makes a zone arguable rather than
    // asserted: the Market Structure section can name the four prices that produced the range.
    //
    // ⚠️ NOT A CHART OVERLAY, now or later. Market Structure is Catalyst Pit's ANALYSIS of the
    // chart, not another thing drawn on it — the chart stays price, user-selected indicators and
    // Evidence event markers. A zone is a RANGE because support is an area rather than false
    // penny-level precision, which is a statement about the number, not a request for a band.
    components: comps.map((c) => ({
      timeframe: c.timeframe, kind: c.kind, price: c.price,
      date: c.date, confirmedAt: c.confirmedAt,
      touches: c.touches, prominence: c.prominence,
      label: c.label, maLabel: c.maLabel ?? null,
    })),
    reasons: comps.map((c) => `${TF_LABEL[c.timeframe]} ${c.label} ${c.price.toFixed(2)}`),
  };
}

const TF_ORDER = { daily: 1, weekly: 2, monthly: 3 };
const TF_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

/**
 * Build support and resistance zones around the current price.
 *
 * Levels are split by ROLE — below price is support, above is resistance — rather than by the kind
 * of pivot they came from, because a broken resistance genuinely becomes support and pretending
 * otherwise puts levels on the wrong side of the tape.
 */
export function buildZones(levels, { price, unit }) {
  const p = Number(price);
  if (!Number.isFinite(p) || !unit) return { support: [], resistance: [], inside: null };

  // CLUSTER ONCE, THEN CLASSIFY BY POSITION.
  //
  // An earlier version fed near-price levels into BOTH sides and clustered each separately, which
  // produced MSFT weekly support at 489.70–492.37 and resistance at 489.41–495.33 — two overlapping
  // bands around the same price, which is not a reading a trader can act on. Clustering the levels
  // once and then asking where each resulting zone sits relative to price makes overlap impossible
  // by construction.
  const clusters = clusterLevels(levels, unit);
  const support = [], resistance = [];
  let inside = null;

  for (const c of clusters) {
    const lo = c.components.length === 1 ? c.low - unit * 0.3 : c.low;
    const hi = c.components.length === 1 ? c.high + unit * 0.3 : c.high;
    if (p >= lo && p <= hi) {
      // Price is INSIDE this band. It is genuinely both — the floor it is standing on and the
      // ceiling it is under — so it is reported once, as `inside`, and appears at the head of both
      // lists rather than being duplicated into two different-looking zones.
      inside = describeZone(c, { unit, price: p, side: 'inside' });
      continue;
    }
    const side = hi < p ? 'support' : 'resistance';
    (side === 'support' ? support : resistance).push(describeZone(c, { unit, price: p, side }));
  }

  support.sort((a, b) => b.high - a.high);     // nearest (highest) support first
  resistance.sort((a, b) => a.low - b.low);    // nearest (lowest) resistance first
  return { support, resistance, inside };
}

// ── where price is, relative to the zones ────────────────────────────────────

export const PRICE_STATE = Object.freeze({
  INSIDE: 'inside',
  APPROACHING: 'approaching',
  HOLDING: 'holding',
  BROKEN: 'broken',
  CLEAR: 'clear',
});

/** Within this many units of the near edge, price is "approaching" rather than merely above/below. */
export const APPROACH_ATR = 1.0;
/** How many recent bars are inspected to tell "holding" from merely "above". */
export const HOLD_LOOKBACK = 10;

/**
 * Price's relationship to a zone, with the zone itself attached.
 *
 * "Holding" is a claim about behaviour, not position, so it requires evidence: price must have
 * traded INTO the zone within the recent window and closed back out of it. Without that it is
 * simply above (or below), and saying "holding support" of a level price has not been near in
 * months would be describing something that has not happened.
 */
export function priceRelationship(zone, { price, recentBars = [] }) {
  if (!zone) return null;
  const p = Number(price);
  const unit = zone.width > 0 ? zone.width : Math.abs(zone.high - zone.low) || 1;
  const approach = Math.max(unit, p * 0.005) * APPROACH_ATR;
  const recent = recentBars.slice(-HOLD_LOOKBACK);

  if (zone.side === 'support') {
    if (p < zone.low) return { state: PRICE_STATE.BROKEN, detail: `price ${fmt(p)} is below the zone`, zone };
    if (p <= zone.high) return { state: PRICE_STATE.INSIDE, detail: `price ${fmt(p)} is inside the zone`, zone };
    const tested = recent.some((b) => b.low <= zone.high && b.close > zone.high);
    if (tested) {
      return { state: PRICE_STATE.HOLDING, detail: `price traded into the zone and closed back above within ${HOLD_LOOKBACK} bars`, zone };
    }
    if (p - zone.high <= approach) return { state: PRICE_STATE.APPROACHING, detail: `price is ${fmt(p - zone.high)} above the zone`, zone };
    return { state: PRICE_STATE.CLEAR, detail: `price is ${fmt(p - zone.high)} above the zone`, zone };
  }

  if (p > zone.high) return { state: PRICE_STATE.BROKEN, detail: `price ${fmt(p)} is above the zone`, zone };
  if (p >= zone.low) return { state: PRICE_STATE.INSIDE, detail: `price ${fmt(p)} is inside the zone`, zone };
  const rejected = recent.some((b) => b.high >= zone.low && b.close < zone.low);
  if (rejected) {
    return { state: PRICE_STATE.HOLDING, detail: `price traded into the zone and closed back below within ${HOLD_LOOKBACK} bars`, zone };
  }
  if (zone.low - p <= approach) return { state: PRICE_STATE.APPROACHING, detail: `price is ${fmt(zone.low - p)} below the zone`, zone };
  return { state: PRICE_STATE.CLEAR, detail: `price is ${fmt(zone.low - p)} below the zone`, zone };
}

/**
 * Nearest and major, for one side.
 *
 * MAJOR IS NOT MANUFACTURED. When no zone satisfies the criteria, major is null — a second level
 * invented to fill the field would be the least structurally significant zone wearing the most
 * significant label. When the nearest zone is itself major, both point at the same zone and say so.
 */
export function selectZones(zones) {
  const nearest = zones[0] ?? null;
  const major = zones.find((z) => z.major) ?? null;
  return {
    nearest,
    major,
    majorIsNearest: !!(nearest && major && nearest.low === major.low && nearest.high === major.high),
  };
}

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const round = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
