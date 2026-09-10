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

// FALLBACK: Polygon Financials for tickers SEC XBRL can't serve as us-gaap quarters — i.e. FOREIGN
// issuers / ADRs (NBIS etc.) that file 20-F/IFRS, not 10-Q/10-K. Maps to the same earnings row shape.
const POLY_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;
async function polygonEarnings(ticker) {
  if (!POLY_KEY) return [];
  try {
    const r = await fetch(`https://api.polygon.io/vX/reference/financials?ticker=${encodeURIComponent(ticker)}&timeframe=quarterly&order=desc&limit=12&apiKey=${POLY_KEY}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    const results = Array.isArray(j.results) ? j.results : [];
    const rows = results.map((res) => {
      const inc = res.financials?.income_statement || {};
      const rev = inc.revenues?.value ?? null;
      const eps = inc.diluted_earnings_per_share?.value ?? inc.basic_earnings_per_share?.value ?? null;
      return {
        quarter: `${res.fiscal_period || ''} ${res.fiscal_year || ''}`.trim(),
        report_date: res.filing_date || res.end_date || null,
        period_end: res.end_date || null,
        revenue: rev,
        eps_basic: eps != null ? Math.round(eps * 100) / 100 : null,
        form: null, derived: false,
        filing_url: res.source_filing_url || null,
        _rev: rev, _eps: eps, _fp: res.fiscal_period, _fy: Number(res.fiscal_year),
      };
    });
    const byKey = {};
    rows.forEach((x) => { byKey[`${x._fp}-${x._fy}`] = x; });
    const yoy = (c, p) => (c != null && p != null && p !== 0) ? Math.round(((c - p) / Math.abs(p)) * 1000) / 10 : null;
    for (const x of rows) { const prior = byKey[`${x._fp}-${x._fy - 1}`]; x.revenue_yoy_pct = yoy(x._rev, prior?._rev ?? null); x.eps_yoy_pct = yoy(x._eps, prior?._eps ?? null); }
    return rows.filter((x) => x.revenue != null || x.eps_basic != null).map(({ _rev, _eps, _fp, _fy, ...r }) => r);
  } catch { return []; }
}
// When SEC XBRL has no earnings, try Polygon; cache + return whichever we get (empty if neither).
async function earningsFallback(ticker, cik) {
  const rows = await polygonEarnings(ticker);
  if (rows.length) {
    const payload = { ticker, cik: cik ?? null, count: rows.length, earnings: rows, meta: { cached: false, source: 'polygon' } };
    await kvSet(`earnings:${ticker}`, JSON.stringify(payload), TTL_EARNINGS);
    return Response.json(payload);
  }
  return empty(ticker, cik);
}

export async function GET(request) {
  let ticker = '';
  try {
    ticker = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
    if (!TICKER_RE.test(ticker)) return empty(ticker, null, 'invalid_ticker');

    const key = `earnings:${ticker}`, lastKey = `${key}:last`;
    const hit = await kvGet(key);
    if (hit != null) { try { const v = JSON.parse(hit); return Response.json({ ...v, meta: { ...v.meta, cached: true } }); } catch { /* refetch */ } }

    const cik = (await getCikMap())[ticker] || null;
    if (!cik) return earningsFallback(ticker, null);   // not in SEC map (foreign/ADR) → try Polygon financials

    let facts = null, status = 0;
    try {
      const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_UA, cache: 'no-store' });
      status = r.status;
      if (r.ok) facts = await r.json();
    } catch (e) { console.log(`[earnings] ${ticker} SEC fetch threw: ${e.message}`); }

    // 404 = entity has no XBRL financial facts (ETF/trust/foreign) → try Polygon before giving up.
    if (!facts && status === 404) return earningsFallback(ticker, cik);

    if (!facts) {                                   // real SEC failure → stale-fallback, else empty (never 503)
      const stale = await kvGet(lastKey);
      if (stale != null) { try { const v = JSON.parse(stale); return Response.json({ ...v, meta: { ...v.meta, cached: true } }); } catch { /* fall through */ } }
      console.log(`[earnings] ${ticker} (${cik}) SEC fetch failed (status ${status}), no stale cache`);
      return empty(ticker, cik, 'data_unavailable');
    }

    const earnings = parseEarnings(facts, cik);
    if (!earnings.length) return earningsFallback(ticker, cik);   // foreign/IFRS filer (no us-gaap quarters) → Polygon
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
