// THE MARKET STRUCTURE ENGINE. PURE: daily candles in, structure out. No DB, no vendor, no clock.
//
// ── THREE TIMEFRAMES, DELIBERATELY NOT COMBINED ─────────────────────────────
//
// There is no overall technical score and there must not be one. "MONTHLY uptrend, WEEKLY uptrend,
// DAILY pullback" is a more useful sentence than any number that could summarise it, and the
// disagreement IS the information — a long-term holder and a swing trader read that situation in
// opposite directions, and a single blended figure serves neither.
//
// So each timeframe derives its own trend, its own swings, its own averages and its own levels,
// independently, from bars folded out of one canonical adjusted daily history. The multiTimeframe
// section describes how they relate; it never replaces them.
//
// ── POINT IN TIME ───────────────────────────────────────────────────────────
//
// `asOf` flows into every layer. Swings are filtered on confirmedAt, touch history stops at the
// boundary, partial periods are excluded from structure. Called without it the engine describes
// now; called with it, it reconstructs what was knowable then — which is the only way the research
// harness can measure whether these levels ever mattered.

import { buildTimeframes, completedOnly, TIMEFRAMES, TIMEFRAME_IDS, atr } from './bars.mjs';
import { findSwings, swingsAsOf, deriveTrend, structuralEvents, widthFor, TREND } from './swings.mjs';
import { movingAverages, maStructure } from './moving-averages.mjs';
import { candidateLevels, zoneUnit } from './levels.mjs';
import { buildZones, selectZones, priceRelationship } from './zones.mjs';

export const METHODOLOGY_VERSION = 'structure_v1';

/**
 * Structure for one timeframe.
 *
 * Completed bars only. A forming weekly bar has a high and low that are still moving, and letting
 * it confirm a pivot means Wednesday's swing low can disappear on Thursday.
 */
export function timeframeStructure(bars, timeframe, { asOf = null, price = null, dailyBars = null } = {}) {
  const spec = TIMEFRAMES[timeframe];
  const complete = completedOnly(bars);
  const current = bars.length && !bars[bars.length - 1].complete ? bars[bars.length - 1] : null;

  if (complete.length < spec.minBars) {
    return {
      timeframe, label: spec.label, available: false,
      reason: `needs ${spec.minBars} completed ${timeframe} bars, have ${complete.length}`,
      bars: complete.length, trend: TREND.UNKNOWN, currentBar: current,
    };
  }

  const width = widthFor(timeframe);
  const swings = swingsAsOf(findSwings(complete, { width }), asOf);

  // TREND IS READ FROM RECENT SWINGS, NOT FROM ALL OF HISTORY.
  //
  // deriveTrend takes the last two highs and last two lows, and with twelve years of monthly bars
  // those can be pivots from years ago. MSFT read as a monthly DOWNTREND off swing lows at $349 and
  // $355 — both long past, while the 20-month average was rising and price sat near $494. A trend
  // label describing structure nobody is trading is worse than no label.
  const from = Math.max(0, complete.length - (spec.trendWindow ?? complete.length));
  const recentSwings = swings.filter((s) => s.index >= from);
  const trend = deriveTrend(recentSwings);
  const mas = movingAverages(complete, timeframe);
  const last = complete[complete.length - 1];
  const px = price ?? Number(last.close);

  const levels = candidateLevels(complete, timeframe, { asOf, price: px, maxAgeBars: spec.levelLookback });
  const unit = zoneUnit(dailyBars || complete, px);
  const { support, resistance } = buildZones(levels, { price: px, unit });

  return {
    timeframe, label: spec.label, available: true,
    bars: complete.length,
    lastBar: { date: last.date, close: round(last.close), complete: true },
    currentBar: current ? { date: current.date, close: round(current.close), complete: false, sessions: current.sessions } : null,
    trend: trend.trend,
    trendReasons: trend.reasons,
    // The confirmation lag, disclosed. A swing needs pivotWidth bars to its right to exist, so the
    // newest structure is never in the verdict; the reader is told how far back it is anchored and
    // how much price has moved since.
    trendAsOfPivot: trend.asOfPivot ?? null,
    barsSincePivot: trend.pivotIndex == null ? null : (complete.length - 1 - trend.pivotIndex),
    priceSincePivotPct: trend.pivotIndex == null ? null
      : round(((px - complete[trend.pivotIndex].close) / complete[trend.pivotIndex].close) * 100, 2),
    swings: {
      count: recentSwings.length,
      lastHigh: pick(trend.lastHigh), prevHigh: pick(trend.prevHigh),
      lastLow: pick(trend.lastLow), prevLow: pick(trend.prevLow),
    },
    movingAverages: mas,
    maStructure: maStructure(mas),
    events: structuralEvents(complete, recentSwings, { lookback: Math.min(40, complete.length - 1) }),
    atr: round(atr(complete, 14)),
    // Per-timeframe zones, so "WEEKLY nearest support" is answerable on its own.
    support: { ...selectZones(support), all: support.slice(0, 6) },
    resistance: { ...selectZones(resistance), all: resistance.slice(0, 6) },
    levelCount: levels.length,
  };
}

const pick = (s) => (s ? { price: round(s.price), date: s.date, confirmedAt: s.confirmedAt } : null);

// ── cross-timeframe ──────────────────────────────────────────────────────────

export const ALIGNMENT = Object.freeze({
  BULLISH: 'bullish-alignment',
  BEARISH: 'bearish-alignment',
  LONG_BULL_SHORT_WEAK: 'long-term-bullish-short-term-weak',
  LONG_BEAR_SHORT_STRONG: 'long-term-bearish-short-term-strong',
  CONFLICT: 'structure-conflict',
  MIXED: 'mixed',
  UNKNOWN: 'insufficient-history',
});

/**
 * How the three timeframes relate.
 *
 * Descriptive and deterministic: the state is a function of the three trend labels and nothing
 * else, and the trends themselves are listed beside it so the reader can disagree with the summary
 * without losing the facts. No weighting, no score.
 */
export function describeAlignment({ daily, weekly, monthly }) {
  const d = daily?.available ? daily.trend : null;
  const w = weekly?.available ? weekly.trend : null;
  const m = monthly?.available ? monthly.trend : null;
  const known = [d, w, m].filter(Boolean);
  if (known.length < 2) {
    return { state: ALIGNMENT.UNKNOWN, reasons: ['fewer than two timeframes have enough history'], trends: { daily: d, weekly: w, monthly: m } };
  }

  const ups = known.filter((t) => t === TREND.UP).length;
  const downs = known.filter((t) => t === TREND.DOWN).length;
  const reasons = [];
  const say = (tf, t) => { if (t) reasons.push(`${tf}: ${t}`); };
  say('Monthly', m); say('Weekly', w); say('Daily', d);

  let state = ALIGNMENT.MIXED;
  if (ups === known.length) state = ALIGNMENT.BULLISH;
  else if (downs === known.length) state = ALIGNMENT.BEARISH;
  // The two states worth naming separately: a long-term trend intact while the short end has turned
  // is a pullback; the higher timeframe disagreeing with BOTH lower ones is a genuine conflict.
  else if ((m === TREND.UP || w === TREND.UP) && d === TREND.DOWN && m !== TREND.DOWN) {
    state = ALIGNMENT.LONG_BULL_SHORT_WEAK;
  } else if ((m === TREND.DOWN || w === TREND.DOWN) && d === TREND.UP && m !== TREND.UP) {
    state = ALIGNMENT.LONG_BEAR_SHORT_STRONG;
  } else if (m && w && m !== w && (m === TREND.UP || m === TREND.DOWN) && (w === TREND.UP || w === TREND.DOWN)) {
    state = ALIGNMENT.CONFLICT;
  }

  const conflicts = [];
  if (m && w && m !== w) conflicts.push(`Monthly ${m} vs Weekly ${w}`);
  if (w && d && w !== d) conflicts.push(`Weekly ${w} vs Daily ${d}`);
  if (m && d && m !== d) conflicts.push(`Monthly ${m} vs Daily ${d}`);

  return { state, reasons, conflicts, trends: { daily: d, weekly: w, monthly: m } };
}

/**
 * Zones built from the levels of ALL timeframes at once.
 *
 * This is where multi-timeframe confluence becomes a price range rather than an assertion: a weekly
 * swing low, a daily prior breakout and a rising 50DMA within half an ATR of each other produce one
 * band whose components name all three. Distant levels do NOT merge merely because they come from
 * different timeframes — the same width ceiling applies.
 */
export function multiTimeframeZones(levelsByTimeframe, { price, unit, recentBars = [] }) {
  const all = TIMEFRAME_IDS.flatMap((id) => levelsByTimeframe[id] || []);
  const { support, resistance } = buildZones(all, { price, unit });

  const sSel = selectZones(support);
  const rSel = selectZones(resistance);
  return {
    support: {
      ...sSel,
      relationship: priceRelationship(sSel.nearest, { price, recentBars }),
      confluence: support.filter((z) => z.multiTimeframe).slice(0, 4),
      all: support.slice(0, 8),
    },
    resistance: {
      ...rSel,
      relationship: priceRelationship(rSel.nearest, { price, recentBars }),
      confluence: resistance.filter((z) => z.multiTimeframe).slice(0, 4),
      all: resistance.slice(0, 8),
    },
  };
}

/**
 * The whole picture for one security.
 *
 * `dailyBars` is the canonical adjusted daily history: [{ date, open, high, low, close, volume }]
 * ascending. Everything else is folded from it.
 */
export function marketStructure(dailyBars, { asOf = null, priceQuality = null } = {}) {
  const src = Array.isArray(dailyBars) ? dailyBars : [];
  if (src.length < 30) {
    return { available: false, reason: `needs 30 daily bars, have ${src.length}`, methodology: METHODOLOGY_VERSION };
  }
  // The same continuity protection the reaction engine uses: a series that stops describing the
  // same security produces levels from two different companies, and no amount of adjustment fixes
  // it. Unusable in, nothing out.
  if (priceQuality && priceQuality.usable === false) {
    return {
      available: false,
      reason: `price series unusable (${priceQuality.reason || 'continuity'})`,
      methodology: METHODOLOGY_VERSION,
    };
  }

  const tf = buildTimeframes(src, { asOf });
  const dailyComplete = completedOnly(tf.daily);
  const last = dailyComplete[dailyComplete.length - 1];
  const price = Number(last.close);
  const unit = zoneUnit(dailyComplete, price);

  const daily = timeframeStructure(tf.daily, 'daily', { asOf, price, dailyBars: dailyComplete });
  const weekly = timeframeStructure(tf.weekly, 'weekly', { asOf, price, dailyBars: dailyComplete });
  const monthly = timeframeStructure(tf.monthly, 'monthly', { asOf, price, dailyBars: dailyComplete });

  const levelsByTimeframe = {
    daily: daily.available ? candidateLevels(completedOnly(tf.daily), 'daily', { asOf, price, maxAgeBars: TIMEFRAMES.daily.levelLookback }) : [],
    weekly: weekly.available ? candidateLevels(completedOnly(tf.weekly), 'weekly', { asOf, price, maxAgeBars: TIMEFRAMES.weekly.levelLookback }) : [],
    monthly: monthly.available ? candidateLevels(completedOnly(tf.monthly), 'monthly', { asOf, price, maxAgeBars: TIMEFRAMES.monthly.levelLookback }) : [],
  };
  const mtf = multiTimeframeZones(levelsByTimeframe, { price, unit, recentBars: dailyComplete });

  return {
    available: true,
    methodology: METHODOLOGY_VERSION,
    asOf: asOf ? String(asOf).slice(0, 10) : last.date,
    currentPrice: round(price),
    priceDate: last.date,
    zoneUnit: round(unit),
    dailyAtr: round(atr(dailyComplete, 14)),
    daily, weekly, monthly,
    multiTimeframe: {
      alignment: describeAlignment({ daily, weekly, monthly }),
      support: mtf.support,
      resistance: mtf.resistance,
      conflicts: describeAlignment({ daily, weekly, monthly }).conflicts,
    },
  };
}

const round = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
