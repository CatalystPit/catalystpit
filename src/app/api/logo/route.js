export const runtime = 'nodejs';

// Ticker logo proxy. Resolves a per-ticker logo server-side and streams it back.
// Source order: logo.dev (if LOGODEV_TOKEN set — reliable, covers ETFs) → FMP (legacy/keyless,
// spotty) → 404, so <TickerLogo> falls back to an initials badge.
//
// Cache is deliberately NOT immutable: upstreams are spotty, so a bad/missing result should
// self-heal, not freeze for a week. Good logos cache 1 day (served stale up to a week while
// revalidating); misses cache just 1 hour so they recover fast without hammering upstream.
const FMP_API_KEY = process.env.FMP_API_KEY;
const LOGODEV_TOKEN = process.env.LOGODEV_TOKEN;
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const HIT_CACHE  = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800';
const MISS_CACHE = 'public, max-age=3600, s-maxage=3600';
const miss = () => new Response(null, { status: 404, headers: { 'Cache-Control': MISS_CACHE } });

// Fetch one candidate; return {buf, ct} on a real image, else null.
async function tryLogo(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 200) return null;   // filter tiny placeholder images
    return { buf, ct };
  } catch {
    return null;
  }
}

export async function GET(request) {
  const t = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
  if (!TICKER_RE.test(t)) return new Response(null, { status: 404 });

  const sources = [];
  // logo.dev by ticker — fallback=404 so it only returns a real logo (we render our own initials
  // badge for the rest, keeping the fallback consistent with the app's styling).
  if (LOGODEV_TOKEN) {
    sources.push(`https://img.logo.dev/ticker/${encodeURIComponent(t)}?token=${LOGODEV_TOKEN}&format=png&size=128&retina=true&fallback=404`);
  }
  // FMP as a secondary (only real help when a paid key is set; keyless is unreliable).
  sources.push(`https://financialmodelingprep.com/image-stock/${encodeURIComponent(t)}.png${FMP_API_KEY ? `?apikey=${FMP_API_KEY}` : ''}`);

  for (const src of sources) {
    const hit = await tryLogo(src);
    if (hit) return new Response(hit.buf, { status: 200, headers: { 'Content-Type': hit.ct, 'Cache-Control': HIT_CACHE } });
  }
  return miss();
}
