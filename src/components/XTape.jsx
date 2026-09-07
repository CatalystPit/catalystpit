'use client';

// "Tape (via X)" — an embed-only rolling feed of an X (Twitter) List the operator curates
// (e.g. "Pit Wire"). It is PRESENCE, not a wire: X's own official widget renders the posts in
// an iframe, so it visibly says "via X" and we never copy tweet text into our own cards or
// promote a post into Top Stories. 8-K/PR (server-side) stays the source of truth.
//
// The List URL defaults to the operator's "Pit Wire" list and can be overridden anytime via
// NEXT_PUBLIC_X_LIST_URL (set in Vercel) to swap the List with no code change. It's a public URL,
// not a secret. If it's ever cleared to empty, the component renders NOTHING (page never breaks).
//
// Reliability note: X's syndication endpoint that feeds this widget rate-limits (HTTP 429) PER
// VISITOR IP. That fetch happens in the visitor's own browser, so a dev refreshing repeatedly gets
// throttled while a normal first-time visitor is unaffected. We use createTimeline() (one clean
// call, no repeated widgets.load storms) + retry-with-backoff so a transient 429 self-heals, and
// fall back to a direct "open on X" link if it still can't paint — the box is never left dead.

import { useEffect, useRef, useState } from 'react';
import { C } from '../lib/cp-shared';

// Default: the "Pit Wire" X List. Override with NEXT_PUBLIC_X_LIST_URL to swap without a code change.
const LIST_URL = process.env.NEXT_PUBLIC_X_LIST_URL || 'https://x.com/i/lists/2096931068477620423';
const LIST_ID = (LIST_URL.match(/lists\/(\d+)/) || [])[1] || null;
const WIDGETS_SRC = 'https://platform.twitter.com/widgets.js';
const RETRY_DELAYS = [3000, 8000, 20000]; // backoff for transient 429s / slow syndication

// Load platform.twitter.com/widgets.js exactly once; resolve with window.twttr when ready.
let widgetsPromise = null;
function loadWidgets() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.twttr?.widgets) return Promise.resolve(window.twttr);
  if (widgetsPromise) return widgetsPromise;
  widgetsPromise = new Promise((resolve, reject) => {
    let script = document.querySelector(`script[src="${WIDGETS_SRC}"]`);
    const done = () => (window.twttr?.widgets ? resolve(window.twttr) : reject(new Error('twttr missing')));
    if (!script) {
      script = document.createElement('script');
      script.src = WIDGETS_SRC;
      script.async = true;
      script.onload = done;
      script.onerror = () => reject(new Error('widgets.js failed'));
      document.body.appendChild(script);
    } else {
      // Script present but twttr may still be initializing — poll briefly.
      let n = 0;
      const t = setInterval(() => {
        if (window.twttr?.widgets) { clearInterval(t); resolve(window.twttr); }
        else if (++n > 40) { clearInterval(t); reject(new Error('twttr init timeout')); } // ~12s
      }, 300);
    }
  });
  return widgetsPromise;
}

export default function XTape() {
  const ref = useRef(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'

  useEffect(() => {
    if (!LIST_ID) { setStatus('error'); return; }
    let cancelled = false;
    let timer;

    const attempt = (i) => {
      if (cancelled) return;
      loadWidgets()
        .then((twttr) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = ''; // clear any prior (failed) render before re-inserting
          return twttr.widgets.createTimeline(
            { sourceType: 'list', id: LIST_ID },
            ref.current,
            { theme: 'light', chrome: 'noheader nofooter transparent', height: 620 },
          );
        })
        .then((el) => {
          if (cancelled) return;
          if (el) { setStatus('ready'); return; }        // el === undefined means X declined (429/etc.)
          throw new Error('timeline not created');
        })
        .catch(() => {
          if (cancelled) return;
          if (i < RETRY_DELAYS.length) timer = setTimeout(() => attempt(i + 1), RETRY_DELAYS[i]);
          else setStatus('error');
        });
    };
    attempt(0);

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  if (!LIST_ID) return null;

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden',
      fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Tape</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: C.dim, letterSpacing: 0.3,
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 6px' }}>
            VIA X
          </span>
        </div>
        <div style={{ marginTop: 5, fontSize: 11, fontWeight: 300, color: C.muted, lineHeight: 1.4 }}>
          Unverified social tape — mixes official prints and rumors. Not investment advice.
        </div>
      </div>

      {/* Timeline mounts here. Kept in the DOM across states so createTimeline always has its target. */}
      <div ref={ref} style={{ padding: '0 2px', minHeight: status === 'ready' ? undefined : 0 }} />

      {status === 'loading' && (
        <div style={{ padding: '18px 14px', fontSize: 12, color: C.dim, textAlign: 'center' }}>
          Loading tape from X…
        </div>
      )}
      {status === 'error' && (
        <div style={{ padding: '16px 14px', fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          X is rate-limiting the live embed right now.{' '}
          <a href={LIST_URL} target="_blank" rel="noopener noreferrer"
            style={{ color: C.green, fontWeight: 600, textDecoration: 'none' }}>
            Open Pit Wire on X ↗
          </a>
        </div>
      )}
    </div>
  );
}
