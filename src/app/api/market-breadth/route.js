import { readMarketBreadth } from '../../../lib/market-breadth.server.mjs';

export const runtime = 'nodejs';
// ⚠️ DYNAMIC, NOT ISR — AND THAT IS NOT A PERFORMANCE CHOICE. `export const revalidate` on a route
// handler with no dynamic input makes Next try to STATICALLY GENERATE it at build time, which runs this
// database read during the build. The build has no business touching the database, and on Vercel it
// failed there while compiling cleanly on a laptop, because the local build aborts at an unrelated
// prerender error before it ever reaches route handlers.
//
// The caching that actually matters is the Cache-Control header below: the snapshot changes once per
// rebuild, so a busy homepage shares one response for five minutes instead of asking per load. The read
// itself is a primary-key lookup.
export const dynamic = 'force-dynamic';

// Market breadth over the U.S. common-stock universe: advance/decline, 52-week highs and lows, and the
// share above their 50- and 200-day averages.
//
// ⚠️ IT IS A COMPLETED-SESSION READING AND SAYS SO. asOfSession names the session it describes and
// `stale` is set when the snapshot has missed a rebuild; nothing here is presented as live. The counts
// are computed once by /api/cron/market-breadth from stored daily candles — no market-data provider is
// called on this path.
export async function GET() {
  const data = await readMarketBreadth();
  if (!data) {
    // ⚠️ NULL, NOT ZEROS. "We have no snapshot" and "nothing advanced today" are different statements
    // and the card renders them differently.
    return Response.json({ ok: false, reason: 'unavailable', breadth: null }, {
      status: 200, headers: { 'Cache-Control': 'public, max-age=60' },
    });
  }
  return Response.json({ ok: true, breadth: data }, {
    headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' },
  });
}
