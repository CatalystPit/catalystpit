import { buildBoard, BOARDS, BOARDS_VERSION, THRESHOLDS } from './boards.mjs';
import { toScanRows, servedRow, freshnessLabel, aggregateFreshness, JOIN_LINE, SCAN_ROWS_VERSION } from './scan-rows.mjs';
import { MAJOR_MOVE_PCT } from './mover-catalyst.mjs';
import { readPublishedBoard } from '../consensus/refresh';
import { scanReadiness, activeCapabilities } from './runtime';
import { resolveUserAccess, isRealtime } from '../entitlements';

// THE ONE PLACE A SCAN BOARD IS BUILT.
//
// There were two Scan endpoints and only one of them was real. /api/scan-board read the published
// Consensus board and ranked it; /api/pitscan returned `rows: []` — a literal, hard-coded empty
// list, because the signal engine it was written for has never had a feed. Two endpoints named
// after the same product, one of them always answering "nothing", is exactly the failure this
// scanner exists to refuse: an empty table reads as a quiet market, not as a missing wire.
//
// So both routes now come through here. /api/pitscan keeps its own self-description (which signals
// can run, which cannot and why, presets, columns) because that honesty surface is the reason it
// exists — but its ROWS are these rows. There is one board, one ranking, one clock.
//
// ⚠️ A READ NEVER COMPUTES. readPublishedBoard(), never rebuildBoard(), and evidence is never
// resolved here. Consensus recomputes on new public evidence or on its decay job; a Scan visitor
// cannot trigger either, however many of them arrive at once.
//
// ⚠️ AND IT INVENTS NOTHING. No RVOL. The consolidated feed does carry a volume, but it is the
// day's CUMULATIVE figure rather than an interval's, so the provider read drops it instead of
// relabelling it — a ratio built on a number that does not mean what its name suggests is a
// fabrication whether or not the arithmetic is right. No intraday structure either: there are no
// intraday bars in this database, so premarket highs, opening ranges and VWAP stay absent rather
// than approximated. Every row shows what the entitled feed actually said, with the freshness of
// that number printed beside it.

export const DEFAULT_BOARD = 'catalysts-now';
export const DEFAULT_LIMIT = 25;

/**
 * How many of the market's largest movers Moving Now ranks before the board's own gates run.
 *
 * ⚠️ A POOL, NOT A BOARD SIZE. qualifiesMovingNow still decides membership and the caller still
 * caps the served rows; this only bounds how much of the snapshot is converted into row objects.
 * Large enough that the board is drawn from the real market rather than a sliver of it, small
 * enough that a request never maps twenty thousand symbols.
 */
export const MOVER_POOL = 200;

/** The board payload, or `{ degraded: true }` when the evidence board cannot be read. */
export async function buildScanBoardPayload({ board = DEFAULT_BOARD, limit = DEFAULT_LIMIT } = {}) {
  const boardId = BOARDS.includes(board) ? board : DEFAULT_BOARD;
  const cap = Math.min(Number(limit) || DEFAULT_LIMIT, 50);

  // 1. ENTITLEMENT FIRST. `realtime` narrows what may be served and can never widen it.
  //
  //    ⚠️ THIS NOW DECIDES SOMETHING REAL. It used to be near-decorative: the account had no
  //    realtime entitlement, so every path returned completed-session data and the flag only chose
  //    which label to print. The consolidated feed IS entitled, so this flag is now the boundary
  //    between a live price and a delayed one, and it is resolved server-side before any price is
  //    fetched rather than applied to a payload that already contains one.
  let realtime = false;
  try {
    const { tier, beta } = await resolveUserAccess();
    realtime = isRealtime(tier) && !beta;
  } catch { /* signed-out reads as delayed */ }

  // 2. THE PUBLISHED CONSENSUS BOARD — read, never rebuilt.
  const { payload, status } = await readPublishedBoard();
  if (!payload) {
    // An unavailable evidence board is not a quiet market and must never render as one.
    return {
      board: boardId, version: BOARDS_VERSION, rowsVersion: SCAN_ROWS_VERSION,
      readiness: scanReadiness(activeCapabilities()),
      rows: [], rejected: [], degraded: true,
      message: 'The evidence board is unavailable. This is not a statement that nothing is happening.',
    };
  }

  const consensusRows = payload.rows || [];
  const symbols = consensusRows.map((r) => r.ticker).filter(Boolean).slice(0, 100);

  // 3. THE PRICE SIDE — ONE SHARED MARKET SNAPSHOT, GATED ON ENTITLEMENT.
  //
  // ⚠️ THE SNAPSHOT IS ONLY READ FOR AN ENTITLED VIEWER, which is what keeps realtime inside the
  // boundary. An unentitled reader falls through to the same getQuotes path as before and receives
  // the same delayed or completed-session numbers, labelled as such by toScanRow. There is no
  // branch in which a free response contains a consolidated realtime print.
  //
  // ⚠️ AND IT IS ONE REQUEST FOR THE WHOLE MARKET, CACHED SERVER-SIDE. Upstream cost is one call
  // per TTL, not one per viewer and not one per ticker — see market-snapshot.mjs.
  let snapshot = null;
  if (realtime) {
    try {
      const [{ movementSnapshot }, { db }, { sql }] = await Promise.all([
        import('./market-snapshot.mjs'), import('../db'), import('drizzle-orm'),
      ]);
      snapshot = await movementSnapshot(db, sql);
    } catch {
      // A snapshot failure degrades to the quote path; it never empties the board.
      snapshot = null;
    }
  }

  let quotes = {};
  if (snapshot?.rows?.length) {
    for (const r of snapshot.rows) {
      quotes[r.symbol] = { price: r.last, changePct: r.changePct, freshness: 'realtime' };
    }
    // ⚠️ AN ENTITLED BOARD MUST NOT BE LESS COMPLETE THAN A FREE ONE, AND IT WAS.
    //
    // The snapshot is the eligible universe filtered to symbols with a CURRENT print, so a
    // Consensus ticker that is an ADR, a fund, or simply has not traded yet this morning is absent
    // from it. Serving only the snapshot meant those rows reached a Pro reader with no price at
    // all, while a signed-out reader got the completed-session close for the same ticker through
    // getQuotes. Entitlement narrowing what a reader sees is the inverse of what it is for.
    //
    // So the gap is filled from the ordinary quote path, and each of those rows carries its own
    // freshness — 'eod' for a symbol with no current print. That is the honest per-symbol degrade:
    // one ticker without a live quote says so on its own row instead of dragging the whole board's
    // disclosure down with it.
    const missing = symbols.filter((s) => !quotes[s]);
    if (missing.length) {
      try {
        const { getQuotes } = await import('../market-data');
        const rest = (await getQuotes(missing, { realtime })) || {};
        for (const [sym, q] of Object.entries(rest)) if (!quotes[sym]) quotes[sym] = q;
      } catch { /* a gap stays a gap; it never empties the board */ }
    }
  } else {
    try {
      const { getQuotes } = await import('../market-data');
      quotes = (await getQuotes(symbols, { realtime })) || {};
    } catch {
      // No quotes is not no board: the evidence boards remain fully meaningful without a price.
      quotes = {};
    }
  }

  // 4. MOVING NOW RANKS THE MARKET, NOT THE EVIDENCE BOARD.
  //
  // ⚠️ THIS IS THE DEFECT THAT MADE THE BOARD WRONG RATHER THAN MERELY STALE. Every board was built
  // from the published Consensus rows — about a hundred tickers, all of which carry evidence by
  // definition — so a stock could only be "moving now" if a filing already explained it. That
  // inverts the board's question. Price earns the row; evidence is attached when it exists, and a
  // mover with no evidence is a legitimate row rather than an impossible one.
  //
  // The other two boards are evidence-first by design and keep the Consensus board as their source.
  let sourceRows = consensusRows;
  if (boardId === 'moving-now' && snapshot?.rows?.length) {
    const known = new Set(consensusRows.map((r) => String(r.ticker || '').toUpperCase()));
    const movers = [...snapshot.rows]
      // ⚠️ THE FLOOR IS APPLIED BEFORE THE POOL IS SLICED, NOT ONLY AT QUALIFICATION.
      //
      // qualifiesMovingNow is the authority on membership and rejects sub-dollar rows by name. But
      // this pool is the top 200 by move size, and sub-dollar names dominate that ordering by
      // arithmetic — so filtering only downstream would fill the pool with rows destined to be
      // rejected and hand the board a handful of survivors. Same constant, read from the same
      // THRESHOLDS, so the two can never disagree about where the line is.
      .filter((m) => Number.isFinite(m.last) && m.last >= THRESHOLDS.movingNow.minPrice)
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, MOVER_POOL)
      .filter((m) => !known.has(m.symbol))
      // A bare row carries only the ticker: no evidence, no consensus, no catalyst. toScanRow
      // fills the price from the snapshot and leaves every evidence field null, which is exactly
      // what "moving, unexplained" should render as.
      .map((m) => ({ ticker: m.symbol }));
    sourceRows = consensusRows.concat(movers);
  }

  const scanRows = toScanRows(sourceRows, quotes);
  const built = buildBoard(boardId, scanRows, { limit: cap });

  // ── WHY IS IT MOVING? Bounded, server-side, and only for the rows that warrant it ──
  //
  // ⚠️ AFTER buildBoard, NOT BEFORE. Resolution runs on the rows actually SERVED — at most a
  // handful — rather than on every candidate the board considered. And only for major moves with
  // no canonical evidence, because a row that already has evidence has its answer.
  //
  // ⚠️ THE RESULT IS CACHED SERVER-SIDE FOR EVERYBODY. A hundred people opening Pit Scan cost what
  // one costs; there is no per-viewer lookup anywhere in this path.
  if (boardId === 'moving-now' && built.rows?.length) {
    const unmatched = built.rows.filter((r) => !r.display?.evidence
      && Math.abs(r.changePct ?? 0) >= MAJOR_MOVE_PCT);
    if (unmatched.length) {
      try {
        const [{ resolveMoverCatalysts }, { db }, { sql }] = await Promise.all([
          import('./mover-catalyst.mjs'), import('../db'), import('drizzle-orm'),
        ]);
        const found = await resolveMoverCatalysts(db, sql, unmatched.map((r) => r.symbol));
        for (const r of unmatched) {
          if (!(r.symbol in found)) continue;              // never checked — leave it alone
          const hit = found[r.symbol];
          if (hit?.headline) {
            // Promoted onto the card through the same display field evidence uses, so a reader
            // cannot tell a recovered catalyst from a canonical one by its placement — only by the
            // source it names.
            r.display.evidence = hit.headline;
            r.display.catalystSource = hit.source || null;
            r.display.catalystUrl = hit.url || null;
            r.display.catalystPublicTime = hit.publicTime || null;
            // FRESH vs RECENT RELEVANT — the distinction the timing supports, never causation.
            r.display.join = hit.fresh === false ? JOIN_LINE.RECENT_CATALYST : JOIN_LINE.MATCHING_CATALYST;
          } else {
            // ⚠️ CHECKED AND FOUND NOTHING — a different statement from "we hold no record", and
            // the only one of the two worth a trader's attention.
            r.display.join = JOIN_LINE.NO_CATALYST_IDENTIFIED;
          }
        }
      } catch { /* resolution is best effort; the board renders unchanged without it */ }
    }
  }

  // The freshness actually being served, taken from the quotes rather than from hope.
  //
  // ⚠️ FROM THE SERVED ROWS, NOT EVERY ROW CONSIDERED. Moving Now now builds from a market-wide
  // snapshot plus the evidence board, and a Consensus ticker outside the eligible universe has no
  // snapshot price and stays 'eod'. Measured across ALL candidates that single row made the set
  // size 2 and collapsed the whole board's label to LAST CLOSE while every row on screen was live
  // — a disclosure that is wrong in the direction of describing live prices as stale.
  // ⚠️ AND MIXED IS ITS OWN ANSWER — see aggregateFreshness. Collapsing "some live, some not" onto
  // either extreme has now been wrong twice: first to LAST CLOSE, then to 'near', which the label
  // map renders as DELAYED. An entitled reader watching live consolidated prices was told
  // "Delayed quotes — not live" because one row of twenty-five had no current print.
  const freshness = aggregateFreshness((built.rows || []).map((r) => r?.display?.freshness));

  return {
    board: boardId,
    version: BOARDS_VERSION,
    rowsVersion: SCAN_ROWS_VERSION,
    consensusStatus: status,
    consensusBuiltAt: payload.builtAt ?? null,
    readiness: scanReadiness(activeCapabilities()),
    // ⚠️ SAID OUT LOUD, IN WHICHEVER DIRECTION IS TRUE. Unentitled this is the last completed
    // session's move and the board must not imply otherwise; entitled and live, it must not claim
    // to be stale either. The label is derived, never chosen.
    freshness,
    // Derived from the SAME value the disclosure above resolved to, so the badge and the field can
    // never disagree — reading row[0] let one row's provenance speak for the whole board.
    freshnessLabel: freshnessLabel(freshness),
    calculatedAt: built.calculatedAt ?? new Date().toISOString(),
    // ⚠️ ONE REASON PER ROW — see servedRow() in scan-rows.mjs for why the evidence line leads.
    rows: built.rows.map(servedRow),
    // Kept so "why is this NOT here" is answerable too, which is half of trusting a board.
    rejected: built.rejected,
    degraded: false,
  };
}
