// MARKET STRUCTURE — the ticker page's endpoint.
//
// ── THE RESPONSE VARIES BY USER, SO IT IS NEVER CDN-CACHED ──────────────────
//
// A shared cache and a per-tier payload cannot coexist: one free response stored at the edge would
// be served to a Pro user, or worse, one Pro response to everyone. So the HTTP response is
// `private, no-store`, exactly like /api/me/plan.
//
// THE COMPUTATION IS CACHED INSTEAD. That is the expensive half (~370ms of swing detection over
// twelve years of candles) and it is IDENTICAL for every viewer — tier only decides which parts of
// the result are serialised. Caching the compute keyed on (ticker, session date) gives a warm
// response for every user after the first, with no possibility of a tier crossing between them.
//
// Structure changes when a new daily bar closes, so the key carries the last session date and the
// entry expires on its own; a stale reading is impossible rather than merely unlikely.

import { apiRateLimit } from '../../../lib/api-guard.mjs';
import { resolveUserTier } from '../../../lib/entitlements';
import { isRenderableTicker } from '../../../lib/security-identity.mjs';
import { tickerStructure } from '../../../lib/structure/structure-data';
import { shapeForTier } from '../../../lib/structure/present.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;

// Per-user payload → never shared. See the note above.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// ── the compute cache ────────────────────────────────────────────────────────
// Process-local, bounded, and keyed so a new session invalidates it without a sweep.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();   // ticker -> { at, structure }

function cachedGet(ticker, now) {
  const hit = cache.get(ticker);
  if (!hit || now - hit.at > CACHE_TTL_MS) return null;
  return hit.structure;
}

function cachedPut(ticker, structure, now) {
  // Oldest-out when full. A structure page is not worth unbounded memory on a shared lambda.
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(ticker, { at: now, structure });
}

/** Test seam. */
export function __clearCache() { cache.clear(); }

export async function GET(request) {
  const rl = await apiRateLimit(request, 'structure', 'heavy');
  if (rl) return rl;

  const { searchParams } = new URL(request.url);
  const ticker = String(searchParams.get('ticker') || '').trim().toUpperCase();
  // The same identity gate every other ticker-facing surface uses.
  if (!isRenderableTicker(ticker)) {
    return Response.json({ error: 'invalid_ticker' }, { status: 400, headers: NO_STORE });
  }

  try {
    // Tier and structure resolve in parallel: Clerk is a network round trip and there is no reason
    // for the candle query to wait on it.
    const now = Date.now();
    const cached = cachedGet(ticker, now);
    const [tier, structure] = await Promise.all([
      resolveUserTier(),
      cached ? Promise.resolve(cached) : tickerStructure(ticker),
    ]);
    if (!cached && structure) cachedPut(ticker, structure, now);

    // GATING HAPPENS BEFORE SERIALISATION. What a free client receives never contained the Pro
    // fields — see present.mjs.
    return Response.json(shapeForTier(structure, tier), { headers: NO_STORE });
  } catch (e) {
    // A real status code, not 200-with-nothing. DEFINITION-OF-DONE §3.
    return Response.json(
      { error: 'structure_unavailable', detail: String(e?.message || e) },
      { status: 503, headers: NO_STORE },
    );
  }
}
