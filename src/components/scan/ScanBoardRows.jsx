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
// ⚠️ AND THE FRESHNESS IS ALWAYS VISIBLE — IN WHICHEVER DIRECTION IS TRUE. Realtime is entitled
// now, so a row's price may be a live consolidated print or the last completed session's close,
// and the row says which. A board called "Moving Now" that hid either would be telling a trader
// something untrue at the moment they act: stale prices passed off as current, or — the failure
// that actually shipped — current prices disclaimed as delayed.

import { useEffect, useState } from 'react';
import { C, Badge, TickerLogo } from '../../lib/cp-shared';

const BOARD_TABS = [
  // ⚠️ THE BLURB NO LONGER NAMES A CLOCK, AND THAT IS THE POINT. It used to read "on the last
  // completed session", which was true while realtime was unentitled and became a false claim the
  // day it was not — printed directly beneath a banner saying LIVE. A static subtitle cannot know
  // what the feed delivered; the banner and the per-row badges can, and they do. So the subtitle
  // says what the board SELECTS and leaves what it is PRICED FROM to the two places that measure it.
  { key: 'moving-now', label: 'Moving Now',
    blurb: 'A meaningful move, with the evidence that explains it.' },
  { key: 'catalysts-now', label: 'Evidence Now',
    blurb: 'Fresh material filings and unusual activity. Price may be flat — timing comes from the filing.' },
  { key: 'divergence', label: 'Divergence',
    blurb: 'Meaningful evidence and a meaningful move pointing opposite ways. The gate is deliberately tight.' },
];

/**
 * THE FEED BANNER — one component, used by the Terminal panel and any page wrapper.
 *
 * ── ⚠️ IT HAD NO LIVE STATE, AND THAT BECAME THE BUG ────────────────────────
 *
 * This was two states — DELAYED or LAST CLOSE — written when Tiingo commercial realtime was not
 * entitled, on the reasoning that a LIVE branch could only ever be wrong. The entitlement is on
 * now, and the missing branch inverted: there was no input for which this banner could tell the
 * truth to an entitled reader. A fully live board fell through to "Last completed session — not
 * live quotes", and a board with one unpriced row among twenty-five reported 'near', which read
 * as "Delayed quotes — not live" over a screen of live consolidated prices.
 *
 * ⚠️ THE STATE COMES FROM THE SERVED ROWS, NOT FROM THE ENTITLEMENT. aggregateFreshness reads the
 * freshness the rows actually carry, so LIVE appears only when live prices were delivered. Being
 * entitled to realtime and receiving it are different facts, and only the second one may be
 * announced. A Free reader's rows are 'eod' or 'delayed' and this renders exactly as it always did.
 */
const FEED_STATE = {
  realtime: { label: 'LIVE', text: 'Real-time consolidated quotes.' },
  near: { label: 'LIVE', text: 'Real-time consolidated quotes, seconds behind the tape.' },
  // ⚠️ NEITHER EXTREME. Some rows are live and some have no current print; claiming either one
  // for the whole board is a false statement about prices a trader is about to act on. Each row
  // still carries its own badge, which is where the per-symbol truth lives.
  mixed: { label: 'PARTLY LIVE', text: 'Live where the feed has a current print — last close on the rest. Every row says which.' },
  delayed: { label: 'DELAYED', text: 'Delayed quotes — not live.' },
  eod: { label: 'LAST CLOSE', text: 'Last completed session — not live quotes.' },
};

export function FeedBanner({ freshness, compact = false }) {
  // An unknown or absent freshness is not a live one.
  const state = FEED_STATE[freshness] || FEED_STATE.eod;
  const { label, text } = state;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: compact ? '5px 8px' : '8px 12px', borderRadius: 6,
      background: C.surface, border: `1px solid ${C.border2}`,
      fontSize: compact ? 10.5 : 11.5, color: C.muted, marginBottom: compact ? 9 : 16,
    }}>
      <Badge>{label}</Badge>
      <span>{text}</span>
      {!compact && (
        <span style={{ color: C.dim }}>
          Evidence timing is unaffected — filings are timestamped from public availability.
        </span>
      )}
    </div>
  );
}

const JOIN_TONE = {
  'PRICE CONFIRMING': C.green,
  'PRICE DIVERGING': C.conflictAccent,
  'PRICE SELLING OFF': C.red,
  'CONFLICT + MOVING': C.conflictAccent,
  'NO REACTION': C.muted,
  // Neutral on purpose. "We have not matched this to evidence" is a statement about our coverage,
  // not a judgement on the stock, and colouring it like a conflict would read as one.
  'NO MATCHING EVIDENCE': C.dim,
  // A recovered public item. Neutral-positive: it is an attribution, not a verdict on direction.
  'MATCHING CATALYST': C.blue,
  'RECENT RELEVANT CATALYST': C.blue,
  // We looked and found nothing. Dim, because it reports our coverage rather than the stock.
  'NO PUBLIC CATALYST IDENTIFIED': C.dim,
  'REACTION UNAVAILABLE': C.dim,
  '—': C.dim,
};

function Row({ r, onWatch, onAlert, busy, onPick }) {
  const up = Number.isFinite(r.changePct) && r.changePct > 0;
  const moveColor = !Number.isFinite(r.changePct) ? C.dim : up ? C.green : C.red;

  // ⚠️ THE SAME ROW SERVES A PAGE AND A TERMINAL PANEL, AND THE TICKER MEANS SOMETHING DIFFERENT
  // IN EACH. On /scan there is nowhere to sync to, so the symbol is a link to the ticker page and
  // must stay one. Inside the Terminal the panels are wired together, so the symbol should drive
  // the linked chart rather than navigate the whole workspace away from it.
  //
  // It stays an <a> with a real href either way — middle-click, "open in new tab" and a
  // screen reader all keep working — and `onPick` merely intercepts the plain left click. A
  // button would have thrown that away to save nothing.
  const pickTicker = (e) => {
    if (!onPick) return;                       // /scan: let the link do what a link does
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onPick(r.ticker);
  };

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
      padding: '10px 12px' }}>
      {/* IDENTITY + PRICE, with the freshness of that price beside it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <TickerLogo symbol={r.ticker} size={20} />
        <a href={`/ticker/${encodeURIComponent(r.ticker)}`} className="cp-tkr"
          onClick={pickTicker}
          title={onPick ? `Load ${r.ticker} in the linked Terminal panels` : undefined}
          style={{ fontSize: 13.5, fontWeight: 800, color: C.ink, textDecoration: 'none' }}>{r.ticker}</a>
        <span style={{ fontSize: 12.5, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
          {/* ⚠️ TWO DECIMALS TURNS A REAL SUB-PENNY PRICE INTO "$0.00". ADTX last traded at
              $0.0046 and the card printed $0.00 beside a percentage move — a row stating a price
              of zero for a security that has one. Sub-dollar prices keep the digits that carry
              their value; a dollar and above is unchanged at two decimals. Nothing is rounded INTO
              existence: a null price is still an em dash. */}
          {Number.isFinite(r.last)
            ? `$${r.last >= 1 ? r.last.toFixed(2) : r.last.toPrecision(2)}`
            : '—'}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: moveColor, fontVariantNumeric: 'tabular-nums' }}>
          {Number.isFinite(r.changePct) ? `${up ? '+' : ''}${r.changePct.toFixed(1)}%` : '—'}
        </span>
        {/* Never hidden, never abbreviated away. */}
        {r.freshnessLabel && (
          <Badge size="xs">{r.freshnessLabel}</Badge>
        )}
      </div>

      {/* ⚠️ A FIELD IS PRINTED ONLY WHEN IT HAS SOMETHING TO SAY.
          Every row used to render all three labels, so a price-first mover with no filing behind it
          read "STRUCTURE —  EVIDENCE —  JOIN NO REACTION": three lines, none of them informative
          and one of them false. An empty field advertises what we do not have. The JOIN line stays
          on every row because it is never empty — with no evidence it now says so explicitly. */}
      <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: '2px 8px', marginTop: 7 }}>
        {r.structure?.length > 0 && (
          <>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>STRUCTURE</span>
            <span style={{ fontSize: 11.5, color: C.text }}>{r.structure.join(' · ')}</span>
          </>
        )}

        {r.evidence && (
          <>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>EVIDENCE</span>
            <span style={{ fontSize: 11.5, color: C.text, overflowWrap: 'anywhere' }}>{r.evidence}</span>
          </>
        )}

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

/**
 * ONE BOARD. Used on its own by /scan (three stacked) and behind tabs in the Terminal panel.
 * There is exactly one Row design and one fetch path; the two surfaces differ only in arrangement.
 */
export function ScanBoard({ board, title, onState, onPick }) {
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
        // The page-level banner needs the feed state, and it must come from the response rather
        // than from an assumption made in the page.
        if (onState) onState(j);
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
      {title && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.6px', color: C.ink }}>
            {title.toUpperCase()}
          </span>
          {state && (
            <span style={{ fontSize: 10.5, color: C.dim }}>
              {rows.length} {rows.length === 1 ? 'name' : 'names'}
            </span>
          )}
        </div>
      )}

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
            <Row key={r.ticker} r={r} onWatch={watch} onAlert={alert} busy={busy} onPick={onPick} />
          ))}
        </div>
      )}

      {toast && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.muted }}>{toast}</div>
      )}
    </div>
  );
}

/**
 * THE TERMINAL ARRANGEMENT — the same boards behind tabs, because a panel has one board's worth of
 * height. /scan stacks all three instead. Same component, same API, same row.
 */
export default function ScanBoardRows({ onPick } = {}) {
  const [board, setBoard] = useState('catalysts-now');
  const [feed, setFeed] = useState(null);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif" }}>
      {/* Stated at the top of the panel, and again on every row. */}
      <FeedBanner freshness={feed} compact />

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
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
      </div>
      <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 10, lineHeight: 1.45 }}>
        {BOARD_TABS.find((t) => t.key === board)?.blurb}
      </div>

      <ScanBoard board={board} onState={(j) => setFeed(j?.freshness || null)} onPick={onPick} />
    </div>
  );
}

export { BOARD_TABS };
