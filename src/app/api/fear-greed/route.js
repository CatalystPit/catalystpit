// ⚠️ THE STRIPPING MOVED TO lib/fear-greed/public-payload.mjs, BECAUSE app/fear-greed/page.jsx
// RENDERS THE SCORE ON THE SERVER NOW.
//
// What this route returns is a DISCLOSURE BOUNDARY, not a shape: the window length, the refusal
// threshold, the methodology version, each component's `samples` and the withdrawn non-inclusion
// text are all deliberately withheld, and one of those leaks was caught against the live response
// rather than the source. A second copy of that logic written to let a server component render the
// gauge is the same defect a third time, baked into cached public HTML. One function, both callers.
import { fearGreedPublicPayload } from '../../../lib/fear-greed/public-payload.mjs';

// Unchanged by the extraction above: this route's own rendering mode is not part of that change.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const payload = await fearGreedPublicPayload();
    return Response.json(payload, {
      // Daily data. A five-minute edge cache is generous and keeps the origin idle.
      // The unavailable branch keeps its shorter window so a first computation appears promptly.
      headers: {
        'cache-control': payload.available === false
          ? 'public, s-maxage=60'
          : 'public, s-maxage=300, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    return Response.json({ available: false, reason: 'error', error: e.message }, { status: 500 });
  }
}
