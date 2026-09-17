// THE SIGNAL REGISTRY.
//
// Pit Scan does not produce a score. It produces NAMED CONDITIONS, each with the numbers that
// justify it, so a trader can always read why a symbol is on the screen: "above its pre-market high
// by 0.8%, held for 4 minutes; 5-minute move accelerated from +0.3% to +1.8%". A composite number
// cannot be argued with, cannot be filtered on, and cannot be explained when it is wrong.
//
// EVERY SIGNAL EVALUATES TO A STATE, NOT AN EVENT. It answers "is this true right now?" and returns
//
//     { active, direction, detail, values, invalidated? }   or   null
//
// where NULL MEANS UNDETERMINABLE — the data needed is missing — and is emphatically not `false`.
// lifecycle.mjs turns consecutive states into events, so a signal never has to know whether it has
// fired before. That split is why the same registry serves the scanner table (states), Pit Pulse
// (events), Custom Scanner (filters) and, later, chart markers and alerts.
//
// EVERY SIGNAL DECLARES ITS DATA REQUIREMENTS and the engine will not run one the active provider
// cannot satisfy. That is what makes "never manufacture a signal when the data is missing" a
// property of the architecture rather than a promise.

import { pctChange, openingRange, sessionVwap } from './market-state.mjs';
import { acceleration, velocity, normalizedMove } from './velocity.mjs';
import { relativeStrength } from './relative-strength.mjs';
import { levelInteraction, reclaimed, ACCEPTANCE } from './levels.mjs';
import { cumulativeRvol, intervalRvol } from './volume-baseline.mjs';

export const CATEGORIES = {
  momentum: 'Momentum',
  breakout: 'Breakouts',
  premarket: 'Premarket',
  relative: 'Relative Strength',
  volatility: 'Volatility',
  volume: 'Volume',
  liquidity: 'Liquidity',
};

export const CATEGORY_IDS = Object.keys(CATEGORIES);

const n = (v) => (Number.isFinite(v) ? v : null);
const fmt = (v) => (v == null ? '—' : v.toFixed(2));
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`);
const plural = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;

/**
 * A level-break signal, which is most of them.
 *
 * ACCEPTANCE, NOT A TOUCH. The state is true when price is through the level by a meaningful
 * distance and has held there — see levels.mjs. A one-tick poke is reported as `invalidated` when it
 * comes back, because a failed break is information rather than silence.
 */
function levelSignal({ id, label, category, side, levelOf, requires, describe, lifecycle, weight }) {
  return {
    id,
    label,
    category,
    requires,
    weight: weight ?? 3,
    lifecycle,
    kind: 'level',
    evaluate(state) {
      const interaction = levelInteraction(state, levelOf(state), { side });
      // A level we do not know is not a level we can break. Undeterminable, not false.
      if (!interaction) return null;
      if (interaction.accepted) {
        return {
          active: true,
          direction: side,
          detail: describe(interaction),
          values: {
            level: interaction.level,
            throughPct: interaction.throughPct,
            barsBeyond: interaction.barsBeyond,
          },
        };
      }
      return {
        active: false,
        direction: side,
        // Traded through and came back — the failed break.
        invalidated: interaction.rejected,
        detail: interaction.rejected ? `Failed at ${fmt(interaction.level)}` : null,
        values: { level: interaction.level, throughPct: interaction.throughPct },
      };
    },
  };
}

export const SIGNALS = [
  // ── PREMARKET ──────────────────────────────────────────────────────────────
  levelSignal({
    id: 'premarket_high_break',
    label: 'Premarket high break',
    category: 'premarket',
    side: 'up',
    levelOf: (s) => s.premarketHigh,
    requires: { quoteFreshness: 'delayed', extendedHours: true },
    weight: 4,
    describe: (i) => `Above the premarket high of ${fmt(i.level)} by ${fmtPct(i.throughPct)}, ${plural(i.barsBeyond, 'bar')} held`,
  }),
  levelSignal({
    id: 'premarket_low_break',
    label: 'Premarket low break',
    category: 'premarket',
    side: 'down',
    levelOf: (s) => s.premarketLow,
    requires: { quoteFreshness: 'delayed', extendedHours: true },
    weight: 4,
    describe: (i) => `Below the premarket low of ${fmt(i.level)}, ${plural(i.barsBeyond, 'bar')} held`,
  }),

  // ── PREVIOUS SESSION ───────────────────────────────────────────────────────
  levelSignal({
    id: 'prev_day_high_break',
    label: 'Previous-day high break',
    category: 'breakout',
    side: 'up',
    levelOf: (s) => s.prevHigh,
    requires: { quoteFreshness: 'delayed', historicalDaily: true },
    describe: (i) => `Above yesterday's high of ${fmt(i.level)} by ${fmtPct(i.throughPct)}`,
  }),
  levelSignal({
    id: 'prev_day_low_break',
    label: 'Previous-day low break',
    category: 'breakout',
    side: 'down',
    levelOf: (s) => s.prevLow,
    requires: { quoteFreshness: 'delayed', historicalDaily: true },
    describe: (i) => `Below yesterday's low of ${fmt(i.level)}`,
  }),

  // ── SESSION EXTREMES ───────────────────────────────────────────────────────
  // Not a level break: "new session high" means the extreme has just MOVED, which is a different
  // fact from being above a level set hours ago. Short cooldown, because it legitimately repeats as
  // a symbol grinds up — but not every second.
  {
    id: 'new_session_high',
    label: 'New session high',
    category: 'breakout',
    requires: { quoteFreshness: 'delayed' },
    weight: 2,
    kind: 'state',
    lifecycle: { cooldownSeconds: 120, ttlSeconds: 300 },
    evaluate(state) {
      const price = n(state.price);
      const high = n(state.sessionHigh);
      if (price == null || high == null) return null;
      // The open alone is not a session high; there has to be a session behind it.
      if ((state.regularBars || []).length < 2) return null;
      if (price < high) return { active: false, direction: 'up', values: { sessionHigh: high } };
      return {
        active: true,
        direction: 'up',
        detail: `New high of the session at ${fmt(price)}`,
        values: { price, sessionHigh: high },
      };
    },
  },
  {
    id: 'new_session_low',
    label: 'New session low',
    category: 'breakout',
    requires: { quoteFreshness: 'delayed' },
    weight: 2,
    kind: 'state',
    lifecycle: { cooldownSeconds: 120, ttlSeconds: 300 },
    evaluate(state) {
      const price = n(state.price);
      const low = n(state.sessionLow);
      if (price == null || low == null) return null;
      if ((state.regularBars || []).length < 2) return null;
      if (price > low) return { active: false, direction: 'down', values: { sessionLow: low } };
      return {
        active: true,
        direction: 'down',
        detail: `New low of the session at ${fmt(price)}`,
        values: { price, sessionLow: low },
      };
    },
  },

  // ── OPENING RANGE ──────────────────────────────────────────────────────────
  // One definition, four configurable ranges. openingRange() returns null while the range is still
  // forming, so a break of an unfinished range cannot be reported — which is what stops every
  // gap-up firing at 09:31.
  ...[1, 5, 15, 30].flatMap((minutes) => ([
    levelSignal({
      id: `opening_range_break_${minutes}m`,
      label: `${minutes}m opening range break`,
      category: 'breakout',
      side: 'up',
      levelOf: (s) => openingRange(s, minutes)?.high ?? null,
      requires: { quoteFreshness: 'delayed', minBarSeconds: 60 },
      describe: (i) => `Broke the ${minutes}-minute opening range high of ${fmt(i.level)}`,
    }),
    levelSignal({
      id: `opening_range_breakdown_${minutes}m`,
      label: `${minutes}m opening range breakdown`,
      category: 'breakout',
      side: 'down',
      levelOf: (s) => openingRange(s, minutes)?.low ?? null,
      requires: { quoteFreshness: 'delayed', minBarSeconds: 60 },
      describe: (i) => `Broke below the ${minutes}-minute opening range low of ${fmt(i.level)}`,
    }),
  ])),

  // ── MULTI-DAY LEVELS ───────────────────────────────────────────────────────
  levelSignal({
    id: 'high_20d', label: '20-day high', category: 'breakout', side: 'up',
    levelOf: (s) => s.high20d, requires: { historicalDaily: true },
    describe: (i) => `Above its 20-day high of ${fmt(i.level)}`,
  }),
  levelSignal({
    id: 'low_20d', label: '20-day low', category: 'breakout', side: 'down',
    levelOf: (s) => s.low20d, requires: { historicalDaily: true },
    describe: (i) => `Below its 20-day low of ${fmt(i.level)}`,
  }),
  levelSignal({
    id: 'high_52w', label: '52-week high', category: 'breakout', side: 'up', weight: 5,
    levelOf: (s) => s.high52w, requires: { historicalDaily: true },
    describe: (i) => `Above its 52-week high of ${fmt(i.level)}`,
  }),
  levelSignal({
    id: 'low_52w', label: '52-week low', category: 'breakout', side: 'down', weight: 5,
    levelOf: (s) => s.low52w, requires: { historicalDaily: true },
    describe: (i) => `Below its 52-week low of ${fmt(i.level)}`,
  }),

  // ── VWAP ───────────────────────────────────────────────────────────────────
  // Gated on CONSOLIDATED volume, not merely volume. A VWAP from one venue's prints is not the VWAP
  // anyone is trading against, and "reclaimed VWAP" is a line people act on.
  {
    id: 'vwap_reclaim',
    label: 'VWAP reclaim',
    category: 'momentum',
    requires: { quoteFreshness: 'near', liveVolume: true, consolidatedVolume: true },
    weight: 3,
    kind: 'state',
    evaluate(state) {
      const vwap = sessionVwap(state);
      const price = n(state.price);
      if (vwap == null || price == null) return null;
      const bars = state.regularBars || [];
      if (price <= vwap) return { active: false, direction: 'up', values: { vwap } };
      // A reclaim requires history: it must have been above, lost it, and taken it back. Without
      // that test every gap-up "reclaims" VWAP on its first bar.
      if (!reclaimed(bars, vwap, { side: 'up' })) return { active: false, direction: 'up', values: { vwap } };
      return {
        active: true,
        direction: 'up',
        detail: `Reclaimed VWAP at ${fmt(vwap)}`,
        values: { vwap, price, distancePct: pctChange(vwap, price) },
      };
    },
  },
  {
    id: 'vwap_loss',
    label: 'VWAP loss',
    category: 'momentum',
    requires: { quoteFreshness: 'near', liveVolume: true, consolidatedVolume: true },
    weight: 3,
    kind: 'state',
    evaluate(state) {
      const vwap = sessionVwap(state);
      const price = n(state.price);
      if (vwap == null || price == null) return null;
      const bars = state.regularBars || [];
      if (price >= vwap) return { active: false, direction: 'down', values: { vwap } };
      if (!reclaimed(bars, vwap, { side: 'down' })) return { active: false, direction: 'down', values: { vwap } };
      return {
        active: true,
        direction: 'down',
        detail: `Lost VWAP at ${fmt(vwap)}`,
        values: { vwap, price, distancePct: pctChange(vwap, price) },
      };
    },
  },

  // ── MOMENTUM ───────────────────────────────────────────────────────────────
  {
    id: 'price_acceleration_5m',
    label: '5m acceleration',
    category: 'momentum',
    requires: { quoteFreshness: 'near', minBarSeconds: 60 },
    weight: 5,
    kind: 'state',
    lifecycle: { cooldownSeconds: 300, ttlSeconds: 600 },
    evaluate(state) {
      const a = acceleration(state.bars, '5m', state.now);
      if (!a) return null;
      const big = a.accelerating
        && Math.abs(a.current) >= MIN_MOVE_PCT
        && Math.abs(a.delta) >= MIN_ACCEL_DELTA_PCT;
      if (!big) return { active: false, direction: a.direction, values: { current: a.current, prior: a.prior } };
      return {
        active: true,
        direction: a.direction,
        detail: `5-minute move accelerated from ${fmtPct(a.prior)} to ${fmtPct(a.current)}`,
        values: { current: a.current, prior: a.prior, delta: a.delta, ratio: a.ratio },
      };
    },
  },
  {
    id: 'price_velocity_1m',
    label: '1m velocity',
    category: 'momentum',
    requires: { quoteFreshness: 'near', minBarSeconds: 60 },
    weight: 2,
    kind: 'state',
    lifecycle: { cooldownSeconds: 180, ttlSeconds: 300 },
    evaluate(state) {
      const v = velocity(state.bars, '1m', state.now);
      if (!v || v.pct == null) return null;
      if (Math.abs(v.pct) < MIN_1M_PCT) return { active: false, values: { pct: v.pct } };
      return {
        active: true,
        direction: v.pct >= 0 ? 'up' : 'down',
        detail: `Moved ${fmtPct(v.pct)} in one minute`,
        values: { pct: v.pct },
      };
    },
  },
  {
    id: 'sudden_displacement',
    label: 'Sudden displacement',
    category: 'volatility',
    requires: { quoteFreshness: 'near', minBarSeconds: 60, historicalDaily: true },
    weight: 4,
    kind: 'state',
    lifecycle: { cooldownSeconds: 300, ttlSeconds: 600 },
    evaluate(state) {
      // MEASURED AGAINST THE SYMBOL'S OWN RANGE. A 2% minute is ordinary in one name and
      // extraordinary in another; a fixed threshold fills the scanner with the former.
      const nm = normalizedMove(state, '1m');
      if (!nm) return null;
      if (nm.atrShare < DISPLACEMENT_ATR_SHARE) return { active: false, values: { atrShare: nm.atrShare } };
      return {
        active: true,
        direction: nm.pct >= 0 ? 'up' : 'down',
        detail: `Moved ${(nm.atrShare * 100).toFixed(0)}% of its average daily range in one minute`,
        values: { atrShare: nm.atrShare, pct: nm.pct },
      };
    },
  },

  // ── VOLATILITY ─────────────────────────────────────────────────────────────
  {
    id: 'range_expansion',
    label: 'Range expansion',
    category: 'volatility',
    requires: { quoteFreshness: 'delayed', minBarSeconds: 60, historicalDaily: true },
    weight: 2,
    kind: 'state',
    evaluate(state) {
      const atr = n(state.atr14);
      const hi = n(state.sessionHigh);
      const lo = n(state.sessionLow);
      if (atr == null || atr <= 0 || hi == null || lo == null) return null;
      const ratio = (hi - lo) / atr;
      if (ratio < RANGE_EXPANSION_RATIO) return { active: false, values: { ratio } };
      return {
        active: true,
        direction: null,
        detail: `Session range is ${ratio.toFixed(1)}× its average daily range`,
        values: { ratio, range: hi - lo, atr },
      };
    },
  },
  {
    id: 'compression_expansion',
    label: 'Compression break',
    category: 'volatility',
    requires: { quoteFreshness: 'near', minBarSeconds: 60 },
    weight: 4,
    kind: 'state',
    lifecycle: { cooldownSeconds: 900, ttlSeconds: 1200 },
    evaluate(state) {
      // A quiet stretch followed by a loud one. BOTH halves have to exist: expansion alone is just
      // movement, and compression alone is nothing happening.
      const bars = state.regularBars || [];
      if (bars.length < COMPRESSION_BARS + EXPANSION_BARS) return null;
      const spread = (list) => {
        let hi = -Infinity;
        let lo = Infinity;
        for (const b of list) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
        return (hi === -Infinity || lo === Infinity) ? null : hi - lo;
      };
      const loud = spread(bars.slice(-EXPANSION_BARS));
      const quiet = spread(bars.slice(-(COMPRESSION_BARS + EXPANSION_BARS), -EXPANSION_BARS));
      if (quiet == null || loud == null || quiet <= 0) return null;
      const ratio = loud / quiet;
      if (ratio < COMPRESSION_BREAK_RATIO) return { active: false, values: { ratio } };
      const recent = bars.slice(-EXPANSION_BARS);
      return {
        active: true,
        direction: recent[recent.length - 1].c >= recent[0].o ? 'up' : 'down',
        detail: `Broke out of a ${COMPRESSION_BARS}-minute coil, ${ratio.toFixed(1)}× the prior range`,
        values: { ratio, quiet, loud },
      };
    },
  },

  // ── RELATIVE STRENGTH ──────────────────────────────────────────────────────
  {
    id: 'relative_strength',
    label: 'Relative strength',
    category: 'relative',
    requires: { quoteFreshness: 'near', minBarSeconds: 60 },
    weight: 3,
    kind: 'state',
    evaluate(state, ctx) {
      const rs = relativeStrength(state, ctx?.benchmarks, { window: '5m', now: state.now });
      // No benchmark data is UNDETERMINABLE. A benchmark we could not measure is not a benchmark of
      // zero, and treating it as one makes every symbol look strong.
      if (!rs || rs.spread == null) return null;
      if (Math.abs(rs.spread) < MIN_RS_SPREAD_PCT) {
        return { active: false, values: { benchmark: rs.benchmark, spread: rs.spread } };
      }
      const out = rs.spread > 0;
      return {
        active: true,
        direction: out ? 'up' : 'down',
        detail: `${out ? 'Outperforming' : 'Underperforming'} ${rs.benchmark} by ${fmtPct(rs.spread)} over 5 minutes`,
        values: { benchmark: rs.benchmark, spread: rs.spread, symbolPct: rs.symbolPct, benchmarkPct: rs.benchmarkPct },
      };
    },
  },

  // ── VOLUME ─────────────────────────────────────────────────────────────────
  // DEFINED IN FULL, DELIBERATELY DARK on the interim feed. Every one is gated on consolidated live
  // volume AND on time-of-day history, because an RVOL against a flat full-day average is wrong in a
  // direction that makes quiet mornings look like discoveries. RVOL is what people size on.
  {
    id: 'rvol_elevated',
    label: 'Relative volume',
    category: 'volume',
    requires: { liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true },
    weight: 4,
    kind: 'state',
    evaluate(state, ctx) {
      if (state.volumeQuality !== 'consolidated') return null;
      const r = cumulativeRvol(ctx?.baseline, state.etMinutes, state.volume);
      if (!r) return null;
      if (r.rvol < RVOL_THRESHOLD) return { active: false, values: { rvol: r.rvol } };
      return {
        active: true,
        direction: null,
        detail: `Trading ${r.rvol.toFixed(1)}× its normal volume for this time of day`,
        values: { rvol: r.rvol, expected: r.expected, observed: r.observed, z: r.z },
      };
    },
  },
  {
    id: 'volume_spike',
    label: 'Volume spike',
    category: 'volume',
    requires: { liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true, minBarSeconds: 60 },
    weight: 3,
    kind: 'state',
    lifecycle: { cooldownSeconds: 300, ttlSeconds: 600 },
    evaluate(state, ctx) {
      if (state.volumeQuality !== 'consolidated') return null;
      const bars = state.regularBars || [];
      if (bars.length < 5) return null;
      const recent = bars.slice(-5).reduce((s, b) => s + (b.v || 0), 0);
      const r = intervalRvol(ctx?.baseline, state.etMinutes, recent);
      if (!r) return null;
      if (r.rvol < VOLUME_SPIKE_RATIO) return { active: false, values: { rvol: r.rvol } };
      return {
        active: true,
        direction: null,
        detail: `Last five minutes traded ${r.rvol.toFixed(1)}× normal for this slot`,
        values: { rvol: r.rvol, expected: r.expected, observed: r.observed },
      };
    },
  },
  {
    id: 'volume_acceleration',
    label: 'Volume acceleration',
    category: 'volume',
    requires: { liveVolume: true, consolidatedVolume: true, minBarSeconds: 60 },
    weight: 3,
    kind: 'state',
    evaluate(state) {
      if (state.volumeQuality !== 'consolidated') return null;
      const bars = state.regularBars || [];
      if (bars.length < 10) return null;
      const recent = bars.slice(-5).reduce((s, b) => s + (b.v || 0), 0) / 5;
      const prior = bars.slice(-10, -5).reduce((s, b) => s + (b.v || 0), 0) / 5;
      if (!(prior > 0) || !(recent > 0)) return null;
      const ratio = recent / prior;
      if (ratio < VOLUME_ACCEL_RATIO) return { active: false, values: { ratio } };
      return {
        active: true,
        direction: null,
        detail: `Volume rate ${ratio.toFixed(1)}× the prior five minutes`,
        values: { ratio, recent, prior },
      };
    },
  },
  {
    id: 'volume_confirmed_breakout',
    label: 'Volume-confirmed breakout',
    category: 'volume',
    requires: { liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true, historicalDaily: true },
    weight: 6,
    kind: 'state',
    // THE ONE SIGNAL THAT READS OTHERS, and it does so through the engine's already-decided set
    // rather than by calling a peer — so it cannot confirm a breakout the engine rejected.
    dependsOnPeers: true,
    evaluate(state, ctx) {
      if (state.volumeQuality !== 'consolidated') return null;
      const broke = (ctx?.activeStates || []).find((s) => s.category === 'breakout' && s.direction === 'up' && s.active);
      if (!broke) return { active: false };
      const r = cumulativeRvol(ctx?.baseline, state.etMinutes, state.volume);
      if (!r) return null;
      if (r.rvol < RVOL_THRESHOLD) return { active: false, values: { rvol: r.rvol } };
      return {
        active: true,
        direction: 'up',
        detail: `${broke.label} on ${r.rvol.toFixed(1)}× volume`,
        values: { rvol: r.rvol, confirms: broke.id },
      };
    },
  },

  // ── LIQUIDITY ──────────────────────────────────────────────────────────────
  // Not a reason to look at a symbol — a reason to DISCARD one. Exposed as a signal so the same
  // registry can express "tradeable" and Custom Scanner can filter on it.
  {
    id: 'wide_spread',
    label: 'Wide spread',
    category: 'liquidity',
    requires: { bidAsk: true },
    weight: 0,
    kind: 'state',
    evaluate(state) {
      const spreadPct = n(state.spreadPct);
      if (spreadPct == null) return null;
      if (spreadPct < WIDE_SPREAD_PCT) return { active: false, values: { spreadPct } };
      return {
        active: true,
        direction: null,
        detail: `Spread is ${spreadPct.toFixed(2)}% — thin`,
        values: { spreadPct, bid: state.bid, ask: state.ask },
      };
    },
  },
];

// ── thresholds, in one place so they are tuned as a set rather than hunted for ──
export const MIN_MOVE_PCT = 0.5;
export const MIN_ACCEL_DELTA_PCT = 0.4;
export const MIN_1M_PCT = 0.75;
export const DISPLACEMENT_ATR_SHARE = 0.25;
export const RANGE_EXPANSION_RATIO = 1.5;
export const COMPRESSION_BARS = 15;
export const EXPANSION_BARS = 3;
export const COMPRESSION_BREAK_RATIO = 2.5;
export const MIN_RS_SPREAD_PCT = 0.75;
export const RVOL_THRESHOLD = 2;
export const VOLUME_SPIKE_RATIO = 3;
export const VOLUME_ACCEL_RATIO = 2;
export const WIDE_SPREAD_PCT = 1;

export const SIGNAL_BY_ID = new Map(SIGNALS.map((s) => [s.id, s]));
export const SIGNAL_IDS = SIGNALS.map((s) => s.id);
export { ACCEPTANCE };
