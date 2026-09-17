// THE COMPOSABLE FILTER MODEL.
//
// Pit Scan and Custom Scanner are the same engine wearing different clothes:
//
//   PIT SCAN        a curated set of conditions we chose, tuned, and stand behind
//   CUSTOM SCANNER  the same conditions, chosen by the trader
//
// So neither owns a query language. Both build a FILTER SET out of the same fields, and both evaluate
// it with the same function. Adding "5-minute change > 3%" to Custom Scanner is adding one entry to
// the field registry below — not writing a scanner.
//
// FIELDS ARE DECLARED, AND EACH ONE STATES THE CAPABILITY IT NEEDS. A filter on RVOL is unavailable
// on a feed without consolidated volume, exactly as the signal is, and for the same reason: an
// answer computed from data we do not have is worse than no answer. This mirrors the pattern
// screener-filters.js already uses for the daily screener, so the two read the same way.
//
// Pure: a filter set is data, it serialises to JSON, and it can be saved as a preset or sent to a
// server-side evaluator without carrying code.

import { SIGNAL_BY_ID, CATEGORIES } from './signals.mjs';
import { signalAvailability } from './market-capabilities.mjs';

/** How a field is compared. Deliberately few: every one has to be explicable in the UI. */
export const OPERATORS = {
  gt: { label: 'is above', arity: 1, apply: (v, a) => v > a },
  gte: { label: 'is at least', arity: 1, apply: (v, a) => v >= a },
  lt: { label: 'is below', arity: 1, apply: (v, a) => v < a },
  lte: { label: 'is at most', arity: 1, apply: (v, a) => v <= a },
  between: { label: 'is between', arity: 2, apply: (v, a, b) => v >= a && v <= b },
  eq: { label: 'is', arity: 1, apply: (v, a) => v === a },
  neq: { label: 'is not', arity: 1, apply: (v, a) => v !== a },
  isTrue: { label: 'is true', arity: 0, apply: (v) => v === true },
  isFalse: { label: 'is false', arity: 0, apply: (v) => v !== true },
};

export const OPERATOR_IDS = Object.keys(OPERATORS);

const numField = (id, label, group, read, requires, unit) =>
  ({ id, label, group, type: 'number', read, requires: requires || {}, unit: unit || null });

/**
 * THE FIELD REGISTRY — everything a filter can be written about.
 *
 * `read(row)` pulls the value out of an engine row. Returning undefined or null means UNKNOWN, and an
 * unknown value never satisfies a filter: a symbol whose float we do not have must not appear in a
 * "float under 20M" screen just because the number is missing.
 */
export const FIELDS = {
  // ── price and identity ──
  price: numField('price', 'Price', 'Price', (r) => r.price, {}, '$'),
  changePct: numField('changePct', 'Change', 'Price', (r) => r.changePct, {}, '%'),
  gapPct: numField('gapPct', 'Gap', 'Price', (r) => r.gapPct, { historicalDaily: true }, '%'),
  marketCap: numField('marketCap', 'Market cap', 'Liquidity', (r) => r.marketCap, { marketCap: true }, '$'),
  float: numField('float', 'Float', 'Liquidity', (r) => r.float, { float: true }, 'shares'),

  // ── liquidity. The filters that remove thin names, which is most of what a filter set is for. ──
  volume: numField('volume', 'Volume', 'Liquidity', (r) => r.volume, { liveVolume: true }, 'shares'),
  dollarVolume: numField('dollarVolume', 'Dollar volume', 'Liquidity', (r) => r.dollarVolume, { liveVolume: true }, '$'),
  spreadPct: numField('spreadPct', 'Spread', 'Liquidity', (r) => r.spreadPct, { bidAsk: true }, '%'),

  // ── velocity, one field per window, each inheriting that window's requirement ──
  ...Object.fromEntries(['30s', '1m', '2m', '3m', '5m', '10m', '15m', '30m'].map((w) => [
    `vel_${w}`,
    numField(`vel_${w}`, `${w} change`, 'Momentum',
      (r) => r.velocity?.[w]?.pct,
      w === '30s' ? { observationsPerMinute: 2, quoteFreshness: 'realtime' } : { quoteFreshness: 'near', minBarSeconds: 60 },
      '%'),
  ])),

  // ── volume behaviour ──
  rvol: numField('rvol', 'RVOL', 'Volume', (r) => r.rvol,
    { liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true }, '×'),

  // ── relative strength ──
  rsSpread: numField('rsSpread', 'Relative strength', 'Relative',
    (r) => r.relativeStrength?.spread, { quoteFreshness: 'near', minBarSeconds: 60 }, '%'),

  // ── enrichment. The differentiator: filter on Catalyst Pit's own intelligence. ──
  newsAgeMinutes: numField('newsAgeMinutes', 'News age', 'Catalyst', (r) => r.context?.news?.ageMinutes, {}, 'min'),
  insiderBuy: {
    id: 'insiderBuy', label: 'Recent insider buying', group: 'Catalyst', type: 'bool',
    read: (r) => r.context?.insider?.recentBuy === true, requires: {},
  },
  congressActivity: {
    id: 'congressActivity', label: 'Recent congressional trade', group: 'Catalyst', type: 'bool',
    read: (r) => r.context?.congress?.recent === true, requires: {},
  },

  // ── the signal stack itself, which is what makes Pit Scan's curation expressible as a filter ──
  hasSignal: {
    id: 'hasSignal', label: 'Has signal', group: 'Signals', type: 'signal',
    read: (r, arg) => (r.signals || []).some((s) => s.id === arg),
    requiresFor: (arg) => SIGNAL_BY_ID.get(arg)?.requires || {},
  },
  signalCategory: {
    id: 'signalCategory', label: 'Has signal in category', group: 'Signals', type: 'category',
    read: (r, arg) => (r.signals || []).some((s) => s.category === arg),
    requires: {},
  },
  signalCount: numField('signalCount', 'Active signals', 'Signals', (r) => (r.signals || []).length, {}),
};

export const FIELD_IDS = Object.keys(FIELDS);
export const FIELD_GROUPS = [...new Set(Object.values(FIELDS).map((f) => f.group))];

/** One condition. Plain data, so a filter set is JSON and a preset is a row in a table. */
export const condition = (field, op, args = []) => ({ field, op, args });

/**
 * Can this condition be evaluated on the current feed?
 *
 * A signal condition inherits the requirements of the signal it names, which is what stops a Custom
 * Scanner screen for "RVOL over 5" silently returning everything on a feed with no live volume.
 */
export function conditionAvailability(cond, caps) {
  const field = FIELDS[cond?.field];
  if (!field) return { available: false, reason: 'Unknown field' };
  const requires = field.requiresFor ? field.requiresFor(cond.args?.[0]) : field.requires;
  return signalAvailability({ requires }, caps);
}

/**
 * Evaluate one condition against one engine row.
 *
 * AN UNKNOWN VALUE NEVER MATCHES. Not for `lt`, not for `neq`, not for anything — because a filter is
 * a claim about a symbol, and we cannot make a claim about a number we do not have.
 */
export function matchesCondition(row, cond) {
  const field = FIELDS[cond?.field];
  const op = OPERATORS[cond?.op];
  if (!field || !op) return false;
  const value = field.read(row, cond.args?.[0]);
  if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) return false;
  if (field.type === 'signal' || field.type === 'category' || field.type === 'bool') {
    return op.apply(value === true, ...(cond.args || []).slice(1));
  }
  return op.apply(value, ...(cond.args || []));
}

/**
 * A whole filter set. AND by default, because that is what a trader means by adding a condition.
 *
 * Conditions the feed cannot support are reported, not silently dropped — a screen that quietly
 * ignores half its own criteria is worse than one that refuses to run.
 */
export function evaluateFilterSet(rows, filterSet, caps) {
  const conds = (filterSet?.conditions || []).filter(Boolean);
  const unsupported = [];
  const usable = [];
  for (const c of conds) {
    const a = conditionAvailability(c, caps);
    if (a.available) usable.push(c);
    else unsupported.push({ condition: c, reason: a.reason });
  }
  const matched = (rows || []).filter((row) => usable.every((c) => matchesCondition(row, c)));
  return { rows: matched, unsupported, applied: usable.length };
}

/** A sentence describing a condition, for the chip in the UI and for a saved preset's summary. */
export function describeCondition(cond) {
  const field = FIELDS[cond?.field];
  const op = OPERATORS[cond?.op];
  if (!field || !op) return 'Unknown condition';
  if (field.type === 'signal') return `Has ${SIGNAL_BY_ID.get(cond.args?.[0])?.label || cond.args?.[0]}`;
  if (field.type === 'category') return `Has a ${CATEGORIES[cond.args?.[0]] || cond.args?.[0]} signal`;
  const args = (cond.args || []).join(' and ');
  return `${field.label} ${op.label}${op.arity ? ` ${args}${field.unit === '%' ? '%' : ''}` : ''}`;
}
