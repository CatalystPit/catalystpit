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
const CREATE_TIMEOUT = 15000;             // createTimeline must settle or we treat it as a failure

// createTimeline returns X's own promise. It normally resolves (with the element, or with undefined
// when X declines), but a hung syndication request can leave it pending forever, and a promise that
// never settles means the catch that schedules the retry never runs: the box sits on "Loading tape
// from X…" until the page is reloaded. Racing it against a deadline makes every outcome reachable.
const withDeadline = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('createTimeline timed out')), ms);
  Promise.resolve(p).then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); },
  );
});

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

export default function XTape({ height = 620, onClose, bare = false }) {
  const ref = useRef(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'

  // The embed lives in a CROSS-ORIGIN iframe, so its text colour is fixed at creation and cannot be
  // restyled afterwards. It therefore has to be built with the theme that is actually active, and
  // rebuilt when the user toggles. `null` until measured on the client, deliberately: the shared
  // useTheme() starts at "light" and corrects after mount, which would build the widget twice on
  // every dark-mode load and burn two syndication requests against X's per-visitor rate limit.
  const [theme, setTheme] = useState(null);
  // Height tracks the window and changes on every resize event. It is read at build time rather than
  // being a dependency, because rebuilding the widget mid-drag of a window edge would fire a
  // syndication request per resize tick and get the visitor rate-limited.
  const heightRef = useRef(height);
  heightRef.current = height;

  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!LIST_ID) { setStatus('error'); return; }
    if (!theme) return;                 // not measured yet; never build with a guessed theme
    let cancelled = false;
    let timer;
    setStatus('loading');               // every build starts from the intentional loading state

    const attempt = (i) => {
      if (cancelled) return;
      loadWidgets()
        .then((twttr) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = ''; // clear any prior (failed or stale-theme) render
          return withDeadline(twttr.widgets.createTimeline(
            { sourceType: 'list', id: LIST_ID },
            ref.current,
            // `transparent` is deliberately NOT in this list. It tells X to drop its own background
            // so the host page shows through, but X still emits the DARK theme's light-grey text
            // while the iframe canvas paints white, so usernames, tweet text, timestamps, the X
            // glyphs and the interaction counts all land at roughly 1.3:1 on white. Links and
            // avatars keep their own colours, which is why only part of the feed looked washed out.
            // Letting X paint its own background costs nothing (its light background matches our
            // light card exactly, and its dark background sits inside our dark panel) and is the
            // only way the embed renders its own theme consistently.
            { theme, chrome: 'noheader nofooter', height: heightRef.current },
          ), CREATE_TIMEOUT);
        })
        .then((el) => {
          if (cancelled) return;
          // Trust what is actually in the DOM over the promise's word. X resolves with undefined when
          // it declines (429), and has also been seen to resolve oddly while the iframe did paint.
          if (el || ref.current?.querySelector('iframe')) { setStatus('ready'); return; }
          throw new Error('timeline not created');
        })
        .catch(() => {
          if (cancelled) return;
          if (i < RETRY_DELAYS.length) timer = setTimeout(() => attempt(i + 1), RETRY_DELAYS[i]);
          else setStatus('error');
        });
    };
    attempt(0);

    // Drop the old widget on teardown. Without this a theme rebuild stacks a second iframe under the
    // first, and the abandoned one keeps its old colours.
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (ref.current) ref.current.innerHTML = '';
    };
  }, [theme]);

  if (!LIST_ID) return null;

  return (
    <div style={{ background: C.white, border: bare ? 'none' : `1px solid ${C.border}`, borderRadius: bare ? 0 : 8,
      overflow: bare ? 'auto' : 'hidden', height: bare ? '100%' : undefined, fontFamily: "'DM Sans',sans-serif" }}>
      {/* Green top bar: black X logo + white "Tape" (hidden in bare mode — panel has its own header) */}
      {!bare && (
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
      )}
      <div style={{ padding: '8px 14px', fontSize: 11, fontWeight: 300, color: C.muted, lineHeight: 1.4, borderBottom: `1px solid ${C.border}` }}>
        Unverified social tape that mixes official prints and rumors. Not investment advice.
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
