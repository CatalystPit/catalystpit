'use client';
import { useMemo } from 'react';
import { C } from '../../lib/cp-shared';

// POSITIVE AND NEGATIVE CLUSTERS — the board at a glance.
//
// ⚠️ WHY THIS EXISTS. A flat list worked at 29 rows and does not at 93. Direction is the right
// axis to group on because it is now the thing the product actually says, and the eye can read two
// clusters far faster than it can scan a column of cards.
//
// ⚠️ SIZE IS AGREEMENT, NOT MARKET CAP. Sizing by market cap would make this a second heatmap and
// would put a mega-cap tile beside a microcap regardless of the evidence — reintroducing the size
// bias the research explicitly warns about ("the strongest structure in the data is market cap,
// not either signal"). Here the only thing that makes a bubble bigger is more independent sources
// agreeing, so a five-insider cluster at a $400M company outranks a single filing at a mega-cap.
// That is the differentiated view and the reason to look at this page rather than a screener.
//
// ⚠️ AND "PRICE HAS NOT MOVED YET" IS THE LOUDEST STATE. Evidence pointing somewhere before the
// move is the only condition in which any of this is actionable, so EARLY rows carry a ring. A row
// whose move has already happened is deliberately muted — it is the least useful thing here, and
// showing it at full strength would flatter the board.

const TIER_SIZE = { STRONG: 108, CONFIRMED: 82, SINGLE: 58 };

/** Colour by direction; opacity by how much independent agreement is behind it. */
function bubbleStyle(row) {
  const rd = row.reading;
  const up = rd.direction === 'up';
  const size = TIER_SIZE[rd.tier] || TIER_SIZE.SINGLE;
  const strength = rd.tier === 'STRONG' ? 1 : rd.tier === 'CONFIRMED' ? 0.82 : 0.6;
  const extended = rd.price === 'EXTENDED';
  return {
    width: size, height: size,
    borderRadius: '50%',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 1,
    textDecoration: 'none',
    background: up ? C.greenLight : C.negBg,
    color: up ? C.green : C.red,
    // ⚠️ THE RING MARKS AN UNPRICED MOVE, which is the only state worth acting on.
    border: rd.price === 'EARLY'
      ? `2px solid ${up ? C.green : C.red}`
      : `1px solid ${C.border2}`,
    opacity: extended ? 0.45 : strength,
    transition: 'transform 120ms ease',
  };
}

function Cluster({ title, rows, tone }) {
  if (!rows.length) return null;
  const strong = rows.filter((r) => r.reading.tier === 'STRONG').length;
  return (
    <div style={{ flex: '1 1 320px', minWidth: 0, border: `1px solid ${C.border2}`,
      borderRadius: 10, background: C.surface, padding: '12px 14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.4px', color: tone }}>
          {title}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{rows.length}</span>
        {strong > 0 && (
          <span style={{ fontSize: 10.5, color: C.muted }}>
            · {strong} with 3+ sources agreeing
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {rows.map((r) => (
          <a key={r.ticker} href={`/ticker/${encodeURIComponent(r.ticker)}`}
            title={`${r.ticker} — ${r.reading.label}, ${r.reading.agreement.agree} of ${r.reading.agreement.total} sources. ${r.reading.priceLabel}. ${r.reading.why || ''}`}
            style={bubbleStyle(r)}>
            <span style={{ fontSize: 13, fontWeight: 800, lineHeight: 1 }}>{r.ticker}</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, opacity: 0.85, lineHeight: 1 }}>
              {r.reading.agreement.agree}/{r.reading.agreement.total}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * @param rows the board rows, already filtered/sorted by the page
 */
export default function ConsensusClusters({ rows = [] }) {
  const { pos, neg, quiet } = useMemo(() => {
    // ⚠️ ONLY ROWS THAT NAME A DIRECTION GET A BUBBLE. INSUFFICIENT is the majority of the board
    // and putting it here as a grey blob would make the clusters read as mostly-nothing, which is
    // both ugly and a misrepresentation — those rows are not weak signals, they are rows where we
    // decline to give one. They stay in the card list below, where their reason can be read.
    const directional = rows.filter((r) => r?.reading?.direction);
    const order = { STRONG: 0, CONFIRMED: 1, SINGLE: 2 };
    const by = (a, b) => (order[a.reading.tier] - order[b.reading.tier])
      || (b.reading.agreement.agree - a.reading.agreement.agree)
      || a.ticker.localeCompare(b.ticker);
    return {
      pos: directional.filter((r) => r.reading.direction === 'up').sort(by),
      neg: directional.filter((r) => r.reading.direction === 'down').sort(by),
      quiet: rows.length - directional.length,
    };
  }, [rows]);

  if (!pos.length && !neg.length) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Cluster title="POSITIVE" rows={pos} tone={C.green} />
        <Cluster title="NEGATIVE" rows={neg} tone={C.red} />
      </div>
      <div style={{ fontSize: 10.5, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
        Bubble size is how many independent sources agree — never company size. A ring means the
        price has not moved yet.
        {quiet > 0 && ` ${quiet} further ${quiet === 1 ? 'company carries' : 'companies carry'} evidence that does not name a direction; ${quiet === 1 ? 'it is' : 'they are'} listed below.`}
      </div>
    </div>
  );
}
