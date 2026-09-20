import { BOARDS_VERSION } from '../../../lib/scan/boards.mjs';
import { buildScanBoardPayload, DEFAULT_BOARD, DEFAULT_LIMIT } from '../../../lib/scan/board-payload';
import { apiRateLimit } from '../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;

// PIT SCAN BOARDS — the three boards, fed.
//
// The building lives in lib/scan/board-payload.js so that this route and /api/pitscan cannot drift
// into two different answers about what is on the board. See that file for the read-never-computes
// and invents-nothing rules; this route is now only the HTTP edge.

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request) {
  const rl = await apiRateLimit(request, 'scan-board', 'provider');
  if (rl) return rl;

  const sp = new URL(request.url).searchParams;
  const board = sp.get('board') || DEFAULT_BOARD;
  const limit = Number(sp.get('limit')) || DEFAULT_LIMIT;

  try {
    const payload = await buildScanBoardPayload({ board, limit });
    // A board we could not read is served as 503 with its reason, never as an empty board.
    return Response.json(payload, { status: payload.degraded ? 503 : 200, headers: NO_STORE });
  } catch (e) {
    console.error(`[scan-board] ${e.message}`);
    return Response.json({
      board, version: BOARDS_VERSION, rows: [], rejected: [], degraded: true,
      message: 'Pit Scan is temporarily unavailable.',
    }, { status: 503, headers: NO_STORE });
  }
}
