// Dividends — history + TTM yield from POLYGON (/v3/reference/dividends + /v2 prev close). Polygon is
// unlimited on our plan and covers ETFs (VOO/SPY/…) which SEC/Tiingo miss, and gives explicit
// frequency + pay dates. (Was Tiingo, whose free 50/hour limit — shared with congress enrichment —
// kept 429ing and, worse, the empty result got cached for 24h, so "no dividend" stuck for everything.)

export const runtime = 'nodejs';
export const maxDuration = 15;

const POLYGON_KEY = process.env.POLYGON_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const TTL = 24 * 60 * 60;            // 24h — dividend data changes quarterly at most
const MS_DAY = 86_400_000;
const FREQ_LABEL = { 0: 'One-time', 1: 'Annual', 2: 'Semi-annual', 4: 'Quarterly', 12: 'Monthly' };

// ── KV (REST), mirrors the other routes ──
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttl}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch { /* non-fatal */ }
}

// median gap (days) between consecutive ex-dates → frequency label + payments/year
function inferFrequency(exDatesAsc) {
  if (exDatesAsc.length < 2) return { label: exDatesAsc.length ? 'Irregular' : 'None', perYear: exDatesAsc.length };
  const gaps = [];
  for (let i = 1; i < exDatesAsc.length; i++) gaps.push((Date.parse(exDatesAsc[i]) - Date.parse(exDatesAsc[i - 1])) / MS_DAY);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med < 45)  return { label: 'Monthly', perYear: 12 };
  if (med < 135) return { label: 'Quarterly', perYear: 4 };
  if (med < 270) return { label: 'Semi-annual', perYear: 2 };
  return { label: 'Annual', perYear: 1 };
}

const EMPTY = (ticker) => ({
  ticker, payer: false, events: [], ttmDividend: 0, frequency: 'None',
  mostRecent: null, currentPrice: null, ttmYield: null,
});

// Previous-day close from Polygon — the price basis for yield.
async function polyPrice(ticker) {
  try {
    const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${POLYGON_KEY}`);
    if (!r.ok) return null;
    const c = Number((await r.json())?.results?.[0]?.c);
    return Number.isFinite(c) && c > 0 ? c : null;
  } catch { return null; }
}

async function buildDividends(ticker) {
  if (!POLYGON_KEY) return { ...EMPTY(ticker), error: true };

  let results;
  try {
    const r = await fetch(`https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(ticker)}&limit=100&order=desc&sort=ex_dividend_date&apiKey=${POLYGON_KEY}`);
    if (r.status === 429 || r.status >= 500) return { ...EMPTY(ticker), error: true };   // transient → DON'T cache
    if (!r.ok) { return { ...EMPTY(ticker), currentPrice: await polyPrice(ticker) }; }   // 404 → genuinely no data
    results = (await r.json())?.results;
    if (!Array.isArray(results)) results = [];
  } catch { return { ...EMPTY(ticker), error: true }; }

  const currentPrice = await polyPrice(ticker);
  const events = results
    .filter((d) => Number(d.cash_amount) > 0 && d.ex_dividend_date)
    .map((d) => ({ exDate: d.ex_dividend_date, amount: Number(d.cash_amount), payDate: d.pay_date || null }))
    .sort((a, b) => a.exDate.localeCompare(b.exDate));

  if (!events.length) return { ...EMPTY(ticker), currentPrice };   // valid ticker, simply doesn't pay

  const freqInt = Number(results[0]?.frequency);
  const frequency = FREQ_LABEL[freqInt] || inferFrequency(events.map((e) => e.exDate)).label;

  const cutoff = Date.now() - 365 * MS_DAY;
  const ttmDividend = +events
    .filter((e) => Date.parse(e.exDate) >= cutoff)
    .reduce((s, e) => s + e.amount, 0)
    .toFixed(6);

  const ttmYield = (currentPrice && ttmDividend > 0) ? +((ttmDividend / currentPrice) * 100).toFixed(2) : null;
  const mostRecent = events[events.length - 1];

  return { ticker, payer: true, events: events.slice().reverse(), ttmDividend, frequency, mostRecent, currentPrice, ttmYield };
}

export async function GET(request) {
  let ticker = '';
  try {
    const { searchParams } = new URL(request.url);
    ticker = (searchParams.get('ticker') || '').toUpperCase().trim();
    const forceRefresh = searchParams.get('refresh') === '1';
    if (!TICKER_RE.test(ticker)) return Response.json({ error: 'Invalid ticker' }, { status: 400 });

    const cacheKey = `dividends:v2:${ticker}`;   // v2 → ignore the Tiingo-era poisoned "no dividend" cache
    if (!forceRefresh) {
      const cached = await kvGet(cacheKey);
      if (cached) return Response.json({ ...cached, cached: true });
    }

    const fresh = await buildDividends(ticker);
    if (!fresh.error) await kvSet(cacheKey, fresh, TTL);   // never cache a transient failure (429/5xx)
    return Response.json({ ...fresh, cached: false });
  } catch (e) {
    console.log(`[dividends] ${ticker} route error: ${e.message}`);
    return Response.json({ ...EMPTY(ticker), error: false }, { status: 200 });   // null discipline
  }
}
