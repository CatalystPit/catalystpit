// THE EVIDENCE API — one canonical engine, many consumers.
//
// The ticker page is the first consumer. Pit Scan, watchlists, alerts, the Terminal, the homepage
// and the Catalyst Brief are meant to read THIS rather than each reimplementing "what changed",
// which is how four surfaces end up with four different answers about the same company.
//
// `since` is the whole of the "3 things changed since you last checked" mechanism: the client holds
// the watermark and asks for what is newer. No per-user notification state exists or is needed for
// that, which is exactly what section 13 of the brief asked for — structure it so the question can
// be asked, without building a notification system to answer it.
//
// FAILS LOUDLY. A resolver outage returns 503, never 200 with an empty list: an empty evidence list
// means "nothing changed", and rendering an outage as "nothing changed" is a lie the user cannot
// see. Per-family failures are different — those degrade, and are reported in the payload.

import { apiRateLimit } from '../../../lib/api-guard.mjs';
import { tickerEvidence } from '../../../lib/evidence/resolve';
import { tickerEvidenceRange } from '../../../lib/evidence/timeline';
import { isRenderableTicker } from '../../../lib/security-identity.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;

// Evidence changes when a filing lands, which is minutes-scale, not seconds-scale. Identical for
// every viewer, so it belongs in the shared CDN cache rather than being recomputed per request.
const CACHE = { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' };

export async function GET(request) {
  const rl = await apiRateLimit(request, 'evidence', 'heavy');
  if (rl) return rl;

  const { searchParams } = new URL(request.url);
  const ticker = String(searchParams.get('ticker') || '').trim().toUpperCase();

  // The same identity gate as every other ticker-facing surface. 'NONE' never gets this far.
  if (!isRenderableTicker(ticker)) {
    return Response.json({ error: 'invalid_ticker' }, { status: 400 });
  }

  const since = searchParams.get('since');
  if (since && !Number.isFinite(new Date(since).getTime())) {
    return Response.json({ error: 'invalid_since' }, { status: 400 });
  }

  // RANGE MODE powers the chart's Evidence Timeline: the same engine, emitting evidence at each
  // distinct public moment rather than as a digest. Both modes share every classification rule —
  // see src/lib/evidence/timeline.js.
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const wantsRange = Boolean(from || to);
  for (const [k, v] of [['from', from], ['to', to]]) {
    if (v && !Number.isFinite(new Date(v).getTime())) {
      return Response.json({ error: `invalid_${k}` }, { status: 400 });
    }
  }

  try {
    if (wantsRange) {
      // The server bounds the span regardless of what the client asks for — an unbounded range is
      // an unbounded query, and the chart can legitimately request five years.
      const result = await tickerEvidenceRange(ticker, { from, to });
      return Response.json(result, { headers: CACHE });
    }
    const result = await tickerEvidence(ticker, { since: since || null });
    return Response.json(result, { headers: since ? { 'Cache-Control': 'no-store' } : CACHE });
  } catch (e) {
    // A real status code, not 200-with-nothing. See DEFINITION-OF-DONE §3.
    return Response.json(
      { error: 'evidence_unavailable', detail: String(e?.message || e) },
      { status: 503 },
    );
  }
}
