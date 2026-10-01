import { auth } from '@clerk/nextjs/server';
import { runPitScan } from '../../../lib/pitscan-feed';
import { apiRateLimit } from '../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// TWO SEPARATE scanner products (Terminal only):
//   ?mode=pit     → PIT SCAN: CatalystPit's proprietary hidden momentum/abnormal-activity engine.
//                   All scoring runs server-side in lib/pitscan.js; this route returns ONLY the
//                   approved output fields (no weights/thresholds/sub-scores). Needs a real-time
//                   feed — reports configured:false until one is wired.
//   (?mode=custom was an FMP stock-screener proxy and has been removed — see the note in the handler.)
// Custom results cached ~45s in KV per query.

// ⚠️ THE FMP BASE URL AND KEY BINDING ARE GONE WITH THE MODE THEY SERVED. A dangling vendor
// constant is how a removed integration comes back: it reads as scaffolding somebody meant to use.
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
  const _rl = await apiRateLimit(request, 'scan', 'provider');
  if (_rl) return _rl;

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

    // ⚠️ THE FMP CUSTOM SCANNER IS REMOVED.
    //
    // ?mode=custom proxied financialmodelingprep.com/api/v3/stock-screener. FMP_API_KEY IS set in
    // production, so this answered `configured: true` and returned "FMP HTTP 403" — the key exists and
    // the entitlement does not. Nothing in the UI called it, which is the only reason no user ever
    // received FMP rows; an undocumented endpoint that would serve unlicensed data the moment the
    // entitlement changed is not a safe thing to leave reachable.
    //
    // The Screener at /screener covers this need from our own tables. Any other mode is a 400.
    return Response.json({ error: 'unknown mode' }, { status: 400, headers: NO_STORE });
  } catch (e) {
    console.log(`[scan] ${e.message}`);
    return Response.json({ configured: !!KEY, rows: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
