'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { C } from '../lib/cp-tokens.mjs';
// cp-shared re-exports C from cp-tokens; importing the token module directly keeps this component
// off the shared bundle, which drags in Clerk and the whole nav.

/**
 * THE TAPE'S POSTS, RENDERED BY US.
 *
 * ── ⚠️ WHY THIS REPLACED X'S EMBED ───────────────────────────────────────────────────────────────
 *
 * The embed stopped working at X's end. Measured repeatedly on the live site in a real browser:
 * syndication returns 200 with a ZERO-BYTE body to the embed, so widgets.js leaves its iframe at
 * 0x0 and never renders. Nothing in our code could fix that — X's own script builds that request.
 * Meanwhile the identical URL fetched from our server still returns the full timeline, which is what
 * /api/x-tape/posts reads. Same List, same posts, same document; the read that works.
 *
 * ── ⚠️ FEWER REQUESTS OF X, NOT MORE ─────────────────────────────────────────────────────────────
 *
 * The embed spent one syndication request per visitor per rebuild, billed to the visitor's IP. This
 * polls OUR endpoint, which makes one upstream read per 30s shared by everybody. A tape left open
 * all day no longer throttles itself.
 *
 * ── ⚠️ NO FABRICATION, AND NO INDEFINITE SPINNER ─────────────────────────────────────────────────
 *
 * Every field is X's: author, handle, avatar, timestamp, text, and a link to the post itself. If the
 * endpoint cannot serve posts, this says so and offers the List and a Retry — it never invents a row
 * and never sits on a loading message, which is what the embed did for ~71 seconds.
 */

// Matches the server's cache window; asking faster only costs us, and the server answers from its
// last good payload in between anyway.
const POLL_MS = 45_000;

const timeAgo = (ms) => {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export default function XTapeFeed({ height = 620, listUrl, bare = false }) {
  const [posts, setPosts] = useState(null);     // null = first load not finished
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // ⚠️ HOVER PAUSES THE REFRESH. Replacing rows under a cursor mid-read is how a trader loses the
  // post they were reading; the tape is for reading, so reading wins over freshness.
  const hoverRef = useRef(false);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/x-tape/posts', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (!aliveRef.current) return;
      if (j?.posts?.length) { setPosts(j.posts); setFailed(false); }
      // ⚠️ A FAILED REFRESH MUST NOT BLANK A TAPE ALREADY ON SCREEN. Only a first load with nothing
      // to fall back on surfaces the failure.
      else setFailed((prev) => (posts?.length ? prev : true));
    } catch {
      if (aliveRef.current) setFailed((prev) => (posts?.length ? prev : true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts?.length]);

  useEffect(() => {
    aliveRef.current = true;
    setFailed(false);
    load();
    const id = setInterval(() => { if (!hoverRef.current) load(); }, POLL_MS);
    return () => { aliveRef.current = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const box = {
    height: bare ? '100%' : height, overflowY: 'auto', overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
  };

  if (posts === null && !failed) {
    return (
      <div style={{ ...box, padding: '18px 14px', fontSize: 12, color: C.dim, textAlign: 'center' }}>
        Loading tape from X…
      </div>
    );
  }

  if (failed && !posts?.length) {
    return (
      <div style={{ ...box, padding: '16px 14px', fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
        The tape from X is unavailable right now.{' '}
        <a href={listUrl} target="_blank" rel="noopener noreferrer"
          style={{ color: C.green, fontWeight: 600, textDecoration: 'none' }}>
          Open Pit Wire on X ↗
        </a>
        <button type="button" onClick={() => { setPosts(null); setNonce((n) => n + 1); }}
          style={{
            display: 'block', marginTop: 10, padding: '6px 12px', borderRadius: 5,
            border: `1px solid ${C.border}`, background: C.surface, color: C.text,
            fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      style={box}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; }}
    >
      {(posts || []).map((p) => (
        /* ⚠️ THE WHOLE ROW LINKS TO THE POST ON X. Attribution is not decoration here: these are
           other people's words on our page, so the author, the handle and the way back to the
           original all travel with every row. */
        <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer"
          style={{
            display: 'block', padding: '10px 14px', borderBottom: `1px solid ${C.surface}`,
            textDecoration: 'none', color: 'inherit',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            {p.avatar && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={p.avatar} alt="" width={18} height={18} loading="lazy"
                style={{ borderRadius: '50%', flexShrink: 0 }} />
            )}
            <span style={{ fontSize: 12, fontWeight: 700, color: C.text, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '45%' }}>
              {p.name}
            </span>
            <span style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden',
              textOverflow: 'ellipsis' }}>
              @{p.handle}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dim, flexShrink: 0 }}>
              {timeAgo(p.at)}
            </span>
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.45, color: C.text, overflowWrap: 'anywhere' }}>
            {p.text}
          </div>
        </a>
      ))}
    </div>
  );
}
