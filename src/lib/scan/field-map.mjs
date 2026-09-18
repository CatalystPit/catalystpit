// ONE VOCABULARY FOR THE LIVE SCANNER.
//
// Before this file there were THREE naming systems for the same quantities and nothing reconciled
// them:
//
//   scanner-fields.mjs  the Finviz-style dropdowns   vel5m   rvol   rsSpy   vwapSide
//   filters.mjs         the filter evaluator         vel_5m  rvol   rsSpread
//   columns.mjs         the table                    vel_5m  rvol   rsSpread
//
// A dropdown named `vel5m` and an evaluator keyed `vel_5m` do not fail loudly — they fail as a
// filter that silently matches nothing, which is the worst outcome available: a trader's saved scan
// quietly stops finding anything and nothing says so.
//
// So every live field resolves HERE, once, to exactly one of four verdicts:
//
//   derived      a value deriveRow() computes        → `path` says where to read it
//   state        a field the normalized state carries → `path` says where to read it
//   signal       satisfied by the signal stack, not a scalar
//   unsupported  the engine has no implementation    → `reason` says so, and the UI must not offer it
//
// "Unsupported" is a first-class answer and is NOT the same as null. Null means the market input is
// unknown right now; unsupported means Catalyst Pit has not built it. Conflating them is how a
// capability system ends up claiming a column works when nobody wired the value.
//
// Pure data plus lookups. No calculation lives here.

import { LIVE_FIELDS } from './scanner-fields.mjs';
import { VELOCITY_WINDOWS } from './velocity.mjs';

export const RESOLUTION = Object.freeze({
  DERIVED: 'derived',
  STATE: 'state',
  SIGNAL: 'signal',
  UNSUPPORTED: 'unsupported',
});

const derived = (path, kind = 'number') => ({ resolution: RESOLUTION.DERIVED, path, kind });
const state = (path, kind = 'number') => ({ resolution: RESOLUTION.STATE, path, kind });
const unsupported = (reason) => ({ resolution: RESOLUTION.UNSUPPORTED, path: null, reason });

/**
 * THE MAP. Every id in LIVE_FIELDS appears exactly once, and a test asserts that.
 *
 * `path` is read against the ROW the engine emits (which carries the derived block merged in), so a
 * reader can follow a dropdown to a value without knowing which module produced it.
 */
export const FIELD_MAP = Object.freeze({
  // ── Momentum. One dropdown per window; the row keys them by the window's own id. ──
  ...Object.fromEntries(VELOCITY_WINDOWS.map((w) => [`vel${w.id}`, derived(`velocity.${w.id}.pct`)])),
  accel5m: derived('accel5m', 'enum'),

  // ── Volume ──
  rvol: derived('rvol'),
  rvolInterval: derived('rvolInterval'),
  volAccel: derived('volAccel'),
  // A spike is a threshold on RVOL rather than its own quantity — expressed as a boolean so the
  // dropdown reads naturally, resolved from the same number so the two can never disagree.
  volSpike: derived('volSpike', 'bool'),
  dollarVolLive: state('dollarVolume'),

  // ── Structure ──
  vwapSide: derived('vwapSide', 'enum'),
  vwapDistance: derived('vwapState.distancePct'),
  prevDayLevel: derived('prevDayLevel', 'enum'),
  sessionExtreme: derived('sessionExtreme', 'enum'),
  openingRange: derived('openingRange', 'enum'),

  // ── Premarket ──
  pmLevel: derived('pmLevel', 'enum'),
  pmHighDistance: derived('pmHighDistance'),
  pmChange: derived('pmChange'),
  pmVolume: derived('pmVolume'),

  // ── Relative strength. Per benchmark, not "the strongest", because the dropdowns name them. ──
  rsSpy: derived('rsSpy'),
  rsQqq: derived('rsQqq'),
  rsSector: derived('rsSector'),

  // ── Volatility ──
  atrPct: derived('atrPct'),
  rangeExpansion: derived('rangeExpansion'),
  // COMPRESSION IS NOT IMPLEMENTED. A compression break needs a squeeze definition (band width
  // against its own history) that the engine does not have, and inventing one here would be exactly
  // the fabrication this work exists to avoid. Declared unsupported so the dropdown is not offered.
  compression: unsupported('The engine has no compression/squeeze calculation yet.'),

  // ── Liquidity ──
  spreadPct: state('spreadPct'),

  // ── Catalyst. Read from Catalyst Pit's own enrichment, not from the market feed. ──
  newsAge: state('context.news.ageMinutes'),
  hasInsiderBuy: state('context.insider.recentBuy', 'bool'),
  hasCongress: state('context.congress.recent', 'bool'),
  earningsProximity: state('context.earnings.daysAway', 'enum'),
});

/** Read a dotted path off a row, returning undefined when any hop is missing. */
export function readPath(row, path) {
  if (!row || !path) return undefined;
  let cur = row;
  for (const key of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/** How a live field resolves, or a stated "unknown field" rather than a silent undefined. */
export function resolveField(id) {
  return FIELD_MAP[id] || { resolution: RESOLUTION.UNSUPPORTED, path: null, reason: `No mapping for "${id}".` };
}

/**
 * Read a live field's value off an engine row.
 *
 * Returns `undefined` ONLY for an unsupported field. A supported field with no data returns null,
 * because those are different facts and the filter layer treats them differently.
 */
export function readField(row, id) {
  const m = resolveField(id);
  if (m.resolution === RESOLUTION.UNSUPPORTED || m.resolution === RESOLUTION.SIGNAL) return undefined;
  const v = readPath(row, m.path);
  return v === undefined ? null : v;
}

export const isSupported = (id) => resolveField(id).resolution !== RESOLUTION.UNSUPPORTED;

/** Live field ids the engine can actually serve — what the UI may offer. */
export const SUPPORTED_FIELD_IDS = Object.keys(LIVE_FIELDS).filter(isSupported);
export const UNSUPPORTED_FIELD_IDS = Object.keys(LIVE_FIELDS).filter((id) => !isSupported(id));

/**
 * Every live field with its resolution attached — the audit the previous readiness report asked for.
 *
 * A field that is capability-available but engine-unsupported is the exact contradiction this
 * function exists to surface: the UI would offer it and nothing would answer.
 */
export function fieldVocabulary(caps, availabilityFn) {
  return Object.entries(LIVE_FIELDS).map(([id, def]) => {
    const m = resolveField(id);
    const a = availabilityFn({ requires: def.requires }, caps);
    return {
      id,
      label: def.label,
      category: def.category,
      resolution: m.resolution,
      path: m.path,
      capabilityAvailable: a.available,
      capabilityReason: a.available ? null : a.reason,
      // The only combination that must never ship: the feed can serve it and the engine cannot.
      offerable: a.available && m.resolution !== RESOLUTION.UNSUPPORTED,
      unsupportedReason: m.reason || null,
    };
  });
}

/**
 * The bridge between the three id styles, so a saved layout or a saved scan written against any of
 * them keeps working. Column and filter ids use `vel_5m`; dropdowns use `vel5m`.
 */
export const COLUMN_ID_FOR = Object.freeze({
  ...Object.fromEntries(VELOCITY_WINDOWS.map((w) => [`vel${w.id}`, `vel_${w.id}`])),
  rvol: 'rvol',
  dollarVolLive: 'dollarVolume',
  spreadPct: 'spreadPct',
});
export const FIELD_ID_FOR_COLUMN = Object.freeze(
  Object.fromEntries(Object.entries(COLUMN_ID_FOR).map(([field, col]) => [col, field])),
);
