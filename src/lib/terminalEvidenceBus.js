// "INSPECT THIS TICKER'S EVIDENCE" — one channel, window-anchored.
//
// ── ⚠️ WHY THIS IS NOT THE SYMBOL BUS ───────────────────────────────────────
//
// selectTerminalSymbol already exists and already reaches every panel, so the cheap move would be
// to reuse it. It would be wrong. That bus means "the workspace is now looking at NVDA" — the chart
// follows it, and every symbol-aware panel is expected to. Asking to inspect a ticker's evidence is
// a different intent: it opens ONE panel and must not drag the chart off whatever the trader was
// studying. Overloading one channel with two intents is how clicking Evidence on a scan row ends up
// silently changing the chart underneath it.
//
// ── ⚠️ AND WHY IT IS ANCHORED TO window ─────────────────────────────────────
//
// Same reason as the symbol bus: a module-local Set duplicates across Next route and layout bundles,
// so the subscriber in the Terminal workspace and the emitter inside a panel would end up holding
// two different Sets and the event would go nowhere.

function bus() {
  if (typeof window === 'undefined') return null;
  if (!window.__cpEvidenceBus) window.__cpEvidenceBus = { subs: new Set(), last: null };
  return window.__cpEvidenceBus;
}

/** Ask the Terminal to inspect a ticker's evidence. A no-op anywhere there is no Terminal. */
export function inspectEvidence(sym) {
  const b = bus();
  if (!b || !sym) return;
  const s = String(sym).toUpperCase().trim();
  if (!s) return;
  b.last = s;
  b.subs.forEach((fn) => { try { fn(s); } catch { /* one bad subscriber must not stop the rest */ } });
}

/** Subscribe. Returns the unsubscribe, as the symbol bus does. */
export function onEvidenceRequest(fn) {
  const b = bus();
  if (!b) return () => {};
  b.subs.add(fn);
  return () => b.subs.delete(fn);
}

/**
 * Whether anything is listening.
 *
 * ⚠️ THIS IS WHAT KEEPS /scan WORKING. The same Pit Scan row renders on the Terminal and on the
 * public /scan page, and on /scan there is no workspace to open a panel in — so Evidence there must
 * stay the link it always was. The row asks whether an inspector exists rather than being told by
 * each of its two callers, which is one fewer thing for a third caller to get wrong.
 */
export function evidenceInspectorAvailable() {
  const b = bus();
  return !!b && b.subs.size > 0;
}
