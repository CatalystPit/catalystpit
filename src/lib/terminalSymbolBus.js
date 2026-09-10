// Centralized Terminal symbol selection. Window-anchored so a single instance is shared across Next
// chunks (same fix as pitDockBus — a module-local Set would duplicate across route/layout bundles).
// Any panel or ticker tape calls selectTerminalSymbol(); the Terminal workspace subscribes via
// onTerminalSymbol() to drive the chart + future symbol-aware panels. Clicking a ticker ANYWHERE in
// the Terminal sets the active symbol instead of navigating away.

function bus() {
  if (typeof window === 'undefined') return null;
  if (!window.__cpSymBus) window.__cpSymBus = { subs: new Set(), last: null };
  return window.__cpSymBus;
}

export function selectTerminalSymbol(sym) {
  const b = bus(); if (!b || !sym) return;
  const s = String(sym).toUpperCase().trim();
  if (!s) return;
  b.last = s;
  b.subs.forEach((fn) => { try { fn(s); } catch { /* ignore */ } });
}

export function onTerminalSymbol(fn) {
  const b = bus(); if (!b) return () => {};
  b.subs.add(fn);
  return () => b.subs.delete(fn);
}

// True when the current route is the Terminal — lets globally-mounted tapes (top ticker tape) choose
// to set the Terminal symbol instead of navigating, without affecting their behavior elsewhere.
export function onTerminalRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/terminal');
}
