import { readMarketBreadth } from '../../../lib/market-breadth.server.mjs';

export const runtime = 'nodejs';
// ⚠️ THE READ IS A PRIMARY-KEY LOOKUP, and this cache is about crawl/traffic shape rather than user
// latency. The snapshot changes once per rebuild, so serving the same bytes for five minutes costs a
// reader nothing and keeps a busy homepage from asking the database on every load.
export const revalidate = 300;

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
