'use client';

// ConsensusTeaser — homepage box surfacing the top Pit Consensus names (where insiders,
// Congress, and funds are stacking the same direction). Teaser only: top 3, linking to the
// full board at /consensus.
import { useEffect, useState } from 'react';
import { C, Dot, Skel, TickerLogo } from '../lib/cp-shared';

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
// Everything below therefore reads fields the current board actually emits, and returns null when
// it cannot — the row then points at the board rather than narrating a guess.

// ⚠️ "FAMILY" IS OUR WORD, NOT THE READER'S. The row used to say "2 of 3 families aligned" beside a
// large green "3 / FAMILIES". Nobody outside this codebase knows what a family is, and the number
// was the least useful thing in the widest part of the row. The underlying model is unchanged and
// still called families everywhere it is computed; this is the translation layer at the glass.
const SOURCE_LABEL = {
  insider: 'Insiders', insiders: 'Insiders',
  catalyst: 'Catalyst', catalysts: 'Catalyst',
  institution: 'Institutions', institutions: 'Institutions',
  congress: 'Congress',
  structure: 'Price structure',
};

/** The direction blocks the row carries, as [familyKey, direction] pairs. */
function directionPairs(r) {
  const fams = r?.families;
  if (!fams || typeof fams !== 'object') return [];
  return Object.entries(fams)
    .map(([key, val]) => {
      const block = Array.isArray(val) ? val.find(Boolean) : val;
      return [key, block?.direction];
    })
    .filter(([key, dir]) => SOURCE_LABEL[key] && typeof dir === 'string');
}

/**
 * Which evidence sources point the way the setup points — in the reader's words.
 *
 * ⚠️ NOTHING IS CALLED "ALIGNED" THAT THE ROW DOES NOT SAY IS ALIGNED. The claim is built from the
 * per-family directions on the canonical row and compared against the setup's own direction, so a
 * source that disagrees, or that has no direction at all, can never be counted as agreeing. When
 * the setup itself names no direction (a conflict, a mixed read), the sources are listed WITHOUT
 * the word — "Catalyst + Institutions" is true of a disagreement; "2 sources aligned" is not.
 */
function sourceSummary(r) {
  const pairs = directionPairs(r);
  if (!pairs.length) return null;
  const dir = String(r?.setup?.direction || '').toLowerCase();
  const name = (list) => [...new Set(list.map(([key]) => SOURCE_LABEL[key]))];

  if (dir === 'positive' || dir === 'negative') {
    const agreeing = pairs.filter(([, d]) => d === dir);
    if (agreeing.length >= 3) return `${agreeing.length} evidence sources aligned`;
    if (agreeing.length) return name(agreeing).join(' + ');
  }
  const active = name(pairs);
  return active.length ? active.join(' + ') : null;
}

/**
 * The strongest factual sentence the canonical row already carries. Never composed here.
 *
 * ⚠️ PRECEDENCE, NOT INVENTION. Each branch returns a string the engine wrote: the exceptional-
 * significance reason (always concrete, always carries the number), then the setup's own stated
 * reason, then the driving evidence's summary, then its headline. Four canonical sources in
 * descending specificity — and null when the row carries none of them, which the caller renders as
 * a pointer to the board rather than as a sentence.
 */
function reasonFor(r) {
  const hs = r?.highSignificance;
  if (hs?.high && Array.isArray(hs.reasons)) {
    const hit = hs.reasons.find((x) => typeof x?.reason === 'string' && x.reason.trim());
    if (hit) return hit.reason.trim();
  }
  const setupReason = Array.isArray(r?.setup?.reasons)
    ? r.setup.reasons.find((x) => typeof x === 'string' && x.trim()) : null;
  if (setupReason) return setupReason.trim();
  const sig = Array.isArray(r?._significant)
    ? r._significant.find((s) => typeof s?.evidence?.summary === 'string' && s.evidence.summary.trim()) : null;
  if (sig) return sig.evidence.summary.trim();
  const headline = r?.driver?.headline;
  return typeof headline === 'string' && headline.trim() ? headline.trim() : null;
}

/** The setup the board itself named. Falls back to the state map only if the label is absent. */
function setupLabel(r) {
  return r?.setup?.label || (STATE_UI[r?.state] || STATE_UI.MIXED).label;
}
function setupColor(r) {
  if (r?.setup?.setup === 'CROSS_SOURCE_CONFLICT') return C.conflictAccent;
  return (STATE_UI[r?.state] || STATE_UI.MIXED).color || C.muted;
}
/** How long the reason has been true, in the row's own words. Absent rather than estimated. */
function whyNowAgo(r) {
  const ago = r?.setup?.whyNowAgo;
  return typeof ago === 'string' && ago.trim() ? ago.trim() : null;
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
      {/* ⚠️ THE ROWS ARE THE EXPLANATION NOW. The header carried an "EVIDENCE ALIGNMENT" badge
          that said less than any row beneath it; the space reads better as a title and a way in. */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>PIT CONSENSUS</span>
        <a href="/consensus" style={{ marginLeft: 'auto', fontSize: 11, color: C.green, textDecoration: 'none', fontWeight: 600 }}>
          Full board →
        </a>
      </div>
      <div style={{ padding: 8 }}>
        {rows == null ? (
          <div style={{ padding: 8 }}>{[0, 1, 2].map((i) => <Skel key={i} h={46} mb={i < 2 ? 8 : 0} />)}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '18px 8px', textAlign: 'center', fontSize: 12, color: C.muted, fontWeight: 300 }}>
            {/* Same bar as the board — two independent sources — in the reader's vocabulary. */}
            No ticker currently has qualifying evidence from two or more independent sources.
          </div>
        ) : (
          rows.map((r, i) => {
            const reason = reasonFor(r);
            const sources = sourceSummary(r);
            const ago = whyNowAgo(r);
            return (
              <a key={r.ticker} href={`/ticker/${encodeURIComponent(r.ticker)}`} className="hov"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '9px 8px', borderRadius: 7,
                  textDecoration: 'none', borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
                <span className="cp-num" style={{ width: 16, textAlign: 'center', fontSize: 12, fontWeight: 700,
                  color: C.dim, lineHeight: '24px' }}>{i + 1}</span>
                <TickerLogo symbol={r.ticker} size={24} />
                {/* ⚠️ minWidth:0 IS WHAT LETS THE REASON ELLIPSE. Without it a flex child refuses to
                    shrink below its content and the row pushes the card sideways on a phone. */}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    <span className="cp-tkr" style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{r.ticker}</span>
                    {/* The badge takes the STATE's colour. Hardcoding green painted a conflict row
                        green while its own label said "Conflict". */}
                    <span style={{ fontSize: 9, fontWeight: 700, color: setupColor(r), background: C.surface,
                      border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                      {setupLabel(r)}
                    </span>
                    {/* The age of the reason, right-aligned — the space the big number used to
                        occupy, spent on something the reader can act on. */}
                    {ago && (
                      <span className="cp-num" style={{ marginLeft: 'auto', fontSize: 9.5, color: C.dim,
                        fontWeight: 400, whiteSpace: 'nowrap', paddingLeft: 6 }}>{ago}</span>
                    )}
                  </div>
                  {/* ⚠️ THE REASON CARRIES THE WEIGHT, THE SOURCES SIT UNDER IT. The old row had one
                      muted line of internal arithmetic and a big number; this is the sentence the
                      reader came for, in the row's own words, with the provenance beneath it. */}
                  <div style={{ fontSize: 12, color: C.text, fontWeight: 500, lineHeight: 1.35, marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {/* ⚠️ NO SUMMARY IS BETTER THAN A FALSE ONE. When the row carries no canonical
                        sentence the teaser points at the board rather than writing one — the board
                        is the one place the full setup is always rendered correctly. */}
                    {reason || 'See the full board for this setup →'}
                  </div>
                  {sources && (
                    <div style={{ fontSize: 10, color: C.dim, fontWeight: 300, lineHeight: 1.3, marginTop: 1,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {sources}
                    </div>
                  )}
                </div>
              </a>
            );
          })
        )}
      </div>
    </div>
  );
}
