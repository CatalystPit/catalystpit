'use client';
import { useState, useEffect, useCallback } from 'react';
import { C, Skel, timeAgo, minsSince } from '../lib/cp-shared';

// Bull & Bear synthesis panel — fetches /api/bulls-bears?ticker=, renders the AI synthesis.
// Self-contained (Step 3): NOT wired into the Overview tab yet. No Pro/Free gating yet (Step 6).
// Fonts are plain DOM (DM Sans / Cormorant) — CSP already allows fonts.gstatic.com,
// so no canvas-style font race here (that was a Lightweight-Charts-only problem).

const SOURCE_PILL = { fontFamily: "'DM Sans',sans-serif", fontSize: 10, letterSpacing: '0.3px', color: C.dim };

// "Updated Xm ago" from an ISO timestamp.
const updatedAgo = (iso) => {
  const m = minsSince(iso);
  return m == null ? '' : `Updated ${timeAgo(m)}`;
};
// "10-Q · May 28" — source + short date for a bullet's attribution pill.
const fmtPillDate = (d) => {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

function Bullet({ b, accent }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, lineHeight: 1.5, color: C.text }}>{b.text}</div>
      {(b.source || b.date) && (
        <div style={{ ...SOURCE_PILL, marginTop: 5, display: 'inline-block',
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 7px' }}>
          {[b.source, fmtPillDate(b.date)].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  );
}

// Locked placeholder row — represents the ABSENCE of a bullet that was never
// delivered to the client (free tier). Contains ZERO synthesis text: just a faint
// muted bar + a tiny lock glyph, sized to roughly match a Bullet's footprint.
// This is not blur-over-real-content — there is no real content behind it.
const LOCK_WIDTHS = ['78%', '64%', '72%', '68%', '74%'];
function LockedRow({ w }) {
  return (
    <div style={{ marginBottom: 14 }} aria-hidden="true">
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 10, color: C.hint, lineHeight: 1, flexShrink: 0 }}>🔒</span>
        <div style={{ height: 11, width: w, borderRadius: 4, background: C.surface2 }} />
      </div>
      <div style={{ marginTop: 6, width: 54, height: 14, borderRadius: 4, background: C.surface, border: `1px solid ${C.border}` }} />
    </div>
  );
}

function Column({ title, color, bullets, lockedCount = 0 }) {
  const hasContent = bullets.length > 0 || lockedCount > 0;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: '0.8px',
        color, marginBottom: 12, textTransform: 'uppercase' }}>{title}</div>
      {!hasContent
        ? <div style={{ fontSize: 12, color: C.dim, fontStyle: 'italic' }}>No clear signals from current data.</div>
        : (
          <>
            {bullets.map((b, i) => <Bullet key={i} b={b} accent={color} />)}
            {/* lockedCount placeholder rows — no bullet data is passed in (none exists) */}
            {Array.from({ length: lockedCount }).map((_, i) => (
              <LockedRow key={`lock-${i}`} w={LOCK_WIDTHS[i % LOCK_WIDTHS.length]} />
            ))}
          </>
        )}
    </div>
  );
}

const SOURCE_CATEGORIES = ['SEC EDGAR', 'News', 'FINRA', 'Form 4', 'Congress'];

export default function BullsBears({ ticker }) {
  const [data, setData] = useState(null);     // null = loading
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true); else { setData(null); setError(false); }
    try {
      const url = `/api/bulls-bears?ticker=${encodeURIComponent(ticker)}${refresh ? '&refresh=1' : ''}`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) { if (!refresh) setError(true); }
      else if (j.refreshed_recently) { setRefreshNote('Refreshed recently — try again in a few min'); setTimeout(() => setRefreshNote(''), 6000); if (j.bulls) setData(j); }
      else { setData(j); setError(false); }
    } catch { if (!refresh) setError(true); }
    finally { setRefreshing(false); }
  }, [ticker]);

  useEffect(() => { load(false); }, [load]);

  const card = (children) => (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {children}
    </div>
  );

  // header bar — title + AI badge + refresh
  const header = (
    <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
      display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Bull &amp; Bear Case</span>
      <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, fontWeight: 600, letterSpacing: '0.8px',
        textTransform: 'uppercase', color: C.green, background: C.greenLight, border: `1px solid ${C.greenBorder}`,
        padding: '2px 7px', borderRadius: 4 }}>AI Synthesis</span>
      <button onClick={() => load(true)} disabled={refreshing} aria-label="Refresh synthesis"
        style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: refreshing ? 'default' : 'pointer',
          color: C.green, fontSize: 15, lineHeight: 1, opacity: refreshing ? 0.4 : 1 }}>↻</button>
    </div>
  );

  // ── states ──
  if (error) {
    return card(<>{header}
      <div style={{ padding: '28px 16px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
        Synthesis unavailable for this ticker.
      </div></>);
  }

  if (data == null) {
    return card(<>{header}
      <div style={{ padding: 16 }}>
        <Skel w="70%" h={16} mb={16} />
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {[0, 1].map((col) => (
            <div key={col} style={{ flex: 1, minWidth: 220 }}>
              <Skel w="40%" h={12} mb={12} />
              {[0, 1, 2].map((i) => <Skel key={i} h={32} mb={12} />)}
            </div>
          ))}
        </div>
      </div></>);
  }

  const bulls = data.bulls || [];
  const bears = data.bears || [];
  const ago = updatedAgo(data.generatedAt);
  // Tier-agnostic: the component only reads the locked counts. Free → N>0, the
  // locked bullets were stripped server-side and are NOT in the payload. Pro/elite
  // → undefined/0 → no placeholders, no CTA. The UI cannot reveal what it never got.
  const lockedBull = data.lockedBullCount || 0;
  const lockedBear = data.lockedBearCount || 0;
  const lockedTotal = lockedBull + lockedBear;

  return card(<>{header}
    <div style={{ padding: 16 }}>
      {ago && (
        <div style={{ textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, marginBottom: 8 }}>
          {refreshNote
            ? <span style={{ color: C.gold }}>{refreshNote}</span>
            : ago}
        </div>
      )}

      {data.summary_line && (
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontStyle: 'italic', fontSize: 16, lineHeight: 1.45,
          color: C.ink, margin: '0 0 18px', paddingBottom: 16, borderBottom: `1px solid ${C.surface}` }}>
          {data.summary_line}
        </div>
      )}

      <div className="bb-cols">
        <Column title="Bulls Say" color={C.green} bullets={bulls} lockedCount={lockedBull} />
        <Column title="Bears Say" color={C.red} bullets={bears} lockedCount={lockedBear} />
      </div>

      {/* upgrade CTA — only when there are locked points (free tier). Pro/elite: lockedTotal 0 → hidden. */}
      {lockedTotal > 0 && (
        <div style={{ marginTop: 16, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
          flexWrap: 'wrap', background: C.greenLight, border: `1px solid ${C.greenBorder}`, borderRadius: 8 }}>
          <span style={{ flex: 1, minWidth: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.ink }}>
            🔒 {lockedTotal} more {lockedTotal === 1 ? 'point' : 'points'} in the full Bull &amp; Bear breakdown
          </span>
          {/* M7: point to upgrade/checkout flow */}
          <a href="/account" style={{ background: C.green, color: '#fff', textDecoration: 'none', whiteSpace: 'nowrap',
            padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif" }}>
            Upgrade to Pro
          </a>
        </div>
      )}

      {/* footer: source categories + disclaimer */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.surface}` }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {SOURCE_CATEGORIES.map((s) => (
            <span key={s} style={{ ...SOURCE_PILL, background: C.surface, borderRadius: 4, padding: '2px 7px' }}>{s}</span>
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
          AI-synthesized from public filings, news sources, and market data. Not investment advice.
        </div>
      </div>
    </div>
  </>);
}
