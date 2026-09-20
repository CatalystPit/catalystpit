'use client';
import { useEffect, useState } from 'react';
import { C } from '../lib/cp-shared';

// PIT CONSENSUS — the per-ticker evidence reading.
//
// Replaces ConsensusBadge, which showed a 0-100 score from the confluence board. That number
// averaged three sub-scores and multiplied by 1.6 or 2.4, and no part of it could be explained to
// the person reading it.
//
// THE FAMILY ROWS ARE THE PRODUCT. Each family is read from its own records, keeps its own state
// vocabulary, and is never combined with the others into a figure.
//
// The aggregate outputs this panel used to lead with — "Bullish Lean", "Alignment 73%",
// "Confidence High" — are gone. They were computed by summing E_f = D·S·F·Q across families, which
// is a weighting claim: that a $2M insider purchase and a quarterly 13F shift sit on one axis, in
// one unit, and cancel. Experiment 002 tested that premise and measured institutional evidence
// adding +0.43% over insider-alone at t=0.82. A percentage and a confidence word on top of that
// read as validated precision nobody had established, and they invited the reader to trust the
// headline instead of the evidence.
//
// What replaces them is a state a reader can verify against the rows immediately below it, and —
// when families disagree — the disagreement named outright. Averaging destroyed exactly the
// information a reader most needed.
//
// ⚠️ NOT A RATING. No buy/sell, no target, no expected return, no probability, no score.

// Presentation order: slowest-moving structural evidence first, fastest-moving last. NOT precedence.
const FAMILY_ORDER = ['structure', 'institutions', 'insiders', 'congress', 'catalysts'];
const FAMILY_LABEL = {
  structure: 'Market structure',
  insiders: 'Insiders', institutions: 'Institutions', congress: 'Congress', catalysts: 'Catalysts',
};
const STATE_LABEL = {
  bullish: 'Bullish', bearish: 'Bearish', mixed: 'Mixed',
  accumulating: 'Accumulating', distributing: 'Distributing',
  positive: 'Positive', negative: 'Negative',
  'routine-sale': 'Routine sales', 'cluster-sale': 'Cluster selling', 'cluster-buy': 'Cluster buying',
  // The structure engine's own words. A confirmed sequence, not a claim a trend is still running.
  'higher-highs-and-lows': 'Higher highs & lows',
  'lower-highs-and-lows': 'Lower highs & lows',
  'no-clear-sequence': 'No clear sequence',
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

const stateColor = (s) => (['bullish', 'accumulating', 'positive', 'cluster-buy', 'higher-highs-and-lows'].includes(s) ? C.green
  : ['bearish', 'distributing', 'negative', 'cluster-sale', 'lower-highs-and-lows'].includes(s) ? C.red : C.muted);

const AGREEMENT_LABEL = {
  aligned: 'Evidence families agree',
  conflicting: 'Evidence families disagree',
  'no-clear-agreement': 'No clear agreement',
  'single-family': 'Only one family has current evidence',
  'no-evidence': 'No current evidence',
};
const STATE_UI = {
  POSITIVE_ALIGNMENT: { label: 'Positive alignment', color: C.green },
  NEGATIVE_ALIGNMENT: { label: 'Negative alignment', color: C.red },
  POSITIVE_LEAN_WITH_CONFLICT: { label: 'Positive lean, with conflict', color: C.green },
  NEGATIVE_LEAN_WITH_CONFLICT: { label: 'Negative lean, with conflict', color: C.red },
  BALANCED_CONFLICT: { label: 'Balanced conflict', color: C.red },
  MIXED: { label: 'Mixed / ambiguous', color: C.muted },
  SINGLE_SOURCE: { label: 'Single-source evidence', color: C.muted },
  NO_EVIDENCE: { label: 'No current evidence', color: C.muted },
};
const MARKET_UI = {
  CONFIRMING: { label: 'Confirming', color: C.green },
  DIVERGING: { label: 'Diverging', color: C.red },
  MIXED: { label: 'Mixed', color: C.muted },
  UNAVAILABLE: { label: 'Unavailable', color: C.dim },
};
const agreementColor = (a) => (a === 'conflicting' ? C.red : a === 'aligned' ? C.ink : C.muted);

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

  const families = [...(data.families || [])]
    .sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family));
  const active = families.filter((f) => f.active);
  // One line per family where possible, so a single talkative family cannot crowd the others out of
  // the WHY list.
  const reasons = active.flatMap((f) => (f.reasons || []).slice(0, 2).map((t) => ({ family: f.family, text: t }))).slice(0, 7);

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
        {/* WHAT THE EVIDENCE COLLECTIVELY SAYS — a state a reader can check against the rows below,
            not a verdict. There is deliberately no "Bullish Lean", no alignment percentage and no
            confidence word: each implied a validated scale that does not exist, and each invited the
            reader to skip the evidence and trust the headline. */}
        {/* THE CANONICAL STATE — the same object and the same function the market-wide board
            headlines with, so the two surfaces cannot describe this company differently. */}
        <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.2px',
          color: (STATE_UI[data.canonical?.state] || {}).color || agreementColor(data.agreement) }}>
          {(STATE_UI[data.canonical?.state] || {}).label
            || AGREEMENT_LABEL[data.agreement] || 'No clear agreement'}
        </div>
        {data.canonical && (
          <>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
              {data.canonical.confidence} confidence · {data.canonical.coverage.active} of{' '}
              {data.canonical.coverage.total} disclosure families active
              {' · '}Market{' '}
              <b style={{ color: (MARKET_UI[data.canonical.market.confirmation] || {}).color, fontWeight: 700 }}>
                {(MARKET_UI[data.canonical.market.confirmation] || {}).label}
              </b>
            </div>
            <div style={{ fontSize: 12, color: C.text, marginTop: 6, lineHeight: 1.45 }}>
              {data.canonical.why}
            </div>
          </>
        )}
        {/* Fallback only. When the canonical reading is present it already states coverage — over the
            four DISCLOSURE families — and printing a second count over five would read as a
            contradiction on the same card. */}
        {!data.canonical && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
            {data.activeCount === 0
              ? 'Nothing currently reportable across the evidence families'
              : `${data.activeCount} of ${data.evaluatedCount} families have current evidence`}
          </div>
        )}

        {/* KEY CONFLICT — named, not averaged away. This is the single most useful thing the panel
            can say, and the old aggregate destroyed it by construction. */}
        {data.conflicts?.length > 0 && (
          // The accent BAR carries the separation, not the fill. On a dark card a tinted surface
          // can only be a step or two off the background before it starts shouting, so the block is
          // held apart by a 3px rule at 7.5:1 against the card and a visible border — restrained
          // enough to read as "these sources disagree", not as a system failure.
          <div style={{ marginTop: 10, padding: '9px 11px 9px 12px', background: C.conflictBg,
            border: `1px solid ${C.conflictBorder}`, borderLeft: `3px solid ${C.conflictAccent}`,
            borderRadius: 7 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.conflictAccent, letterSpacing: '0.6px' }}>KEY CONFLICT</div>
            <div style={{ fontSize: 12.5, color: C.conflictText, marginTop: 3, lineHeight: 1.45 }}>
              {data.conflicts[0].text}
            </div>
          </div>
        )}

        {/* MINOR CONTRARY EVIDENCE — deliberately NOT a box. This is evidence outweighed by more
            than 5:1; giving it the conflict treatment would tell the reader there is a contest when
            the engine has just determined there isn't one. A thin rule and muted warm text. */}
        {data.canonical?.minorContrary?.length > 0 && (
          <div style={{ marginTop: 9, paddingLeft: 9, borderLeft: `2px solid ${C.contraryRule}`,
            fontSize: 11.5, color: C.contraryText, lineHeight: 1.45 }}>
            <span style={{ fontWeight: 600, letterSpacing: '0.3px' }}>Minor contrary evidence</span>
            {' · '}
            {data.canonical.minorContrary.map((f) => f.label).join(', ')}
          </div>
        )}

        {/* EVIDENCE — inactive families are listed too. Omitting them would hide that three of the
            four had nothing to say, which is exactly what the reader needs to judge the reading. */}
        <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
          {families.map((f) => (
            // MOBILE: the family name sits on its own line and the state below it, rather than two
            // fixed-width columns that force the state to truncate on a narrow screen. "Higher
            // highs & lows" is the longest state and is exactly the one a phone reader must not
            // lose. minWidth:0 lets the flex child actually shrink instead of overflowing.
            <div key={f.family} style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 92, color: C.muted, flexShrink: 0 }}>{FAMILY_LABEL[f.family] || f.family}</span>
              {f.active ? (
                <>
                  <span style={{ fontWeight: 600, color: stateColor(f.state), minWidth: 0, overflowWrap: 'anywhere' }}>
                    {STATE_LABEL[f.state] || f.state}
                  </span>
                  {(TREND_LABEL[f.trend] || f.trend) && (
                    <span style={{ color: C.dim, minWidth: 0, overflowWrap: 'anywhere' }}>
                      {TREND_LABEL[f.trend] || String(f.trend).replace(/-/g, ' ')}
                    </span>
                  )}
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
          Each family is read independently from its own records and keeps its own state. Nothing here is
          combined into a score, a percentage or a confidence level, because no validated basis exists for
          weighting one family against another. A structured reading of public evidence — not a rating,
          price target or forecast.
        </div>
      </div>
    </div>
  );
}
