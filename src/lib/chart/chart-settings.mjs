import { CHART_TYPE_IDS } from './chart-types.mjs';
// Saved chart settings.
//
// Uses the storage the product already uses for per-user chart-shaped state: localStorage under a
// `cp_` key, the same as the Terminal's layout (`cp_terminal_layout`). There is no server-side chart
// preferences store in this codebase, and a chart layout is inherently per-device anyway.
//
// The read path is DEFENSIVE by design. Anything here can be hand-edited, written by an older
// version, or corrupted, and none of that may break the chart. Every read falls back to the default,
// and a bad entry is dropped rather than repaired into something that looks deliberate.

import {
  INDICATORS, sanitizeParams, defaultParams, isMultiInstance,
  MAX_INSTANCES_PER_INDICATOR, nextInstanceKey,
} from './chart-indicators.mjs';

const KEY = 'cp_chart_indicators';

/**
 * VERSION 2 — instances.
 *
 * v1 stored one entry per indicator id, which could not express a 9/21/50/200 EMA ribbon. v2 stores
 * a list of INSTANCES, each with its own key, params, colour and visibility. A v1 payload is
 * migrated rather than discarded: somebody's saved moving average should survive the upgrade.
 */
const VERSION = 2;

/** What a chart shows before the user has chosen anything. */
export const DEFAULT_ACTIVE = [{ key: 'volume-1', id: 'volume', params: {}, color: null, visible: true }];

const isBrowser = () => typeof window !== 'undefined' && !!window.localStorage;
const MAX_TOTAL = 16;

/**
 * Validate one stored instance against the live registry.
 *
 * An indicator that no longer exists — renamed, removed — must not resurrect as a broken row, and
 * params written by an older version are re-clamped against today's declared ranges.
 */
function coerceInstance(raw, existing) {
  const id = typeof raw?.id === 'string' ? raw.id : null;
  if (!id || !INDICATORS[id]) return null;
  const colour = Number(raw?.color);
  return {
    key: typeof raw?.key === 'string' && raw.key ? raw.key : nextInstanceKey(id, existing),
    id,
    params: sanitizeParams(id, { ...defaultParams(id), ...(raw?.params || {}) }),
    // null means "use the registry's colour for this indicator". A stored colour is an INDEX into
    // the themed palette, never a hex value — see chart-theme.mjs for why.
    color: Number.isFinite(colour) ? Math.max(0, Math.round(colour)) : null,
    // Absent means visible: a setting saved before visibility existed should not hide a line.
    visible: raw?.visible !== false,
  };
}

/** A v1 payload is a list of { id, params } with no keys. */
function migrateV1(items) {
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const inst = coerceInstance({ ...raw, key: null, color: null, visible: true }, out);
    if (inst && !out.some((e) => e.id === inst.id)) out.push(inst);
  }
  return out;
}

/** Enforce the rules that make a set drawable: no duplicate keys, and the per-indicator ceiling. */
function enforce(list) {
  const seenKeys = new Set();
  const perId = new Map();
  const out = [];
  for (const inst of list) {
    if (!inst || seenKeys.has(inst.key)) continue;
    const n = perId.get(inst.id) || 0;
    // A single-instance indicator keeps exactly one; a multi-instance one is capped.
    const cap = isMultiInstance(inst.id) ? MAX_INSTANCES_PER_INDICATOR : 1;
    if (n >= cap) continue;
    perId.set(inst.id, n + 1);
    seenKeys.add(inst.key);
    out.push(inst);
    if (out.length >= MAX_TOTAL) break;
  }
  return out;
}

/** Load the saved set, or the default. Never throws, never returns junk. */
export function loadIndicators() {
  if (!isBrowser()) return DEFAULT_ACTIVE.map((e) => ({ ...e }));
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (!parsed) return DEFAULT_ACTIVE.map((e) => ({ ...e }));
    if (parsed.v === 1) return enforce(migrateV1(parsed.items));
    if (parsed.v !== VERSION || !Array.isArray(parsed.items)) return DEFAULT_ACTIVE.map((e) => ({ ...e }));
    const out = [];
    for (const raw of parsed.items) {
      const inst = coerceInstance(raw, out);
      if (inst) out.push(inst);
    }
    return enforce(out);
  } catch {
    return DEFAULT_ACTIVE.map((e) => ({ ...e }));
  }
}

/** Persist the active set. A storage failure (private mode, quota) is not the chart's problem. */
export function saveIndicators(items) {
  if (!isBrowser()) return;
  try {
    const clean = enforce((Array.isArray(items) ? items : [])
      .map((raw, i, arr) => coerceInstance(raw, arr.slice(0, i)))
      .filter(Boolean));
    window.localStorage.setItem(KEY, JSON.stringify({ v: VERSION, items: clean }));
  } catch { /* ignore */ }
}

// ── view options ─────────────────────────────────────────────────────────────
// Chart-level state that is not an indicator: how price is scaled, which series shape is drawn,
// whether extended hours are requested. Persisted for the same reason the indicators are — a trader
// who works on a log scale expects it to still be a log scale tomorrow.
//
// Kept in its own key rather than merged into the indicator payload so that a corrupt indicator list
// cannot cost the user their view preferences, and so each can version independently.

const VIEW_KEY = 'cp_chart_view';
const VIEW_VERSION = 1;

export const DEFAULT_VIEW = {
  chartType: 'Candles',     // any id in the chart-type registry
  logScale: false,
  autoScale: true,
  extended: false,
  showDrawings: true,
  // A flipped price scale. Off by default: it is a deliberate choice, never a default view.
  invertScale: false,
  // Magnet is off by default, as it is on every platform that has one: it changes where an anchor
  // lands, and a user who has not asked for that should not meet it.
  magnet: false,
  // The indicator band of the legend, folded away. Expanded by default: a reader who has not asked
  // for a collapsed legend should be able to see what is plotted on their chart.
  legendCollapsed: false,
};

export function loadView() {
  if (!isBrowser()) return { ...DEFAULT_VIEW };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VIEW_KEY) || 'null');
    if (!parsed || parsed.v !== VIEW_VERSION) return { ...DEFAULT_VIEW };
    const v = parsed.view || {};
    return {
      // VALIDATED AGAINST THE REGISTRY, not against a hard-coded pair of ids. The previous version
      // tested for one id and fell back to the other, which silently threw Area away — choose Area,
      // reload, and the chart came back as candles. Anything the registry does not know still falls
      // back to the default rather than being trusted.
      chartType: CHART_TYPE_IDS.includes(v.chartType) ? v.chartType : DEFAULT_VIEW.chartType,
      logScale: v.logScale === true,
      // Auto-scale defaults ON: a chart that opens without it looks broken until the user finds the
      // control, and absent means "not chosen" rather than "off".
      autoScale: v.autoScale !== false,
      extended: v.extended === true,
      showDrawings: v.showDrawings !== false,
      magnet: v.magnet === true,
      invertScale: v.invertScale === true,
      // Absent means "never chosen", which is expanded — the same rule the other opt-in flags use.
      // A saved view from before this existed therefore opens expanded rather than mysteriously
      // hiding the reader's indicators.
      legendCollapsed: v.legendCollapsed === true,
    };
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

export function saveView(view) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify({ v: VIEW_VERSION, view: { ...DEFAULT_VIEW, ...view } }));
  } catch { /* ignore */ }
}

export const STORAGE_KEY = KEY;
export const STORAGE_VERSION = VERSION;
export const VIEW_STORAGE_KEY = VIEW_KEY;
export { coerceInstance as __coerceInstance, enforce as __enforce };

// ── favourite indicators ─────────────────────────────────────────────────────
// A LIST OF IDS, nothing more. Favourites are a shortcut into the catalogue, not a second copy of
// it — so what is stored is which registry entries are starred, and an id the registry no longer
// knows is dropped on read rather than kept as a row that cannot be added.

export const FAVORITES_KEY = 'cp_chart_favorites';

export function loadFavorites() {
  if (!isBrowser()) return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || 'null');
    if (!Array.isArray(raw)) return [];
    return raw.filter((id) => typeof id === 'string');
  } catch {
    return [];
  }
}

export function saveFavorites(ids) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify((ids || []).filter((x) => typeof x === 'string')));
  } catch { /* ignore */ }
}

// ── per-tool last-used settings ───────────────────────────────────────────────
// WHAT A TOOL REMEMBERS, not a template system.
//
// Drawing a second trend line should not mean setting the colour, the width and the extensions
// again — so each TOOL remembers the settings it was last used with, and the next drawing of that
// type starts there. Keyed by tool id, so changing a Fibonacci's levels never changes what a
// rectangle looks like.
//
// Only fields a tool actually reads are kept. Anything else would round-trip through storage
// forever and become a place for junk to accumulate.

export const TOOL_DEFAULTS_KEY = 'cp_chart_tool_defaults';
const REMEMBERED = ['style', 'extendLeft', 'extendRight', 'levels', 'fill'];

export function loadToolDefaults() {
  if (!isBrowser()) return {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(TOOL_DEFAULTS_KEY) || 'null');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [toolId, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      const kept = {};
      for (const k of REMEMBERED) if (v[k] !== undefined) kept[k] = v[k];
      if (Object.keys(kept).length) out[toolId] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveToolDefaults(map) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(TOOL_DEFAULTS_KEY, JSON.stringify(map || {}));
  } catch { /* ignore */ }
}

/** Fold one drawing's current settings back in as its tool's defaults. */
export function rememberToolDefaults(map, drawing) {
  if (!drawing?.type) return map || {};
  const kept = {};
  for (const k of REMEMBERED) if (drawing[k] !== undefined) kept[k] = drawing[k];
  if (!Object.keys(kept).length) return map || {};
  return { ...(map || {}), [drawing.type]: kept };
}
