// "SHOW ME THIS TICKER'S NEWS" — one channel, window-anchored.
//
// ── ⚠️ THIS WAS ONE OF TWO; IT IS NOW THE ONLY ONE ──────────────────────────
//
// terminalEvidenceBus was its twin — the same forty lines, carrying a ticker to the Terminal's
// Evidence panel. That panel was removed for duplicating Pit Consensus, which left the bus with no
// listener and no publisher, so it was deleted rather than left as a channel nobody is on.
// The argument for keeping two copies of this shape went with it.
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
