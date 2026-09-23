'use client';

// ONE EVIDENCE SETUP.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// The V2.1 row led with a state label — POSITIVE ALIGNMENT, BALANCED CONFLICT — and a strip of
// chips reading "Institutions Positive", "Market Diverging". A trader learned the shape of a vote
// and nothing else: not what price did, not what it was diverging from, not that 448 managers held
// the stock against 433 a quarter earlier.
//
// This card leads with the SETUP — the research question — and then shows the facts that produced
// it. The hierarchy is fixed and deliberate:
//
//     SETUP            why this is a question at all
//     WHY THIS IS HERE one deterministic sentence answering it
//     KEY FACTS        the two strongest families, in their own numbers
//     MARKET           what price actually did, measured from public time
//     (expand)         every family, both clocks, historical context, verification
//
// ── COLOUR ──────────────────────────────────────────────────────────────────
//
// Direction carries colour; setup type does not. Seven archetypes each with their own hue would be
// a rainbow, and the reader would be decoding a legend instead of reading evidence. The setup badge
// is a neutral chip; green and red mean what they have always meant here.

import { useState } from 'react';
import { C, TickerLogo } from '../../lib/cp-shared';

const DIR = {
  POSITIVE: { fg: C.green, bg: C.greenLight, label: 'Positive' },
  NEGATIVE: { fg: C.red, bg: C.negBg, label: 'Negative' },
  MIXED: { fg: C.muted, bg: C.surface, label: 'Mixed' },
};

// ⚠️ WHERE PRICE SITS RELATIVE TO THE READING — an axis, never a vote. "Price has not moved yet"
// was previously buried as a footnote on three of five public rows; it is the most useful thing on
// the card, because evidence pointing somewhere before the move is the whole proposition.
const PRICE_UI = {
  EARLY:      { label: 'Price has not moved yet', fg: C.ink },
  CONFIRMING: { label: 'Price moving with it', fg: C.green },
  DIVERGING:  { label: 'Price moving against it', fg: C.red },
  EXTENDED:   { label: 'Move already made', fg: C.muted },
  UNKNOWN:    { label: '', fg: C.muted },
};

// MARKET IS SECONDARY. No ticker is forced into confirming or diverging: inside the dead zone, or
// with no recent public event to measure from, the honest answer is that there was no meaningful
// reaction — a real state, not a missing one.
const MARKET_UI = {
  CONFIRMING: { label: 'Confirming', fg: C.green },
  DIVERGING: { label: 'Diverging', fg: C.conflictAccent },
  NO_REACTION: { label: 'No meaningful reaction', fg: C.muted },
  NOT_MEASURED: { label: 'Not measured', fg: C.dim },
  MIXED: { label: 'Mixed', fg: C.muted },
  UNAVAILABLE: { label: 'Unavailable', fg: C.dim },
};

const FAM_ORDER = ['catalyst', 'insider', 'congress', 'institution'];

/** One family block: the engine's sentence, its own numbers, both clocks, context, verification. */
function FamilyBlock({ f, compact }) {
  const dirColor = f.direction === 'positive' ? C.green
    : f.direction === 'negative' ? C.red : C.muted;
  return (
    <div style={{ marginTop: compact ? 8 : 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.7px', color: C.dim }}>
          {f.familyLabel}
        </span>
        {/* Catalyst direction is `unknown` on most 8-K records; a chip is shown only when the
            record genuinely carries a direction, never as a neutral-looking placeholder. */}
        {f.direction && f.direction !== 'unknown' && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: dirColor }}>
            {f.direction.toUpperCase()}
          </span>
        )}
        {f.unusual && (
          <span style={{ fontSize: 9, fontWeight: 700, color: C.conflictAccent,
            background: C.conflictBg, border: `1px solid ${C.conflictBorder}`,
            borderRadius: 3, padding: '1px 5px', letterSpacing: '0.4px' }}>UNUSUAL</span>
        )}
      </div>
      {f.headline && (
        <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.4 }}>{f.headline}</div>
      )}
      {!compact && f.lines?.map((l, i) => (
        <div key={i} style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.45 }}>{l}</div>
      ))}
      {/* BOTH CLOCKS. "Traded Aug 7 · disclosed 31 days later" is the point-in-time fact. */}
      {f.dates && (
        <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>{f.dates}</div>
      )}
      {f.context && (
        <div style={{ fontSize: 11.5, color: C.conflictAccent, marginTop: 2, lineHeight: 1.4 }}>
          {f.context}
        </div>
      )}
      {!compact && (
        <div style={{ fontSize: 10.5, color: C.dim, marginTop: 2 }}>
          Public {f.publicAgo}
          {/* Only ever the stored canonical URL. Institutions have none — there is no per-ticker
              13F document — and a fabricated link that does not open the filing looks like
              verification, which is worse than no link at all. */}
          {f.url
            ? <> · <a href={f.url} target="_blank" rel="noopener noreferrer"
              style={{ color: C.green, textDecoration: 'none', fontWeight: 600 }}>Verify →</a></>
            : null}
        </div>
      )}
    </div>
  );
}

export default function SetupCard({ row }) {
  const [open, setOpen] = useState(false);
  const s = row?.setup;
  const k = row?.canonical;
  if (!s) return null;

  const dir = DIR[s.direction] || DIR.MIXED;
  // ⚠️ THE READING IS THE HEADLINE. Falls back to the legacy direction so a row materialised by an
  // older board version still renders rather than blanking.
  const rd = row?.reading ?? null;
  const readingUI = rd ? (DIR[rd.reading] || null) : null;
  const priceUI = rd?.price ? PRICE_UI[rd.price] : null;
  // The SECONDARY market state, not V2.1's structure verdict.
  const market = MARKET_UI[s.marketState] || MARKET_UI[row.market?.verdict] || MARKET_UI.UNAVAILABLE;
  const fams = FAM_ORDER.filter((f) => row.families?.[f]?.length);

  // The two strongest families by default. The engine already ranked them; this only truncates.
  const shown = open ? fams : fams.slice(0, 2);

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
      padding: '13px 15px' }}>

      {/* ── SETUP: the research question, first ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
        <TickerLogo symbol={row.ticker} size={28} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <a href={`/ticker/${encodeURIComponent(row.ticker)}`} className="cp-tkr"
              style={{ fontSize: 15, fontWeight: 800, color: C.ink, textDecoration: 'none' }}>
              {row.ticker}
            </a>
            <span style={{ fontSize: 11, fontWeight: 700, color: C.ink, background: C.surface,
              border: `1px solid ${C.border2}`, borderRadius: 4, padding: '2px 8px',
              letterSpacing: '0.2px' }}>
              {s.label}
            </span>
            {s.whyNowAgo && (
              <span style={{ fontSize: 10.5, color: C.dim }}>trigger {s.whyNowAgo}</span>
            )}
          </div>

          {/* Direction is SECONDARY — useful, never the headline. */}
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4, display: 'flex',
            gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ color: (readingUI || dir).fg, fontWeight: 700 }}>{(readingUI || dir).label}</b>
            {rd?.agreement?.total > 0 && (
              <>
                <span>·</span>
                <span>{rd.agreement.agree} of {rd.agreement.total} source{rd.agreement.total === 1 ? '' : 's'}</span>
              </>
            )}
            {priceUI?.label && (
              <>
                <span>·</span>
                <b style={{ color: priceUI.fg, fontWeight: 700 }}>{priceUI.label}</b>
              </>
            )}
            <span>·</span>
            <span>{k?.confidence ?? '—'} confidence</span>
          </div>
        </div>
      </div>

      {/* ── WHY THIS IS HERE — deterministic, from the same objects rendered below ── */}
      {row.why && (
        <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5, marginTop: 10,
          paddingLeft: 10, borderLeft: `2px solid ${C.border2}` }}>
          {row.why}
        </div>
      )}

      {/* ── KEY FACTS ── */}
      <div style={{ marginTop: 6 }}>
        {shown.map((fam) => row.families[fam].map((f) => (
          <FamilyBlock key={f.evidenceId} f={f} compact={!open} />
        )))}
      </div>

      {/* ── MARKET STRUCTURE — what price actually did, from public time ── */}
      {(row.market?.lines?.length > 0 || row.market?.explain) && (
        <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${C.surface}` }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.7px', color: C.dim }}>
            MARKET STRUCTURE · <span style={{ color: market.fg }}>{market.label.toUpperCase()}</span>
          </div>
          {row.market.lines.slice(0, open ? 9 : 2).map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: C.text, lineHeight: 1.45 }}>{l}</div>
          ))}
          {open && row.market.explain && (
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{row.market.explain}</div>
          )}
          {open && (
            // Stated plainly so nothing here is mistaken for live intraday data.
            <div style={{ fontSize: 10, color: C.dim, marginTop: 5, lineHeight: 1.45 }}>
              {row.market.basis}
            </div>
          )}
        </div>
      )}

      {/* ── ACTIONS ── */}
      <div style={{ display: 'flex', gap: 14, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={`/ticker/${encodeURIComponent(row.ticker)}`}
          style={{ fontSize: 11.5, fontWeight: 700, color: C.green, textDecoration: 'none' }}>
          Open evidence →
        </a>
        <button type="button" onClick={() => setOpen((v) => !v)}
          style={{ fontSize: 11, color: C.muted, background: 'none', border: 'none', padding: 0,
            cursor: 'pointer', fontFamily: 'inherit' }}>
          {open ? 'Hide detail' : 'Full evidence'} {open ? '▴' : '▾'}
        </button>
        {s.secondary?.length > 0 && (
          <span style={{ fontSize: 10.5, color: C.dim }}>
            Also: {s.secondary.map((x) => x.replace(/_/g, ' ').toLowerCase()).join(', ')}
          </span>
        )}
        {row.degraded && (
          // An engine failure is not an absence of evidence, and the card says which part is missing.
          <span style={{ fontSize: 10.5, color: C.conflictAccent }}>
            {row.failedFamilies?.join(', ')} evidence unavailable
          </span>
        )}
      </div>
    </div>
  );
}
