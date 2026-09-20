import { buildBoard, BOARDS, BOARDS_VERSION } from './boards.mjs';
import { toScanRows, servedRow, SCAN_ROWS_VERSION } from './scan-rows.mjs';
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
// ⚠️ AND IT INVENTS NOTHING. No RVOL — there is no consolidated volume on this feed, and a ratio
// computed against a different methodology would be a fabrication. No intraday structure — there
// are no intraday bars in the database. Every row shows what the entitled feed actually said, with
// the freshness of that number printed beside it.

export const DEFAULT_BOARD = 'catalysts-now';
export const DEFAULT_LIMIT = 25;

/** The board payload, or `{ degraded: true }` when the evidence board cannot be read. */
export async function buildScanBoardPayload({ board = DEFAULT_BOARD, limit = DEFAULT_LIMIT } = {}) {
  const boardId = BOARDS.includes(board) ? board : DEFAULT_BOARD;
  const cap = Math.min(Number(limit) || DEFAULT_LIMIT, 50);

  // 1. ENTITLEMENT FIRST. `realtime` narrows what may be served and can never widen it: getQuotes
  //    only returns live data when the account is actually entitled, which it is not today, so
  //    every row ends up labelled with the freshness it really has.
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

  // 3. QUOTES, through the entitlement boundary.
  let quotes = {};
  try {
    const { getQuotes } = await import('../market-data');
    quotes = (await getQuotes(symbols, { realtime })) || {};
  } catch {
    // No quotes is not no board: the evidence boards remain fully meaningful without a price.
    quotes = {};
  }

  const scanRows = toScanRows(consensusRows, quotes);
  const built = buildBoard(boardId, scanRows, { limit: cap });

  // The freshness actually being served, taken from the quotes rather than from hope.
  const freshnesses = new Set(scanRows.map((r) => r.display.freshness));
  const freshness = freshnesses.size === 1 ? [...freshnesses][0] : 'eod';

  return {
    board: boardId,
    version: BOARDS_VERSION,
    rowsVersion: SCAN_ROWS_VERSION,
    consensusStatus: status,
    consensusBuiltAt: payload.builtAt ?? null,
    readiness: scanReadiness(activeCapabilities()),
    // ⚠️ SAID OUT LOUD. With realtime unentitled this is the last completed session's move, and a
    // board called "moving now" must not imply otherwise.
    freshness,
    freshnessLabel: scanRows[0]?.display?.freshnessLabel ?? 'LAST CLOSE',
    calculatedAt: built.calculatedAt ?? new Date().toISOString(),
    // ⚠️ ONE REASON PER ROW — see servedRow() in scan-rows.mjs for why the evidence line leads.
    rows: built.rows.map(servedRow),
    // Kept so "why is this NOT here" is answerable too, which is half of trusting a board.
    rejected: built.rejected,
    degraded: false,
  };
}
