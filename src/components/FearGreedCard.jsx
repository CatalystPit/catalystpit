'use client';
import { useState, useEffect } from 'react';
import { C } from '../lib/cp-shared';
import FearGreedMeter from './FearGreedMeter';

// THE HOMEPAGE FEAR & GREED RAIL CARD.
//
// ── ⚠️ COMPACT ON PURPOSE. THE BREAKDOWN LIVES ON /fear-greed. ──────────────
//
// The component table is the reason the full page exists — it is what turns a 0-100 number
// into something a reader can argue with. In a 300px rail it would be six lines of 10px text that
// nobody reads, so the rail carries the score, the zone, the scale and the three comparisons, and
// sends anyone who wants the why to the page that has room for it.
//
// Reads the same materialised /api/fear-greed the full page reads. No calculation happens here and
// none can: the endpoint serves a stored payload.
//
// ── ⚠️ THE SAME DIAL, NOT A SMALL COPY OF IT ────────────────────────────────
//
// The rail used to draw its own 0-100 strip: five divs at 25/20/11/20/24 percent with a marker
// positioned by hand. It agreed with the index by coincidence, and only until someone moved a zone
// boundary in one file and not the other. It renders FearGreedMeter now, in compact form, so the
// arc, the five bands, their colours, their names, the classification and the needle's angle are
// literally the same code as the hero on /fear-greed. The only thing the card chooses is the size.

const ZONE_COLOR = (label) => {
  if (label === 'EXTREME FEAR' || label === 'FEAR') return { fg: C.red, bg: C.redLight };
  if (label === 'GREED' || label === 'EXTREME GREED') return { fg: C.green, bg: C.greenLight };
  if (label === 'NEUTRAL') return { fg: C.muted, bg: C.surface };
  return { fg: C.dim, bg: C.surface };
};

function Point({ label, point }) {
  const ok = point && Number.isFinite(Number(point.score));
  return (
    <div style={{ flex: '1 1 0', textAlign: 'center', minWidth: 0 }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 8.5, color: C.dim, letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
        {label}
      </div>
      <div className="cp-num" style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginTop: 1 }}>
        {ok ? Math.round(point.score) : '—'}
      </div>
      {/* ⚠️ The zone comes from the payload, not from re-classifying the rounded number here. */}
      <div style={{
        fontFamily: "'DM Sans',sans-serif", fontSize: 7.5, fontWeight: 700, letterSpacing: '0.5px',
        color: ZONE_COLOR(point?.zone).fg, whiteSpace: 'nowrap', marginTop: 1,
      }}>{ok && point.zone ? point.zone : '—'}</div>
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
          <div style={{ padding: '10px 6px 8px' }}>
            <FearGreedMeter compact score={d.score} zone={zone} maxWidth={320} />
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
