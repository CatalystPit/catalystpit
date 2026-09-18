import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';
import { apiRateLimit } from '../../../lib/api-guard.mjs';
import { readTickerIssuer } from '../../../lib/ticker-issuer';

export const runtime = 'nodejs';

// Ticker autocomplete. Matches against SEC's free company_tickers.json (ticker + company name)
// AUGMENTED with our own resolved 13F ticker universe (SEC's file omits ETFs like VOO/VTI/SPY —
// they file under the fund registrant, not as a ticker). Cached in the warm instance. Prefix matches
// on the symbol rank first (so "NV" → NVDA), then symbol-contains, then name-contains. Returns 8.
const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const TTL_MS = 12 * 60 * 60 * 1000;   // refresh the symbol list twice a day
let CACHE = null;
let CACHE_AT = 0;
let INFLIGHT = null;

/**
 * ONE REBUILD AT A TIME PER INSTANCE.
 *
 * The cache is a module-level variable, so a cold lambda has nothing — and the trigger is a search
 * box with a 130 ms debounce. Typing "NVDA" on a cold instance used to start four independent
 * rebuilds, each fetching SEC and each aggregating the holdings table. They now share one.
 */
function loadTickers() {
  if (CACHE && (Date.now() - CACHE_AT) < TTL_MS) return Promise.resolve(CACHE);
  if (INFLIGHT) return INFLIGHT;
  INFLIGHT = buildTickers().finally(() => { INFLIGHT = null; });
  return INFLIGHT;
}

/**
 * The original inline roll-up, kept for the window before ingest has built the table.
 *
 * It is the expensive one — without it, a fresh database would silently drop every ETF out of
 * autocomplete, which is worse than being slow once.
 */
async function legacyIssuerRollup() {
  console.log('[symbol-search] ticker_issuer empty — falling back to the live roll-up');
  const res = await db.execute(sql`
    SELECT ticker, (array_agg(issuer ORDER BY n DESC))[1] AS name
    FROM (SELECT ticker, issuer, count(*)::int AS n FROM fund_holdings WHERE ticker IS NOT NULL AND coalesce(put_call,'')='' AND issuer IS NOT NULL GROUP BY ticker, issuer) t
    GROUP BY ticker`);
  return (res?.rows || []).map((r) => ({ ticker: String(r.ticker).toUpperCase(), name: r.name || '' }));
}

async function buildTickers() {
  let sec = [];
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
    if (r.ok) sec = Object.values(await r.json()).map((x) => ({ ticker: String(x.ticker).toUpperCase(), name: x.title || '' }));
  } catch { sec = CACHE || []; }

  // Augment with our own resolved tickers (ETFs + anything SEC's ticker file lacks) — dominant issuer
  // as the name.
  //
  // PRECOMPUTED AT INGEST. This used to be a two-level GROUP BY over all 9.17M rows of
  // fund_holdings, unbounded, on every cold instance — 11.6 seconds measured in production, in front
  // of somebody typing in the nav search box. `ticker_issuer` holds the same answer as ~14.5k small
  // rows and is refreshed when ingest resolves a ticker.
  let ours = [];
  try {
    ours = await readTickerIssuer() ?? await legacyIssuerRollup();
  } catch { /* SEC list still works on its own */ }

  const seen = new Set(sec.map((x) => x.ticker));
  const merged = sec.length || ours.length ? [...sec, ...ours.filter((o) => o.ticker && !seen.has(o.ticker))] : (CACHE || []);
  if (merged.length) { CACHE = merged; CACHE_AT = Date.now(); }
  return CACHE || [];
}

export async function GET(request) {
  const _rl = await apiRateLimit(request, 'symsearch', 'heavy');
  if (_rl) return _rl;

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
