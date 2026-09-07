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

export default function XTape({ height = 620, onClose }) {
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
            { theme: 'light', chrome: 'noheader nofooter transparent', height },
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
      {/* Green top bar: black X logo + white "Tape" */}
      <div style={{ background: C.green, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="#000" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Tape</span>
        {onClose && (
          <button onClick={onClose} aria-label="Collapse tape"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
              color: '#fff', fontSize: 16, lineHeight: 1, padding: '2px 4px' }}>
            ✕
          </button>
        )}
      </div>
      <div style={{ padding: '8px 14px', fontSize: 11, fontWeight: 300, color: C.muted, lineHeight: 1.4, borderBottom: `1px solid ${C.border}` }}>
        Unverified social tape — mixes official prints and rumors. Not investment advice.
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
