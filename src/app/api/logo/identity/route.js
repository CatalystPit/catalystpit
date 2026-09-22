import { apiRateLimit } from '../../../../lib/api-guard.mjs';
import { classifyLogo, LOGO_STATE } from '../../../../lib/logo-identity.mjs';
import { readLogoSignature, countSignatureMembers, logoStoreConfigured } from '../../../../lib/logo-store.mjs';

export const runtime = 'nodejs';

// WHICH OF THESE TICKERS HAVE A PICTURE THAT IS ACTUALLY ABOUT THEM?
//
//   GET /api/logo/identity?tickers=AVDE,AVLV,AAPL  ->  { AVDE: 'GENERIC_ISSUER_LOGO', ... }
//
// ⚠️ ONE REQUEST PER VIEW, NOT ONE PER TILE. A holding map asks once for all of its securities.
// Answering per tile would be 30 round trips to decide 30 pictures, which is exactly the
// "expensive work on every render" the design has to avoid; batching makes it a single cheap
// lookup against values computed when the images were first proxied.
//
// ⚠️ NOTHING IS FETCHED FROM A PROVIDER HERE. This route reads signatures that /api/logo already
// recorded and counts set membership. A ticker nobody has proxied yet comes back UNKNOWN and the
// map keeps showing its logo — the classification arrives on its own once the image has been
// served once. That keeps this endpoint O(KV) and immune to an upstream being slow or down.
//
// Cacheable: the answer for a given set of tickers changes only as slowly as the family sets do,
// and being briefly stale costs at most one tile drawn the old way.
const CACHE = 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400';
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const MAX_TICKERS = 120;        // a full holding map plus the activity lists, with room to spare

export async function GET(request) {
  const _rl = await apiRateLimit(request, 'logo-identity', 'logo');
  if (_rl) return _rl;

  const raw = (new URL(request.url).searchParams.get('tickers') || '').toUpperCase();
  const tickers = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))]
    .slice(0, MAX_TICKERS);

  // Without a store every ticker is UNKNOWN, which renders exactly as it did before this existed.
  if (!tickers.length || !logoStoreConfigured()) {
    return Response.json({ states: Object.fromEntries(tickers.map((t) => [t, LOGO_STATE.UNKNOWN])) },
      { headers: { 'Cache-Control': CACHE } });
  }

  const states = {};
  await Promise.all(tickers.map(async (t) => {
    try {
      const sig = await readLogoSignature(t);
      const shared = sig && sig !== 'none' ? await countSignatureMembers(sig) : 0;
      states[t] = classifyLogo(sig, shared);
    } catch {
      states[t] = LOGO_STATE.UNKNOWN;     // fail open, per ticker
    }
  }));

  return Response.json({ states }, { headers: { 'Cache-Control': CACHE } });
}
