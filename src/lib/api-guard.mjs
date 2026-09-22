// ABUSE PROTECTION FOR THE COST-BEARING PUBLIC API.
//
// Applied per route, never in middleware. Middleware runs on every request including
// /ticker/[symbol], robots.txt and sitemap.xml, and a limiter there would throttle Google and the
// ticker pages that are the whole point of the SEO surface. These pages must stay unmetered, so the
// guard is called inside the handful of API handlers that actually cost something.
//
// WHAT COSTS SOMETHING, measured in production:
//   /api/ticker, /api/chart-daily, /api/congress-chart   provider fetch + a candle-cache DB write
//   /api/logo, /api/movers, /api/scan                    provider fetch
//   /api/institutions, /api/symbol-search, /api/screener  heavy reads (13.1s cold on symbol-search,
//                                                         which groups all 9.2M fund_holdings rows)
//
// Everything else is a cheap cached read and is left alone.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

/**
 * The client IP, derived the way Vercel actually provides it.
 *
 * x-forwarded-for's LEFTMOST entry is the conventional "original client", and it is exactly the
 * value a caller can set themselves — trusting it hands an abuser a free reset of their own bucket
 * on every request. Vercel sets `x-real-ip` to the connecting peer it observed, and that is the
 * value to key on. x-forwarded-for is consulted only as a fallback for non-Vercel environments
 * (local dev, a preview proxy), and never as the primary.
 */
export function clientIp(request) {
  const h = request.headers;
  const real = h.get('x-real-ip');
  if (real) return real.trim();
  const vf = h.get('x-vercel-forwarded-for');
  if (vf) return vf.split(',')[0].trim();
  const xff = h.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

// Generous on purpose. A ticker page fires about four API calls and the Terminal polls a few
// endpoints on a timer, so these sit roughly an order of magnitude above real usage. They exist to
// stop a script, not to ration people — and offices, schools and mobile carriers share one public
// IP, so a tight limit would lock out a whole building before it inconvenienced an abuser.
export const LIMITS = {
  provider: { max: 40, window: 60 },   // a provider call and often a DB write
  heavy:    { max: 90, window: 60 },   // expensive reads, no provider cost
  // ─── THE LOGO PROXY IS NOT A PROVIDER CALL ────────────────────────────────
  //
  // ⚠️ IT WAS ON `provider` (40/60s) AND THAT WAS THE BUG BEHIND THE MISSING LOGOS. Measured
  // against production: 59 distinct tickers requested in one window returned 40 images and
  // **19 × 429**. A 429 is not an image, so <TickerLogo>'s onError fires and the row falls back
  // to an initials badge — which is exactly the "missing logos" reported on Politicians, and an
  // amplifier on a fund profile that paints ~430 logos at once.
  //
  // A logo is a cacheable, immutable-ish image, not a metered upstream: HIT_CACHE puts it on the
  // CDN for a day (confirmed in production, X-Vercel-Cache: HIT), so repeat views and every
  // subsequent visitor cost zero invocations. Only cache-cold tickers reach the function, and a
  // page legitimately showing 200 holdings needs 200 cold logos exactly once. Rationing that was
  // rationing the product, not an abuser.
  //
  // The cap stays low enough to stop a scraper enumerating the ticker universe through this
  // endpoint, which is the only thing it was ever there to prevent.
  logo:     { max: 300, window: 60 },
};

async function kv(path) {
  const r = await fetch(`${KV_URL}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store',
  });
  if (!r.ok) throw new Error('kv ' + r.status);
  return r.json();
}

/**
 * Returns a 429 Response when the caller is over budget, or null to continue.
 *
 * FAILS OPEN. No KV, a KV error, a signed-in user, or an IP we could not determine all return null.
 * An availability problem in the limiter must never become an outage in the product — the worst case
 * of failing open is the cost we already have today.
 */
export async function apiRateLimit(request, bucket, kind = 'heavy', { userId = null } = {}) {
  if (userId) return null;                       // signed-in traffic has its own per-user limits
  if (!KV_URL || !KV_TOKEN) return null;
  const ip = clientIp(request);
  if (ip === 'unknown') return null;
  const { max, window } = LIMITS[kind] || LIMITS.heavy;
  const key = `rl:${bucket}:${ip}`;
  try {
    const { result } = await kv(`/incr/${encodeURIComponent(key)}`);
    const n = Number(result) || 0;
    if (n === 1) await kv(`/expire/${encodeURIComponent(key)}/${window}`);
    if (n > max) {
      return Response.json({ error: 'rate_limited' }, {
        status: 429,
        headers: { 'Retry-After': String(window), 'Cache-Control': 'no-store' },
      });
    }
  } catch { return null; }                       // fail open
  return null;
}
