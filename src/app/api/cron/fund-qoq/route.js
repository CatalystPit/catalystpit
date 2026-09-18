import { refreshFundQoq } from '../../../../lib/fund-qoq';

// Rebuild the 13F quarter-over-quarter summary that Pit Consensus reads.
//
// The institutions ingest calls this itself once it has finished writing holdings, so this route is
// the safety net rather than the primary trigger: it catches a failed ingest, a partial backfill, a
// manual holdings correction, and the first day of a new quarter. Idempotent, so running it when
// nothing has changed simply rewrites the same numbers.
//
// It is a cron, not a request path — this is the eight-second job that used to run in front of
// visitors on the homepage, every ticker page and the consensus board.

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const out = await refreshFundQoq();
    console.log(`[fund-qoq] ${JSON.stringify(out)}`);
    return Response.json(out);
  } catch (e) {
    console.log(`[fund-qoq] ERROR ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
