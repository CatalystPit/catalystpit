import { auth } from '@clerk/nextjs/server';
import { runPitScan } from '../../../lib/pitscan-feed';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// TWO SEPARATE scanner products (Terminal only):
//   ?mode=pit     → PIT SCAN: CatalystPit's proprietary hidden momentum/abnormal-activity engine.
//                   All scoring runs server-side in lib/pitscan.js; this route returns ONLY the
//                   approved output fields (no weights/thresholds/sub-scores). Needs a real-time
//                   feed — reports configured:false until one is wired.
//   ?mode=custom  → CUSTOM SCANNER: user-defined screen via FMP's stock-screener (transparent
//                   price/volume/mktcap/sector filters). Dormant until FMP_API_KEY is set.
// Custom results cached ~45s in KV per query.

const FMP = 'https://financialmodelingprep.com/api/v3';
const KEY = process.env.FMP_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL = 45;

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(k, v, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/set/${encodeURIComponent(k)}?EX=${ttl}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(v) }); } catch { /* non-fatal */ }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// Normalize either screener rows or gainers/losers rows to one shape.
const shape = (r) => ({
  symbol: r.symbol,
  name: r.companyName || r.name || null,
  price: num(r.price),
  changePct: num(r.changesPercentage ?? r.changePct),
  volume: num(r.volume),
  marketCap: num(r.marketCap ?? r.marketCapitalization),
  sector: r.sector || null,
});

export async function GET(request) {
  try {
    await auth();   // terminal is Pro-gated in the UI; API stays lightweight
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode');

    // ── PIT SCAN — proprietary engine, no FMP. Returns approved fields only. ──
    if (mode === 'pit') {
      const direction = searchParams.get('dir') === 'bear' ? 'bear' : 'bull';
      const out = await runPitScan({ direction });
      return Response.json({ mode: 'pit', direction, ...out }, { headers: NO_STORE });
    }

    // ── CUSTOM SCANNER — FMP stock-screener (transparent user filters). ──
    if (!KEY) return Response.json({ configured: false, rows: [] }, { headers: NO_STORE });
    const p = new URLSearchParams({ isActivelyTrading: 'true', exchange: 'NASDAQ,NYSE,AMEX', limit: '50', apikey: KEY });
    const map = { priceMin: 'priceMoreThan', priceMax: 'priceLowerThan', volumeMin: 'volumeMoreThan', mktCapMin: 'marketCapMoreThan', mktCapMax: 'marketCapLowerThan' };
    for (const [q, fmp] of Object.entries(map)) { const v = searchParams.get(q); if (v) p.set(fmp, v); }
    const sector = searchParams.get('sector'); if (sector) p.set('sector', sector);
    const url = `${FMP}/stock-screener?${p.toString()}`;

    const cacheKey = `scan:custom:${url.replace(KEY, 'K')}`;
    const cached = await kvGet(cacheKey);
    if (cached) return Response.json({ configured: true, rows: cached, cached: true }, { headers: NO_STORE });

    const r = await fetch(url);
    if (!r.ok) throw new Error(`FMP HTTP ${r.status}`);
    const data = await r.json();
    const rows = Array.isArray(data) ? data.map(shape).filter((x) => x.symbol).slice(0, 50) : [];
    await kvSet(cacheKey, rows, TTL);
    return Response.json({ configured: true, rows, cached: false }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[scan] ${e.message}`);
    return Response.json({ configured: !!KEY, rows: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
