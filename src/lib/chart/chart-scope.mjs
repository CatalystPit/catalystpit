// WHOSE CHART STATE THIS IS.
//
// ── ⚠️ THE BUG THIS EXISTS TO CLOSE ─────────────────────────────────────────
//
// Every chart storage key was global to the browser: `cp_chart_drawings`, `cp_chart_indicators`
// and four more, all written straight to localStorage with no idea who was signed in. Sign out of
// one account, sign into another on the same machine, and the second account opened NVDA holding
// the first account's trend lines and indicators. That is one customer's workspace shown to
// another customer, which is a privacy failure and not a cosmetic one.
//
// ── ⚠️ THE IDENTITY IS CLERK'S USER ID AND NOTHING ELSE ─────────────────────
//
// Not the email, not the username, not the display name: all three are mutable, and two of them
// can be re-pointed at a different person. The Clerk user id is immutable for the life of the
// account, so a key written under it can only ever be read back by the same account.
//
// ── ⚠️ AND THERE ARE THREE STATES, NOT TWO ──────────────────────────────────
//
//   a signed-in user  →  their own namespace, keyed by the Clerk id
//   a signed-out visitor →  a separate `anon` namespace. Charts work signed out, and that state
//                        has to go somewhere; what it must never do is share a namespace with a
//                        real account in either direction.
//   NOT YET KNOWN    →  null. Clerk resolves asynchronously, so for the first moments after a load
//                        we genuinely do not know who this is. Reads return defaults and writes are
//                        DROPPED. Guessing here is how the bug comes back: write during the unknown
//                        window and the value lands in whichever namespace we assumed.
//
// ── ⚠️ NO FALLBACK. EVER. ───────────────────────────────────────────────────
//
// If a user has no saved state for a symbol they get the DEFAULT chart. There is deliberately no
// path that reads another namespace — not the legacy global key, not `anon`, not another user's —
// because every such path is the original bug wearing a different hat.

/** Storage keys that existed before any of this was scoped. Never read; swept once, then gone. */
export const LEGACY_KEYS = Object.freeze([
  'cp_chart_drawings',
  'cp_chart_indicators',
  'cp_chart_view',
  'cp_chart_favorites',
  'cp_chart_tool_defaults',
  'cp_chart_evidence',
]);

/** The namespace a signed-out visitor writes to. Never shared with a signed-in account. */
export const ANON_SCOPE = 'anon';

let scope = null;          // null = not yet resolved
let sweptFor = null;       // the scope the legacy sweep has already run for

const isBrowser = () => typeof window !== 'undefined' && !!window.localStorage;

/**
 * Point the chart stores at a user.
 *
 * @param {string|null|undefined} userId  Clerk user id, or null for a resolved signed-out visitor
 * @param {{ resolved?: boolean }} o      resolved:false keeps the scope unknown while Clerk loads
 * @returns {{ scope: string|null, changed: boolean }}
 */
export function setChartScope(userId, { resolved = true } = {}) {
  const next = !resolved ? null : (userId ? `u:${String(userId)}` : ANON_SCOPE);
  const changed = next !== scope;
  scope = next;
  // ⚠️ THE SWEEP RUNS ONCE PER SCOPE AND ONLY AFTER WE KNOW WHO THIS IS, so a page that never
  // resolves an identity does not destroy anything.
  if (scope && sweptFor !== scope) { sweptFor = scope; sweepLegacyKeys(); }
  return { scope, changed };
}

/** The active namespace, or null while Clerk is still resolving. */
export function currentChartScope() { return scope; }

/**
 * The storage key for `base` in the active namespace, or NULL when the scope is unknown.
 *
 * ⚠️ NULL IS A REFUSAL, NOT AN ERROR. Callers treat it as "no storage available": reads fall back
 * to their own defaults and writes do nothing. That is what keeps state out of the wrong account
 * during the window where Clerk has not answered yet.
 */
export function chartScopeKey(base) {
  if (!scope) return null;
  return `${base}:${scope}`;
}

/**
 * ⚠️ LEGACY STATE IS DELETED, NOT ADOPTED.
 *
 * There is already unscoped chart state in real browsers, and nothing in it records who made it.
 * Handing it to the next account that signs in is exactly the bug being fixed — on a shared or
 * handed-down machine it would show one person's workspace to another. Giving it to nobody costs
 * the original owner some drawings once; giving it to the wrong person is a privacy incident. The
 * brief calls this trade explicitly and this is the safe side of it.
 */
export function sweepLegacyKeys() {
  if (!isBrowser()) return 0;
  let removed = 0;
  for (const k of LEGACY_KEYS) {
    try {
      if (window.localStorage.getItem(k) !== null) { window.localStorage.removeItem(k); removed++; }
    } catch { /* private mode — nothing to sweep */ }
  }
  return removed;
}

/** Test seam: forget the resolved scope and the sweep bookkeeping. */
export function __resetChartScope() { scope = null; sweptFor = null; }
