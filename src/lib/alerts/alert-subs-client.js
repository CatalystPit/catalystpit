// THE SUBSCRIBED-TICKER SET, FETCHED ONCE PER PAGE AND SHARED BY EVERY CONTROL ON IT.
//
// ⚠️ THE FAILURE THIS EXISTS TO PREVENT. Pit Scan renders a hundred rows, each with an Alert
// control that needs to know whether it is already on. A control that asked for its own state
// would be a hundred requests on every board render, and the brief forbids exactly that. One
// module-level promise answers all of them, and a toggle updates the set in place so the other
// ninety-nine controls re-render from memory rather than re-fetching.
//
// Deliberately not React context: the controls live in three unrelated trees (Pit Scan, the
// Terminal watchlist, the ticker page) that share no provider, and wiring one through all three
// would be the refactor the brief tells me not to do.

let cache = null;              // Promise<{ pro, tickers:Set }> — the in-flight or settled fetch
const listeners = new Set();

function emit() { for (const fn of listeners) { try { fn(); } catch { /* a bad listener is not a bug here */ } } }

async function fetchSubs() {
  try {
    const r = await fetch('/api/evidence-alerts', { cache: 'no-store' });
    if (!r.ok) return { pro: false, tickers: new Set() };
    const j = await r.json();
    return { pro: !!j.pro, tickers: new Set(j.tickers || []) };
  } catch {
    // ⚠️ A FAILED LOAD READS AS "NOT SUBSCRIBED", NEVER AS SUBSCRIBED. Showing "Alert On" for a
    // subscription we could not confirm would tell someone they are covered when they may not be.
    return { pro: false, tickers: new Set() };
  }
}

export function loadAlertSubs() {
  if (!cache) cache = fetchSubs();
  return cache;
}

/** Re-read from the server — after a sign-in, or when a surface wants to be sure. */
export function refreshAlertSubs() {
  cache = fetchSubs();
  cache.then(emit, emit);
  return cache;
}

export function onAlertSubsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Toggle one ticker. Returns the new enabled state, or throws with a reason the caller can show.
 *
 * ⚠️ THE SERVER'S ANSWER IS WHAT LANDS IN THE SET, not the state we optimistically assumed. A
 * refusal — not Pro, over the limit — must leave the control showing the truth.
 */
export async function toggleAlert(ticker) {
  const sym = String(ticker || '').trim().toUpperCase();
  const r = await fetch('/api/evidence-alerts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker: sym }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error === 'pro_required' ? 'Evidence Alerts are a Pit Pro feature'
      : j?.error === 'unauthorized' ? 'Sign in to set alerts'
        : (j?.error || 'Could not set alert'));
    err.code = j?.error;
    throw err;
  }
  const current = await loadAlertSubs();
  const next = { pro: current.pro, tickers: new Set(j.tickers || []) };
  cache = Promise.resolve(next);
  emit();
  return !!j.enabled;
}
