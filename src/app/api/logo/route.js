export const runtime = 'nodejs';

// Ticker logo proxy. Pulls the per-ticker logo from FMP server-side and streams it back.
// Unknown ticker / no logo → 404, so <TickerLogo> falls back to an initials badge.
//
// Cache is deliberately NOT immutable: FMP is spotty (esp. without a key), so a bad or missing
// result should self-heal, not freeze for a week. Good logos cache 1 day (served stale up to a
// week while revalidating); misses cache just 1 hour so they recover fast without hammering FMP.
const FMP_API_KEY = process.env.FMP_API_KEY;
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const HIT_CACHE  = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800';
const MISS_CACHE = 'public, max-age=3600, s-maxage=3600';
const miss = () => new Response(null, { status: 404, headers: { 'Cache-Control': MISS_CACHE } });

export async function GET(request) {
  const t = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
  if (!TICKER_RE.test(t)) return new Response(null, { status: 404 });

  const src = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(t)}.png${FMP_API_KEY ? `?apikey=${FMP_API_KEY}` : ''}`;
  try {
    const r = await fetch(src, { cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.startsWith('image/')) return miss();
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 200) return miss();   // filter tiny placeholder images
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': ct, 'Cache-Control': HIT_CACHE },
    });
  } catch {
    return miss();
  }
}
