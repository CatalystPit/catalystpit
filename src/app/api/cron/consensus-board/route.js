import { db } from '../../../../lib/db';
import { sql } from 'drizzle-orm';
import { buildConsensusBoard, BOARD_LIMIT } from '../../../../lib/consensus/board.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

// PIT CONSENSUS BOARD — built here, never in a request.
//
// resolveEvidence costs ~1.6s per ticker and the Neon HTTP driver serialises under concurrency, so
// a sixty-ticker board takes ~90s. That cannot live in a page load at any parallelism, which is why
// this is a cron writing KV — the same shape the confluence board and pit-snapshot already use.
//
// The KV entry carries its own build time and is served with a long TTL, so a failed or slow cron
// degrades to a STALE board rather than an empty one. /api/consensus-board distinguishes the two.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
export const BOARD_KEY = 'consensus:board:v1';
// Well beyond the 30-minute cron cadence. A board that is hours old is still a truthful account of
// the evidence — filings do not move quickly — and is far better than a blank page.
const TTL = 6 * 60 * 60;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  try {
    const board = await buildConsensusBoard(db, sql, { limit: BOARD_LIMIT });
    const payload = { ...board, ms: Date.now() - t0 };

    if (KV_URL && KV_TOKEN) {
      await fetch(`${KV_URL}/set/${encodeURIComponent(BOARD_KEY)}?EX=${TTL}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    console.log(`[consensus-board] ${board.rows.length} rows / ${board.candidates} candidates,`
      + ` ${board.failed} failed, ${payload.ms}ms`);
    return Response.json({ ok: true, rows: board.rows.length, candidates: board.candidates,
      failed: board.failed, ms: payload.ms });
  } catch (e) {
    // A failed build leaves the PREVIOUS board in KV. Overwriting it with an empty one would turn a
    // build failure into "no evidence exists", which is a different and false statement.
    console.error(`[consensus-board] build failed: ${e.message}`);
    return Response.json({ ok: false, error: 'build_failed' }, { status: 500 });
  }
}
