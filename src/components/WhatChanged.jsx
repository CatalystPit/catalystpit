'use client';

// WHAT CHANGED — the first visible surface of the Market Evidence Engine.
//
// Answers, in the order a trader asks them: what is new, why does it matter, how unusual is it for
// THIS company, and where can I verify it. Every line is a stored record; nothing here is generated
// prose, and the "View filing" link is the actual document the claim came from.
//
// ── RENDERING RULES THAT ARE NOT COSMETIC ───────────────────────────────────
//
// 1. BOTH CLOCKS, ALWAYS, where they differ. A congressional disclosure shows the disclosure date as
//    the headline time and the trade date beneath it; a 13F shows "Quarter ended … · Disclosed …".
//    Showing one date for two-clock evidence is the failure this whole engine exists to prevent.
// 2. NO ROW WITHOUT PROVENANCE. If an item has no verifiable link we still show the fact — it came
//    from a stored filing — but we never invent a destination for the link.
// 3. AN EMPTY RESULT IS AN EMPTY STATE, NEVER A BLANK. "No qualifying changes" is information;
//    a blank panel reads as a broken page. A failed fetch says so, distinctly.
//
// Data: /api/evidence?ticker=. All interpretation happens server-side in the engine, so this file
// contains no thresholds, no scoring and no classification — if it did, the next surface would need
// its own copy of them and the two would drift.

import { useEffect, useState } from 'react';
import { C, Dot, Skel, timeAgo, minsSince } from '../lib/cp-shared';

// Family → the small uppercase tag on the left of each row. Colour carries direction, not family:
// a trader scanning the column should see "positive / negative" without reading.
const FAMILY_LABEL = {
  catalyst: 'SEC 8-K',
  insider: 'FORM 4',
  institution: 'INSTITUTIONS',
  congress: 'CONGRESS',
  market: 'PRICE',
};

const dirColor = (d) => (d === 'positive' ? C.green : d === 'negative' ? C.red : C.muted);
const dirBg = (d) => (d === 'positive' ? C.greenLight : d === 'negative' ? C.redLight : C.surface);

const shortDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// <24h → "34m ago"; older → a date. Always computed from publicTime.
const publicAgo = (iso) => {
  const mins = minsSince(iso);
  if (mins == null) return '';
  if (mins < 1440) return timeAgo(mins);
  return shortDate(iso) || '';
};

function EvidenceRow({ e }) {
  const label = FAMILY_LABEL[e.family] || e.family?.toUpperCase();
  const color = dirColor(e.direction);

  // The second clock, shown only when it genuinely differs from the first.
  let secondClock = null;
  if (e.family === 'institution' && e.facts?.quarterEnd) {
    secondClock = `Quarter ended ${shortDate(e.facts.quarterEnd)} · Disclosed ${shortDate(e.publicTime)}`;
  } else if (e.family === 'congress' && e.facts?.transactionDate) {
    const lag = e.facts.disclosureLagDays;
    secondClock = `Traded ${shortDate(e.facts.transactionDate)}`
      + (Number.isFinite(lag) ? ` · disclosed ${lag} days later` : '');
  } else if (e.eventTime && shortDate(e.eventTime) !== shortDate(e.publicTime)) {
    secondClock = `Event dated ${shortDate(e.eventTime)}`;
  }

  return (
    <div style={{
      borderLeft: `3px solid ${color}`, background: C.white,
      padding: '11px 14px', marginBottom: 8, borderRadius: 4,
      border: `1px solid ${C.border}`, borderLeftWidth: 3, borderLeftColor: color,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: "'DM Sans',sans-serif", fontSize: 9, letterSpacing: '0.8px',
          color, background: dirBg(e.direction), padding: '2px 7px', borderRadius: 3, fontWeight: 600,
        }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{e.summary}</span>
        <span className="cp-num" style={{ marginLeft: 'auto', fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>
          {publicAgo(e.publicTime)}
        </span>
      </div>

      {/* The historical context line — the thing that makes a fact interesting. Present only when
          the engine could PROVE it; its absence is deliberate, never a rendering gap. */}
      {e.context?.text && (
        <div style={{ marginTop: 5, fontSize: 12, color: C.ink, fontWeight: 500 }}>
          {e.context.text}
        </div>
      )}

      {secondClock && (
        <div style={{ marginTop: 4, fontSize: 11, color: C.muted, fontWeight: 300 }}>{secondClock}</div>
      )}

      {e.url && (
        <a href={e.url} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-block', marginTop: 6, fontSize: 11, color: C.green, textDecoration: 'none' }}>
          View filing →
        </a>
      )}
    </div>
  );
}

function Group({ title, items }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim,
        letterSpacing: '0.8px', marginBottom: 7,
      }}>{title}</div>
      {items.map((e) => <EvidenceRow key={e.evidenceId} e={e} />)}
    </div>
  );
}

export default function WhatChanged({ symbol }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    setState({ loading: true, error: null, data: null });
    fetch(`/api/evidence?ticker=${encodeURIComponent(symbol)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (alive) setState({ loading: false, error: null, data: d }); })
      // A failed fetch is an ERROR STATE, not an empty one. Rendering an outage as "nothing
      // changed" would be the most misleading thing this panel could do.
      .catch((e) => { if (alive) setState({ loading: false, error: String(e.message || e), data: null }); });
    return () => { alive = false; };
  }, [symbol]);

  const { loading, error, data } = state;
  const items = data?.evidence || [];
  // The engine ranks; this only groups. Freshness tiers come from the engine's own classification,
  // which is why the headings and the ordering can never disagree.
  const today = items.filter((e) => minsSince(e.publicTime) != null && minsSince(e.publicTime) <= 1440);
  const older = items.filter((e) => !today.includes(e));

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>What changed</span>
        {!loading && !error && items.length > 0 && (
          <span style={{ fontSize: 9, background: '#FFF6E8', color: '#7A5018', padding: '2px 7px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }}>
            {items.length} {items.length === 1 ? 'ITEM' : 'ITEMS'}
          </span>
        )}
      </div>

      <div style={{ padding: 14 }}>
        {loading && Array(3).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}

        {!loading && error && (
          <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            Evidence is temporarily unavailable.
          </div>
        )}

        {!loading && !error && !items.length && (
          <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            No qualifying changes for {symbol} in the last 45 days.
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <>
            <Group title="TODAY" items={today} />
            <Group title={today.length ? 'OLDER / STILL RELEVANT' : 'RECENT'} items={older} />
            <div style={{ marginTop: 12, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
              Ordered by how recently each item became public, then by materiality and evidence
              quality. Times are when the information became publicly available — a filing date, not
              a transaction date. Historical comparisons are bounded by the history we hold.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
