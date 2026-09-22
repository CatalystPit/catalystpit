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

// The price basis for yield — our own stored completed-session close.
//
// ⚠️ THIS WAS A POLYGON prev-close CALL PER TICKER PER REQUEST, on a provider whose
// redistribution rights we never established, for a number we already hold.
// ticker_daily_candles is Tiingo split-adjusted history; reading the last close costs an indexed
// query and no vendor request at all, so the Dividends tab stops scaling with page views.
async function lastClose(ticker) {
  try {
    const { dailyCloses } = await import('../../../lib/market/daily-series.mjs');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const series = await dailyCloses(ticker, from, to);
    const last = series[series.length - 1];
    return last && Number.isFinite(last.close) && last.close > 0 ? last.close : null;
  } catch { return null; }
}

// ⚠️ MIGRATED OFF POLYGON. The ticker page's Dividends tab fetched dividend events AND the yield
// price basis from Polygon — and a comment on the page already claimed Tiingo, which it was not.
//
// Events now come from Tiingo corporate actions, derived from the daily bars' divCash on the feed
// the whole product runs on, so a dividend and the price it is measured against share one source
// and one adjustment convention.
//
// ⚠️ ONE FIELD IS GENUINELY LOST: Polygon returned pay_date and a numeric frequency code. Tiingo's
// derivation carries neither, so payDate is null and the frequency is INFERRED from ex-date
// spacing — which inferFrequency() already did whenever Polygon's code was absent. Reporting a
// pay date we do not have would be a fabrication; an absent one is a visible gap.
async function buildDividends(ticker) {
  let actions;
  try {
    const { getCorporateActions } = await import('../../../lib/market/tiingo.mjs');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 365 * 86400000).toISOString().slice(0, 10);
    actions = await getCorporateActions(ticker, { from, to });
    if (!actions?.ok) return { ...EMPTY(ticker), error: true };        // transient → DON'T cache
  } catch { return { ...EMPTY(ticker), error: true }; }

  const currentPrice = await lastClose(ticker);
  const events = (actions.dividends || [])
    .filter((d) => Number(d.amount) > 0 && d.exDate)
    .map((d) => ({ exDate: String(d.exDate).slice(0, 10), amount: Number(d.amount), payDate: null }))
    .sort((a, b) => a.exDate.localeCompare(b.exDate));

  if (!events.length) return { ...EMPTY(ticker), currentPrice };   // valid ticker, simply doesn't pay

  const frequency = inferFrequency(events.map((e) => e.exDate)).label;

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
