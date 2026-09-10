import { auth } from '@clerk/nextjs/server';

export const runtime = 'nodejs';
export const maxDuration = 30;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Market movers for the Terminal — top gainers / losers / most-active from Polygon snapshots
// (15-min delayed on Stocks Starter). One combined KV-cached payload (~60s) so all three tabs share
// a single upstream fetch. Provider stays server-side; the panel gets normalized rows only.
const POLYGON_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL = 60;
const CACHE_KEY = 'movers:v1';
const MIN_PRICE = 1;          // drop sub-$1 noise
const MIN_VOL = 200000;       // liquidity floor
const LIMIT = 25;

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(k, v, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/set/${encodeURIComponent(k)}?EX=${ttl}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(v) }); } catch { /* non-fatal */ }
}

const CLEAN = /^[A-Z]{1,5}$/;
const shape = (t) => ({
  ticker: t.ticker,
  price: t.lastTrade?.p ?? t.day?.c ?? t.prevDay?.c ?? null,
  changePct: t.todaysChangePerc ?? null,
  volume: t.day?.v ?? null,
});
const usable = (r) => r.ticker && CLEAN.test(r.ticker) && r.price != null && r.price >= MIN_PRICE && (r.volume ?? 0) >= MIN_VOL;

async function fetchDirection(kind) {   // 'gainers' | 'losers'
  const r = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/${kind}?apiKey=${POLYGON_KEY}`, { cache: 'no-store' });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.tickers || []).map(shape).filter(usable).slice(0, LIMIT);
}

async function fetchActive() {
  // Full-market snapshot in one call → sort by day volume for most-active (delayed).
  const r = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${POLYGON_KEY}`, { cache: 'no-store' });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.tickers || []).map(shape).filter(usable).sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, LIMIT);
}

export async function GET() {
  try {
    await auth();
    if (!POLYGON_KEY) return Response.json({ configured: false, gainers: [], losers: [], active: [] }, { headers: NO_STORE });
    const cached = await kvGet(CACHE_KEY);
    if (cached) return Response.json({ configured: true, cached: true, ...cached }, { headers: NO_STORE });

    const [gainers, losers, active] = await Promise.all([fetchDirection('gainers'), fetchDirection('losers'), fetchActive()]);
    const payload = { gainers, losers, active, asOf: null };   // asOf stamped client-side to avoid Date in cache key
    await kvSet(CACHE_KEY, payload, TTL);
    return Response.json({ configured: true, cached: false, ...payload }, { headers: NO_STORE });
  } catch (e) {
    return Response.json({ configured: !!POLYGON_KEY, gainers: [], losers: [], active: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
