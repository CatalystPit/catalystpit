'use client';

// ONE ROW OF THE CONSENSUS BOARD.
//
// ── WHY THIS IS COMPACT ─────────────────────────────────────────────────────
//
// The previous card printed five equally-weighted family rows, a confidence word, a positive/
// negative tally and a full-width KEY CONFLICT box — for every ticker. That is the model's working
// state, not a reading of it, and it made the trader do the synthesis the engine had already done.
// It was also tall enough that a market-wide board could not be scanned.
//
// So the default row answers the four questions and stops: what does the evidence say, what
// meaningfully disagrees, is price confirming, and why. Everything else is behind Details, and the
// full investigation lives on the ticker page rather than being duplicated here.

import { useState } from 'react';
import { C, TickerLogo } from '../../lib/cp-shared';

export const STATE_UI = {
  POSITIVE_ALIGNMENT: { label: 'Positive alignment', tone: 'pos' },
  NEGATIVE_ALIGNMENT: { label: 'Negative alignment', tone: 'neg' },
  POSITIVE_LEAN_WITH_CONFLICT: { label: 'Positive lean · conflict', tone: 'pos' },
  NEGATIVE_LEAN_WITH_CONFLICT: { label: 'Negative lean · conflict', tone: 'neg' },
  BALANCED_CONFLICT: { label: 'Balanced conflict', tone: 'warn' },
  MIXED: { label: 'Mixed / ambiguous', tone: 'flat' },
  SINGLE_SOURCE: { label: 'Single-source', tone: 'flat' },
  NO_EVIDENCE: { label: 'No current evidence', tone: 'flat' },
};
const TONE = {
  pos: { fg: C.green, bg: C.greenLight },
  neg: { fg: '#A83030', bg: '#FBEDED' },
  warn: { fg: '#7A5018', bg: '#FFF6E8' },
  flat: { fg: C.muted, bg: C.surface },
};

const NSTATE = { POSITIVE: 'Positive', NEGATIVE: 'Negative', MIXED: 'Mixed', INACTIVE: 'Inactive' };
const NCOLOR = { POSITIVE: C.green, NEGATIVE: '#A83030', MIXED: C.muted, INACTIVE: C.dim };
const TREND = { NEW: 'New', STRENGTHENING: 'Strengthening', WEAKENING: 'Weakening', STABLE: null };
const MARKET_UI = {
  CONFIRMING: { label: 'Confirming', fg: C.green },
  DIVERGING: { label: 'Diverging', fg: '#A83030' },
  MIXED: { label: 'Mixed', fg: C.muted },
  UNAVAILABLE: { label: 'Unavailable', fg: C.dim },
};

/** A family as a single inline chip: state, trend, and its own descriptor. */
function FamilyChip({ f, dim }) {
  const trend = TREND[f.trend];
  return (
    <span style={{
      fontSize: 10.5, padding: '2px 7px', borderRadius: 999, background: C.surface,
      border: `1px solid ${C.border}`, color: dim ? C.dim : C.text, whiteSpace: 'nowrap',
    }}>
      <b style={{ color: dim ? C.dim : NCOLOR[f.state], fontWeight: 700 }}>{f.label}</b>
      {' '}{NSTATE[f.state]}{trend ? ` · ${trend}` : ''}
    </span>
  );
}

export default function ConsensusRow({ r }) {
  const [open, setOpen] = useState(false);
  const k = r.canonical;
  if (!k) return null;

  const ui = STATE_UI[k.state] || STATE_UI.MIXED;
  const tone = TONE[ui.tone];
  const market = MARKET_UI[k.market.confirmation] || MARKET_UI.UNAVAILABLE;

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 9 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 13px' }}>
        <TickerLogo symbol={r.ticker} size={26} />
        <div style={{ minWidth: 0, flex: 1 }}>
          {/* 1-3. TICKER · STATE · CONFIDENCE + COVERAGE */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <a href={`/ticker/${encodeURIComponent(r.ticker)}`} className="cp-tkr"
              style={{ fontSize: 14.5, fontWeight: 800, color: C.ink, textDecoration: 'none' }}>{r.ticker}</a>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: tone.fg, background: tone.bg,
              border: `1px solid ${tone.fg}22`, borderRadius: 4, padding: '2px 7px' }}>{ui.label}</span>
            <span style={{ fontSize: 11, color: C.muted }}>
              {k.confidence} confidence · {k.coverage.active} of {k.coverage.total} families
            </span>
            {/* 6. MARKET — its own axis, never mixed into the family count. */}
            <span style={{ fontSize: 11, color: C.muted }}>
              · Market <b style={{ color: market.fg, fontWeight: 700 }}>{market.label}</b>
            </span>
          </div>

          {/* 4-5. DRIVING vs OPPOSING — the synthesis, not five equal rows. */}
          <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            {k.drivers.map((f) => <FamilyChip key={f.family} f={f} />)}
            {k.opposition.length > 0 && (
              <>
                <span style={{ fontSize: 10, color: C.dim, fontWeight: 700 }}>vs</span>
                {k.opposition.map((f) => <FamilyChip key={f.family} f={f} />)}
              </>
            )}
          </div>

          {/* MINOR CONTRARY EVIDENCE is surfaced, never hidden — but it does not get a conflict box.
              A family outweighed by more than 5:1 is a footnote, and printing it as a contest
              misrepresents the evidence. */}
          {k.minorContrary.length > 0 && (
            <div style={{ fontSize: 10.5, color: C.dim, marginTop: 5 }}>
              Minor contrary evidence: {k.minorContrary.map((f) => f.label).join(', ')}
            </div>
          )}

          {/* 7. WHY — deterministic, from the families. */}
          <div style={{ fontSize: 11.5, color: C.text, marginTop: 6, lineHeight: 1.45 }}>{k.why}</div>

          {/* 8. OPEN EVIDENCE — into the ticker experience, not a duplicate viewer here. */}
          <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
            <a href={`/ticker/${encodeURIComponent(r.ticker)}`}
              style={{ fontSize: 11, fontWeight: 700, color: C.green, textDecoration: 'none' }}>Open evidence →</a>
            <button type="button" onClick={() => setOpen((v) => !v)}
              style={{ fontSize: 10.5, color: C.muted, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
              {open ? 'Hide details' : 'Details'} {open ? '▴' : '▾'}
            </button>
          </div>

          {open && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.surface}` }}>
              {k.families.map((f) => (
                <div key={f.family} style={{ display: 'flex', gap: 8, fontSize: 11.5, marginBottom: 3, flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 96, color: C.muted }}>{f.label}</span>
                  {f.active ? (
                    <>
                      <span style={{ fontWeight: 600, color: NCOLOR[f.state] }}>{NSTATE[f.state]}</span>
                      {f.reasons?.[0] && <span style={{ color: C.dim, overflowWrap: 'anywhere' }}>· {f.reasons[0]}</span>}
                    </>
                  ) : (
                    <span style={{ color: C.dim, fontStyle: 'italic' }}>No qualifying evidence</span>
                  )}
                </div>
              ))}
              {/* 13F dates are never collapsed: a filing published yesterday can describe a
                  position up to ~135 days old. */}
              {k.families.find((f) => f.family === 'institutions')?.dates?.quarterEnd && (
                <div style={{ fontSize: 10.5, color: C.dim, marginTop: 5 }}>
                  Institutional holdings as of quarter ended{' '}
                  {k.families.find((f) => f.family === 'institutions').dates.quarterEnd}
                  {k.families.find((f) => f.family === 'institutions').dates.disclosedAt
                    && <> · disclosed {k.families.find((f) => f.family === 'institutions').dates.disclosedAt}</>}
                </div>
              )}
              <div style={{ fontSize: 10.5, color: C.dim, marginTop: 6 }}>{k.market.text}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
