export const runtime = 'nodejs';

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const KV_URL      = process.env.KV_REST_API_URL;
const KV_TOKEN    = process.env.KV_REST_API_TOKEN;

const PFX = 'catalystpit:ticker:';
// Per-section TTLs (seconds): profile rarely changes; quote/news are live;
// metric drifts slowly; notfound is a short negative cache so junk symbols
// don't re-hit Finnhub on every keystroke-typo lookup.
const TTL = { profile: 86400, quote: 300, metric: 1800, news: 300, notfound: 600 };

// ─── Upstash KV (REST) — mirrors src/app/api/refresh/route.js ────────────────
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ?? null;          // Upstash returns { result: <string|null> }
  } catch { return null; }
}
async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?ex=${ttlSec}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
    });
  } catch { /* cache-write failure is non-fatal */ }
}

// check KV → hit returns parsed value; miss runs fetcher, writes KV, returns live
async function cached(key, ttlSec, fetcher) {
  const hit = await kvGet(key);
  if (hit != null) {
    try { return { value: JSON.parse(hit), source: 'cache' }; }
    catch { return { value: hit, source: 'cache' }; }
  }
  const value = await fetcher();
  if (value != null) await kvSet(key, JSON.stringify(value), ttlSec);  // don't persist a failed fetch
  return { value, source: 'live' };
}

// ─── Finnhub ─────────────────────────────────────────────────────────────────
const fh = async (path) => {
  const r = await fetch(`https://finnhub.io/api/v1${path}${path.includes('?') ? '&' : '?'}token=${FINNHUB_KEY}`);
  if (!r.ok) return null;
  return r.json().catch(() => null);
};

// Each fetcher returns null on a *fetch failure* (so cached() won't persist it
// and it retries next request); a successful-but-empty result is a real value
// (e.g. no-news → []) and is cacheable.
const fetchProfile = async (sym) => {
  const p = await fh(`/stock/profile2?symbol=${encodeURIComponent(sym)}`);
  if (p == null) return null;
  return { name: p.name || null, exchange: p.exchange || null, ticker: p.ticker || sym,
           industry: p.finnhubIndustry || null, logo: p.logo || null };
};
const fetchQuote = async (sym) => {
  const q = await fh(`/quote?symbol=${encodeURIComponent(sym)}`);
  if (q == null) return null;
  return { c: q.c ?? null, d: q.d ?? null, dp: q.dp ?? null, h: q.h ?? null, l: q.l ?? null, pc: q.pc ?? null };
};
const fetchMetric = async (sym) => {
  const r = await fh(`/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`);
  if (r == null) return null;
  const m = r.metric || {};
  return {
    high52:    m['52WeekHigh'] ?? null,
    low52:     m['52WeekLow'] ?? null,
    marketCap: m.marketCapitalization ?? null,           // millions USD
    peTTM:     m.peTTM ?? null,
    divYield:  m.dividendYieldIndicatedAnnual ?? null,   // can be absent → null → "—"
    avgVol10d: m['10DayAverageTradingVolume'] ?? null,   // millions
  };
};
const fetchNews = async (sym) => {
  const to = new Date(), from = new Date(to.getTime() - 14 * 86_400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const arr = await fh(`/company-news?symbol=${encodeURIComponent(sym)}&from=${fmt(from)}&to=${fmt(to)}`);
  if (!Array.isArray(arr)) return null;                  // fetch failed → null (don't cache); genuine no-news → []
  return arr
    .filter(a => a.headline && a.url)
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
    .slice(0, 10)
    .map(a => ({
      headline: a.headline,
      source:   a.source || 'Finnhub',
      url:      a.url,
      datetime: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
      image:    a.image || null,
    }));
};

// validity cascade: profile2 (name) → /search exact → /quote c>0. Content-based,
// since Finnhub 200s everything. Only runs the fallbacks when profile is empty.
async function resolveValidity(sym, profile) {
  if (profile.name) return { valid: true, name: profile.name };
  const se = await fh(`/search?q=${encodeURIComponent(sym)}`);
  const exact = (se?.result || []).find(r => (r.symbol || '').toUpperCase() === sym);
  if (exact) return { valid: true, name: exact.description || sym };
  const q = await fh(`/quote?symbol=${encodeURIComponent(sym)}`);
  if (q && q.c > 0) return { valid: true, name: sym };
  return { valid: false, name: null };
}

export async function GET(request) {
  try {
    const sym = (new URL(request.url).searchParams.get('symbol') || '').toUpperCase().trim();

    // format gate — reject junk with zero Finnhub calls
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) {
      return Response.json({ symbol: sym, valid: false, reason: 'format' });
    }

    // negative cache — recently-confirmed not-found symbols short-circuit here
    if (await kvGet(`${PFX}${sym}:notfound`) != null) {
      return Response.json({ symbol: sym, valid: false, reason: 'not_found', meta: { cache: { notfound: 'cache' } } });
    }

    const prof = await cached(`${PFX}${sym}:profile`, TTL.profile, () => fetchProfile(sym));
    const v = await resolveValidity(sym, prof.value || {});
    if (!v.valid) {
      // only negative-cache a *confirmed* not-found (we reached Finnhub), never a transient blip
      if (prof.value != null) await kvSet(`${PFX}${sym}:notfound`, '1', TTL.notfound);
      console.log(`[ticker_api] ${sym} not found${prof.value == null ? ' (uncached: profile fetch failed)' : ''}`);
      return Response.json({ symbol: sym, valid: false, reason: 'not_found' });
    }

    const [quote, metric, news] = await Promise.all([
      cached(`${PFX}${sym}:quote`,  TTL.quote,  () => fetchQuote(sym)),
      cached(`${PFX}${sym}:metric`, TTL.metric, () => fetchMetric(sym)),
      cached(`${PFX}${sym}:news`,   TTL.news,   () => fetchNews(sym)),
    ]);

    const meta = { cache: { profile: prof.source, quote: quote.source, metric: metric.source, news: news.source } };
    console.log(`[ticker_api] ${sym} ok · cache=${JSON.stringify(meta.cache)}`);
    return Response.json({
      symbol: sym, valid: true,
      name: v.name, exchange: prof.value?.exchange ?? null, industry: prof.value?.industry ?? null, logo: prof.value?.logo ?? null,
      quote: quote.value, metric: metric.value, news: news.value,
      meta,
    });
  } catch (e) {
    console.log(`[ticker_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
