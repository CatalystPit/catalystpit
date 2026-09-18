import { refreshFundQoq } from '../../../../lib/fund-qoq';
import { refreshTickerIssuer } from '../../../../lib/ticker-issuer';

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
    // Both derive from fund_holdings and both used to run in front of users — the board's roll-up
    // and symbol search's ticker->issuer map. Sequential on purpose: they hit the same 3 GB table,
    // and racing them would just make each other slower.
    const out = await refreshFundQoq();
    const names = await refreshTickerIssuer();
    console.log(`[fund-qoq] ${JSON.stringify({ ...out, names })}`);
    return Response.json({ ...out, names });
  } catch (e) {
    console.log(`[fund-qoq] ERROR ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
