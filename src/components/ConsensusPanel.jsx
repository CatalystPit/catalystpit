'use client';
import { useEffect, useState } from 'react';
import { C } from '../lib/cp-shared';

// PIT CONSENSUS — the per-ticker evidence reading.
//
// Replaces ConsensusBadge, which showed a 0-100 score from the confluence board. That number
// averaged three sub-scores and multiplied by 1.6 or 2.4, and no part of it could be explained to
// the person reading it.
//
// THE THREE OUTPUTS STAY SEPARATE HERE TOO. Direction, alignment and confidence answer different
// questions and collapsing them into one figure is what made the old presentation unreadable. The
// evidence table underneath is not decoration: a reading nobody can audit is indistinguishable from
// a guess, so every family shows its own state and the reasons list quotes only what the records
// actually say.
//
// ⚠️ NOT A RATING. No buy/sell, no target, no expected return, no probability. The wording is
// deliberately "lean" and the disclaimer is part of the component rather than something a page is
// trusted to add.

const FAMILY_LABEL = {
  insiders: 'Insiders', institutions: 'Institutions', congress: 'Congress', catalysts: 'Catalysts',
};
const STATE_LABEL = {
  bullish: 'Bullish', bearish: 'Bearish', mixed: 'Mixed',
  accumulating: 'Accumulating', distributing: 'Distributing',
  positive: 'Positive', negative: 'Negative',
  'routine-sale': 'Routine sales', 'cluster-sale': 'Cluster selling', 'cluster-buy': 'Cluster buying',
};
const TREND_LABEL = {
  strengthening: 'Strengthening', weakening: 'Weakening', stable: 'Stable',
  'new-cluster': 'New cluster', accumulating: 'Accumulating', distributing: 'Distributing',
  'multiple-actors': 'Multiple actors', 'single-actor': 'Single actor',
  fresh: 'Fresh', fading: 'Fading',
};
const INACTIVE_LABEL = {
  'no-evidence': 'No evidence in window', stale: 'Evidence too old',
  'unusable-quality': 'Not classifiable', 'no-strength': 'Not classifiable',
  'resolution-error': 'Unavailable', 'incomplete-inputs': 'Unavailable',
};

const dirColor = (d) => (d === 'bullish-lean' ? C.green : d === 'bearish-lean' ? C.red : C.muted);
const stateColor = (s) => (['bullish', 'accumulating', 'positive', 'cluster-buy'].includes(s) ? C.green
  : ['bearish', 'distributing', 'negative', 'cluster-sale'].includes(s) ? C.red : C.muted);

export default function ConsensusPanel({ symbol }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/consensus?ticker=${encodeURIComponent(symbol)}`);
        if (!r.ok) { if (alive) setFailed(true); return; }
        const j = await r.json();
        if (alive) setData(j);
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; };
  }, [symbol]);

  // A failed fetch is not "no evidence" — saying so would be a claim about the company rather than
  // about us. The panel simply does not render.
  if (failed || !data || data.error) return null;

  const families = data.families || [];
  const active = families.filter((f) => f.active);
  const reasons = active.flatMap((f) => (f.reasons || []).map((t) => ({ family: f.family, text: t }))).slice(0, 5);

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>PIT CONSENSUS</span>
        <span style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>
          {String(data.version || '').toUpperCase()}
        </span>
      </div>

      <div style={{ padding: '14px 16px' }}>
        {/* DIRECTION */}
        <div style={{ fontSize: 20, fontWeight: 700, color: dirColor(data.direction), letterSpacing: '-0.2px' }}>
          {data.directionLabel}
        </div>

        {/* ALIGNMENT + CONFIDENCE — alignment is a state, not always a percentage. With one active
            family it says Single-source rather than the 100% that would otherwise be the most
            misleading number on the page. */}
        <div style={{ display: 'flex', gap: 18, marginTop: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: C.muted }}>
            {data.alignmentState === 'computed' ? (
              <>Alignment <b style={{ color: C.ink }}>{Math.round(data.alignment * 100)}%</b></>
            ) : data.alignmentState === 'single-source' ? (
              <b style={{ color: C.ink }}>Single-source</b>
            ) : (
              <b style={{ color: C.ink }}>No current evidence</b>
            )}
          </span>
          <span style={{ fontSize: 12.5, color: C.muted }}>
            Confidence <b style={{ color: C.ink }}>{data.confidence}</b>
          </span>
          {data.conflict?.conflict && (
            <span style={{ fontSize: 11.5, color: C.red, fontWeight: 600 }}>Families disagree</span>
          )}
        </div>

        {/* EVIDENCE — inactive families are listed too. Omitting them would hide that three of the
            four had nothing to say, which is exactly what the reader needs to judge the reading. */}
        <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
          {families.map((f) => (
            <div key={f.family} style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12.5 }}>
              <span style={{ width: 92, color: C.muted, flexShrink: 0 }}>{FAMILY_LABEL[f.family] || f.family}</span>
              {f.active ? (
                <>
                  <span style={{ width: 96, fontWeight: 600, color: stateColor(f.state), flexShrink: 0 }}>
                    {STATE_LABEL[f.state] || f.state}
                  </span>
                  <span style={{ color: C.dim }}>{TREND_LABEL[f.trend] || f.trend || ''}</span>
                </>
              ) : (
                <span style={{ color: C.dim, fontStyle: 'italic' }}>{INACTIVE_LABEL[f.inactiveReason] || 'No evidence'}</span>
              )}
            </div>
          ))}
        </div>

        {/* 13F DATES — both of them, always. A filing published yesterday describes a position up to
            ~135 days old, and showing only one date would imply live institutional positioning. */}
        {active.find((f) => f.family === 'institutions')?.dates?.quarterEnd && (
          <div style={{ marginTop: 10, fontSize: 11, color: C.dim }}>
            Institutional holdings as of quarter ended{' '}
            {active.find((f) => f.family === 'institutions').dates.quarterEnd}
            {active.find((f) => f.family === 'institutions').dates.disclosedAt
              && <>, disclosed {active.find((f) => f.family === 'institutions').dates.disclosedAt}</>}
          </div>
        )}

        {/* WHY — generated from the records, never written to fit the conclusion. */}
        {reasons.length > 0 && (
          <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.dim, letterSpacing: '0.6px', marginBottom: 7 }}>WHY</div>
            <ul style={{ margin: 0, paddingLeft: 16, display: 'grid', gap: 5 }}>
              {reasons.map((r, i) => (
                <li key={i} style={{ fontSize: 12, color: C.text, lineHeight: 1.45 }}>{r.text}</li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ marginTop: 12, fontSize: 10.5, color: C.dim, lineHeight: 1.5 }}>
          A structured reading of public filings and disclosures. Not a rating, price target or forecast.
        </div>
      </div>
    </div>
  );
}
