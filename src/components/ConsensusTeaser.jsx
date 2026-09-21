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

// ── READING THE CANONICAL ROW, NOT A FIELD IT STOPPED EMITTING ──────────────
//
// ⚠️ THIS PRINTED "No active families" AND A BIG GREEN 0 WHILE /consensus SHOWED THE SAME TICKER
// AS A CROSS-SOURCE CONFLICT. Both surfaces read the same board; this one read `r.normalised`,
// a V2.1 field the V3.8 payload no longer carries, so `(r.normalised || [])` silently became an
// empty array and every row reported zero. A missing field read through `|| []` does not fail —
// it reports absence as fact, which is the worst way for a schema change to land.
//
// The row does carry the answer: evidence_layer.activeCount, and a per-family fact sheet whose
// blocks each state a direction. Same row, same board, no second Consensus.

/** Active families on the canonical row, or null when the shape is not one we recognise. */
function familyCount(r) {
  const n = r?.evidence_layer?.activeCount;
  return Number.isFinite(n) ? n : null;
}

/** How the active families split. Null when the row cannot be read safely. */
function summarize(r) {
  const total = familyCount(r);
  if (total == null) return null;
  const blocks = Object.values(r.families || {}).flat().filter(Boolean);
  const up = blocks.filter((b) => b.direction === 'positive').length;
  const down = blocks.filter((b) => b.direction === 'negative').length;
  if (up && down) return `${up} positive, ${down} negative of ${total} families`;
  if (up || down) return `${Math.max(up, down)} of ${total} families aligned`;
  return `${total} active families, none directional`;
}

/** The setup the board itself named. Falls back to the state map only if the label is absent. */
function setupLabel(r) {
  return r?.setup?.label || (STATE_UI[r?.state] || STATE_UI.MIXED).label;
}
function setupColor(r) {
  if (r?.setup?.setup === 'CROSS_SOURCE_CONFLICT') return C.conflictAccent;
  return (STATE_UI[r?.state] || STATE_UI.MIXED).color || C.muted;
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
                  <span style={{ fontSize: 9, fontWeight: 700, color: setupColor(r), background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 6px' }}>
                    {setupLabel(r)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {/* ⚠️ NO SUMMARY IS BETTER THAN A FALSE ONE. When the row cannot be read the
                      teaser points at the board rather than inventing a count — the board is the
                      one place the full setup is always rendered correctly. */}
                  {summarize(r) || 'See the full board for this setup →'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {/* Active families from the canonical row, not the deprecated 0-100 blend — and
                    an em dash rather than a confident 0 when the count is unavailable. */}
                <div className="cp-num" style={{ fontSize: 16, fontWeight: 800, color: familyCount(r) == null ? C.dim : C.green }}>
                  {familyCount(r) ?? '—'}
                </div>
                <div style={{ fontSize: 7, color: C.dim, letterSpacing: '0.5px' }}>FAMILIES</div>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
