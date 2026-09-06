export const runtime = 'nodejs';

// Ticker logo proxy. Pulls the per-ticker logo from FMP server-side (the key never ships to
// the browser) and streams it back, CDN-cached 7d. Unknown ticker / no logo → 404, so
// <TickerLogo> falls back to an initials badge. FMP is our licensed source (compliant).
const FMP_API_KEY = process.env.FMP_API_KEY;
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

export async function GET(request) {
  const t = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
  if (!TICKER_RE.test(t)) return new Response(null, { status: 404 });

  const src = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(t)}.png${FMP_API_KEY ? `?apikey=${FMP_API_KEY}` : ''}`;
  try {
    const r = await fetch(src, { cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.startsWith('image/')) return new Response(null, { status: 404 });
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 200) return new Response(null, { status: 404 });   // filter tiny placeholder images
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=604800, s-maxage=604800, immutable' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
