import { resolveEvidence } from '../../../lib/consensus/evidence';
import { computeConsensus, METHODOLOGY_VERSION } from '../../../lib/consensus/consensus-v1.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;

// PIT CONSENSUS V1 — the normalised reading for one ticker.
//
// A structured reading of public evidence. NOT a rating, target, recommendation, expected return or
// forecast, and the response deliberately contains no field that could be mistaken for one: no
// score, no numeric grade, no probability.
//
// ── SHAPE IS THE CONTRACT ───────────────────────────────────────────────────
//
// Three separate outputs — direction, alignment, confidence — plus the per-family evidence that
// produced them. Consumers read the object rather than a number, which is what stops the old
// "consensus_score: 73" from reappearing somewhere downstream in a different costume.
//
// ── MARKET-PRICE INDEPENDENT, ON PURPOSE ────────────────────────────────────
//
// No price, volume, return or quote input reaches this. Pit Scan can join the result against live
// market reaction later; a divergence board is only meaningful when the evidence side has not
// already seen the price.
//
// Cached briefly: the inputs move on filing and ingest cadences, not per request.
const CACHE = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' };
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const ticker = String(sp.get('ticker') || '').toUpperCase().trim();
  if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(ticker)) {
    return Response.json({ error: 'valid ticker required' }, { status: 400, headers: NO_STORE });
  }

  try {
    const now = Date.now();
    const families = await resolveEvidence(ticker, { now });
    const result = computeConsensus(families, { now });
    return Response.json({ ticker, ...result }, { headers: CACHE });
  } catch (e) {
    // A failure is a failure, not an empty reading. Returning 200 with "insufficient evidence"
    // would be indistinguishable from a ticker nobody has filed anything about.
    console.error(`[api/consensus] ${ticker} failed: ${e.message}`);
    return Response.json({ ticker, error: 'consensus_unavailable', version: METHODOLOGY_VERSION },
      { status: 503, headers: NO_STORE });
  }
}
