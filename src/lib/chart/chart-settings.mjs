// Saved chart settings.
//
// Uses the storage the product already uses for per-user chart-shaped state: localStorage under a
// `cp_` key, the same as the Terminal's layout (`cp_terminal_layout`) and panel visibility. There is
// no server-side chart preferences store in this codebase, so inventing one here would mean adding a
// table, a route and an auth path for a setting that is inherently per-device — which is where a
// chart layout belongs anyway.
//
// The read path is DEFENSIVE by design. Anything here can be edited by hand, written by an older
// version of the app, or corrupted; none of that may break the chart. Every read falls back to the
// default, and a bad entry is dropped rather than repaired into something that looks deliberate.

import { INDICATORS, sanitizeParams, defaultParams } from './chart-indicators.mjs';

const KEY = 'cp_chart_indicators';
/** Bumped when the stored shape changes, so an old payload is ignored instead of misread. */
const VERSION = 1;

/** What a chart shows before the user has chosen anything. */
export const DEFAULT_ACTIVE = [{ id: 'volume', params: {} }];

const isBrowser = () => typeof window !== 'undefined' && !!window.localStorage;

/**
 * Validate one stored entry against the live registry.
 *
 * An indicator that no longer exists — renamed, removed — must not resurrect as a broken row, and a
 * params object from an older version is re-clamped against today's declared ranges.
 */
function coerceEntry(raw) {
  const id = typeof raw?.id === 'string' ? raw.id : null;
  if (!id || !INDICATORS[id]) return null;
  return { id, params: sanitizeParams(id, { ...defaultParams(id), ...(raw.params || {}) }) };
}

/** Load the saved indicator set, or the default. Never throws, never returns junk. */
export function loadIndicators() {
  if (!isBrowser()) return DEFAULT_ACTIVE.map((e) => ({ ...e }));
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.items)) return DEFAULT_ACTIVE.map((e) => ({ ...e }));
    const seen = new Set();
    const out = [];
    for (const raw of parsed.items) {
      const e = coerceEntry(raw);
      // One instance per indicator: the menu is a set of toggles, and two SMAs with the same
      // settings would draw the same line twice. Multiple instances are a later feature with its own
      // identity scheme, not something a duplicated stored row should turn on by accident.
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  } catch {
    return DEFAULT_ACTIVE.map((e) => ({ ...e }));
  }
}

/** Persist the active set. A storage failure (private mode, quota) is not the chart's problem. */
export function saveIndicators(items) {
  if (!isBrowser()) return;
  try {
    const clean = (Array.isArray(items) ? items : [])
      .map(coerceEntry)
      .filter(Boolean)
      .slice(0, 12);      // a bound, so a runaway loop cannot fill the user's storage
    window.localStorage.setItem(KEY, JSON.stringify({ v: VERSION, items: clean }));
  } catch { /* ignore */ }
}

export const STORAGE_KEY = KEY;
export const STORAGE_VERSION = VERSION;
