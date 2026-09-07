'use client';

// XTapeDock — the "Tape (via X)" as a global, collapsible dock rendered ONCE in the root layout,
// so it's available on every page and (because the layout doesn't remount on client navigation)
// the X embed mounts a single time and stays alive as the user clicks around — live news that
// persists, and one embed load per session instead of one per page (kind to X's rate limit).
//
// Desktop (>860px): a slim "⚡ TAPE" tab pinned to the right edge; click slides a ~340px panel in/out
//   (transform, so it floats OVER content and never reflows the page). Open/closed persists in
//   localStorage. Once opened, XTape stays MOUNTED (slid off-screen when collapsed) so it keeps
//   updating live.
// Mobile (≤860px): a floating round button opens a full-screen sheet; XTape mounts lazily on first
//   open (don't auto-load the embed for mobile visitors who never open it).

import { useEffect, useState } from 'react';
import XTape from './XTape';
import { C } from '../lib/cp-shared';

const PANEL_W = 300;
const MOBILE_Q = '(max-width: 860px)';
const PREF_KEY = 'cp_tape_open';

export default function XTapeDock() {
  const [ready, setReady] = useState(false);   // client-mounted (dock is client-only chrome)
  const [mobile, setMobile] = useState(false);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // has XTape ever been mounted this session
  const [vh, setVh] = useState(700);

  useEffect(() => {
    setReady(true);
    const mq = window.matchMedia(MOBILE_Q);
    const applyMq = () => setMobile(mq.matches);
    applyMq();
    mq.addEventListener('change', applyMq);

    // Restore preference; default open on desktop, closed on mobile.
    let saved = null;
    try { saved = localStorage.getItem(PREF_KEY); } catch { /* private mode */ }
    const isOpen = saved == null ? !mq.matches : saved === '1';
    setOpen(isOpen);
    if (isOpen && !mq.matches) setMounted(true); // desktop + open → mount immediately; mobile stays lazy

    const setH = () => setVh(Math.max(360, window.innerHeight - 120));
    setH();
    window.addEventListener('resize', setH);
    return () => { mq.removeEventListener('change', applyMq); window.removeEventListener('resize', setH); };
  }, []);

  const toggle = (next) => {
    const v = typeof next === 'boolean' ? next : !open;
    setOpen(v);
    if (v) setMounted(true);
    try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

  if (!ready) return null;

  // ── MOBILE: floating button + full-screen sheet (lazy mount) ──
  if (mobile) {
    return (
      <>
        <button onClick={() => toggle(true)} aria-label="Open the Tape"
          style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 60, width: 52, height: 52,
            borderRadius: '50%', background: C.green, color: '#fff', border: 'none', cursor: 'pointer',
            fontSize: 22, boxShadow: '0 4px 14px rgba(0,0,0,0.25)', display: open ? 'none' : 'flex',
            alignItems: 'center', justifyContent: 'center' }}>
          ⚡
        </button>
        {open && (
          <div onClick={() => toggle(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.45)' }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 'min(92vw, 360px)',
                background: C.bg, overflowY: 'auto', boxShadow: '8px 0 24px rgba(0,0,0,0.2)' }}>
              <XTape height={vh} onClose={() => toggle(false)} />
            </div>
          </div>
        )}
      </>
    );
  }

  // ── DESKTOP: slim edge tab + sliding panel (kept mounted once opened) ──
  return (
    <>
      <button onClick={() => toggle()} aria-label={open ? 'Collapse the Tape' : 'Open the Tape'}
        style={{ position: 'fixed', top: '50%', left: open ? PANEL_W : 0, transform: 'translateY(-50%)',
          zIndex: 61, transition: 'left 0.25s ease', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 6, padding: '12px 7px', cursor: 'pointer',
          background: C.green, color: '#fff', border: 'none', borderRadius: '0 8px 8px 0',
          boxShadow: '2px 0 10px rgba(0,0,0,0.12)' }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>⚡</span>
        <span style={{ writingMode: 'vertical-rl', fontSize: 10,
          fontWeight: 700, letterSpacing: 1.5, fontFamily: "'DM Sans',sans-serif" }}>
          TAPE
        </span>
      </button>

      {mounted && (
        <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: PANEL_W, zIndex: 60,
          transform: open ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.25s ease',
          background: C.bg, borderRight: `1px solid ${C.border}`, overflowY: 'auto',
          boxShadow: open ? '8px 0 24px rgba(0,0,0,0.12)' : 'none' }}>
          <XTape height={vh} onClose={() => toggle(false)} />
        </div>
      )}
    </>
  );
}
