import { readPayload, payloadFromHistory } from '../../../lib/fear-greed/store.mjs';
import { METHODOLOGY, COMPONENTS, ZONES, NORM_WINDOW, MIN_COMPONENTS } from '../../../lib/fear-greed/model.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// THE READ PATH. It never computes.
//
// ⚠️ A VISITOR MUST NOT BE ABLE TO TRIGGER THE BUILD. The calculation reads about a thousand
// tickers of daily history and takes ~40 seconds; exposing it to a page load would turn a hundred
// readers into a hundred of those. This route reads the materialised payload, and if KV is cold it
// RESHAPES the durable history rather than recalculating — so what a reader sees is always a number
// the cron produced.

export async function GET() {
  try {
    let payload = await readPayload();
    let source = 'kv';
    if (!payload) {
      payload = await payloadFromHistory();
      source = 'history';
    }
    if (!payload) {
      // ⚠️ FAIL CLOSED. No stored index is "we do not know", never a 50 and never a guess.
      return Response.json({
        available: false,
        reason: 'not-yet-computed',
        methodology: METHODOLOGY,
        zones: ZONES,
      }, { status: 200, headers: { 'cache-control': 'public, s-maxage=60' } });
    }
    // ⚠️ LABELS COME FROM THE LIVE REGISTRY, NOT FROM THE CACHED PAYLOAD.
    //
    // buildPayload bakes each component's label and description in at build time, so a rename would
    // keep serving the old wording until the next daily cron — up to 24 hours of the UI calling
    // Realized Volatility "Market Volatility". The scores stay exactly as computed; only the words
    // are re-read from COMPONENTS, which is the single place they are defined.
    const meta = new Map(COMPONENTS.map((m) => [m.key, m]));
    // ⚠️ A COMPONENT THE CURRENT METHODOLOGY NO LONGER HAS MUST NOT BE SERVED. A stored payload
    // from an older version can carry one; the registry is the definition of what the index is.
    const components = (payload.components || [])
      .filter((c) => meta.has(c.key))
      .map((c) => ({ ...c, label: meta.get(c.key).label, meaning: meta.get(c.key).meaning }));

    // ── ⚠️ WHAT THIS ROUTE DELIBERATELY DOES NOT PUBLISH ──────────────────────
    //
    // `normalizationWindow`, `minComponents` and the methodology version used to travel here. The
    // window length and the refusal threshold are most of the recipe stated as integers, and the
    // version identifier means nothing to a reader while telling anyone reproducing us exactly
    // which revision they are looking at. All three remain in the code and in the store, where
    // they are load-bearing; none of them is a fact a reader of the index needs.
    const { version, normalizationWindow, ...publicPayload } = payload;
    void version; void normalizationWindow; void MIN_COMPONENTS; void NORM_WINDOW;

    return Response.json({
      ...publicPayload,
      components,
      source,
      zones: ZONES,
      methodology: METHODOLOGY,
      componentMeta: COMPONENTS,
    }, {
      // Daily data. A five-minute edge cache is generous and keeps the origin idle.
      headers: { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600' },
    });
  } catch (e) {
    return Response.json({ available: false, reason: 'error', error: e.message }, { status: 500 });
  }
}
