import { projectHalts, detectedHalts } from '../../../lib/primary-events';
import { after } from 'next/server';
import { fetchHalts, kvGetHalts, kvSetHalts, haltKey, mergeDetected, HALTS_TTL } from '../../../lib/halts.mjs';

export const runtime = 'nodejs';

// Live US trading-halt scanner. The feed, the parse, the cache and the merge all live in
// lib/halts.mjs now, because /api/cron/primary-sources needs exactly the same sweep — see the comment
// there for why halts ride that cron rather than one of their own.
//
// This route is what the Terminal reads. It serves the cached copy the sweep maintains and only
// fetches itself on a miss, so a reader is never waiting on nasdaqtrader.com when the cron has
// already asked within the last 45 seconds.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  const cached = await kvGetHalts();
  if (cached) return Response.json({ ...cached, cached: true }, { headers: NO_STORE });

  const { halts, error } = await fetchHalts();

  // ⚠️ A FEED OUTAGE IS NOT AN EMPTY MARKET. This returned `{ halts: [], error }` with HTTP 200, so a
  // failed fetch rendered as "nothing is halted" — a claim about every US exchange, produced by our
  // own outage, on a panel a trader watches precisely to learn that something IS halted.
  if (error || !halts) {
    console.log(`[halts] ${error || 'no halts returned'}`);
    return Response.json({ error: 'halts_unavailable' }, { status: 503, headers: NO_STORE });
  }

  const detected = mergeDetected(halts, await detectedHalts().catch(() => []));
  const payload = {
    halts: [...detected, ...halts].sort((a, b) => haltKey(b) - haltKey(a)),
    asOf: new Date().toISOString(),
  };
  await kvSetHalts(payload, { ttl: HALTS_TTL });

  // Mirror into the primary-event stream. The cron does this every minute; keeping it here means a
  // cache miss served to a reader still captures, and after() defers it past the response so the
  // user-facing latency is unchanged. projectHalts is idempotent on its own content hash.
  after(async () => {
    try { await projectHalts(halts); } catch (e) { console.log(`[halts] project failed: ${e.message}`); }
  });

  return Response.json({ ...payload, cached: false }, { headers: NO_STORE });
}
