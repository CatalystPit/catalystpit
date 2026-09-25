'use client';
import { useState, useEffect } from 'react';
import { C } from '../lib/cp-shared';

// THE HOMEPAGE FEAR & GREED RAIL CARD.
//
// ── ⚠️ COMPACT ON PURPOSE. THE BREAKDOWN LIVES ON /fear-greed. ──────────────
//
// The five-component table is the reason the full page exists — it is what turns a 0-100 number
// into something a reader can argue with. In a 300px rail it would be five lines of 10px text that
// nobody reads, so the rail carries the score, the zone, the scale and the three comparisons, and
// sends anyone who wants the why to the page that has room for it.
//
// Reads the same materialised /api/fear-greed the full page reads. No calculation happens here and
// none can: the endpoint serves a stored payload.

const ZONE_COLOR = (label) => {
  if (label === 'EXTREME FEAR' || label === 'FEAR') return { fg: C.red, bg: C.redLight };
  if (label === 'GREED' || label === 'EXTREME GREED') return { fg: C.green, bg: C.greenLight };
  if (label === 'NEUTRAL') return { fg: C.muted, bg: C.surface };
  return { fg: C.dim, bg: C.surface };
};

function Point({ label, point }) {
  return (
    <div style={{ flex: '1 1 0', textAlign: 'center', minWidth: 0 }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 8.5, color: C.dim, letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
        {label}
      </div>
      <div className="cp-num" style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginTop: 1 }}>
        {point && Number.isFinite(Number(point.score)) ? Math.round(point.score) : '—'}
      </div>
    </div>
  );
}

export default function FearGreedCard() {
  const [d, setD] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let alive = true;
    fetch('/api/fear-greed')
      .then((r) => r.json())
      .then((j) => { if (!alive) return; setD(j); setState(j?.available ? 'ok' : 'unavailable'); })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, []);

  // ⚠️ THE CARD DISAPPEARS RATHER THAN GUESSING. A rail widget that cannot load its number has
  // nothing useful to say, and a placeholder score would be a claim about the market.
  if (state === 'error') return null;

  const zone = d?.zone?.label ?? d?.zone ?? null;
  const col = ZONE_COLOR(zone);
  const pct = Math.min(100, Math.max(0, Number(d?.score) || 0));

  return (
    <a
      href="/fear-greed"
      style={{
        display: 'block', textDecoration: 'none', background: C.white,
        border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden',
      }}
    >
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.ink, letterSpacing: '0.2px' }}>
          CATALYST PIT FEAR &amp; GREED
        </span>
        {/* ⚠️ THE CADENCE IS PART OF THE HEADLINE. Every input is a completed daily session, so the
            card says DAILY rather than letting a rail number imply it is live. */}
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>
          DAILY
        </span>
      </div>

      {state === 'loading' && (
        <div style={{ padding: '30px 14px', textAlign: 'center', fontSize: 12, color: C.dim }}>Loading…</div>
      )}

      {state === 'unavailable' && (
        <div style={{ padding: '24px 14px', textAlign: 'center' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>INDEX UNAVAILABLE</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Not enough components to publish a score.</div>
        </div>
      )}

      {state === 'ok' && (
        <>
          <div style={{ padding: '14px 14px 10px', textAlign: 'center' }}>
            <div className="cp-num" style={{ fontSize: 44, lineHeight: 1.05, fontWeight: 700, color: C.ink }}>
              {Math.round(Number(d.score))}
            </div>
            <div style={{
              display: 'inline-block', marginTop: 5, padding: '3px 11px', borderRadius: 999,
              background: col.bg, color: col.fg, fontSize: 10.5, fontWeight: 700, letterSpacing: '1px',
            }}>{zone}</div>

            {/* The 0-100 scale, with the same zone widths the full page draws. */}
            <div style={{ marginTop: 12 }}>
              <div style={{ height: 6, borderRadius: 999, overflow: 'hidden', display: 'flex' }}>
                <div style={{ width: '25%', background: C.red, opacity: 0.85 }} />
                <div style={{ width: '20%', background: C.red, opacity: 0.45 }} />
                <div style={{ width: '11%', background: C.border2 }} />
                <div style={{ width: '20%', background: C.greenMid, opacity: 0.5 }} />
                <div style={{ width: '24%', background: C.greenMid, opacity: 0.9 }} />
              </div>
              <div style={{ position: 'relative', height: 11 }}>
                <div style={{
                  position: 'absolute', left: `${pct}%`, transform: 'translateX(-50%)', top: -2,
                  width: 2, height: 11, background: C.ink,
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: "'DM Sans',sans-serif", fontSize: 8.5, color: C.dim, letterSpacing: '0.4px' }}>
                <span>FEAR</span><span>GREED</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 4, padding: '9px 10px', borderTop: `1px solid ${C.border}`, background: C.surface }}>
            <Point label="PREV CLOSE" point={d.comparisons?.previousClose} />
            <Point label="1 WEEK" point={d.comparisons?.weekAgo} />
            <Point label="1 MONTH" point={d.comparisons?.monthAgo} />
          </div>

          <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}`, textAlign: 'right' }}>
            <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>View full index →</span>
          </div>
        </>
      )}
    </a>
  );
}
