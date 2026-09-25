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
    return Response.json({
      ...payload,
      source,
      minComponents: MIN_COMPONENTS,
      normalizationWindow: NORM_WINDOW,
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
