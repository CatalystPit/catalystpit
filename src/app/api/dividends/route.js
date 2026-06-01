// Dividends — history + TTM yield from Tiingo EOD /prices (divCash field). Free, commercial-OK,
// same wiring as our daily candles (see scripts/probe-dividends.mjs). Finnhub /stock/dividend is
// paywalled (403) on our tier. Tiingo EOD gives ex-date + amount only — no pay/record/declared
// dates and no explicit frequency (we infer it from the cadence of ex-dates).

export const runtime = 'nodejs';
export const maxDuration = 15;

const TIINGO_API_KEY = process.env.TIINGO_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const TTL = 24 * 60 * 60;            // 24h — dividend data changes quarterly at most
const YEARS_BACK = 3;
const MS_DAY = 86_400_000;

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

async function buildDividends(ticker) {
  if (!TIINGO_API_KEY) return EMPTY(ticker);

  const to = new Date();
  const from = new Date(to.getTime());
  from.setFullYear(from.getFullYear() - YEARS_BACK);
  const fmt = (d) => d.toISOString().slice(0, 10);

  // Tiingo uses dashes for class shares (BRK.B → BRK-B).
  const tiingoSym = ticker.replace(/\./g, '-');
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(tiingoSym)}/prices`
    + `?startDate=${fmt(from)}&endDate=${fmt(to)}&format=json&token=${TIINGO_API_KEY}`;

  let rows;
  try {
    const r = await fetch(url);
    if (!r.ok) return EMPTY(ticker);            // 404 unknown ticker / etc. → empty (no crash)
    rows = await r.json();
  } catch { return EMPTY(ticker); }
  if (!Array.isArray(rows) || !rows.length) return EMPTY(ticker);

  // latest EOD close = the price basis for yield (same response, no extra call)
  const sortedByDate = [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const lastClose = Number(sortedByDate[sortedByDate.length - 1]?.close);
  const currentPrice = Number.isFinite(lastClose) && lastClose > 0 ? lastClose : null;

  const events = rows
    .filter((d) => Number(d.divCash) > 0)
    .map((d) => ({ exDate: (d.date || '').slice(0, 10), amount: Number(d.divCash) }))
    .sort((a, b) => a.exDate.localeCompare(b.exDate));

  if (!events.length) return { ...EMPTY(ticker), currentPrice };   // valid ticker, simply doesn't pay

  const { label: frequency } = inferFrequency(events.map((e) => e.exDate));

  // TTM dividend = sum of amounts with ex-date in the trailing 365 days
  const cutoff = to.getTime() - 365 * MS_DAY;
  const ttmDividend = +events
    .filter((e) => Date.parse(e.exDate) >= cutoff)
    .reduce((s, e) => s + e.amount, 0)
    .toFixed(6);

  const ttmYield = (currentPrice && ttmDividend > 0) ? +((ttmDividend / currentPrice) * 100).toFixed(2) : null;
  const mostRecent = events[events.length - 1];

  return {
    ticker,
    payer: true,
    events: events.slice().reverse(),   // most recent first
    ttmDividend,
    frequency,
    mostRecent,
    currentPrice,
    ttmYield,
  };
}

export async function GET(request) {
  let ticker = '';
  try {
    const { searchParams } = new URL(request.url);
    ticker = (searchParams.get('ticker') || '').toUpperCase().trim();
    const forceRefresh = searchParams.get('refresh') === '1';
    if (!TICKER_RE.test(ticker)) return Response.json({ error: 'Invalid ticker' }, { status: 400 });

    const cacheKey = `dividends:${ticker}`;
    if (!forceRefresh) {
      const cached = await kvGet(cacheKey);
      if (cached) return Response.json({ ...cached, cached: true });
    }

    const fresh = await buildDividends(ticker);
    await kvSet(cacheKey, fresh, TTL);
    return Response.json({ ...fresh, cached: false });
  } catch (e) {
    console.log(`[dividends] ${ticker} route error: ${e.message}`);
    return Response.json({ ...EMPTY(ticker), error: false }, { status: 200 });   // null discipline
  }
}
