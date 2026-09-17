import { auth } from '@clerk/nextjs/server';
import { scanState } from '../../../lib/scan/runtime';
import { apiRateLimit } from '../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// PIT SCAN.
//
// Returns the scanner's state AND its own description: which signals can run on the active feed,
// which cannot and why, which presets are available, which columns can be filled. That self-
// description is the product's honesty guarantee made visible — a trader can see exactly what Pit
// Scan is and what it is waiting for, instead of an empty table that reads as a quiet market.
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
    return Response.json(scanState({ preset }), { headers: NO_STORE });
  } catch (e) {
    console.log(`[pitscan] ${e.message}`);
    // A failure here must not look like a quiet market either.
    return Response.json({
      readiness: { live: false, needs: [], reason: 'Pit Scan is temporarily unavailable.' },
      rows: [], events: [], error: true,
    }, { status: 200, headers: NO_STORE });
  }
}
