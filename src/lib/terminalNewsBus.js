// "SHOW ME THIS TICKER'S NEWS" — one channel, window-anchored.
//
// ── ⚠️ A SIBLING OF terminalEvidenceBus, DELIBERATELY DUPLICATED ────────────
//
// The two are the same forty lines and it is tempting to factor them into one bus factory. Not in
// this change. The evidence channel is live, covered by its own suite, and the only thing standing
// between a scan row and a working inspector; rewriting it to prove a point about duplication is a
// change to working code in a task that is about adding a second inspector. If a third arrives,
// that is the moment to extract the shape — with three examples in front of us rather than two and
// a guess about what the third will need.
//
// ── ⚠️ AND IT IS ITS OWN CHANNEL, NOT THE EVIDENCE ONE ──────────────────────
//
// "Inspect the evidence for MSTR" and "show me MSTR's news" are different requests opening
// different panels. One channel carrying both would mean clicking a NEWS badge also re-points the
// evidence inspector at whatever was last asked about — a panel changing underneath a trader for a
// reason they cannot see.

function bus() {
  if (typeof window === 'undefined') return null;
  if (!window.__cpNewsBus) window.__cpNewsBus = { subs: new Set(), last: null };
  return window.__cpNewsBus;
}

/** Ask the Terminal to show a ticker's news. A no-op anywhere there is no Terminal. */
export function inspectNews(sym) {
  const b = bus();
  if (!b || !sym) return;
  const s = String(sym).toUpperCase().trim();
  if (!s) return;
  b.last = s;
  b.subs.forEach((fn) => { try { fn(s); } catch { /* one bad subscriber must not stop the rest */ } });
}

/** Subscribe. Returns the unsubscribe. */
export function onNewsRequest(fn) {
  const b = bus();
  if (!b) return () => {};
  b.subs.add(fn);
  return () => b.subs.delete(fn);
}

/**
 * Whether anything is listening.
 *
 * ⚠️ THE BADGE ASKS RATHER THAN BEING TOLD. The Watchlist renders inside the Terminal today, but a
 * component that assumes where it is rendered breaks the first time it is rendered somewhere else.
 * With no inspector listening the badge stays exactly what it is now: a label.
 */
export function newsInspectorAvailable() {
  const b = bus();
  return !!b && b.subs.size > 0;
}
