export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Forward earnings calendar. Needs a calendar data feed — wired to Twelve Data, DORMANT until
// TWELVE_DATA_API_KEY is set (returns configured:false so the panel shows a clean "connect data"
// state). No unofficial/scraped calendars (data-source policy). Cached ~1h in KV when live.
const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL = 3600;

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(k, v, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/set/${encodeURIComponent(k)}?EX=${ttl}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(v) }); } catch { /* non-fatal */ }
}

const CLEAN = /^[A-Z]{1,5}$/;

export async function GET() {
  if (!TWELVE_KEY) return Response.json({ configured: false, rows: [] }, { headers: NO_STORE });
  try {
    const cached = await kvGet('earnings_cal:v1');
    if (cached) return Response.json({ configured: true, cached: true, rows: cached }, { headers: NO_STORE });

    // Twelve Data earnings calendar (US). Field shape is normalized defensively.
    const r = await fetch(`https://api.twelvedata.com/earnings_calendar?apikey=${TWELVE_KEY}`, { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    let list = [];
    if (Array.isArray(j?.earnings)) list = j.earnings;
    else if (j?.earnings && typeof j.earnings === 'object') list = Object.values(j.earnings).flat();
    else if (Array.isArray(j)) list = j;

    const rows = list.map((e) => ({
      ticker: (e.symbol || e.ticker || '').toUpperCase(),
      name: e.name || null,
      date: e.date || e.report_date || null,
      time: e.time || e.hour || null,               // e.g. 'amc' | 'bmo' | 'time-not-supplied'
      epsEst: e.eps_estimate ?? e.estimate ?? null,
      epsActual: e.eps_actual ?? e.actual ?? null,
    })).filter((e) => CLEAN.test(e.ticker) && e.date).slice(0, 400);

    if (rows.length) await kvSet('earnings_cal:v1', rows, TTL);
    return Response.json({ configured: true, cached: false, rows }, { headers: NO_STORE });
  } catch (e) {
    return Response.json({ configured: true, rows: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
