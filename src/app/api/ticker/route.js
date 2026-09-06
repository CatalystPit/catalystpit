import { db } from '../../../lib/db';
import { tickerDailyCandles, shortInterest } from '../../../lib/schema';
import { eq, desc } from 'drizzle-orm';
import { fetchTiingoDaily } from '../../../lib/congress-ingest.mjs';
import { resolveFloat } from '../../../lib/finra-short-interest.mjs';

export const runtime = 'nodejs';

const FINNHUB_KEY    = process.env.FINNHUB_KEY;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY;  // Vercel uses POLYGON_KEY, local .env.local uses POLYGON_API_KEY
const TIINGO_API_KEY = process.env.TIINGO_API_KEY;
const KV_URL         = process.env.KV_REST_API_URL;
const KV_TOKEN       = process.env.KV_REST_API_TOKEN;

const PFX = 'catalystpit:ticker:';
// Per-section TTLs (seconds): profile rarely changes; quote/news are live;
// metric drifts slowly; notfound is a short negative cache so junk symbols
// don't re-hit Finnhub on every keystroke-typo lookup.
const TTL = { profile: 86400, quote: 300, metric: 1800, news: 300, newsFallback: 60, notfound: 600, ma50: 86400, shortint: 21600 };
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
           country: p.country || null, ipo: p.ipo || null, weburl: p.weburl || null,
           shareOutstanding: p.shareOutstanding ?? null };   // millions — powers short-interest % of float
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
    epsTTM:    m.epsTTM ?? null,                          // free rider on this call → inherits metric TTL
    beta:      m.beta ?? null,
    divYield:  m.dividendYieldIndicatedAnnual ?? null,   // can be absent → null → "—"
    avgVol10d: m['10DayAverageTradingVolume'] ?? null,   // millions
  };
};

// 50-day SMA of adjusted closes from ticker_daily_candles. Lazy: if <50 candles stored,
// fetch ~90d of Tiingo daily and upsert first (mirrors /api/chart-daily). null if still <50.
async function computeFiftyDayMA(sym) {
  const last50 = () => db.select({ close: tickerDailyCandles.close })
    .from(tickerDailyCandles).where(eq(tickerDailyCandles.ticker, sym))
    .orderBy(desc(tickerDailyCandles.date)).limit(50);
  let rows = await last50();
  if (rows.length < 50 && TIINGO_API_KEY) {
    const to = new Date(), from = new Date(to.getTime() - 90 * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const { ok, data } = await fetchTiingoDaily(sym, fmt(from), fmt(to), TIINGO_API_KEY);
    if (ok && Array.isArray(data) && data.length) {
      const vals = data
        .filter(d => d.date && Number.isFinite(d.adjClose))
        .map(d => ({ ticker: sym, date: d.date.slice(0, 10),
          open: d.adjOpen, high: d.adjHigh, low: d.adjLow, close: d.adjClose,
          volume: d.adjVolume ?? 0, source: 'tiingo' }));
      if (vals.length) {
        await db.insert(tickerDailyCandles).values(vals)
          .onConflictDoNothing({ target: [tickerDailyCandles.ticker, tickerDailyCandles.date] });
        rows = await last50();
      }
    }
  }
  const closes = rows.map(r => Number(r.close)).filter(n => !isNaN(n));
  if (closes.length < 50) return null;
  return +(closes.reduce((a, b) => a + b, 0) / 50).toFixed(2);
}

// Latest FINRA short-interest row + % of float. Float comes from the SHARED resolveFloat
// (lib/finra-short-interest.mjs) — the exact same path the Short Interest tab uses — so the
// hero and the tab always agree. resolveFloat lazily fetches+caches FMP float on first view
// (cached 30d); pre-warm cron means popular tickers are usually already populated.
async function fetchHeroShortInterest(sym) {
  const [si] = await db.select({
    settlementDate: shortInterest.settlementDate, shortIntShares: shortInterest.shortIntShares,
    daysToCover: shortInterest.daysToCover, changePercent: shortInterest.changePercent,
  }).from(shortInterest).where(eq(shortInterest.ticker, sym))
    .orderBy(desc(shortInterest.settlementDate)).limit(1);
  if (!si) return null;
  const fl = await resolveFloat(sym);
  const floatShares = fl?.float_shares ?? null;
  const pctFloat = (si.shortIntShares != null && floatShares > 0)
    ? +((si.shortIntShares / floatShares) * 100).toFixed(2) : null;
  return { settlementDate: si.settlementDate, shortIntShares: si.shortIntShares,
    daysToCover: si.daysToCover, changePercent: si.changePercent, pctFloat };
}
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

// SEC company_tickers.json → ticker→company name. Identity resolution WITHOUT a
// market-data vendor (rule: resolve name from SEC, not Finnhub, on production). KV-cached
// 7d + module-memoised for warm invocations. null when SEC has no such symbol.
const SEC_NAME_UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
let SEC_NAMES = null;
async function loadSecNames() {
  if (SEC_NAMES) return SEC_NAMES;
  const hit = await kvGet('catalystpit:sec:ticker_names');
  if (hit != null) { try { SEC_NAMES = JSON.parse(hit); return SEC_NAMES; } catch { /* refetch */ } }
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_NAME_UA });
    if (!r.ok) return null;
    const data = await r.json();
    const map = {};
    for (const e of Object.values(data)) if (e?.ticker) map[String(e.ticker).toUpperCase()] = e.title || null;
    SEC_NAMES = map;
    await kvSet('catalystpit:sec:ticker_names', JSON.stringify(map), 7 * 24 * 3600);
    return map;
  } catch { return null; }
}
async function secTickerName(sym) {
  const map = await loadSecNames();
  return map ? (map[sym] || null) : null;
}

// validity cascade: profile2 (name) → prefetched /quote c>0 → /search exact → SEC name.
// Content-based,
// since Finnhub 200s everything. The quote is fetched in parallel by the caller, so the happy
// path costs no extra call; /search only fires for the rare profile-less + no-quote ticker.
async function resolveValidity(sym, profile, quote) {
  if (profile.name) return { valid: true, name: profile.name };
  if (quote && quote.c > 0) return { valid: true, name: sym };
  const se = await fh(`/search?q=${encodeURIComponent(sym)}`);
  const exact = (se?.result || []).find(r => (r.symbol || '').toUpperCase() === sym);
  if (exact) return { valid: true, name: exact.description || sym };
  const secName = await secTickerName(sym);          // SEC identity fallback — no market-data vendor
  if (secName) return { valid: true, name: secName };
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
    const [prof, quote, metric, news, ma50, shortInt] = await Promise.all([
      cached(`${PFX}${sym}:profile`, TTL.profile, () => fetchProfile(sym)),
      cached(`${PFX}${sym}:quote`,   TTL.quote,   () => fetchQuote(sym)),
      cached(`${PFX}${sym}:metric`,  TTL.metric,  () => fetchMetric(sym)),
      cachedNews(sym),
      cached(`${PFX}${sym}:ma50`,    TTL.ma50,     () => computeFiftyDayMA(sym)),
      cached(`${PFX}${sym}:shortint`, TTL.shortint, () => fetchHeroShortInterest(sym)),
    ]);

    const v = await resolveValidity(sym, prof.value || {}, quote.value);
    if (!v.valid) {
      // only negative-cache a *confirmed* not-found (we actually reached Finnhub), never a transient blip
      if (prof.value != null || quote.value != null) await kvSet(`${PFX}${sym}:notfound`, '1', TTL.notfound);
      console.log(`[ticker_api] ${sym} not found${prof.value == null ? ' (uncached: profile fetch failed)' : ''}`);
      return Response.json({ symbol: sym, valid: false, reason: 'not_found' });
    }

    const meta = { cache: { profile: prof.source, quote: quote.source, metric: metric.source, news: news.source, ma50: ma50.source, shortInterest: shortInt.source } };
    console.log(`[ticker_api] ${sym} ok · cache=${JSON.stringify(meta.cache)}`);
    return Response.json({
      symbol: sym, valid: true,
      name: v.name, exchange: prof.value?.exchange ?? null, industry: prof.value?.industry ?? null, logo: prof.value?.logo ?? null,
      country: prof.value?.country ?? null, ipo: prof.value?.ipo ?? null, weburl: prof.value?.weburl ?? null,
      quote: quote.value,
      // shareOutstanding lives on profile2 (not metric); merge it into metric so the UI
      // reads one place. Spread-guarded so a null metric fetch still surfaces it.
      metric: { ...(metric.value || {}), shareOutstanding: prof.value?.shareOutstanding ?? null },
      fiftyDayMA: ma50.value,          // number | null (null when <50 candles even after lazy fetch)
      shortInterest: shortInt.value,   // { settlementDate, shortIntShares, daysToCover, changePercent, pctFloat } | null
      news: news.value,
      meta,
    });
  } catch (e) {
    console.log(`[ticker_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
