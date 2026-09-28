import { buildWatchlistEvents, coverage } from '../../../../lib/watchlist-materialise.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

// MATERIALISE QUALIFYING EVENTS, so the watchlist read path does not.
//
// ⚠️ WHY THIS CRON EXISTS. Resolving one ticker through the Evidence Engine costs ~1,350ms and
// seven database queries. The watchlist badge used to pay that for every nominated ticker on every
// request — ~420 queries and twenty-two seconds for a sixty-name list, per user, per minute — and
// was capped to survive it. The cap then reported unchecked securities as "nothing happened".
//
// None of that work depends on who is reading. It is done here once per event instead, and the read
// becomes a single indexed query with no cap and nothing to truncate.
//
// Every five minutes: the wire is continuous and the 8-K ingest runs on the same cadence, so this
// keeps the badge within a few minutes of the tape while the endpoint itself stays free.
export async function GET(request) {
  // The same gate every other cron here uses: Vercel's own header, or the project secret.
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  const authorized = isVercelCron
    || request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`;
  if (!authorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const t0 = Date.now();
    const r = await buildWatchlistEvents();
    return Response.json({ ...r, ms: Date.now() - t0, coverage: await coverage() },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[watchlist-events]', e);
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
