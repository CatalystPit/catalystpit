// PIT SCAN V1 — THE THREE BOARDS.
//
// One question: WHAT IS MOVING RIGHT NOW, AND WHY?
//
//   MOVING NOW      price-first    a real structure event, with the best available explanation
//   CATALYSTS NOW   evidence-first fresh material evidence, whether or not price has moved yet
//   DIVERGENCE      the join       market reaction disagreeing with the public-evidence lean
//
// Pure: no database, no network, no clock. Membership and ranking are functions of a row, so both
// are testable without fixtures and a board can be explained line by line. That is the point —
// "why is this here?" must have an answer for every row.
//
// ⚠️ NO MASTER PIT SCORE. Each board ranks by what its own purpose cares about, and the ranking
// inputs stay visible on the row. A single opaque number across three different questions would be
// the same mistake the old Consensus score made.
//
// ⚠️ RANKING IS DISCOVERY PRIORITISATION, NOT PREDICTION. Nothing here is fitted against historical
// returns, and doing so would turn an ordering into an unvalidated forecast.

export const BOARDS = Object.freeze(['moving-now', 'catalysts-now', 'divergence']);
export const BOARDS_VERSION = 'pitscan_v1';

export const THRESHOLDS = Object.freeze({
  version: BOARDS_VERSION,

  movingNow: Object.freeze({
    /**
     * ⚠️ A SUB-DOLLAR PRICE IS A PERCENTAGE-MOVE ARTEFACT, NOT A SMALLER COMPANY.
     *
     * This board ranks on the SIZE of the move, and at $0.05 a one-cent tick is 20%. Once Moving
     * Now started ranking the whole eligible universe instead of the evidence board, sub-dollar
     * names took the top of it by arithmetic rather than by significance — the first page was
     * $0.175 and $0.053 tickers while $1+ movers with real moves sat below them.
     *
     * ⚠️ AND IT IS A PRICE FLOOR, NOT A SIZE FILTER. No market cap, no volume, no liquidity score —
     * a small company trading at $3 belongs on this board and is untouched. It removes the one
     * class of row whose percentage cannot mean what the column implies.
     *
     * Moving Now only. Evidence Now and Divergence are evidence-first and keep every price.
     */
    minPrice: 1.00,
    // A move must be big enough to be worth a trader's attention. Below this the "structure event"
    // is noise wearing a label.
    minAbsChangePct: 2.0,
    // …unless a genuine structure signal fired, in which case a smaller move still qualifies: a
    // clean opening-range break at +1.2% is more interesting than a driftless +2.5%.
    minAbsChangePctWithStructure: 0.75,
    // A structure signal older than this is no longer "right now".
    maxStructureAgeMinutes: 90,
  }),

  catalystsNow: Object.freeze({
    // Evidence-first: the catalyst must be both material and fresh. Age is measured from PUBLIC
    // AVAILABILITY, never from the underlying transaction.
    maxAgeHours: 72,
    minMateriality: 0.5,
  }),

  divergence: Object.freeze({
    // Deliberately selective. Divergence is the most interesting board and the easiest to pollute:
    // weak evidence plus a random move is not a disagreement, it is noise with a story attached.
    minActiveFamilies: 2,
    minConfidence: 'Medium',
    minAbsChangePct: 3.0,
    // The evidence lean must be a real lean, not a shrug.
    minAbsDirectionValue: 0.30,
  }),
});

const CONFIDENCE_RANK = { Low: 0, Medium: 1, High: 2 };
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const abs = (n) => (finite(n) ? Math.abs(n) : 0);

/**
 * MOVING NOW — price-first.
 *
 * A row qualifies on a real move, or on a smaller move accompanied by a structure signal that fired
 * recently. Evidence is attached when it exists but is never REQUIRED: this board's job is "what is
 * moving", and a stock can move for reasons no filing explains yet.
 */
export function qualifiesMovingNow(row, { now = Date.now() } = {}) {
  const t = THRESHOLDS.movingNow;
  const move = abs(row?.changePct);
  if (!finite(row?.changePct) || !finite(row?.last)) return no('no-price');
  // ⚠️ STATED, NOT INFERRED FROM THE FLOOR. The $1 floor happens to exclude a zero, so a
  // non-positive price was never REJECTED for being impossible — it was rejected for being small,
  // and the two are different failures. If the floor ever moved or a board without one reused this
  // gate, a $0.00 row would qualify. A price that is not positive is not a price.
  if (row.last <= 0) return no('non-positive-price');
  // ⚠️ A PRICE SEVERAL SESSIONS OLD CANNOT SAY WHAT IS MOVING NOW. The row keeps its evidence on
  // the evidence-first board; it simply cannot claim to be moving today.
  if (row.freshness === 'stale') return no('stale-price');
  // Rejected by NAME, so the row appears in `rejected` with its reason rather than vanishing.
  if (row.last < t.minPrice) return no('sub-dollar');

  const sig = row?.structure || null;
  const sigAgeMin = sig?.at ? (now - new Date(sig.at).getTime()) / 60000 : null;
  const sigFresh = sig && (sigAgeMin == null || sigAgeMin <= t.maxStructureAgeMinutes);

  if (sigFresh && move >= t.minAbsChangePctWithStructure) {
    return yes(`${sig.label} on ${row.changePct.toFixed(1)}%`);
  }
  if (move >= t.minAbsChangePct) return yes(`${row.changePct.toFixed(1)}% move`);
  return no(sig && !sigFresh ? 'structure-stale' : 'move-too-small');
}

/**
 * CATALYSTS NOW — evidence-first.
 *
 * Fresh material evidence qualifies whether or not price has reacted. That is the point: a trader
 * wants the 8-K before the move, not after it.
 *
 * ⚠️ 13F CAN NEVER QUALIFY A ROW HERE. Institutional positioning is background evidence describing a
 * quarter that ended months ago; treating it as a live catalyst would fill this board with every
 * mega-cap every quarter. It is excluded at the source (see catalyst-select.mjs) and re-checked here
 * because the rule matters more than where it is enforced.
 */
export function qualifiesCatalystsNow(row, { now = Date.now() } = {}) {
  const t = THRESHOLDS.catalystsNow;
  const c = row?.catalyst;
  if (!c) return no('no-catalyst');
  if (c.family === 'institutions') return no('13f-is-not-a-catalyst');
  if (!finite(c.materiality) || c.materiality < t.minMateriality) return no('below-materiality');
  if (!c.publicAt) return no('no-public-timestamp');

  const ageH = (now - new Date(c.publicAt).getTime()) / 3600000;
  // Future-dated evidence is a data error, not a very fresh catalyst. Admitting it would let a bad
  // timestamp jump the queue on every board.
  if (!finite(ageH) || ageH < 0) return no('future-dated');
  if (ageH > t.maxAgeHours) return no('stale');

  return yes(`${c.label} · ${formatAge(ageH)}`);
}

/**
 * DIVERGENCE — the join, and the only board that needs both sides.
 *
 * Market reaction against the public-evidence lean. Every gate below exists to stop a coincidence
 * being sold as a disagreement.
 *
 * ⚠️ CONSENSUS MUST BE V1 AND MUST NEVER BE THE OLD SCORE. The legacy 0-100 confluence number had no
 * direction, no confidence and no family count — nothing this board needs — so a row whose consensus
 * is not `consensus_v1` is refused rather than coerced.
 */
export function qualifiesDivergence(row, { now = Date.now() } = {}) {
  const t = THRESHOLDS.divergence;
  const k = row?.consensus;
  if (!k) return no('no-consensus');
  if (k.version !== 'consensus_v1') return no('legacy-consensus-refused');
  if (!finite(row?.changePct)) return no('no-price');
  // A disagreement needs a CURRENT reaction to disagree with. A stale last-known price is not one,
  // so it can neither create a divergence nor rule one out.
  if (row.freshness === 'stale') return no('stale-price');

  if ((k.activeCount ?? 0) < t.minActiveFamilies) return no('too-few-families');
  if ((CONFIDENCE_RANK[k.confidence] ?? -1) < CONFIDENCE_RANK[t.minConfidence]) return no('confidence-too-low');
  if (abs(k.directionValue) < t.minAbsDirectionValue) return no('evidence-lean-too-weak');
  if (abs(row.changePct) < t.minAbsChangePct) return no('move-too-small');

  // The disagreement itself: evidence and tape pointing opposite ways.
  const evidenceUp = k.directionValue > 0;
  const priceUp = row.changePct > 0;
  if (evidenceUp === priceUp) return no('evidence-and-price-agree');

  return yes(evidenceUp
    ? `Bullish evidence, price ${row.changePct.toFixed(1)}%`
    : `Bearish evidence, price +${row.changePct.toFixed(1)}%`);
}

const yes = (why) => ({ ok: true, why });
const no = (reason) => ({ ok: false, reason });

export function formatAge(hours) {
  if (!finite(hours) || hours < 0) return '';
  const m = Math.round(hours * 60);
  if (m < 60) return `${m}m`;
  if (m < 60 * 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// ── RANKING ──────────────────────────────────────────────────────────────────
// Explicit per board, and every input is a field already on the row, so an ordering can be explained
// by pointing at the row rather than at a model.

/** Magnitude of the move, then whether we can explain it, then how fresh the explanation is. */
export function scoreMovingNow(row, { now = Date.now() } = {}) {
  const move = abs(row?.changePct);
  const hasCatalyst = row?.catalyst ? 1 : 0;
  const catalystAgeH = row?.catalyst?.publicAt ? (now - new Date(row.catalyst.publicAt).getTime()) / 3600000 : null;
  const freshness = catalystAgeH == null ? 0 : Math.max(0, 1 - catalystAgeH / THRESHOLDS.catalystsNow.maxAgeHours);
  const structure = row?.structure ? (row.structure.weight ?? 1) : 0;
  return move + structure * 0.5 + hasCatalyst * 1.5 + freshness * 1.5;
}

/** Materiality and freshness lead; the market's reaction is context, not the ranking. */
export function scoreCatalystsNow(row, { now = Date.now() } = {}) {
  const c = row?.catalyst;
  if (!c) return 0;
  const ageH = c.publicAt ? (now - new Date(c.publicAt).getTime()) / 3600000 : THRESHOLDS.catalystsNow.maxAgeHours;
  const freshness = Math.max(0, 1 - ageH / THRESHOLDS.catalystsNow.maxAgeHours);
  const quality = finite(c.quality) ? c.quality : 0.5;
  // Reaction is a small tiebreaker only — this board exists to surface evidence BEFORE the move.
  return (c.materiality ?? 0) * 3 + freshness * 2 + quality + Math.min(1, abs(row?.changePct) / 10);
}

/** How strong the disagreement is: evidence conviction × move size, weighted by confidence. */
export function scoreDivergence(row) {
  const k = row?.consensus;
  if (!k) return 0;
  const confWeight = (CONFIDENCE_RANK[k.confidence] ?? 0) + 1;
  return abs(k.directionValue) * abs(row?.changePct) * confWeight;
}

const SCORERS = {
  'moving-now': scoreMovingNow,
  'catalysts-now': scoreCatalystsNow,
  'divergence': (row) => scoreDivergence(row),
};
const QUALIFIERS = {
  'moving-now': qualifiesMovingNow,
  'catalysts-now': qualifiesCatalystsNow,
  'divergence': qualifiesDivergence,
};

/**
 * Build one board from candidate rows.
 *
 * ONE TICKER, ONE ROW. Candidates are deduplicated by symbol before ranking — several 8-Ks on the
 * same day must not become several rows, which would push everything else off the board and read as
 * three separate events.
 */
export function buildBoard(board, rows, { now = Date.now(), limit = 50 } = {}) {
  if (!BOARDS.includes(board)) return { board, version: BOARDS_VERSION, rows: [], rejected: [] };
  const qualify = QUALIFIERS[board];
  const score = SCORERS[board];

  const bySymbol = new Map();
  const rejected = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const symbol = row?.symbol;
    if (!symbol) continue;
    const verdict = qualify(row, { now });
    if (!verdict.ok) { rejected.push({ symbol, reason: verdict.reason }); continue; }
    const scored = { ...row, boardReason: verdict.why, boardScore: score(row, { now }) };
    // Keep the strongest instance of a symbol rather than the first seen, so dedup is deterministic
    // regardless of input order.
    const prev = bySymbol.get(symbol);
    if (!prev || scored.boardScore > prev.boardScore) bySymbol.set(symbol, scored);
  }

  const out = [...bySymbol.values()].sort((a, b) =>
    (b.boardScore - a.boardScore) || String(a.symbol).localeCompare(String(b.symbol)));

  return {
    board,
    version: BOARDS_VERSION,
    calculatedAt: new Date(now).toISOString(),
    rows: out.slice(0, limit),
    rejected,
  };
}
