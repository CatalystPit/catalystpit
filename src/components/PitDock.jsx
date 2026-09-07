'use client';

// PitDock — "The Pit" live chat as a global, collapsible dock on the RIGHT edge, mirroring the
// left Tape dock. Rendered once in the root layout, so it's on every page and (since the layout
// doesn't remount on navigation) the chat + its Ably connection persist as the user clicks around.
//
// Default OPEN for everyone on desktop (grab attention; collapse is their choice) — persisted in
// localStorage. PitChat is mounted ONLY while open, so collapsing frees the Ably connection slot.
// Desktop: slim right-edge "💬 PIT" tab slides a panel in; pushes content left via --cp-pit.
// Mobile (≤860px): floating button (bottom-right) opens a full-screen sheet.

import { useEffect, useState } from 'react';
import PitChat from './PitChat';
import { C } from '../lib/cp-shared';
import { onOpenPitDock } from '../lib/pitDockBus';

const PANEL_W = 330;
const MOBILE_Q = '(max-width: 860px)';
const PREF_KEY = 'cp_pit_open';

export default function PitDock() {
  const [ready, setReady] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [open, setOpen] = useState(false);
  const [vh, setVh] = useState(700);

  useEffect(() => {
    setReady(true);
    const mq = window.matchMedia(MOBILE_Q);
    const applyMq = () => setMobile(mq.matches);
    applyMq();
    mq.addEventListener('change', applyMq);

    let saved = null;
    try { saved = localStorage.getItem(PREF_KEY); } catch { /* private mode */ }
    // Default: open on desktop for everyone, closed on mobile.
    setOpen(saved == null ? !mq.matches : saved === '1');

    const setH = () => setVh(Math.max(360, window.innerHeight));
    setH();
    window.addEventListener('resize', setH);
    return () => { mq.removeEventListener('change', applyMq); window.removeEventListener('resize', setH); };
  }, []);

  // Reserve space on the right for the open panel (desktop only).
  useEffect(() => {
    document.documentElement.style.setProperty('--cp-pit', (!mobile && open) ? `${PANEL_W}px` : '0px');
  }, [open, mobile]);

  // Let other components (e.g. the homepage "Join The Pit" widget) open the dock.
  useEffect(() => onOpenPitDock(() => {
    setOpen(true);
    try { localStorage.setItem(PREF_KEY, '1'); } catch { /* ignore */ }
  }), []);

  const toggle = (next) => {
    const v = typeof next === 'boolean' ? next : !open;
    setOpen(v);
    try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

  if (!ready) return null;

  // ── MOBILE: floating button + full-screen sheet ──
  if (mobile) {
    return (
      <>
        <button onClick={() => toggle(true)} aria-label="Open The Pit"
          style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 60, width: 52, height: 52,
            borderRadius: '50%', background: C.green, color: '#fff', border: 'none', cursor: 'pointer',
            fontSize: 22, boxShadow: '0 4px 14px rgba(0,0,0,0.25)', display: open ? 'none' : 'flex',
            alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
        {open && (
          <div onClick={() => toggle(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.45)' }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(94vw, 400px)' }}>
              <PitChat height={vh} onClose={() => toggle(false)} />
            </div>
          </div>
        )}
      </>
    );
  }

  // ── DESKTOP: slim edge tab + sliding panel (chat mounts only while open) ──
  return (
    <>
      <button onClick={() => toggle()} aria-label={open ? 'Collapse The Pit' : 'Open The Pit'}
        style={{ position: 'fixed', top: '50%', right: open ? PANEL_W : 0, transform: 'translateY(-50%)',
          zIndex: 61, transition: 'right 0.25s ease', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 6, padding: '12px 7px', cursor: 'pointer',
          background: C.green, color: '#fff', border: 'none', borderRadius: '8px 0 0 8px',
          boxShadow: '-2px 0 10px rgba(0,0,0,0.12)' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        <span style={{ writingMode: 'vertical-rl', fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
          fontFamily: "'DM Sans',sans-serif" }}>
          THE PIT
        </span>
      </button>

      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: PANEL_W, zIndex: 60,
        transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease',
        boxShadow: open ? '-8px 0 24px rgba(0,0,0,0.12)' : 'none',
        pointerEvents: open ? 'auto' : 'none' }}>
        {open && <PitChat height={vh} onClose={() => toggle(false)} />}
      </div>
    </>
  );
}
