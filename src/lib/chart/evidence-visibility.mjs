// EVIDENCE VISIBILITY — which marker families the chart draws. PURE + localStorage.
//
// DISPLAY STATE ONLY. Nothing here touches what evidence IS: no fetch, no placement, no materiality,
// no grouping, no reaction. It decides which of the already-loaded canonical objects are handed to
// the marker builder, and nothing else. Toggling a family must never cause a request — the evidence
// for the symbol is already in memory and a visibility change is a filter over it.
//
// ── A REGISTRY, SO THE NEXT FAMILY IS ONE ENTRY ─────────────────────────────
//
// Earnings, analyst changes and other catalysts are coming. Adding one is an entry in FAMILIES plus
// the engine emitting that `family` — the menu, the persistence, the migration and the filter all
// follow from the registry. No component learns a new family name.
//
// ── AN UNREGISTERED FAMILY IS VISIBLE, NOT HIDDEN ───────────────────────────
//
// If the engine ever emits a family this build does not know about, it DRAWS. The alternative — hide
// what we do not recognise — means a newly shipped evidence family is silently invisible to everyone
// running an older tab, with no menu row to discover it by. Failing visible is the safer direction
// for a display filter, and it is the opposite of the fail-closed rule that governs the data itself.

/**
 * The families offered in the menu, in display order.
 *
 * `label` is the trader's word for it, not the engine's. `id` matches the canonical evidence
 * object's `family`.
 */
export const EVIDENCE_FAMILIES = Object.freeze([
  Object.freeze({ id: 'catalyst', label: 'SEC 8-K events', short: '8-K' }),
  Object.freeze({ id: 'insider', label: 'Insider trades / Form 4', short: 'Form 4' }),
  Object.freeze({ id: 'institution', label: 'Institutional activity / 13F', short: '13F' }),
  Object.freeze({ id: 'congress', label: 'Congress trades', short: 'Congress' }),
]);

export const FAMILY_IDS = Object.freeze(EVIDENCE_FAMILIES.map((f) => f.id));

const KEY = 'cp_chart_evidence';
const VERSION = 1;
const isBrowser = () => typeof window !== 'undefined' && !!window.localStorage;

/** Everything on. What a chart shows before the user has chosen anything. */
export function defaultVisibility() {
  const families = {};
  for (const f of FAMILY_IDS) families[f] = true;
  return { enabled: true, families };
}

/**
 * Should this evidence item be drawn?
 *
 * The master switch wins. Below it, a family is hidden only when explicitly set false — an absent
 * key means visible, which is what makes a newly added family appear rather than vanish.
 */
export function isVisible(vis, ev) {
  if (!vis?.enabled) return false;
  const fam = ev?.family;
  if (!fam) return true;
  return vis.families?.[fam] !== false;
}

/** The filter the chart applies. Returns the same array when nothing is hidden, so React sees no churn. */
export function filterEvidence(list, vis) {
  const src = Array.isArray(list) ? list : [];
  if (!vis || (vis.enabled && FAMILY_IDS.every((f) => vis.families?.[f] !== false))) return src;
  if (!vis.enabled) return [];
  return src.filter((ev) => isVisible(vis, ev));
}

/** How many of the registry's families are currently on. Drives the button's count slot. */
export function visibleFamilyCount(vis) {
  if (!vis?.enabled) return 0;
  return FAMILY_IDS.filter((f) => vis.families?.[f] !== false).length;
}

export const allFamiliesOn = (vis) => visibleFamilyCount(vis) === FAMILY_IDS.length && !!vis?.enabled;

// ── mutations, all pure ──────────────────────────────────────────────────────

/**
 * Toggle one family.
 *
 * Turning a family ON while the master is off turns the master on too — otherwise the click appears
 * to do nothing, which reads as a broken control. Turning the LAST family off leaves the master on
 * and every family off, which renders an empty chart and is recoverable from the same menu.
 */
export function toggleFamily(vis, id) {
  const base = vis || defaultVisibility();
  // Flip the EFFECTIVE state — what the menu row actually shows — not the raw map entry. With the
  // master off every family still reads `true` underneath, so toggling the raw entry turned a
  // visibly-off row further off and the click appeared to do nothing.
  const effectivelyOn = isVisible(base, { family: id });

  if (effectivelyOn) {
    return { enabled: base.enabled, families: { ...base.families, [id]: false } };
  }
  // Turning one family on while the master is off means "show me this one", not "show everything".
  // Re-enabling the master without narrowing would resurrect families the user never asked for.
  if (!base.enabled) {
    const families = {};
    for (const f of FAMILY_IDS) families[f] = f === id;
    return { enabled: true, families };
  }
  return { enabled: true, families: { ...base.families, [id]: true } };
}

/** The master switch. Turning it back on restores every family, which is what "All evidence" means. */
export function toggleAll(vis) {
  const base = vis || defaultVisibility();
  if (base.enabled && FAMILY_IDS.some((f) => base.families?.[f] === false)) {
    // Some families are off: "All evidence" turns everything back ON rather than off. A master that
    // switched off from a partially-on state would destroy the user's selection on a mis-click.
    return defaultVisibility();
  }
  if (base.enabled) return { enabled: false, families: { ...base.families } };
  return { enabled: true, families: { ...base.families } };
}

// ── persistence ──────────────────────────────────────────────────────────────
//
// Same storage the rest of the chart's per-user state uses: localStorage under a `cp_` key. The read
// path is defensive for the same reason chart-settings.mjs is — a stored payload can be hand-edited,
// written by an older build, or corrupt, and none of that may break the chart.

export function loadVisibility() {
  if (!isBrowser()) return defaultVisibility();
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return defaultVisibility();
    const out = defaultVisibility();
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    const fams = raw.families;
    if (fams && typeof fams === 'object') {
      // Only ids this build knows are honoured. A family that was removed must not linger as a
      // hidden filter nobody can see or clear.
      for (const id of FAMILY_IDS) if (typeof fams[id] === 'boolean') out.families[id] = fams[id];
    }
    return out;
  } catch {
    return defaultVisibility();
  }
}

export function saveVisibility(vis) {
  if (!isBrowser() || !vis) return;
  try {
    const families = {};
    for (const id of FAMILY_IDS) families[id] = vis.families?.[id] !== false;
    window.localStorage.setItem(KEY, JSON.stringify({ v: VERSION, enabled: !!vis.enabled, families }));
  } catch { /* quota, private mode, disabled storage — a lost preference is not a broken chart */ }
}

export const __KEY = KEY;
