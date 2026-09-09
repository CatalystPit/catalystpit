export const runtime = 'nodejs';
export const maxDuration = 20;

// Stock screener (Finviz-style). Queries FMP's stock-screener server-side and caches the result set
// (respecting FMP's free-tier call budget). Dormant until FMP_API_KEY is set → { configured:false },
// so the UI renders a "connecting data source" state instead of erroring. Free/official data path.
const FMP_API_KEY = process.env.FMP_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL = 600;                 // 10 min — screens don't need to be real-time; protects the call cap

const SECTORS = new Set(['Basic Materials', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive', 'Energy', 'Financial Services', 'Healthcare', 'Industrials', 'Real Estate', 'Technology', 'Utilities']);
const EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX']);
const SORTABLE = new Set(['price', 'marketCap', 'volume', 'symbol', 'beta']);

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } }); if (!r.ok) return null; const d = await r.json(); return d.result ? JSON.parse(d.result) : null; } catch { return null; }
}
async function kvSet(k, v, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/set/${encodeURIComponent(k)}?ex=${ttl}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(v) }); } catch { /* non-fatal */ }
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export async function GET(request) {
  const sp = new URL(request.url).searchParams;

  if (!FMP_API_KEY) {
    return Response.json({ configured: false, rows: [], count: 0 }, { headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  // Parse + whitelist filters.
  const sector = SECTORS.has(sp.get('sector')) ? sp.get('sector') : null;
  const exchange = EXCHANGES.has(sp.get('exchange')) ? sp.get('exchange') : null;
  const marketCapMin = num(sp.get('marketCapMin'));
  const marketCapMax = num(sp.get('marketCapMax'));
  const priceMin = num(sp.get('priceMin'));
  const priceMax = num(sp.get('priceMax'));
  const volumeMin = num(sp.get('volumeMin'));
  const isEtf = sp.get('isEtf') === '1' ? true : sp.get('isEtf') === '0' ? false : null;
  const sort = SORTABLE.has(sp.get('sort')) ? sp.get('sort') : 'marketCap';
  const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(300, Math.max(10, parseInt(sp.get('limit') || '100', 10) || 100));

  const cacheKey = `screener:${sector || '*'}:${exchange || '*'}:${marketCapMin || 0}-${marketCapMax || 0}:${priceMin || 0}-${priceMax || 0}:${volumeMin || 0}:${isEtf}:${sort}:${dir}:${limit}`;

  let rows = await kvGet(cacheKey);
  if (!rows) {
    // FMP stock-screener params.
    const q = new URLSearchParams({ limit: String(limit), isActivelyTrading: 'true', apikey: FMP_API_KEY });
    if (sector) q.set('sector', sector);
    if (exchange) q.set('exchange', exchange);
    if (marketCapMin != null) q.set('marketCapMoreThan', String(marketCapMin));
    if (marketCapMax != null) q.set('marketCapLowerThan', String(marketCapMax));
    if (priceMin != null) q.set('priceMoreThan', String(priceMin));
    if (priceMax != null) q.set('priceLowerThan', String(priceMax));
    if (volumeMin != null) q.set('volumeMoreThan', String(volumeMin));
    if (isEtf != null) q.set('isEtf', String(isEtf));

    try {
      const r = await fetch(`https://financialmodelingprep.com/api/v3/stock-screener?${q.toString()}`, { cache: 'no-store' });
      if (!r.ok) return Response.json({ configured: true, rows: [], count: 0, error: `data source HTTP ${r.status}` }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [];
      rows = arr.map((s) => ({
        symbol: s.symbol, name: s.companyName || '', price: num(s.price), marketCap: num(s.marketCap),
        volume: num(s.volume), sector: s.sector || '', industry: s.industry || '', exchange: s.exchangeShortName || s.exchange || '', beta: num(s.beta), isEtf: !!s.isEtf,
      })).filter((s) => s.symbol);
      const mul = dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        if (sort === 'symbol') return mul * String(a.symbol).localeCompare(String(b.symbol));
        return mul * ((a[sort] ?? -Infinity) - (b[sort] ?? -Infinity));
      });
      await kvSet(cacheKey, rows, TTL);
    } catch (e) {
      return Response.json({ configured: true, rows: [], count: 0, error: e.message }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  return Response.json({ configured: true, rows, count: rows.length }, { headers: { 'Cache-Control': 'public, max-age=120' } });
}
