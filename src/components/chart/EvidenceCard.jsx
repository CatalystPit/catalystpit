'use client';

// The card shown when a trader clicks an evidence marker.
//
// Answers exactly four questions, in the order they are asked: WHAT happened, WHEN did it become
// public, WHY is it notable, WHERE can I verify it. Everything it prints comes from the canonical
// evidence object — no text is generated here and no interpretation is added.
//
// TWO CLOCKS WHERE TWO CLOCKS EXIST. A congressional disclosure shows both the trade date and the
// disclosure date; a 13F shows both the quarter end and the disclosure date. The marker sits on the
// public date, and the card is where the underlying economic date is disclosed rather than hidden —
// showing only one of them is how a reader concludes the market knew something months early.

import { C } from '../../lib/cp-shared';
import { markerPalette } from '../../lib/chart/evidence-markers.mjs';

const FAMILY_LABEL = {
  catalyst: 'SEC 8-K', insider: 'FORM 4', institution: 'INSTITUTIONS',
  congress: 'CONGRESS', market: 'PRICE',
};

const fmtDay = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
// 8-K carries a real timestamp; Form 4 and Congress are day-resolution, so a time would be invented.
const fmtWhen = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const hasTime = d.getUTCHours() || d.getUTCMinutes();
  return hasTime
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : fmtDay(v);
};

function Row({ ev, pal }) {
  const color = ev.family === 'insider'
    ? (ev.direction === 'negative' ? pal.insiderSell : pal.insiderBuy)
    : pal[ev.family] || pal.market;

  // The second clock, only where it genuinely differs from the first.
  let second = null;
  if (ev.family === 'institution' && ev.facts?.quarterEnd) {
    second = `Quarter ended ${fmtDay(ev.facts.quarterEnd)} · Disclosed ${fmtDay(ev.publicTime)}`;
  } else if (ev.family === 'congress' && ev.facts?.transactionDate) {
    const lag = ev.facts.disclosureLagDays;
    second = `Traded ${fmtDay(ev.facts.transactionDate)}`
      + (Number.isFinite(lag) ? ` · disclosed ${lag} day${lag === 1 ? '' : 's'} later` : '');
  } else if (ev.eventTime && fmtDay(ev.eventTime) !== fmtDay(ev.publicTime)) {
    second = `Event dated ${fmtDay(ev.eventTime)}`;
  }

  return (
    <div style={{ padding: '8px 0', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          fontFamily: "'DM Sans',sans-serif", fontSize: 8, letterSpacing: '0.7px',
          color, fontWeight: 700,
        }}>{FAMILY_LABEL[ev.family] || ev.family?.toUpperCase()}</span>
        {ev.facts?.totalValueLabel && (
          <span className="cp-num" style={{ fontSize: 11, fontWeight: 600, color: C.ink }}>
            {ev.facts.totalValueLabel}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, marginTop: 2, lineHeight: 1.35 }}>
        {ev.summary}
      </div>
      {/* Absent when the engine could not PROVE it. Never a placeholder. */}
      {ev.context?.text && (
        <div style={{ fontSize: 11, color: C.ink, marginTop: 3, lineHeight: 1.35 }}>{ev.context.text}</div>
      )}
      <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>
        Filed {fmtWhen(ev.publicTime)}
      </div>
      {second && <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{second}</div>}
      {/* Only ever the URL the ingester stored. A link we cannot honour is worse than none. */}
      {ev.url && (
        <a href={ev.url} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-block', marginTop: 4, fontSize: 10, color: C.green, textDecoration: 'none' }}>
          View filing →
        </a>
      )}
    </div>
  );
}

export default function EvidenceCard({ detail, theme, onClose, hostWidth = 0, hostHeight = 0 }) {
  if (!detail?.items?.length) return null;
  const pal = markerPalette(theme);
  const W = 268;

  // Flip toward whichever side has room, so a marker near the right edge does not open a card that
  // is half off the canvas.
  const left = hostWidth && detail.x + W + 16 > hostWidth
    ? Math.max(8, detail.x - W - 12)
    : detail.x + 12;
  const top = hostHeight ? Math.min(Math.max(8, detail.y - 20), Math.max(8, hostHeight - 180)) : detail.y;

  return (
    <div
      style={{
        position: 'absolute', left, top, width: W, zIndex: 6,
        background: C.white, border: `1px solid ${C.border2}`, borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.13)', padding: '8px 11px 10px',
        maxHeight: 260, overflowY: 'auto',
      }}
      // The chart's own pointer handlers would otherwise close the card the moment it is touched.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: C.ink, letterSpacing: '0.3px' }}>
          EVIDENCE
        </span>
        {detail.items.length > 1 && (
          <span style={{ fontSize: 9, color: C.muted }}>{detail.items.length} items</span>
        )}
        <button
          onClick={onClose}
          aria-label="Close evidence detail"
          style={{
            marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
            color: C.dim, fontSize: 14, lineHeight: 1, padding: 0,
          }}
        >×</button>
      </div>
      {detail.items.map((ev) => <Row key={ev.evidenceId} ev={ev} pal={pal} />)}
    </div>
  );
}
