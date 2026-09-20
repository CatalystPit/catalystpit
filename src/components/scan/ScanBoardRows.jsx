'use client';

// PIT SCAN — THE COMPACT ROW.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// Not the Consensus card. Consensus answers "what does the public evidence say about this
// company"; Scan answers "what is moving, and why". Reproducing the card here would make Scan a
// worse Consensus and give a trader two places to read the same thing.
//
// So the row is deliberately four lines and a pair of facts:
//
//   TICKER  $last  ±%  [freshness]
//   STRUCTURE   daily tags, or —
//   EVIDENCE    one line, at most two clauses
//   JOIN        what price is doing about the evidence
//   · fact      · fact
//
// ⚠️ FORBIDDEN ON THIS ROW, and asserted in the suite: any score, an alignment percentage, a
// confidence word, a Bullish/Bearish headline, family soup ("Insiders Positive · Institutions
// Positive · …"), 13F occupancy ("116 funds hold this"), and RVOL. RVOL in particular cannot exist
// here: there is no consolidated volume on this feed, and a ratio against a different methodology
// would be a fabrication rather than a missing number.
//
// ⚠️ AND THE FRESHNESS IS ALWAYS VISIBLE. Realtime is not entitled, so the move shown is the last
// completed session's. A board called "Moving Now" that hid that would be telling a trader
// something untrue at the moment they act.

import { useEffect, useState } from 'react';
import { C, TickerLogo } from '../../lib/cp-shared';

const BOARD_TABS = [
  { key: 'catalysts-now', label: 'Evidence Now' },
  { key: 'moving-now', label: 'Moving Now' },
  { key: 'divergence', label: 'Divergence' },
];

const JOIN_TONE = {
  'PRICE CONFIRMING': C.green,
  'PRICE DIVERGING': C.conflictAccent,
  'PRICE SELLING OFF': C.red,
  'CONFLICT + MOVING': C.conflictAccent,
  'NO REACTION': C.muted,
  '—': C.dim,
};

function Row({ r, onWatch, onAlert, busy }) {
  const up = Number.isFinite(r.changePct) && r.changePct > 0;
  const moveColor = !Number.isFinite(r.changePct) ? C.dim : up ? C.green : C.red;

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
      padding: '10px 12px' }}>
      {/* IDENTITY + PRICE, with the freshness of that price beside it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <TickerLogo symbol={r.ticker} size={20} />
        <a href={`/ticker/${encodeURIComponent(r.ticker)}`} className="cp-tkr"
          style={{ fontSize: 13.5, fontWeight: 800, color: C.ink, textDecoration: 'none' }}>{r.ticker}</a>
        <span style={{ fontSize: 12.5, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
          {Number.isFinite(r.last) ? `$${r.last.toFixed(2)}` : '—'}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: moveColor, fontVariantNumeric: 'tabular-nums' }}>
          {Number.isFinite(r.changePct) ? `${up ? '+' : ''}${r.changePct.toFixed(1)}%` : '—'}
        </span>
        {/* Never hidden, never abbreviated away. */}
        {r.freshnessLabel && (
          <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.6px', color: C.dim,
            border: `1px solid ${C.border2}`, borderRadius: 3, padding: '1px 5px' }}>
            {r.freshnessLabel}
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: '2px 8px', marginTop: 7 }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>STRUCTURE</span>
        <span style={{ fontSize: 11.5, color: r.structure?.length ? C.text : C.dim }}>
          {r.structure?.length ? r.structure.join(' · ') : '—'}
        </span>

        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>EVIDENCE</span>
        <span style={{ fontSize: 11.5, color: r.evidence ? C.text : C.dim, overflowWrap: 'anywhere' }}>
          {r.evidence || '—'}
        </span>

        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>JOIN</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: JOIN_TONE[r.join] || C.muted }}>
          {r.join}
        </span>
      </div>

      {r.facts?.length > 0 && (
        <div style={{ marginTop: 5 }}>
          {r.facts.map((f, i) => (
            <div key={i} style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>· {f}</div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={`/ticker/${encodeURIComponent(r.ticker)}#chart`}
          style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textDecoration: 'none' }}>Chart</a>
        {/* Into the existing evidence experience — Scan never becomes a second evidence viewer. */}
        <a href={r.evidenceUrl || `/ticker/${encodeURIComponent(r.ticker)}`}
          style={{ fontSize: 10.5, fontWeight: 700, color: C.green, textDecoration: 'none' }}>Evidence</a>
        <button type="button" onClick={() => onWatch(r.ticker)} disabled={busy === r.ticker}
          style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>Watch</button>
        <button type="button" onClick={() => onAlert(r.ticker)} disabled={busy === r.ticker}
          style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>Alert</button>
      </div>
    </div>
  );
}

export default function ScanBoardRows() {
  const [board, setBoard] = useState('catalysts-now');
  const [state, setState] = useState(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/scan-board?board=${board}`, { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setError(!r.ok || j.degraded === true);
        setState(j);
      } catch { if (alive) setError(true); }
    };
    load();
    // Evidence moves on filing cadence, not tick cadence. A two-minute poll keeps the price column
    // current without pretending the board is a live tape.
    const id = setInterval(load, 120_000);
    return () => { alive = false; clearInterval(id); };
  }, [board]);

  const watch = async (ticker) => {
    setBusy(ticker);
    try {
      const r = await fetch('/api/watchlist', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker }) });
      const j = await r.json().catch(() => ({}));
      setToast(r.ok ? `${ticker} added to watchlist` : (j.error || 'Could not add'));
    } catch { setToast('Could not add'); } finally { setBusy(null); setTimeout(() => setToast(null), 2500); }
  };

  const alert = async (ticker) => {
    setBusy(ticker);
    try {
      // `news` needs no threshold and is event-driven, which is the honest default from a scan row:
      // an RVOL alert would be meaningless here because there is no live volume to trigger it.
      const r = await fetch('/api/alerts', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: ticker, type: 'news' }) });
      setToast(r.ok ? `Alert set on ${ticker}` : 'Could not set alert');
    } catch { setToast('Could not set alert'); } finally { setBusy(null); setTimeout(() => setToast(null), 2500); }
  };

  const rows = state?.rows || [];

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {BOARD_TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setBoard(t.key)}
            style={{ fontSize: 11, fontWeight: board === t.key ? 700 : 500, cursor: 'pointer',
              padding: '4px 10px', borderRadius: 999, fontFamily: 'inherit',
              border: `1px solid ${board === t.key ? C.green : C.border}`,
              background: board === t.key ? C.greenLight : C.white,
              color: board === t.key ? C.green : C.muted }}>
            {t.label}
          </button>
        ))}
        {/* The provider's actual freshness, stated once at the top as well as on every row. */}
        {state?.freshness && state.freshness !== 'realtime' && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dim }}>
            Prices are {state.freshness === 'eod' ? 'last-close' : 'delayed'} — realtime is not enabled
          </span>
        )}
      </div>

      {error ? (
        // An unavailable board is not a quiet market and must never render as one.
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '20px 16px', fontSize: 12.5, color: C.muted }}>
          {state?.message || 'Pit Scan is unavailable right now. This is not a statement that nothing is happening.'}
        </div>
      ) : !state ? (
        <div style={{ fontSize: 12, color: C.muted, padding: 16 }}>Loading Pit Scan…</div>
      ) : rows.length === 0 ? (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '20px 16px', fontSize: 12.5, color: C.muted }}>
          Nothing currently qualifies for this board.
          {state.rejected?.length > 0 && (
            <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>
              {state.rejected.length} candidates were considered and did not meet the threshold.
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <Row key={r.ticker} r={r} onWatch={watch} onAlert={alert} busy={busy} />
          ))}
        </div>
      )}

      {toast && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.muted }}>{toast}</div>
      )}
    </div>
  );
}
