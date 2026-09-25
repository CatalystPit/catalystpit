import { BOARDS, BOARDS_VERSION } from '../../../lib/scan/boards.mjs';
import { buildScanBoardPayload, buildAllScanBoards, DEFAULT_BOARD, DEFAULT_LIMIT } from '../../../lib/scan/board-payload';
import { apiRateLimit } from '../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;

// PIT SCAN BOARDS — the three boards, fed.
//
// The building lives in lib/scan/board-payload.js so that this route and /api/pitscan cannot drift
// into two different answers about what is on the board. See that file for the read-never-computes
// and invents-nothing rules; this route is now only the HTTP edge.
//
// ── ⚠️ ?board=all IS WHY A TAB CLICK IS NOW FREE ────────────────────────────
//
// The three boards are three views of one dataset, and the panel shows one at a time. Fetching them
// one at a time made every tab click a fresh entitlement resolution, a fresh board read and a fresh
// hundred-quote batch from the vendor — the same work, three times, for three views of the same
// hundred tickers. `all` builds them from ONE loadScanContext, so the panel fetches once and the
// tabs are a local state change.
//
// The single-board form is unchanged and still serves /scan, which stacks the three and wants them
// independent.

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * ⚠️ TIMING SHIPS WITH THE ANSWER, RATHER THAN BEING ADDED WHEN SOMETHING IS ALREADY SLOW.
 *
 * Server-Timing is a standard header, it costs nothing, and it appears in the browser's network
 * panel beside the request it describes. Production was taking twenty seconds and the only way to
 * find out where was to guess, redeploy and guess again; this is the difference between measuring
 * and speculating, and it stays on.
 */
const timing = (marks) => ({
  'Server-Timing': marks.map(([name, ms]) => `${name};dur=${Math.round(ms)}`).join(', '),
});

export async function GET(request) {
  const t0 = Date.now();
  const rl = await apiRateLimit(request, 'scan-board', 'provider');
  if (rl) return rl;
  const tGuard = Date.now();

  const sp = new URL(request.url).searchParams;
  const board = sp.get('board') || DEFAULT_BOARD;
  const limit = Number(sp.get('limit')) || DEFAULT_LIMIT;

  try {
    if (board === 'all') {
      const out = await buildAllScanBoards({ limit });
      const headers = {
        ...NO_STORE,
        ...timing([['guard', tGuard - t0], ['boards', Date.now() - tGuard], ['total', Date.now() - t0]]),
      };
      // Degraded means the EVIDENCE BOARD could not be read — every view is affected, so the status
      // is about the request rather than about one tab.
      return Response.json({ boards: out.boards, degraded: out.degraded, version: BOARDS_VERSION },
        { status: out.degraded ? 503 : 200, headers });
    }

    const payload = await buildScanBoardPayload({ board, limit });
    const headers = {
      ...NO_STORE,
      ...timing([['guard', tGuard - t0], ['board', Date.now() - tGuard], ['total', Date.now() - t0]]),
    };
    // A board we could not read is served as 503 with its reason, never as an empty board.
    return Response.json(payload, { status: payload.degraded ? 503 : 200, headers });
  } catch (e) {
    console.error(`[scan-board] ${e.message}`);
    const body = {
      version: BOARDS_VERSION, degraded: true,
      message: 'Pit Scan is temporarily unavailable.',
    };
    // ⚠️ THE ERROR KEEPS THE SHAPE THE CALLER ASKED FOR. A client that requested every board and got
    // back a single-board error object has to special-case the failure, and the one that forgets is
    // the one that renders a loading spinner forever.
    const shaped = board === 'all'
      ? { ...body, boards: Object.fromEntries(BOARDS.map((b) => [b, { board: b, rows: [], rejected: [], degraded: true, message: body.message }])) }
      : { ...body, board, rows: [], rejected: [] };
    return Response.json(shaped, { status: 503, headers: { ...NO_STORE, ...timing([['total', Date.now() - t0]]) } });
  }
}
