import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// Ticker autocomplete. Matches against SEC's free company_tickers.json (ticker + company name)
// AUGMENTED with our own resolved 13F ticker universe (SEC's file omits ETFs like VOO/VTI/SPY —
// they file under the fund registrant, not as a ticker). Cached in the warm instance. Prefix matches
// on the symbol rank first (so "NV" → NVDA), then symbol-contains, then name-contains. Returns 8.
const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const TTL_MS = 12 * 60 * 60 * 1000;   // refresh the symbol list twice a day
let CACHE = null;
let CACHE_AT = 0;

async function loadTickers() {
  if (CACHE && (Date.now() - CACHE_AT) < TTL_MS) return CACHE;
  let sec = [];
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
    if (r.ok) sec = Object.values(await r.json()).map((x) => ({ ticker: String(x.ticker).toUpperCase(), name: x.title || '' }));
  } catch { sec = CACHE || []; }

  // Augment with our own resolved tickers (ETFs + anything SEC's ticker file lacks) — dominant issuer as the name.
  let ours = [];
  try {
    const res = await db.execute(sql`
      SELECT ticker, (array_agg(issuer ORDER BY n DESC))[1] AS name
      FROM (SELECT ticker, issuer, count(*)::int AS n FROM fund_holdings WHERE ticker IS NOT NULL AND coalesce(put_call,'')='' AND issuer IS NOT NULL GROUP BY ticker, issuer) t
      GROUP BY ticker`);
    ours = (res?.rows || []).map((r) => ({ ticker: String(r.ticker).toUpperCase(), name: r.name || '' }));
  } catch { /* SEC list still works */ }

  const seen = new Set(sec.map((x) => x.ticker));
  const merged = sec.length || ours.length ? [...sec, ...ours.filter((o) => o.ticker && !seen.has(o.ticker))] : (CACHE || []);
  if (merged.length) { CACHE = merged; CACHE_AT = Date.now(); }
  return CACHE || [];
}

export async function GET(request) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim().toUpperCase();
  if (q.length < 1 || q.startsWith('/')) return Response.json({ results: [] });

  const all = await loadTickers();
  const exact = [], prefix = [], contains = [], byName = [];
  for (const t of all) {
    if (t.ticker === q) exact.push(t);
    else if (t.ticker.startsWith(q)) prefix.push(t);
    else if (t.ticker.includes(q)) contains.push(t);
    else if (t.name && t.name.toUpperCase().includes(q)) byName.push(t);
  }
  // Shorter symbols first within the prefix bucket (NV → NVDA before NVAXY, etc.)
  prefix.sort((a, b) => a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker));
  const results = [...exact, ...prefix, ...contains, ...byName].slice(0, 8);

  return Response.json({ results }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
