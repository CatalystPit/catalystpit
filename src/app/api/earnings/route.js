import { parseEarnings } from '../../../lib/sec-earnings.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
// SEC requires a descriptive User-Agent or it 403s. https://www.sec.gov/os/accessing-edgar-data
const SEC_UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

const CIK_MAP_KEY = 'sec:cik_map';            // ticker → 10-digit CIK, cached 7d (cron refresh = separate concern)
const TTL_EARNINGS = 24 * 3600;               // parsed earnings per ticker
const TTL_STALE    = 7 * 24 * 3600;           // last-good copy for SEC-outage fallback

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    return (await r.json()).result ?? null;
  } catch { return null; }
}
async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?ex=${ttlSec}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: value,
    });
  } catch { /* non-fatal */ }
}

// ticker → 10-digit CIK map, KV-cached 7d. Returns {} on fetch failure (→ ticker simply not found).
async function getCikMap() {
  const hit = await kvGet(CIK_MAP_KEY);
  if (hit != null) { try { return JSON.parse(hit); } catch { /* refetch */ } }
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_UA });
    if (!r.ok) return {};
    const data = await r.json();
    const map = {};
    for (const e of Object.values(data)) map[e.ticker] = String(e.cik_str).padStart(10, '0');
    await kvSet(CIK_MAP_KEY, JSON.stringify(map), TTL_STALE);
    return map;
  } catch { return {}; }
}

const empty = (ticker, cik, error) =>
  Response.json({ ticker, cik: cik ?? null, count: 0, earnings: [], ...(error ? { error } : {}), meta: { cached: false, source: 'sec-edgar' } });

export async function GET(request) {
  let ticker = '';
  try {
    ticker = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
    if (!TICKER_RE.test(ticker)) return empty(ticker, null, 'invalid_ticker');

    const key = `earnings:${ticker}`, lastKey = `${key}:last`;
    const hit = await kvGet(key);
    if (hit != null) { try { const v = JSON.parse(hit); return Response.json({ ...v, meta: { ...v.meta, cached: true } }); } catch { /* refetch */ } }

    const cik = (await getCikMap())[ticker] || null;
    if (!cik) return empty(ticker, null);          // not an SEC filer (ETF/foreign/junk) — legit empty, no error

    let facts = null, status = 0;
    try {
      const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_UA, cache: 'no-store' });
      status = r.status;
      if (r.ok) facts = await r.json();
    } catch (e) { console.log(`[earnings] ${ticker} SEC fetch threw: ${e.message}`); }

    // 404 = entity has no XBRL financial facts (ETF/trust/foreign) → legit empty, not a failure.
    if (!facts && status === 404) return empty(ticker, cik);

    if (!facts) {                                   // real SEC failure → stale-fallback, else empty (never 503)
      const stale = await kvGet(lastKey);
      if (stale != null) { try { const v = JSON.parse(stale); return Response.json({ ...v, meta: { ...v.meta, cached: true } }); } catch { /* fall through */ } }
      console.log(`[earnings] ${ticker} (${cik}) SEC fetch failed (status ${status}), no stale cache`);
      return empty(ticker, cik, 'data_unavailable');
    }

    const earnings = parseEarnings(facts, cik);
    const payload = { ticker, cik, count: earnings.length, earnings, meta: { cached: false, source: 'sec-edgar' } };
    await kvSet(key, JSON.stringify(payload), TTL_EARNINGS);
    await kvSet(lastKey, JSON.stringify(payload), TTL_STALE);
    console.log(`[earnings] ${ticker} (${cik}) quarters=${earnings.length}`);
    return Response.json(payload);
  } catch (e) {
    console.log(`[earnings] ${ticker} failed: ${e.message}`);
    return empty(ticker, null, 'data_unavailable');
  }
}
