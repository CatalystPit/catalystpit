import { auth } from '@clerk/nextjs/server';
import { scanState } from '../../../lib/scan/runtime';
import { buildScanBoardPayload, DEFAULT_BOARD } from '../../../lib/scan/board-payload';
import { apiRateLimit } from '../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// PIT SCAN.
//
// Returns the scanner's state AND its own description: which signals can run on the active feed,
// which cannot and why, which presets are available, which columns can be filled. That self-
// description is the product's honesty guarantee made visible — a trader can see exactly what Pit
// Scan is and what it is waiting for, instead of an empty table that reads as a quiet market.
//
// ⚠️ THE ROWS COME FROM THE SAME BUILDER AS /api/scan-board. scanState() describes the SIGNAL
// engine, which has never had a feed, and it therefore returns `rows: []` — a hard-coded empty
// list. This route is what the Terminal panel calls, so serving that empty list was the exact lie
// the self-description was written to prevent: the evidence boards have been live and full the
// whole time. The self-description below is still scanState's; the rows are the real board.
//
// The legacy /api/scan?mode=pit route is untouched and still serves the older weighted engine; this
// is the signal-based replacement, kept separate so the two can be compared before the old one goes.
export async function GET(request) {
  const _rl = await apiRateLimit(request, 'pitscan', 'provider');
  if (_rl) return _rl;

  try {
    await auth();
    const sp = new URL(request.url).searchParams;
    const preset = sp.get('preset') || null;
    const board = sp.get('board') || DEFAULT_BOARD;

    const state = scanState({ preset });
    // A failed board read must not silently become "no rows" — it keeps its own degraded flag and
    // message, so the panel can say which of the two it is.
    const boardPayload = await buildScanBoardPayload({ board }).catch((e) => {
      console.log(`[pitscan] board ${e.message}`);
      return { rows: [], rejected: [], degraded: true, message: 'Pit Scan is temporarily unavailable.' };
    });

    return Response.json({
      ...state,
      board: boardPayload.board ?? board,
      rows: boardPayload.rows,
      rejected: boardPayload.rejected,
      freshness: boardPayload.freshness ?? null,
      freshnessLabel: boardPayload.freshnessLabel ?? 'LAST CLOSE',
      consensusStatus: boardPayload.consensusStatus ?? null,
      consensusBuiltAt: boardPayload.consensusBuiltAt ?? null,
      calculatedAt: boardPayload.calculatedAt ?? null,
      degraded: !!boardPayload.degraded,
      ...(boardPayload.message ? { message: boardPayload.message } : {}),
    }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pitscan] ${e.message}`);
    // A failure here must not look like a quiet market either.
    return Response.json({
      readiness: { live: false, needs: [], reason: 'Pit Scan is temporarily unavailable.' },
      rows: [], events: [], degraded: true, error: true,
    }, { status: 200, headers: NO_STORE });
  }
}
