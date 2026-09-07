// Tiny in-app signal so any component (e.g. the homepage "Join The Pit" widget) can open the
// PitDock reliably — a module singleton shared across the client bundle (more robust than a
// window event). PitDock subscribes; callers invoke openPitDock().
const listeners = new Set();

export function openPitDock() {
  listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

export function onOpenPitDock(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
