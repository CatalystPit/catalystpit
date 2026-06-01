'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { C } from '../lib/cp-shared';

// Star toggle for the ticker hero. Reflects SERVER state on load (is this symbol
// already on the signed-in user's watchlist?) and toggles optimistically on
// click, reconciling against the API's returned list. Signed-out users are sent
// to /sign-in rather than silently failing. All writes go through /api/watchlist,
// which derives the user from the Clerk session — the symbol is the only input.
export default function WatchlistStar({ symbol }) {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);   // membership resolved (signed-in only)
  const [busy, setBusy] = useState(false);

  // Resolve current membership once auth + symbol are known.
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setReady(true); return; }
    let alive = true;
    setReady(false);
    (async () => {
      try {
        const r = await fetch('/api/watchlist');
        const list = r.ok ? await r.json() : [];
        if (alive) setOn(Array.isArray(list) && list.some(x => x.ticker === symbol));
      } catch {
        if (alive) setOn(false);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, [isLoaded, isSignedIn, symbol]);

  async function toggle() {
    if (!isLoaded) return;
    if (!isSignedIn) { router.push('/sign-in'); return; }
    if (busy) return;

    const next = !on;
    setOn(next);          // optimistic
    setBusy(true);
    try {
      const r = await fetch('/api/watchlist', {
        method: next ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: symbol }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();   // both POST and DELETE return the updated list
      if (Array.isArray(list)) setOn(list.some(x => x.ticker === symbol));
    } catch {
      setOn(!next);       // revert on failure
    } finally {
      setBusy(false);
    }
  }

  const label = on ? 'Remove from watchlist' : 'Add to watchlist';
  // Pre-resolution placeholder keeps layout stable without flashing a wrong state.
  const showFilled = isSignedIn && ready && on;

  return (
    <button
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={showFilled}
      disabled={busy}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: showFilled ? C.greenLight : C.white,
        border: `1px solid ${showFilled ? C.greenBorder : C.border}`,
        color: showFilled ? C.green : C.muted,
        borderRadius: 6, padding: '6px 12px', height: 32,
        fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 600,
        cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        transition: 'all 0.15s', whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!busy) e.currentTarget.style.borderColor = C.greenBorder; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = showFilled ? C.greenBorder : C.border; }}
    >
      <span style={{ fontSize: 15, lineHeight: 1, color: showFilled ? C.green : C.dim }}>
        {showFilled ? '★' : '☆'}
      </span>
      {on ? 'Watching' : 'Watchlist'}
    </button>
  );
}
