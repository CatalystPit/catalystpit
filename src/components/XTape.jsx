'use client';

// "Tape (via X)" — an embed-only rolling feed of an X (Twitter) List the operator curates
// (e.g. "Pit Wire"). It is PRESENCE, not a wire: X's own official widget renders the posts in
// an iframe, so it visibly says "via X" and we never copy tweet text into our own cards or
// promote a post into Top Stories. 8-K/PR (server-side) stays the source of truth.
//
// The List URL defaults to the operator's "Pit Wire" list and can be overridden anytime via
// NEXT_PUBLIC_X_LIST_URL (set in Vercel) to swap the List with no code change. It's a public URL,
// not a secret. If it's ever cleared to empty, the component renders NOTHING (page never breaks).

import { useEffect, useRef } from 'react';
import { C } from '../lib/cp-shared';

// Default: the "Pit Wire" X List. Override with NEXT_PUBLIC_X_LIST_URL to swap without a code change.
const LIST_URL = process.env.NEXT_PUBLIC_X_LIST_URL || 'https://x.com/i/lists/2096931068477620423';
const WIDGETS_SRC = 'https://platform.twitter.com/widgets.js';

export default function XTape() {
  const ref = useRef(null);

  useEffect(() => {
    if (!LIST_URL) return;
    let cancelled = false;
    const render = () => {
      if (cancelled) return;
      // window.twttr.widgets.load(node) scans `node` and upgrades the <a.twitter-timeline> anchor
      // into the List timeline iframe. Safe to call repeatedly (it no-ops already-rendered nodes).
      if (window.twttr?.widgets?.load) window.twttr.widgets.load(ref.current);
    };

    if (window.twttr?.widgets) { render(); return; }

    let poll;
    let script = document.querySelector(`script[src="${WIDGETS_SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = WIDGETS_SRC;
      script.async = true;
      script.onload = render;
      document.body.appendChild(script);
    } else {
      // Script tag already present (e.g. re-mount) but window.twttr may still be initializing.
      poll = setInterval(() => { if (window.twttr?.widgets) { clearInterval(poll); render(); } }, 300);
    }
    return () => { cancelled = true; if (poll) clearInterval(poll); };
  }, []);

  if (!LIST_URL) return null;

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
      <div ref={ref} style={{ padding: '0 2px' }}>
        <a
          className="twitter-timeline"
          data-theme="light"
          data-chrome="noheader nofooter transparent"
          data-height="620"
          href={LIST_URL}
        >
          Posts from the Pit Wire list
        </a>
      </div>
    </div>
  );
}
