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
import { C, BrandStyles, TopNav, Footer, startCheckout } from '../../lib/cp-shared';
import SetupCard from './SetupCard';
import { useTickerHover, TickerHoverPreview, PREVIEW_1Y } from '../../components/TickerHoverChart';
import ConsensusRow, { STATE_UI } from './ConsensusRow';
import { BOARD_FILTERS } from '../../lib/consensus/synthesis.mjs';
import { SETUP_FILTERS, filterSetups } from '../../lib/consensus/setup.mjs';

// Discovery filters over the CANONICAL states, imported from the engine so a filter cannot
// disagree with the label on the row it shows — or quietly leave a state unreachable.
const FILTERS = SETUP_FILTERS;
void BOARD_FILTERS;

// Non-predictive ordering only. None of these claims a security will perform better than another.
const SORTS = [
  { key: 'default', label: 'Research priority' },
  { key: 'coverage', label: 'Most evidence' },
  { key: 'confidence', label: 'Highest confidence' },
];
const CONF_RANK = { High: 3, Medium: 2, Low: 1 };

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

export default function ConsensusClient() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // THREE OUTCOMES, KEPT APART. A load failure is not an empty board, and a degraded evidence
  // system is not "nothing happened".
  const [loadError, setLoadError] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);
  // ⚠️ ONE HOVER OWNER FOR THE WHOLE BOARD — one open timer, one popup, one implementation, as
  // every other surface does it. Consensus asks for a YEAR rather than the usual 3M: these are
  // research cards about a company's situation, and a quarter is too short to see the shape.
  const { hover, bind } = useTickerHover();
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('default');

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

  const all = data?.rows || [];
  const locked = data?.lockedCount || 0;

  // Filtering and ordering are both over the canonical object. The server already ordered by
  // research priority; these only re-cut that, never re-interpret it.
  // Filtering is over the canonical SETUP object. The server already ordered by research
  // relevance; these controls only re-cut that ordering, never re-interpret the evidence.
  let list = filterSetups(all, filter);
  if (sort === 'coverage') {
    list = [...list].sort((x, y) => ((y.canonical?.coverage?.active || 0) - (x.canonical?.coverage?.active || 0))
      || x.ticker.localeCompare(y.ticker));
  } else if (sort === 'confidence') {
    list = [...list].sort((x, y) => ((CONF_RANK[y.canonical?.confidence] || 0) - (CONF_RANK[x.canonical?.confidence] || 0))
      || x.ticker.localeCompare(y.ticker));
  }
  const counts = Object.fromEntries(FILTERS.map((x) => [x.key, filterSetups(all, x.key).length]));
  // ⚠️ SCOPE, FROM COMPUTED VALUES ONLY. "Positive 46" invites the reading "there are 46 positive
  // stocks in the market", which is false — it is 46 that currently MEET the evidence criteria.
  // Both numbers come from the materialised board; neither is hardcoded.
  const scope = all.length && data?.universe
    ? `${all.length} current setups from ${data.universe.toLocaleString()} eligible US stocks · evidence windows differ by source`
    : null;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Pit Consensus" />
      <div style={{ maxWidth: 860, margin: '22px auto', padding: '0 20px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '0 0 2px' }}>Pit Consensus</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 16px', fontWeight: 300, maxWidth: 640 }}>
          Companies where the public evidence currently forms a question worth investigating — a
          fresh filing, historically unusual insider activity, or price moving against the
          disclosures. Evidence accounting, not a prediction.
        </p>

        {/* DISCOVERY CONTROLS. Every filter maps to canonical states, so a filter can never show a
            row whose own label contradicts it. None of these ranks securities by expected return. */}
        {!loading && !loadError && !degraded && all.length > 0 && (
          <div style={{ marginBottom: 14 }}>
          {/* ⚠️ ONE LINE, NOT A METHODOLOGY ESSAY. It exists to stop "Positive 50" being read as
              "there are 50 positive stocks in the market", and to say the evidence windows are
              source-specific rather than one arbitrary lookback. Both numbers are computed. */}
          {scope && <div style={{ fontSize: 10.5, color: C.dim, marginBottom: 8 }}>{scope}</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {FILTERS.filter((x) => x.key === 'all' || counts[x.key] > 0).map((x) => (
              <button key={x.key} type="button" onClick={() => setFilter(x.key)}
                style={{
                  fontSize: 11, fontWeight: filter === x.key ? 700 : 500, cursor: 'pointer',
                  padding: '4px 10px', borderRadius: 999, fontFamily: 'inherit',
                  border: `1px solid ${filter === x.key ? C.green : C.border}`,
                  background: filter === x.key ? C.greenLight : C.white,
                  color: filter === x.key ? C.green : C.muted,
                }}>
                {x.label}{x.key !== 'all' ? ` ${counts[x.key]}` : ''}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10.5, color: C.dim }}>Order</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)}
                style={{ fontSize: 11, padding: '3px 6px', borderRadius: 5, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontFamily: 'inherit' }}>
                {SORTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </span>
          </div>
          </div>
        )}

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
            {all.length === 0
              ? 'No company currently has an active evidence setup. Evidence exists for many tickers — none of it is currently a reason to investigate.'
              : 'No company currently has that setup.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map((r) => <SetupCard key={r.ticker} row={r} bindTicker={bind} />)}

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
                    <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '10px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Unlock Pro · $20/month</button>
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
      {/* ⚠️ OUTSIDE EVERY CARD. A popup rendered inside a card would be clipped by that card;
          fixed positioning plus a top-level mount is what the other four hover surfaces rely on. */}
      <TickerHoverPreview hover={hover} {...PREVIEW_1Y} />

      <Footer />
    </div>
  );
}
