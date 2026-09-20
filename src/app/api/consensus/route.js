import { resolveEvidence } from '../../../lib/consensus/evidence';
import { computeConsensus, METHODOLOGY_VERSION } from '../../../lib/consensus/consensus-v1.mjs';
import { synthesise } from '../../../lib/consensus/synthesis.mjs';

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
// The per-family evidence IS the product: each family's own state, its own supporting facts, and a
// plain statement of where families agree and where they disagree.
//
// ⚠️ THE AGGREGATE OUTPUTS ARE DEPRECATED. `direction`, `directionLabel`, `alignment` and
// `confidence` are still computed and still returned so existing consumers do not break, but they
// are marked deprecated and NOTHING USER-FACING READS THEM ANY MORE. Summing four families into one
// signed number is a weighting claim the evidence does not support — Experiment 002 measured
// institutional evidence adding +0.43% over insider-alone at t=0.82 — and a percentage or a
// confidence word reads as validated precision that was never established.
//
// Remove the deprecated block once no consumer references it.
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
    const synthesis = synthesise(families, { now });

    // Legacy aggregate, computed over the four ORIGINAL families only. Market structure is
    // deliberately excluded from it: adding a fifth family to a sum we no longer believe in would
    // silently change every stored legacy value for no benefit.
    const legacy = computeConsensus(families.filter((f) => f.family !== 'structure'), { now });

    return Response.json({
      ticker,
      ...synthesis,
      deprecated: {
        note: 'Aggregate direction/alignment/confidence are unvalidated and are no longer shown to '
          + 'users. Retained only for consumer compatibility; do not build on these.',
        version: METHODOLOGY_VERSION,
        direction: legacy.direction,
        directionLabel: legacy.directionLabel,
        alignment: legacy.alignment,
        alignmentState: legacy.alignmentState,
        confidence: legacy.confidence,
        confidenceRaw: legacy.confidenceRaw,
      },
    }, { headers: CACHE });
  } catch (e) {
    // A failure is a failure, not an empty reading. Returning 200 with "insufficient evidence"
    // would be indistinguishable from a ticker nobody has filed anything about.
    console.error(`[api/consensus] ${ticker} failed: ${e.message}`);
    return Response.json({ ticker, error: 'consensus_unavailable', version: METHODOLOGY_VERSION },
      { status: 503, headers: NO_STORE });
  }
}
