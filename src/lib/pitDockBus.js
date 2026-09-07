// Signal so any component (e.g. the homepage "Join The Pit" widget) can open the PitDock.
// The subscriber Set is anchored on `window` (not a module-local variable) so it stays a SINGLE
// shared instance even if this module is duplicated across Next.js route/layout chunks.
function bus() {
  if (typeof window === 'undefined') return null;
  if (!window.__cpPitBus) window.__cpPitBus = new Set();
  return window.__cpPitBus;
}

export function openPitDock() {
  const b = bus();
  if (b) b.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

export function onOpenPitDock(fn) {
  const b = bus();
  if (!b) return () => {};
  b.add(fn);
  return () => b.delete(fn);
}
