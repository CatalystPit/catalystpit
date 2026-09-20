'use client';

// ConsensusTeaser — homepage box surfacing the top Pit Consensus names (where insiders,
// Congress, and funds are stacking the same direction). Teaser only: top 3, linking to the
// full board at /consensus.
import { useEffect, useState } from 'react';
import { C, Dot, Skel, TickerLogo } from '../lib/cp-shared';

const money = (v) => {
  if (v == null || isNaN(v)) return '';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};

// The canonical state words, matching the board and the ticker page exactly — all EIGHT of them.
// This had been left on the V2 vocabulary, so every lean and every balanced conflict fell through
// to an unstyled label; and the colours were literal hexes, which do not theme.
const STATE_UI = {
  POSITIVE_ALIGNMENT: { label: 'Positive alignment', color: C.green },
  NEGATIVE_ALIGNMENT: { label: 'Negative alignment', color: C.red },
  POSITIVE_LEAN_WITH_CONFLICT: { label: 'Positive lean · conflict', color: C.green },
  NEGATIVE_LEAN_WITH_CONFLICT: { label: 'Negative lean · conflict', color: C.red },
  BALANCED_CONFLICT: { label: 'Balanced conflict', color: C.conflictAccent },
  MIXED: { label: 'No clear agreement', color: null },
  SINGLE_SOURCE: { label: 'Single-source', color: null },
  NO_EVIDENCE: { label: 'No current evidence', color: null },
};

/** Which families are active and how they split — never a count of raw transactions. */
function summarize(r) {
  const active = (r.normalised || []).filter((f) => f.active);
  if (!active.length) return 'No active families';
  const up = active.filter((f) => f.state === 'POSITIVE').length;
  const down = active.filter((f) => f.state === 'NEGATIVE').length;
  if (up && down) return `${up} positive, ${down} negative of ${active.length} families`;
  if (up || down) return `${Math.max(up, down)} of ${active.length} families aligned`;
  return `${active.length} active families, none directional`;
}

export default function ConsensusTeaser() {
  const [rows, setRows] = useState(null);   // null = loading, [] = none

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // CANONICAL BOARD, not the confluence engine. The old source counted rows on one side
        // only — it queried action='BUY' for the bull board — so it could never see opposing
        // evidence. That is how GOLD appeared here as clean accumulation on one insider purchase
        // while five insiders had sold $7.0M and the canonical engine read the ticker as a conflict.
        const r = await fetch('/api/consensus-board', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setRows((j?.rows || []).slice(0, 3));
      } catch { if (alive) setRows([]); }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>PIT CONSENSUS</span>
        <span style={{ fontSize: 9, background: C.greenLight, color: C.green, padding: '2px 7px',
          borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>EVIDENCE ALIGNMENT</span>
        <a href="/consensus" style={{ marginLeft: 'auto', fontSize: 11, color: C.green, textDecoration: 'none', fontWeight: 600 }}>
          Full board →
        </a>
      </div>
      <div style={{ padding: 8 }}>
        {rows == null ? (
          <div style={{ padding: 8 }}>{[0, 1, 2].map((i) => <Skel key={i} h={40} mb={i < 2 ? 8 : 0} />)}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '18px 8px', textAlign: 'center', fontSize: 12, color: C.muted, fontWeight: 300 }}>
            No ticker currently has qualifying evidence in two or more independent families.
          </div>
        ) : (
          rows.map((r, i) => (
            <a key={r.ticker} href={`/ticker/${encodeURIComponent(r.ticker)}`} className="hov"
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 8px', borderRadius: 7,
                textDecoration: 'none', borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
              <span className="cp-num" style={{ width: 16, textAlign: 'center', fontSize: 12, fontWeight: 700, color: C.dim }}>{i + 1}</span>
              <TickerLogo symbol={r.ticker} size={24} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="cp-tkr" style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{r.ticker}</span>
                  {/* The badge takes the STATE's colour. Hardcoding green painted a conflict row
                      green while its own label said "Conflict". */}
                  <span style={{ fontSize: 9, fontWeight: 700, color: (STATE_UI[r.state] || STATE_UI.MIXED).color || C.muted, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 6px' }}>
                    {(STATE_UI[r.state] || STATE_UI.MIXED).label}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {summarize(r)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {/* Aligned families, not the deprecated 0-100 blend. */}
                <div className="cp-num" style={{ fontSize: 16, fontWeight: 800, color: C.green }}>{(r.normalised || []).filter((f) => f.active).length}</div>
                <div style={{ fontSize: 7, color: C.dim, letterSpacing: '0.5px' }}>FAMILIES</div>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
