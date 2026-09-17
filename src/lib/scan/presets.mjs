// SCANNER PRESETS.
//
// A preset is a named filter set plus a column layout. Nothing more — no privileged code path, no
// hidden conditions. Catalyst Pit's own presets are written in exactly the vocabulary a user's saved
// screen is written in, which is the test of whether the filter model is actually general: if our
// curated screens needed something the user cannot express, the model would be wrong.
//
// Each preset states the capability it needs, derived from its conditions, so the panel can show a
// preset as unavailable with a reason rather than running it and returning nothing.

import { condition, conditionAvailability, FIELDS } from './filters.mjs';
import { DEFAULT_COLUMNS } from './columns.mjs';

const c = condition;

/**
 * The built-in screens.
 *
 * Chosen to cover the distinct questions a trader asks at different points of the day, not to fill a
 * menu. Each one is a claim we are willing to defend; none of them is tuned against a sample.
 */
export const PRESETS = [
  {
    id: 'premarket_momentum',
    label: 'Premarket momentum',
    description: 'Gapping, moving, and taking out the overnight range',
    session: 'premarket',
    conditions: [
      c('signalCategory', 'isTrue', ['premarket']),
      c('gapPct', 'gte', [2]),
    ],
    columns: ['symbol', 'price', 'gapPct', 'changePct', 'vel_5m', 'signals', 'context'],
  },
  {
    id: 'fresh_breakouts',
    label: 'Fresh breakouts',
    description: 'Through a level that matters, and holding above it',
    conditions: [c('signalCategory', 'isTrue', ['breakout'])],
    columns: ['symbol', 'price', 'changePct', 'vel_5m', 'signals', 'context'],
  },
  {
    id: 'opening_drive',
    label: 'Opening drive',
    description: 'Out of the opening range with momentum behind it',
    session: 'regular',
    conditions: [
      c('hasSignal', 'isTrue', ['opening_range_break_5m']),
      c('vel_5m', 'gte', [1]),
    ],
    columns: ['symbol', 'price', 'changePct', 'vel_1m', 'vel_5m', 'signals'],
  },
  {
    id: 'relative_strength',
    label: 'Relative strength',
    description: 'Separating from the market, in either direction',
    conditions: [c('hasSignal', 'isTrue', ['relative_strength'])],
    columns: ['symbol', 'price', 'changePct', 'rsSpread', 'vel_5m', 'signals'],
  },
  {
    id: 'volume_ignition',
    label: 'Volume ignition',
    description: 'Volume arriving well ahead of its normal pace',
    conditions: [
      c('signalCategory', 'isTrue', ['volume']),
      c('rvol', 'gte', [3]),
    ],
    columns: ['symbol', 'price', 'changePct', 'rvol', 'dollarVolume', 'signals'],
  },
  {
    id: 'news_movers',
    label: 'News movers',
    description: 'Moving with a Catalyst Pit catalyst behind it',
    conditions: [
      c('newsAgeMinutes', 'lte', [60]),
      c('signalCount', 'gte', [1]),
    ],
    columns: ['symbol', 'price', 'changePct', 'vel_5m', 'signals', 'context'],
  },
  {
    id: 'liquid_movers',
    label: 'Liquid movers',
    description: 'Only names large enough to trade size in',
    conditions: [
      c('dollarVolume', 'gte', [5_000_000]),
      c('price', 'gte', [2]),
      c('signalCount', 'gte', [2]),
    ],
    columns: ['symbol', 'price', 'changePct', 'dollarVolume', 'marketCap', 'signals'],
  },
  {
    id: 'small_cap_momentum',
    label: 'Small-cap momentum',
    description: 'Low float, moving fast, with volume behind it',
    conditions: [
      c('marketCap', 'lte', [2_000_000_000]),
      c('vel_5m', 'gte', [3]),
    ],
    columns: ['symbol', 'price', 'changePct', 'vel_5m', 'float', 'rvol', 'signals'],
  },
];

export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

/** A preset's availability is the availability of its least-supported condition. */
export function presetAvailability(preset, caps) {
  const blocked = [];
  for (const cond of preset?.conditions || []) {
    const a = conditionAvailability(cond, caps);
    if (!a.available) blocked.push({ field: cond.field, reason: a.reason });
  }
  return {
    available: blocked.length === 0,
    blocked,
    reason: blocked.length ? blocked[0].reason : null,
  };
}

/** Every preset, tagged with whether it can run right now — the panel shows both. */
export function presetsWithAvailability(caps) {
  return PRESETS.map((p) => ({ ...p, ...presetAvailability(p, caps) }));
}

/**
 * A user's saved screen, normalised.
 *
 * Validated against the SAME field registry the built-ins use, so a saved preset cannot contain a
 * condition the engine does not understand — a stored screen that silently stops filtering is the
 * failure mode this guards against.
 */
export function normalizeUserPreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = String(raw.label || '').trim().slice(0, 60);
  if (!label) return null;
  const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
    .filter((x) => x && FIELDS[x.field] && Array.isArray(x.args))
    .slice(0, 20)
    .map((x) => ({ field: x.field, op: x.op, args: x.args }));
  const columns = (Array.isArray(raw.columns) ? raw.columns : DEFAULT_COLUMNS).slice(0, 24);
  return { id: raw.id || `user:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label, conditions, columns, user: true };
}
