export const runtime = 'nodejs';

const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY;  // Vercel uses POLYGON_KEY, local .env.local uses POLYGON_API_KEY
const KV_URL         = process.env.KV_REST_API_URL;
const KV_TOKEN       = process.env.KV_REST_API_TOKEN;

const PFX = 'catalystpit:ticker:';
// Per-section TTLs (seconds): profile rarely changes; quote/news are live;
// metric drifts slowly; notfound is a short negative cache so junk symbols
// don't re-hit Finnhub on every keystroke-typo lookup.
const TTL = { profile: 86400, quote: 300, metric: 1800, news: 300, newsFallback: 60, notfound: 600 };
// news: 5min on the Polygon-primary path; 60s when Polygon FAILED and we served the Finnhub
// (Yahoo-heavy) fallback — so a transient Polygon hiccup self-corrects in ~1min, not ~5.

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
           industry: p.finnhubIndustry || null, logo: p.logo || null,
           country: p.country || null, ipo: p.ipo || null, weburl: p.weburl || null };
};
const fetchQuote = async (sym) => {
  const q = await fh(`/quote?symbol=${encodeURIComponent(sym)}`);
  if (q == null) return null;
  return { c: q.c ?? null, d: q.d ?? null, dp: q.dp ?? null, h: q.h ?? null, l: q.l ?? null, o: q.o ?? null, pc: q.pc ?? null };
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
// Normalized news item: { headline, source, url, datetime (ISO string | null), image }.
// Each source-fetcher returns null on fetch failure (don't cache; retry next request),
// or an array (possibly empty) on success.
const fetchFinnhubNews = async (sym) => {
  const to = new Date(), from = new Date(to.getTime() - 14 * 86_400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const arr = await fh(`/company-news?symbol=${encodeURIComponent(sym)}&from=${fmt(from)}&to=${fmt(to)}`);
  if (!Array.isArray(arr)) return null;                  // fetch failed → null; genuine no-news → []
  return arr
    .filter(a => a.headline && a.url)
    .map(a => ({
      headline: a.headline,
      source:   a.source || 'Finnhub',
      url:      a.url,
      datetime: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
      image:    a.image || null,
    }));
};
// Polygon /v2/reference/news — per-ticker, diverse publishers (Motley Fool, Benzinga,
// GlobeNewswire, …), every item carries an image_url. published_utc is already ISO.
const fetchPolygonNews = async (sym) => {
  if (!POLYGON_API_KEY) return null;
  try {
    const r = await fetch(`https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(sym)}&limit=15&apiKey=${POLYGON_API_KEY}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j.results)) return null;
    return j.results
      .filter(a => a.title && a.article_url)
      .map(a => ({
        headline: a.title,
        source:   a.publisher?.name || 'Polygon',
        url:      a.article_url,
        datetime: a.published_utc || null,
        image:    a.image_url || null,
      }));
  } catch { return null; }
};

const NEWS_CAP = 15;
const POLYGON_ENOUGH = 6;   // Polygon-primary: only fall back to Finnhub (Yahoo-heavy) when Polygon is this thin
const newsTs = (n) => (n.datetime ? (Date.parse(n.datetime) || 0) : 0);

// Polygon-primary, Finnhub fallback. Both fetched in parallel; Finnhub results are only
// merged in when Polygon returns too few (keeps Yahoo out of the common case). null only
// when BOTH sources fail (so the cache won't persist a transient double-failure).
// Returns { items, degraded }. degraded = Polygon fetch FAILED (poly == null) so we leaned on
// the Finnhub/Yahoo fallback — the caller caches that briefly so it self-heals. items == null
// only when BOTH sources fail (caller won't persist a transient double-failure).
const fetchNews = async (sym) => {
  const [poly, fin] = await Promise.all([fetchPolygonNews(sym), fetchFinnhubNews(sym)]);
  if (poly == null && fin == null) return { items: null, degraded: false };
  const polyArr = poly || [], finArr = fin || [];
  let items;
  if (polyArr.length >= POLYGON_ENOUGH) {
    items = polyArr;                                     // enough diverse coverage — Polygon only
  } else {
    const seen = new Set(polyArr.map(a => a.url));       // fallback: top up with Finnhub, dedupe by URL
    items = [...polyArr, ...finArr.filter(a => !seen.has(a.url))];
  }
  return { items: items.sort((a, b) => newsTs(b) - newsTs(a)).slice(0, NEWS_CAP), degraded: poly == null };
};

// News cache with dynamic TTL (Polygon-fail fallback caches briefly). Mirrors cached()'s shape.
async function cachedNews(sym) {
  const key = `${PFX}${sym}:news`;
  const hit = await kvGet(key);
  if (hit != null) { try { return { value: JSON.parse(hit), source: 'cache' }; } catch { /* refetch */ } }
  const { items, degraded } = await fetchNews(sym);
  if (items != null) await kvSet(key, JSON.stringify(items), degraded ? TTL.newsFallback : TTL.news);
  return { value: items, source: 'live' };
}

// validity cascade: profile2 (name) → prefetched /quote c>0 → /search exact. Content-based,
// since Finnhub 200s everything. The quote is fetched in parallel by the caller, so the happy
// path costs no extra call; /search only fires for the rare profile-less + no-quote ticker.
async function resolveValidity(sym, profile, quote) {
  if (profile.name) return { valid: true, name: profile.name };
  if (quote && quote.c > 0) return { valid: true, name: sym };
  const se = await fh(`/search?q=${encodeURIComponent(sym)}`);
  const exact = (se?.result || []).find(r => (r.symbol || '').toUpperCase() === sym);
  if (exact) return { valid: true, name: exact.description || sym };
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

    // Fire profile + quote + metric + news together — none depend on profile, and validity
    // resolves from the already-fetched profile/quote. Cuts ~a Finnhub round-trip off cold loads.
    // (Trade-off: a format-valid-but-nonexistent symbol costs a few extra calls once, then it's
    //  negative-cached — junk is rare and the format gate + notfound cache absorb the common case.)
    const [prof, quote, metric, news] = await Promise.all([
      cached(`${PFX}${sym}:profile`, TTL.profile, () => fetchProfile(sym)),
      cached(`${PFX}${sym}:quote`,   TTL.quote,   () => fetchQuote(sym)),
      cached(`${PFX}${sym}:metric`,  TTL.metric,  () => fetchMetric(sym)),
      cachedNews(sym),
    ]);

    const v = await resolveValidity(sym, prof.value || {}, quote.value);
    if (!v.valid) {
      // only negative-cache a *confirmed* not-found (we actually reached Finnhub), never a transient blip
      if (prof.value != null || quote.value != null) await kvSet(`${PFX}${sym}:notfound`, '1', TTL.notfound);
      console.log(`[ticker_api] ${sym} not found${prof.value == null ? ' (uncached: profile fetch failed)' : ''}`);
      return Response.json({ symbol: sym, valid: false, reason: 'not_found' });
    }

    const meta = { cache: { profile: prof.source, quote: quote.source, metric: metric.source, news: news.source } };
    console.log(`[ticker_api] ${sym} ok · cache=${JSON.stringify(meta.cache)}`);
    return Response.json({
      symbol: sym, valid: true,
      name: v.name, exchange: prof.value?.exchange ?? null, industry: prof.value?.industry ?? null, logo: prof.value?.logo ?? null,
      country: prof.value?.country ?? null, ipo: prof.value?.ipo ?? null, weburl: prof.value?.weburl ?? null,
      quote: quote.value, metric: metric.value, news: news.value,
      meta,
    });
  } catch (e) {
    console.log(`[ticker_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
