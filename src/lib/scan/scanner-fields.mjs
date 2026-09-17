// THE LIVE SCANNER FIELDS, as compact dropdown filters.
//
// Catalyst Pit's Custom Scanner is a Finviz-style grid of dropdowns, and that is deliberate: a
// trader who screens for a living can set eight conditions in eight seconds that way, and no
// field/operator/value rule builder comes close. So the deeper real-time vocabulary — velocity,
// time-of-day RVOL, VWAP structure, premarket levels, relative strength — arrives in EXACTLY the
// same shape as the existing daily filters: a label, a category, and a short list of professional
// presets, plus Custom where a range makes sense.
//
//   INTERNALLY   field + operator + value, shared with the Pit Scan engine
//   EXTERNALLY   one dropdown
//
// Kept separate from screener-filters.js on purpose. Those fields are COLUMNS IN screener_stocks and
// compile to SQL; these are computed from live market state and cannot. Merging the two registries
// would mean one `buildConds` that has to know which half it is looking at — so instead they share a
// shape and are merged for display only, and the daily screener keeps working exactly as it does.
//
// EVERY FIELD HERE IS CAPABILITY-GATED. None of them can run on the interim delayed feed, and each
// says which capability it is waiting for rather than silently returning nothing.

import { FRESHNESS } from './market-capabilities.mjs';

/** Categories, ordered the way a trader scans down them. */
export const LIVE_CATEGORIES = [
  'Momentum', 'Volume', 'Structure', 'Premarket', 'Relative Strength', 'Volatility', 'Liquidity', 'Catalyst',
];

// ── preset builders ──────────────────────────────────────────────────────────
// A preset is a label plus the condition it sets. The condition shape is the same { min, max, eq }
// the daily filters already use, so a saved scan is one JSON object whatever it contains.

const up = (v) => ({ label: `Up ${v}%`, cond: { min: v } });
const down = (v) => ({ label: `Down ${v}%`, cond: { max: -v } });
const over = (v, unit = '') => ({ label: `Over ${unit}${v}`, cond: { min: v } });
const under = (v, unit = '') => ({ label: `Under ${unit}${v}`, cond: { max: v } });

/** Percentage movement, both directions — the shape every velocity window uses. */
const MOVE = [up(1), up(2), up(3), up(5), up(10), up(20), down(1), down(2), down(3), down(5), down(10)];

const RVOL_OPTS = [over(1), over(1.5), over(2), over(3), over(5), over(10), over(20)];

const DOLLAR_VOL = [
  over(1_000_000, '$'), over(5_000_000, '$'), over(10_000_000, '$'),
  over(25_000_000, '$'), over(50_000_000, '$'), over(100_000_000, '$'),
];

const NEWS_AGE = [
  { label: 'Last 5 minutes', cond: { max: 5 } },
  { label: 'Last 15 minutes', cond: { max: 15 } },
  { label: 'Last 30 minutes', cond: { max: 30 } },
  { label: 'Last hour', cond: { max: 60 } },
  { label: 'Last 2 hours', cond: { max: 120 } },
  { label: 'Today', cond: { max: 960 } },
];

const DISTANCE = [
  { label: 'Within 0.5%', cond: { max: 0.5 } },
  { label: 'Within 1%', cond: { max: 1 } },
  { label: 'Within 2%', cond: { max: 2 } },
  { label: 'Within 5%', cond: { max: 5 } },
];

const YES_NO = [{ label: 'Yes', cond: { eq: true } }, { label: 'No', cond: { eq: false } }];

// ── requirement bundles ──────────────────────────────────────────────────────
// Named so a reader can see at a glance which group of fields shares a fate when a provider lands.
const NEEDS_INTRADAY = { quoteFreshness: FRESHNESS.NEAR, minBarSeconds: 60 };
const NEEDS_SUBMINUTE = { quoteFreshness: FRESHNESS.REALTIME, observationsPerMinute: 2 };
const NEEDS_VOLUME = { liveVolume: true, consolidatedVolume: true };
const NEEDS_RVOL = { liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true };
const NEEDS_VWAP = { quoteFreshness: FRESHNESS.NEAR, liveVolume: true, consolidatedVolume: true };
const NEEDS_PREMARKET = { quoteFreshness: FRESHNESS.NEAR, extendedHours: true };
const NEEDS_QUOTE = { bidAsk: true };

const f = (label, category, type, opts, requires, extra = {}) =>
  ({ label, category, type, opts, requires, live: true, pit: true, unit: extra.unit || null, ...extra });

/**
 * THE LIVE FIELDS.
 *
 * `live: true` marks a field the SQL screener must never try to compile — it is computed from market
 * state, not selected from a column. `pit: true` marks it as a Catalyst Pit differentiator, which is
 * what the ◆ in the UI means, and these are all of them.
 */
export const LIVE_FIELDS = {
  // ══ MOMENTUM ══════════════════════════════════════════════════════════════
  // One field per velocity window. 30s carries a stricter requirement than the rest, because it is
  // the one that cannot be honestly computed from minute bars.
  vel30s: f('30s Change', 'Momentum', 'range', MOVE, NEEDS_SUBMINUTE, { unit: '%' }),
  vel1m: f('1m Change', 'Momentum', 'range', MOVE, NEEDS_INTRADAY, { unit: '%' }),
  vel2m: f('2m Change', 'Momentum', 'range', MOVE, NEEDS_INTRADAY, { unit: '%' }),
  vel3m: f('3m Change', 'Momentum', 'range', MOVE, NEEDS_INTRADAY, { unit: '%' }),
  vel5m: f('5m Change', 'Momentum', 'range', MOVE, NEEDS_INTRADAY, { unit: '%' }),
  vel10m: f('10m Change', 'Momentum', 'range', MOVE, NEEDS_INTRADAY, { unit: '%' }),
  vel15m: f('15m Change', 'Momentum', 'range', MOVE, NEEDS_INTRADAY, { unit: '%' }),
  vel30m: f('30m Change', 'Momentum', 'range', MOVE, NEEDS_INTRADAY, { unit: '%' }),
  accel5m: f('5m Acceleration', 'Momentum', 'enum', [
    { label: 'Accelerating up', cond: { eq: 'up' } },
    { label: 'Accelerating down', cond: { eq: 'down' } },
    { label: 'Decelerating', cond: { eq: 'decelerating' } },
    { label: 'Reversing', cond: { eq: 'reversal' } },
  ], NEEDS_INTRADAY),

  // ══ VOLUME ════════════════════════════════════════════════════════════════
  rvol: f('RVOL (time of day)', 'Volume', 'range', RVOL_OPTS, NEEDS_RVOL, { unit: '×' }),
  rvolInterval: f('Interval RVOL', 'Volume', 'range', RVOL_OPTS, NEEDS_RVOL, { unit: '×' }),
  volAccel: f('Volume Acceleration', 'Volume', 'range',
    [over(1.5), over(2), over(3), over(5)], NEEDS_VOLUME, { unit: '×' }),
  volSpike: f('Volume Spike', 'Volume', 'bool', YES_NO, NEEDS_RVOL),
  dollarVolLive: f('Dollar Volume (live)', 'Volume', 'range', DOLLAR_VOL, NEEDS_VOLUME, { unit: '$' }),

  // ══ STRUCTURE ═════════════════════════════════════════════════════════════
  vwapSide: f('VWAP', 'Structure', 'enum', [
    { label: 'Above VWAP', cond: { eq: 'above' } },
    { label: 'Below VWAP', cond: { eq: 'below' } },
    { label: 'Reclaimed VWAP', cond: { eq: 'reclaim' } },
    { label: 'Lost VWAP', cond: { eq: 'loss' } },
  ], NEEDS_VWAP),
  vwapDistance: f('Distance from VWAP', 'Structure', 'range', DISTANCE, NEEDS_VWAP, { unit: '%' }),
  prevDayLevel: f('Previous Day', 'Structure', 'enum', [
    { label: 'Above yesterday’s high', cond: { eq: 'above_high' } },
    { label: 'Below yesterday’s low', cond: { eq: 'below_low' } },
    { label: 'Inside yesterday’s range', cond: { eq: 'inside' } },
  ], NEEDS_INTRADAY),
  sessionExtreme: f('Session Extreme', 'Structure', 'enum', [
    { label: 'At session high', cond: { eq: 'high' } },
    { label: 'At session low', cond: { eq: 'low' } },
  ], NEEDS_INTRADAY),
  openingRange: f('Opening Range', 'Structure', 'enum', [
    { label: '1m range broken', cond: { eq: 'break_1' } },
    { label: '5m range broken', cond: { eq: 'break_5' } },
    { label: '15m range broken', cond: { eq: 'break_15' } },
    { label: '30m range broken', cond: { eq: 'break_30' } },
    { label: '5m range breakdown', cond: { eq: 'down_5' } },
    { label: '15m range breakdown', cond: { eq: 'down_15' } },
  ], NEEDS_INTRADAY),

  // ══ PREMARKET ═════════════════════════════════════════════════════════════
  pmLevel: f('Premarket Level', 'Premarket', 'enum', [
    { label: 'Above premarket high', cond: { eq: 'above_high' } },
    { label: 'Below premarket low', cond: { eq: 'below_low' } },
    { label: 'Premarket high broken', cond: { eq: 'break_high' } },
    { label: 'Premarket low broken', cond: { eq: 'break_low' } },
  ], NEEDS_PREMARKET),
  pmHighDistance: f('Distance from PM High', 'Premarket', 'range', DISTANCE, NEEDS_PREMARKET, { unit: '%' }),
  pmChange: f('Premarket Change', 'Premarket', 'range', MOVE, NEEDS_PREMARKET, { unit: '%' }),
  pmVolume: f('Premarket Volume', 'Premarket', 'range',
    [over(100_000), over(250_000), over(500_000), over(1_000_000), over(5_000_000)],
    { ...NEEDS_PREMARKET, liveVolume: true, consolidatedVolume: true }),

  // ══ RELATIVE STRENGTH ═════════════════════════════════════════════════════
  rsSpy: f('vs SPY', 'Relative Strength', 'range',
    [up(0.5), up(1), up(2), up(3), down(0.5), down(1), down(2), down(3)], NEEDS_INTRADAY, { unit: '%' }),
  rsQqq: f('vs QQQ', 'Relative Strength', 'range',
    [up(0.5), up(1), up(2), up(3), down(0.5), down(1), down(2), down(3)], NEEDS_INTRADAY, { unit: '%' }),
  rsSector: f('vs Sector', 'Relative Strength', 'range',
    [up(0.5), up(1), up(2), up(3), down(0.5), down(1), down(2), down(3)], NEEDS_INTRADAY, { unit: '%' }),

  // ══ VOLATILITY ════════════════════════════════════════════════════════════
  atrPct: f('ATR %', 'Volatility', 'range',
    [over(2), over(3), over(5), over(10), under(2)], NEEDS_INTRADAY, { unit: '%' }),
  rangeExpansion: f('Range Expansion', 'Volatility', 'range',
    [over(1.5, ''), over(2, ''), over(3, '')], NEEDS_INTRADAY, { unit: '×' }),
  compression: f('Compression Break', 'Volatility', 'bool', YES_NO, NEEDS_INTRADAY),

  // ══ LIQUIDITY ═════════════════════════════════════════════════════════════
  spreadPct: f('Spread %', 'Liquidity', 'range',
    [under(0.1), under(0.25), under(0.5), under(1)], NEEDS_QUOTE, { unit: '%' }),

  // ══ CATALYST / INTELLIGENCE ═══════════════════════════════════════════════
  // These read Catalyst Pit's own data rather than the market feed, so they need no market
  // capability — but they are only USEFUL beside a live move, which is why they live here.
  newsAge: f('Fresh News', 'Catalyst', 'range', NEWS_AGE, {}, { unit: 'min' }),
  hasInsiderBuy: f('Insider Buying', 'Catalyst', 'bool', YES_NO, {}),
  hasCongress: f('Congress Activity', 'Catalyst', 'bool', YES_NO, {}),
  earningsProximity: f('Earnings', 'Catalyst', 'enum', [
    { label: 'Today', cond: { eq: 0 } },
    { label: 'Within 2 days', cond: { eq: 2 } },
    { label: 'Within a week', cond: { eq: 7 } },
    { label: 'Reported in last 2 days', cond: { eq: -2 } },
  ], {}),
};

export const LIVE_FIELD_IDS = Object.keys(LIVE_FIELDS);

/**
 * The live vocabulary, tagged with whether the active feed can serve each field.
 *
 * Returned in the SAME shape the daily filters use, so the Custom Scanner renders both from one list
 * and does not need to know which half a field came from. An unavailable field keeps its dropdown
 * visible but disabled, with the reason attached — a trader can see the capability exists and what
 * it is waiting for, which is the honest version of "coming soon".
 */
export function liveFieldsWithAvailability(caps, availabilityFn) {
  const out = {};
  for (const [key, def] of Object.entries(LIVE_FIELDS)) {
    const a = availabilityFn({ requires: def.requires }, caps);
    out[key] = {
      ...def,
      available: a.available,
      unavailableReason: a.available ? null : a.reason,
    };
  }
  return out;
}
