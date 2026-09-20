import { auth } from '@clerk/nextjs/server';
import { buildBoard, BOARDS, BOARDS_VERSION } from '../../../lib/scan/boards.mjs';
import { toScanRows, SCAN_ROWS_VERSION } from '../../../lib/scan/scan-rows.mjs';
import { readPublishedBoard } from '../../../lib/consensus/refresh';
import { scanReadiness, activeCapabilities } from '../../../lib/scan/runtime';
import { resolveUserAccess, isRealtime } from '../../../lib/entitlements';
import { apiRateLimit } from '../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;

// PIT SCAN BOARDS — the three boards, finally fed.
//
// boards.mjs has been pure, tested and unreachable since it was written: nothing ever handed it
// rows, so Pit Scan returned a hard-coded empty list. This route is the wiring. It reads the
// ALREADY-MATERIALIZED Consensus board, attaches whatever quote the caller is entitled to, and
// runs the existing membership and ranking functions.
//
// ⚠️ A READ NEVER COMPUTES. It calls readPublishedBoard(), not rebuildBoard(), and it never
// resolves evidence. Consensus recomputes on new public evidence or on its decay job; a Scan
// visitor cannot trigger either, however many of them arrive.
//
// ⚠️ AND IT INVENTS NOTHING. No RVOL — there is no consolidated volume on this feed and a ratio
// against a different methodology would be a fabrication. No intraday structure — there are no
// intraday bars in the database. What the row shows is what the entitled feed actually said, with
// the freshness of that number printed next to it.

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const DEFAULT_LIMIT = 25;

export async function GET(request) {
  const rl = await apiRateLimit(request, 'scan-board', 'provider');
  if (rl) return rl;

  const sp = new URL(request.url).searchParams;
  const board = BOARDS.includes(sp.get('board')) ? sp.get('board') : 'catalysts-now';
  const limit = Math.min(Number(sp.get('limit')) || DEFAULT_LIMIT, 50);

  try {
    // 1. ENTITLEMENT FIRST. `realtime` narrows what may be served and can never widen it: getQuotes
    //    only returns live data when the account is actually entitled, which it is not today, so
    //    every row is labelled with the freshness it really has.
    let realtime = false;
    try {
      const { tier, beta } = await resolveUserAccess();
      realtime = isRealtime(tier) && !beta;
    } catch { /* signed-out reads as delayed */ }

    // 2. THE PUBLISHED CONSENSUS BOARD — read, never rebuilt.
    const { payload, status } = await readPublishedBoard();
    if (!payload) {
      // An unavailable evidence board is not a quiet market, and must never render as one.
      return Response.json({
        board, version: BOARDS_VERSION, rowsVersion: SCAN_ROWS_VERSION,
        readiness: scanReadiness(activeCapabilities()),
        rows: [], rejected: [], degraded: true,
        message: 'The evidence board is unavailable. This is not a statement that nothing is happening.',
      }, { status: 503, headers: NO_STORE });
    }

    const consensusRows = payload.rows || [];
    const symbols = consensusRows.map((r) => r.ticker).filter(Boolean).slice(0, 100);

    // 3. QUOTES, through the entitlement boundary.
    let quotes = {};
    try {
      const { getQuotes } = await import('../../../lib/market-data');
      quotes = (await getQuotes(symbols, { realtime })) || {};
    } catch {
      // No quotes is not no board: the evidence boards remain fully meaningful without a price.
      quotes = {};
    }

    const scanRows = toScanRows(consensusRows, quotes);
    const built = buildBoard(board, scanRows, { limit });

    // The freshness actually being served, taken from the quotes rather than from hope.
    const freshnesses = new Set(scanRows.map((r) => r.display.freshness));
    const freshness = freshnesses.size === 1 ? [...freshnesses][0] : 'eod';

    return Response.json({
      board,
      version: BOARDS_VERSION,
      rowsVersion: SCAN_ROWS_VERSION,
      consensusStatus: status,
      consensusBuiltAt: payload.builtAt ?? null,
      readiness: scanReadiness(activeCapabilities()),
      // ⚠️ SAID OUT LOUD. With realtime unentitled this is the last completed session's move, and
      // a board called "moving now" must not imply otherwise.
      freshness,
      freshnessLabel: scanRows[0]?.display?.freshnessLabel ?? 'LAST CLOSE',
      calculatedAt: built.calculatedAt ?? new Date().toISOString(),
      rows: built.rows.map((r) => ({ ...r.display, boardReason: r.boardReason })),
      // Kept so "why is this NOT here" is answerable too, which is half of trusting a board.
      rejected: built.rejected,
    }, { headers: NO_STORE });
  } catch (e) {
    console.error(`[scan-board] ${e.message}`);
    return Response.json({
      board, version: BOARDS_VERSION, rows: [], rejected: [], degraded: true,
      message: 'Pit Scan is temporarily unavailable.',
    }, { status: 503, headers: NO_STORE });
  }
}
