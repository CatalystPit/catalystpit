'use client';

// WatchlistDock — the signed-in user's watchlist as a collapsible right-edge dock, mirroring the
// Tape (left) and Pit chat (right) docks. Sits on the BOTTOM half of the right edge (Pit chat takes
// the top half); lets us keep Watchlist off the top nav. Desktop signed-in only — mobile keeps the
// Watchlist link in the burger menu. Pushes content via --cp-watch (shell margin = max of the docks).

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { C, TickerLogo, fmt2 } from '../lib/cp-shared';

const PANEL_W = 330;                 // match the Pit chat + Tape dock width
const MOBILE_Q = '(max-width: 860px)';
const PREF_KEY = 'cp_watch_open';

function Body({ onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch('/api/watchlist?prices=1', { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (alive) setRows(Array.isArray(j) ? j : []); }
      catch { if (alive) setRows([]); }
    };
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.white, borderLeft: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: C.green, color: '#fff', flexShrink: 0 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.3px' }}>WATCHLIST</span>
        <a href="/watchlist" style={{ marginLeft: 'auto', color: 'rgba(255,255,255,0.85)', fontSize: 11, textDecoration: 'none' }}>Manage</a>
        <button onClick={onClose} aria-label="Collapse watchlist" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>›</button>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {rows === null ? (
          <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '24px 18px', textAlign: 'center', color: C.muted, fontSize: 12.5, lineHeight: 1.5 }}>
            Your watchlist is empty. Tap the ★ on any ticker page to track it here.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.ticker} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                    <a href={`/ticker/${encodeURIComponent(r.ticker)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                      <TickerLogo symbol={r.ticker} size={16} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                    </a>
                  </td>
                  <td className="cp-num" style={{ padding: '8px 12px', textAlign: 'right', color: C.ink }}>{r.price != null ? (r.price > 1000 ? (+r.price).toLocaleString() : fmt2(+r.price)) : '—'}</td>
                  <td className="cp-num" style={{ padding: '8px 12px', textAlign: 'right', color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>
                    {r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${fmt2(r.changePct)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function WatchlistDock() {
  const pathname = usePathname();
  const onTerminal = !!pathname && pathname.startsWith('/terminal');
  const { isSignedIn, isLoaded } = useUser();
  const [ready, setReady] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setReady(true);
    const mq = window.matchMedia(MOBILE_Q);
    const applyMq = () => setMobile(mq.matches);
    applyMq();
    mq.addEventListener('change', applyMq);
    let saved = null;
    try { saved = localStorage.getItem(PREF_KEY); } catch { /* private mode */ }
    setOpen(saved == null ? !mq.matches : saved === '1');   // default open on desktop
    return () => mq.removeEventListener('change', applyMq);
  }, []);

  // Reserve the panel width on the right when open (desktop + signed-in only, not on Terminal).
  const active = !!isSignedIn && !mobile && !onTerminal;
  useEffect(() => {
    document.documentElement.style.setProperty('--cp-watch', (active && open) ? `${PANEL_W}px` : '0px');
  }, [active, open]);

  const toggle = (next) => {
    const v = typeof next === 'boolean' ? next : !open;
    setOpen(v);
    try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

  if (!ready || !isLoaded) return null;
  if (!isSignedIn || mobile || onTerminal) return null;   // desktop signed-in only

  return (
    <>
      <button onClick={() => toggle()} aria-label={open ? 'Collapse watchlist' : 'Open watchlist'}
        style={{ position: 'fixed', top: '75%', right: open ? PANEL_W : 0, transform: 'translateY(-50%)',
          zIndex: 61, transition: 'right 0.25s ease', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 6, padding: '12px 7px', cursor: 'pointer',
          background: C.green, color: '#fff', border: 'none', borderRadius: '8px 0 0 8px',
          boxShadow: '-2px 0 10px rgba(0,0,0,0.12)' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        <span style={{ writingMode: 'vertical-rl', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, fontFamily: "'DM Sans',sans-serif" }}>
          WATCHLIST
        </span>
      </button>

      <div style={{ position: 'fixed', bottom: 0, right: 0, height: '50vh', width: PANEL_W, zIndex: 60,
        transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease',
        boxShadow: open ? '-8px 0 24px rgba(0,0,0,0.12)' : 'none', pointerEvents: open ? 'auto' : 'none' }}>
        {open && <Body onClose={() => toggle(false)} />}
      </div>
    </>
  );
}
