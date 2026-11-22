'use client';

// "Tape (via X)" — a rolling feed of an X (Twitter) List the operator curates (e.g. "Pit Wire").
// Presence, not a wire: 8-K/PR (server-side) stays the source of truth, nothing here is promoted
// into Top Stories, and every row is attributed to its author and links back to the post on x.com.
//
// The List URL defaults to the operator's "Pit Wire" list and can be overridden anytime via
// NEXT_PUBLIC_X_LIST_URL (set in Vercel) to swap the List with no code change. It's a public URL,
// not a secret. If it's ever cleared to empty, the component renders NOTHING (page never breaks).
//
// ── ⚠️ THIS WAS X'S OWN IFRAME EMBED, AND THE EMBED DIED AT X'S END ──────────────────────────────
//
// Measured repeatedly on the live site, in a real non-headless browser:
//
//     200  syndication.twitter.com/srv/timeline-list/list-id/<id>?embedId=twitter-widget-0   0 bytes
//
// X accepts the embed's request and returns an EMPTY document. widgets.js therefore leaves its
// iframe at 0x0 with visibility:hidden and never calls makeVisible(), so the panel had nothing to
// show. None of it was fixable here: X's own script builds and sends that request, and the account's
// API credits are depleted (HTTP 402) so the official API was not an alternative either.
//
// The same URL fetched from OUR server still returns the full timeline — /api/x-tape/head had been
// doing exactly that for months and still gets ~99 entries seconds old. So the posts now come from
// the read that works, via /api/x-tape/posts, and XTapeFeed renders them.
//
// That is also strictly cheaper for X. The embed cost one syndication request per visitor per
// rebuild, billed to the VISITOR's IP, against a per-IP limit tight enough that a single tape left
// open could throttle itself; a refused rebuild was silent and indistinguishable from a quiet list.
// It is now one shared server read per 30s for every visitor at once.
//
// All of the embed's lifecycle machinery — widgets.js loading, staging slots, paint detection,
// overlap swapping, head-polling, backoff — is DELETED rather than disabled. It existed to coax a
// cross-origin iframe into painting, and there is no longer an iframe.

import { C } from '../lib/cp-shared';
import XTapeFeed from './XTapeFeed';

// Default: the "Pit Wire" X List. Override with NEXT_PUBLIC_X_LIST_URL to swap without a code change.
const LIST_URL = process.env.NEXT_PUBLIC_X_LIST_URL || 'https://x.com/i/lists/2096931068477620423';
const LIST_ID = (LIST_URL.match(/lists\/(\d+)/) || [])[1] || null;

export default function XTape({ height = 620, onClose, bare = false }) {
  // No List configured → render nothing at all. A panel that explains it has no list is worse than
  // a panel that is not there.
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
          <a href={LIST_URL} target="_blank" rel="noopener noreferrer"
            style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: '#fff',
              textDecoration: 'none', opacity: 0.9 }}>
            via X ↗
          </a>
          {onClose && (
            <button onClick={onClose} aria-label="Collapse tape"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                color: '#fff', fontSize: 16, lineHeight: 1, padding: '2px 4px' }}>
              ✕
            </button>
          )}
        </div>
      )}
      <div style={{ padding: '8px 14px', fontSize: 11, fontWeight: 300, color: C.muted, lineHeight: 1.4, borderBottom: `1px solid ${C.border}` }}>
        Unverified social tape that mixes official prints and rumors. Not investment advice.
      </div>

      {/* Loading, failure, Retry and the List link all live in XTapeFeed, beside the fetch whose
          state they describe. Two components reporting one request's status is how they drift. */}
      <XTapeFeed height={height} bare={bare} listUrl={LIST_URL} />
    </div>
  );
}
