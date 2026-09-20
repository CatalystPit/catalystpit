'use client';

// PIT CONSENSUS — evidence alignment across independent public sources.
//
// ── WHAT THIS PAGE USED TO BE ───────────────────────────────────────────────
//
// A confluence leaderboard: "3/3 SIGNALS", "224 CONFLUENCE", split into Accumulation and
// Distribution tabs. A ticker qualified by having two of three "signals" and was ranked by
// (execs*20 + value/250k*20 + members*25 + netFunds*18) / 3, times 1.6 or 2.4. None of those
// constants was ever validated, the number had no units, and no part of it could be explained to
// the person reading it. The tabs made it worse: a ticker was filed under Accumulation or
// Distribution before the reader saw any evidence, so the conclusion arrived first.
//
// ── WHAT IT IS NOW ──────────────────────────────────────────────────────────
//
// The same question answered from the canonical engine: what do the independent evidence families
// say, and do they agree. A row leads with the state and the families that produced it, so the
// reader can disagree with one family and keep the rest — which is impossible once the families
// have been compressed into a score.
//
// ⚠️ NOT A PREDICTION. No expected return, no price target, no recommendation, no probability. The
// ordering is research priority, not a claim that the top row will perform better than the bottom.

import { useEffect, useState } from 'react';
import ErrorState from '../../components/ErrorState';
import { C, BrandStyles, TopNav, Footer, TickerLogo, startCheckout } from '../../lib/cp-shared';

const FAMILY_LABEL = {
  insiders: 'Insiders', institutions: 'Institutions', congress: 'Congress', catalysts: 'Catalysts',
};
const STATE_LABEL = {
  bullish: 'Positive', bearish: 'Negative', mixed: 'Mixed',
  accumulating: 'Accumulating', distributing: 'Distributing',
  positive: 'Positive', negative: 'Negative',
  'routine-sale': 'Routine sales', 'cluster-sale': 'Cluster selling', 'cluster-buy': 'Cluster buying',
};
const INACTIVE_LABEL = {
  'no-evidence': 'No evidence in window', stale: 'Evidence too old',
  'unusable-quality': 'Not classifiable', 'no-strength': 'Not classifiable',
  'resolution-error': 'Unavailable', 'incomplete-inputs': 'Unavailable',
};

const UP = new Set(['bullish', 'accumulating', 'positive', 'cluster-buy']);
const DOWN = new Set(['bearish', 'distributing', 'negative', 'cluster-sale']);
const stateColor = (s) => (UP.has(s) ? C.green : DOWN.has(s) ? C.red : C.muted);

const dirTone = (d) => (d === 'bullish-lean' ? C.green : d === 'bearish-lean' ? C.red : C.muted);
const CONF_TITLE = 'Confidence in this reading of the EVIDENCE — how many independent families are '
  + 'active, how much they carry and how reliable those sources are. It is not a probability that '
  + 'the stock rises or falls.';

function SkeletonRow() {
  const bar = (w, h = 10) => (
    <span style={{ display: 'inline-block', width: w, height: h, borderRadius: 4, background: C.surface }} />
  );
  return (
    <div aria-hidden="true" style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '14px 16px', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10 }}>
      <span style={{ width: 30, height: 30, borderRadius: '50%', background: C.surface, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>{bar(52, 13)}{bar(86, 13)}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{bar(120, 16)}{bar(108, 16)}{bar(96, 16)}</div>
      </div>
    </div>
  );
}

/** One family's line: its own state in its own vocabulary, plus the fact that produced it. */
function FamilyLine({ f }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
      <span style={{ minWidth: 78, color: C.muted, flexShrink: 0 }}>{FAMILY_LABEL[f.family] || f.family}</span>
      {f.active ? (
        <>
          <span style={{ fontWeight: 600, color: stateColor(f.state), minWidth: 0 }}>
            {STATE_LABEL[f.state] || f.state}
          </span>
          {f.reasons?.[0] && (
            <span style={{ color: C.dim, minWidth: 0, overflowWrap: 'anywhere' }}>· {f.reasons[0]}</span>
          )}
        </>
      ) : (
        <span style={{ color: C.dim, fontStyle: 'italic' }}>
          {INACTIVE_LABEL[f.inactiveReason] || 'No evidence'}
        </span>
      )}
    </div>
  );
}

function Row({ r }) {
  const [open, setOpen] = useState(false);
  const fams = r.families || [];
  const active = fams.filter((f) => f.active);

  // ALIGNMENT AS A COUNT, NOT A PERCENTAGE, and only when it means something. One active family
  // agrees with itself by definition; printing 100% there would be the most misleading number on
  // the page, so it reads SINGLE-SOURCE instead.
  const up = (r.leanUp || []).length;
  const down = (r.leanDown || []).length;
  const alignText = !r.alignmentMeaningful
    ? 'Single-source'
    : up && down
      ? `${up} point positive, ${down} negative`
      : `${Math.max(up, down)} of ${active.length} families aligned`;

  // The 13F date pair, never collapsed: a filing published yesterday describes a position up to
  // ~135 days old.
  const inst = active.find((f) => f.family === 'institutions');

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 13, padding: '14px 16px' }}>
        <TickerLogo symbol={r.ticker} size={30} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <a href={`/ticker/${encodeURIComponent(r.ticker)}`} className="cp-tkr"
              style={{ fontSize: 15, fontWeight: 800, color: C.ink, textDecoration: 'none' }}>{r.ticker}</a>
            <span style={{ fontSize: 14, fontWeight: 700, color: dirTone(r.direction) }}>{r.directionLabel}</span>
            <span title={CONF_TITLE} style={{ fontSize: 11.5, color: C.muted, cursor: 'help' }}>
              {r.confidence} confidence
            </span>
            <span style={{ fontSize: 11.5, color: C.muted }}>· {alignText}</span>
          </div>

          <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
            {fams.map((f) => <FamilyLine key={f.family} f={f} />)}
          </div>

          {inst?.dates?.quarterEnd && (
            <div style={{ marginTop: 7, fontSize: 10.5, color: C.dim }}>
              Institutional holdings as of quarter ended {inst.dates.quarterEnd}
              {inst.dates.disclosedAt && <> · disclosed {inst.dates.disclosedAt}</>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 14, marginTop: 9, alignItems: 'center', flexWrap: 'wrap' }}>
            <a href={`/ticker/${encodeURIComponent(r.ticker)}`}
              style={{ fontSize: 11.5, fontWeight: 700, color: C.green, textDecoration: 'none' }}>
              Open evidence →
            </a>
            {active.some((f) => (f.reasons || []).length > 1 || (f.refs || []).length) && (
              <button type="button" onClick={() => setOpen((v) => !v)}
                style={{ fontSize: 11, color: C.muted, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                {open ? 'Hide why' : 'Why'} {open ? '▴' : '▾'}
              </button>
            )}
          </div>

          {/* WHY — generated from the records, never written to fit the conclusion. */}
          {open && (
            <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${C.surface}` }}>
              {active.map((f) => (
                <div key={f.family} style={{ marginBottom: 7 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, letterSpacing: '0.5px' }}>
                    {(FAMILY_LABEL[f.family] || f.family).toUpperCase()}
                  </div>
                  <ul style={{ margin: '3px 0 0', paddingLeft: 15 }}>
                    {(f.reasons || []).slice(0, 3).map((t, i) => (
                      <li key={i} style={{ fontSize: 11.5, color: C.text, lineHeight: 1.45 }}>{t}</li>
                    ))}
                  </ul>
                  {/* Canonical stored URLs only. A family with none says so rather than linking
                      somewhere approximate. */}
                  {(f.refs || []).length > 0 && (
                    <div style={{ fontSize: 10.5, color: C.dim, marginTop: 2, paddingLeft: 15 }}>
                      {(f.refs || []).length} source record{(f.refs || []).length === 1 ? '' : 's'} on file
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ConsensusClient() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // THREE OUTCOMES, KEPT APART. A load failure is not an empty board, and a degraded evidence
  // system is not "nothing happened".
  const [loadError, setLoadError] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch('/api/consensus-board', { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (r.status === 503 && j?.status === 'degraded') { setDegraded(true); setData(null); setLoadError(false); }
        else if (!r.ok) { setLoadError(true); setData(null); setDegraded(false); }
        else { setData(j); setLoadError(false); setDegraded(false); }
      } catch { if (alive) { setLoadError(true); setData(null); setDegraded(false); } }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [reloadAt]);

  const list = data?.rows || [];
  const locked = data?.lockedCount || 0;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Pit Consensus" />
      <div style={{ maxWidth: 860, margin: '22px auto', padding: '0 20px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '0 0 2px' }}>Pit Consensus</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 16px', fontWeight: 300, maxWidth: 640 }}>
          What the independent public evidence says right now — insiders, institutions, Congress and
          catalysts — and whether those families agree. Evidence accounting, not a prediction.
        </p>

        {loadError && !loading ? (
          <ErrorState
            title="Couldn't load Pit Consensus"
            message="The board didn't come back. This is a loading problem, not an empty board."
            onRetry={() => setReloadAt((n) => n + 1)}
          />
        ) : degraded && !loading ? (
          // DEGRADED IS NOT EMPTY. Saying "no evidence" here would be a claim about the market.
          <ErrorState
            title="Evidence board unavailable"
            message="The evidence board could not be read. This is not a statement that there is no evidence — it means we cannot show it right now."
            onRetry={() => setReloadAt((n) => n + 1)}
          />
        ) : loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true" aria-live="polite">
            <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
              Loading the evidence board
            </span>
            {Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} />)}
          </div>
        ) : list.length === 0 ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            No ticker currently has qualifying evidence in two or more independent families.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map((r) => <Row key={r.ticker} r={r} />)}

            {locked > 0 && (
              <div style={{ position: 'relative', marginTop: 2 }}>
                <div style={{ filter: 'blur(5px)', pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 10 }} aria-hidden="true">
                  {Array.from({ length: Math.min(locked, 4) }).map((_, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10 }}>
                      <div style={{ width: 30, height: 30, borderRadius: '50%', background: C.surface2 }} />
                      <div style={{ flex: 1 }}><div style={{ height: 12, width: '40%', background: C.surface2, borderRadius: 4, marginBottom: 8 }} /><div style={{ height: 10, width: '70%', background: C.surface2, borderRadius: 4 }} /></div>
                    </div>
                  ))}
                </div>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ background: C.white, border: `1px solid ${C.greenBorder}`, borderRadius: 10, padding: '20px 26px', textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginBottom: 6 }}>🔒 {locked} more {locked === 1 ? 'name' : 'names'}</div>
                    <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>See the full evidence board with Pro.</div>
                    <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '10px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Unlock Pro · $12/mo</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
          Families: insider Form 4, institutional 13F, congressional STOCK Act disclosures, and SEC
          catalysts. Every family is dated by when the information became PUBLIC — a congressional
          trade by its disclosure, a 13F by its filing, not by when the trade or quarter happened.
          A family with no qualifying evidence is shown as inactive, never as neutral evidence.
          Ordering is research priority, not a performance ranking. Evidence accounting, not
          investment advice.
          {data?.builtAt && <> · Built {new Date(data.builtAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</>}
        </div>
      </div>
      <Footer />
    </div>
  );
}
