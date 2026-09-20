'use client';

// WHAT CHANGED ON YOUR NAMES — the one implementation, shared by every watchlist surface.
//
// ── WHY ONE COMPONENT ───────────────────────────────────────────────────────
//
// The watchlist appears in three places: the home card, the dock, and the Terminal panel. Each of
// them showing its own version of "what changed" is how three surfaces end up disagreeing about
// the same company on the same screen — the exact failure the Evidence Engine exists to prevent,
// reintroduced one component at a time. The hook fetches once; the pieces render it.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
//
// Not an alert, not a notification, not a feed. It answers a question the user asked by opening
// the page. Nothing here polls in the background, and nothing fires.
//
// ⚠️ NO PRICE, NO MOVE, NO "UP ON VOLUME". Every line is a PUBLIC DISCLOSURE and its publication
// time. Realtime is not entitled, so a change line implying live movement would be untrue at the
// moment it mattered most; the list's own quote column already says LAST CLOSE and that is the
// only place price is claimed at all.

import { useCallback, useEffect, useState } from 'react';
import { C } from '../lib/cp-shared';

// One word per family, in the vocabulary the rest of the product already uses.
const FAMILY_LABEL = {
  insider: 'INSIDER',
  catalyst: 'FILING',
  congress: 'CONGRESS',
  institution: '13F',
};

const FAMILY_TONE = {
  insider: C.green,
  catalyst: C.conflictAccent || C.muted,
  congress: '#2A4A70',
  institution: C.muted,
};

/** "3h ago" / "2d ago" — publication age, never an event age. */
export function publicAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/**
 * Fetch what changed once, and hand back a per-ticker index for badges.
 *
 * `enabled` exists so a surface with no tickers never makes the call — the endpoint is a bounded
 * fan-out over the Evidence Engine and should not run to discover an empty list.
 */
export function useWatchlistChanges({ enabled = true } = {}) {
  const [data, setData] = useState(null);      // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) { setData({ changes: [], byTicker: {} }); return; }
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/watchlist/changes', { cache: 'no-store' });
        if (!alive) return;
        if (r.status === 401) { setData({ changes: [], byTicker: {}, signedOut: true }); return; }
        // ⚠️ A 503 IS NOT AN EMPTY LIST. The endpoint fails loudly on purpose; rendering that as
        // "no new public evidence" would be a calm, reassuring lie.
        if (!r.ok) { setError('unavailable'); setData({ changes: [], byTicker: {} }); return; }
        setData(await r.json());
      } catch {
        if (alive) { setError('unavailable'); setData({ changes: [], byTicker: {} }); }
      }
    })();
    return () => { alive = false; };
  }, [enabled]);

  // Advancing the watermark is a deliberate act, never a side effect of rendering: a page opened
  // in a background tab must not silently consume the thing it was opened to show.
  const markSeen = useCallback(async () => {
    try { await fetch('/api/watchlist/changes', { method: 'POST' }); } catch { /* best effort */ }
    setData((d) => (d ? { ...d, changes: [], byTicker: {}, justCleared: true } : d));
  }, []);

  return { data, loading: data === null, error, markSeen };
}

/** The small count badge a row or header shows. Renders nothing at zero — silence is the default. */
export function ChangedBadge({ count }) {
  if (!count) return null;
  return (
    <span style={{
      fontFamily: "'DM Sans',sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: '0.4px',
      background: C.green, color: '#fff', borderRadius: 999, padding: '1px 6px', whiteSpace: 'nowrap',
    }}>{count} NEW</span>
  );
}

/** One change: family tag, the engine's own sentence, when it became public. */
export function ChangeLine({ c, showTicker = true }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, padding: '5px 0', minWidth: 0 }}>
      <span style={{
        fontFamily: "'DM Sans',sans-serif", fontSize: 8.5, fontWeight: 700, letterSpacing: '0.5px',
        color: FAMILY_TONE[c.family] || C.muted, border: `1px solid ${C.border2}`,
        borderRadius: 3, padding: '1px 5px', flexShrink: 0,
      }}>{FAMILY_LABEL[c.family] || 'EVIDENCE'}</span>

      {showTicker && (
        <a href={c.tickerUrl} className="cp-tkr" style={{
          fontFamily: "'DM Sans',sans-serif", fontSize: 11.5, fontWeight: 800,
          color: C.ink, textDecoration: 'none', flexShrink: 0,
        }}>{c.ticker}</a>
      )}

      {/* The engine's sentence, verbatim. Nothing here rewords it. */}
      <span style={{ fontSize: 11.5, color: C.text, minWidth: 0, overflowWrap: 'anywhere' }}>
        {c.summary}
        {/* ⚠️ 13F IS A QUARTER, DISCLOSED LATE — never "buying now". The reference period is
            printed beside it so the row cannot be read as live positioning. */}
        {c.family === 'institution' && c.referencePeriod && (
          <span style={{ color: C.muted }}> · quarter ended {String(c.referencePeriod).slice(0, 10)}</span>
        )}
      </span>

      <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dim, whiteSpace: 'nowrap', flexShrink: 0 }}>
        {publicAgo(c.publicTime)}
      </span>
    </div>
  );
}

/**
 * The block a watchlist surface embeds.
 *
 * `compact` trims it for the dock. `limit` caps the lines — this is a summary of what changed, not
 * a second Wire.
 */
export default function WatchlistChanges({ enabled = true, limit = 6, compact = false, onSeen, state = null }) {
  // A surface that also badges its rows already holds the hook; passing that state in keeps the
  // whole page to ONE request. Without it the component fetches for itself.
  const own = useWatchlistChanges({ enabled: enabled && !state });
  const { data, loading, error, markSeen } = state || own;

  if (loading) {
    return <div style={{ padding: compact ? '8px 10px' : '12px 16px', fontSize: 11.5, color: C.dim }}>Checking for new evidence…</div>;
  }
  if (data?.signedOut) return null;

  const changes = data?.changes || [];
  const shown = changes.slice(0, limit);

  return (
    <div style={{ padding: compact ? '8px 10px' : '12px 16px', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: shown.length ? 4 : 0 }}>
        <span style={{
          fontFamily: "'DM Sans',sans-serif", fontSize: 9, fontWeight: 700,
          letterSpacing: '0.7px', color: C.dim,
        }}>WHAT CHANGED</span>
        <ChangedBadge count={changes.length} />
        {/* Which question was answered. "Since you last looked" and "in the last 24 hours" are
            different claims, and a reader cannot tell them apart unless we say so. */}
        <span style={{ fontSize: 10, color: C.dim }}>
          {data?.sinceSource === 'last_seen' ? 'since you last looked' : 'last 24 hours'}
        </span>
        {changes.length > 0 && (
          <button
            onClick={() => { markSeen(); onSeen?.(); }}
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: 10, fontWeight: 700, color: C.muted, fontFamily: "'DM Sans',sans-serif",
            }}>Mark seen</button>
        )}
      </div>

      {error ? (
        // Failing loudly, in the user's words. Silence here would read as "nothing happened".
        <div style={{ fontSize: 11.5, color: C.muted }}>
          Couldn’t check for new evidence just now. This is not a statement that nothing changed.
        </div>
      ) : shown.length === 0 ? (
        <div style={{ fontSize: 11.5, color: C.muted }}>No new public evidence on your names.</div>
      ) : (
        <>
          {shown.map((c) => <ChangeLine key={`${c.ticker}-${c.type}-${c.publicTime}`} c={c} />)}
          {changes.length > shown.length && (
            <div style={{ fontSize: 10.5, color: C.dim, paddingTop: 4 }}>
              +{changes.length - shown.length} more
            </div>
          )}
          {data?.truncated && (
            // Said out loud rather than hidden: the fan-out is bounded, so a very long watchlist
            // is only partly checked and the user should know which claim they are reading.
            <div style={{ fontSize: 10, color: C.dim, paddingTop: 4 }}>
              Checked your first {data.resolved} names with new filings.
            </div>
          )}
        </>
      )}
    </div>
  );
}
