import { db } from '../../../lib/db';
import { tickerDailyCandles, shortInterest } from '../../../lib/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { fetchTiingoDaily } from '../../../lib/congress-ingest.mjs';
import { resolveFloat } from '../../../lib/finra-short-interest.mjs';
import { apiRateLimit } from '../../../lib/api-guard.mjs';
import { tiingoDailyToCanonical, assertCanonicalCandles } from '../../../lib/market/candles.mjs';
import { LICENSED_CANDLE_SOURCES_SQL, servableMetaSource } from '../../../lib/licensing/providers.mjs';
import { computePe } from '../../../lib/sec/xbrl-facts.mjs';
import { claimRefreshAttempt, coalesce } from '../../../lib/market/refresh-policy.mjs';

export const runtime = 'nodejs';

const TIINGO_API_KEY = process.env.TIINGO_API_KEY;
const KV_URL         = process.env.KV_REST_API_URL;
const KV_TOKEN       = process.env.KV_REST_API_TOKEN;

const PFX = 'catalystpit:ticker:';
// Per-section TTLs (seconds): profile rarely changes; quote/news are live;
// metric drifts slowly; notfound is a short negative cache so junk symbols
// don't re-hit Finnhub on every keystroke-typo lookup.
const TTL = { profile: 86400, quote: 300, metric: 1800, news: 300, newsFallback: 60, notfound: 600, ma50: 86400, shortint: 21600 };

// ⚠️ THE FIX FOR THE 5-10 SECOND TICKER PAGE, and it is not in this handler's code.
//
// Measured: the handler body runs in 3-5ms with every field a cache hit, while the request takes
// 4-7 SECONDS from the browser. The instrumentation starts INSIDE the handler, so a multi-second
// wall time against total=4ms is time spent before our code exists — Vercel cold-starting the
// function. The response was `public, max-age=0, must-revalidate`, so X-Vercel-Cache was MISS on
// every single request and there was no way to avoid paying that boot. On a site with pre-launch
// traffic the function is cold for most first clicks, and the whole ticker page waits on this one
// request, which is exactly the partial-page state being reported.
//
// ⚠️ SAFE TO SHARE AT THE EDGE because this response is user-independent: no auth() call, no tier
// resolution, no cookie read, no Set-Cookie. Every visitor gets byte-identical content. (Verified,
// and asserted in verify-ticker-cache.mjs so it stays true.)
//
// ⚠️ AND IT CANNOT WEAKEN FRESHNESS. The quote behind this already has a 300s KV TTL, so the data
// may ALREADY be five minutes old for everyone. 45s at the edge plus at most 120s of
// stale-while-revalidate is 165s worst case — strictly fresher than what the endpoint could already
// serve. Free/Pro real-time rules are untouched: they live on /api/quotes and /api/chart-intraday,
// which resolve entitlement per user and are NOT edge-cached.
const TICKER_CDN_CACHE = { 'Cache-Control': 'public, s-maxage=45, stale-while-revalidate=120' };
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

// ONE Redis command for many keys. Upstash bills per COMMAND, so seven independent GETs cost seven
// while a single MGET of the same seven costs one. Pipelining would not have helped: it saves round
// trips, not commands. Returns values positionally, null where the key is absent, and null for
// everything if the call fails so callers fall through to their own fetch exactly as before.
async function kvMGet(keys) {
  if (!KV_URL || !KV_TOKEN || !keys.length) return keys.map(() => null);
  try {
    const path = keys.map((k) => encodeURIComponent(k)).join('/');
    const r = await fetch(`${KV_URL}/mget/${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return keys.map(() => null);
    const d = await r.json();
    return Array.isArray(d.result) ? d.result.map((v) => v ?? null) : keys.map(() => null);
  } catch { return keys.map(() => null); }
}

// check KV → hit returns parsed value; miss runs fetcher, writes KV, returns live.
// `preloaded` lets a caller that already fetched this key via kvMGet skip the individual GET. The
// semantics are unchanged: same key, same value, same TTL on write.
async function cached(key, ttlSec, fetcher, preloaded) {
  const hit = preloaded !== undefined ? preloaded : await kvGet(key);
  if (hit != null) {
    try { return { value: JSON.parse(hit), source: 'cache' }; }
    catch { return { value: hit, source: 'cache' }; }
  }
  const value = await fetcher();
  if (value != null) await kvSet(key, JSON.stringify(value), ttlSec);  // don't persist a failed fetch
  return { value, source: 'live' };
}

// ⚠️ EVERY THIRD-PARTY CALL ON THIS ROUTE IS BOUNDED, and none of them was.
//
// This endpoint fans out to Finnhub, Tiingo and SEC.gov inside a Promise.all, so the response takes
// as long as the SLOWEST of them and none had a timeout. Measured on production: three consecutive
// calls returned in 0.33s, 7.30s and 0.21s — the middle one is a vendor having a bad moment, and the
// page simply waited. A ticker page that usually paints in 200ms and occasionally takes seven
// seconds is what "feels slow" actually means.
//
// ⚠️ A TIMEOUT HERE CHANGES NO DATA. Every fetcher already returns null on a fetch failure, and
// cached() deliberately does not persist a null — so an aborted call behaves exactly like the
// failure case that already existed: the field is absent for this request and refetched on the next
// one. Nothing is fabricated and nothing stale is promoted.
const VENDOR_TIMEOUT_MS = 3500;
const fetchBounded = async (url, init = {}, ms = VENDOR_TIMEOUT_MS) => {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); }
  catch { return null; }
};

// ─── LICENSED SOURCES ONLY ───────────────────────────────────────────────────
//
// ⚠️ THIS ROUTE WAS A FINNHUB PROXY, AND IT WAS THE PRODUCT'S WORST LICENSING EXPOSURE. Five Finnhub
// endpoints — /stock/profile2, /quote, /stock/metric, /company-news and /search — answered on every
// ticker page, to ANONYMOUS visitors, with a live vendor request per page view (meta.cache.quote was
// literally "live"). The profile's `logo` was a hotlink to static2.finnhub.io, so the reader's own
// browser fetched an image from a vendor we hold no agreement with.
//
// Everything below now comes from Tiingo, from SEC, or from our own tables — and where there is no
// approved source the field is NULL and the page renders the em dash it already renders for unknowns.
// Nothing is substituted from a near-neighbour vendor and nothing is estimated.
//
//   name / exchange / industry   our security master (security_identity + screener_meta) and SEC
//   quote                        Tiingo, through the same getQuotes() the rest of the product uses
//   52-week high / low           our licensed daily candles
//   average volume (10d)         our licensed daily candles
//   market cap / shares out      screener_meta, and only rows whose provenance is approved
//   beta                         screener_stocks, recomputed from licensed candles
//   dividend yield               screener_meta.annual_dividend over the licensed last close
//   P/E, EPS TTM                 NULL — see backfillFundamentals in lib/screener-data.js
//   logo / country / IPO / url   NULL — no approved source; the UI draws its own initials mark

/** The quote shape the ticker page has always consumed, built from the licensed provider. */
const fetchQuote = async (sym) => {
  try {
    const { getQuotes } = await import('../../../lib/market-data');
    // ⚠️ realtime:false DELIBERATELY. This response is shared at the CDN and is user-independent, so it
    // must never carry an entitled real-time print. Pro's live quote arrives through /api/quotes, which
    // resolves entitlement per caller and is never shared-cached.
    const q = (await getQuotes([sym], { realtime: false }))[sym];
    if (!q || !Number.isFinite(Number(q.price))) return null;
    const c = Number(q.price);
    const pc = Number.isFinite(Number(q.prevClose)) ? Number(q.prevClose) : null;
    return {
      c,
      d:  pc != null ? +(c - pc).toFixed(4) : null,
      dp: Number.isFinite(Number(q.changePct)) ? Number(q.changePct) : (pc > 0 ? +(((c - pc) / pc) * 100).toFixed(4) : null),
      h:  Number.isFinite(Number(q.high)) ? Number(q.high) : null,
      l:  Number.isFinite(Number(q.low)) ? Number(q.low) : null,
      o:  Number.isFinite(Number(q.open)) ? Number(q.open) : null,
      pc,
    };
  } catch { return null; }
};

/**
 * Identity from our own master. No vendor profile call.
 *
 * ⚠️ RETURNS null ONLY WHEN THE LOOKUP ITSELF FAILED, so a transient DB error is retried rather than
 * cached as "this company has no name" — the same contract the vendor fetchers had.
 */
const fetchProfile = async (sym) => {
  try {
    const m = await masterIdentity(sym);
    const name = m.name || (await secTickerName(sym));
    return {
      ticker: sym,
      name: name || null,
      exchange: m.exchange || null,
      industry: m.industry || m.sector || null,
      // No approved source supplies these. Null, not a substitute.
      logo: null, country: null, ipo: null, weburl: null,
      shareOutstanding: m.sharesOut ?? null,     // already gated on provenance inside masterIdentity
    };
  } catch { return null; }
};

/**
 * The metrics block, computed from licensed inputs.
 *
 * ⚠️ 52-WEEK AND AVERAGE VOLUME ARE COMPUTED, NOT COPIED, and that is a real improvement: the vendor's
 * figures were opaque numbers we could not reproduce or audit. These are one indexed query over the
 * candles the charts already draw, so the hero and the chart cannot disagree.
 *
 * ⚠️ P/E AND EPS ARE NULL ON PURPOSE. They were Finnhub's peTTM/epsTTM. We have no licensed market-data
 * source for them and no verified SEC extractor yet, and an invented ratio on a stock page is worse
 * than a blank one.
 */
const fetchMetric = async (sym) => {
  try {
    const res = await db.execute(sql`
      with lic as (
        select close, volume, date
          from ticker_daily_candles
         where ticker = ${sym} and source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)})
           and date >= current_date - 400
      )
      select
        (select max(close) from (select close from lic order by date desc limit 252) w)      as high52,
        (select min(close) from (select close from lic order by date desc limit 252) w)      as low52,
        (select count(*)  from (select close from lic order by date desc limit 252) w)       as n52,
        (select avg(volume) from (select volume from lic order by date desc limit 10) v)     as avg_vol_10d,
        (select count(volume) from (select volume from lic order by date desc limit 10) v)   as n_vol,
        (select close from lic order by date desc limit 1)                                   as last_close`);
    const r = (res.rows ?? res)[0] || {};

    // ⚠️ A RANGE IS ONLY A 52-WEEK RANGE IF THERE IS A YEAR BEHIND IT, and this guard exists because the
    // first version of this query did not have one. Measured on SPY while the licensed rebuild was still
    // in flight: high 773.38, low 762.63, last 762.63 — a 1.4% "52-week range", computed from the handful
    // of sessions that happened to be present. Every number was arithmetically correct and the label was
    // a lie, which is the exact failure mode this whole change exists to remove. Min/max over a short
    // window degrades silently; a count does not.
    //
    // 150 sessions is ~60% of a trading year: enough that the extremes are meaningful, loose enough to
    // cover a recent listing's genuinely shorter history rather than demanding data that cannot exist.
    const n52 = Number(r.n52) || 0;
    const nVol = Number(r.n_vol) || 0;
    const haveYear = n52 >= 150;
    const haveVol = nVol >= 10;

    const meta = await db.execute(sql`
      select market_cap, shares_out, annual_dividend, source from screener_meta where ticker = ${sym}`);
    const m = (meta.rows ?? meta)[0] || {};
    const metaOk = servableMetaSource(m.source);

    const beta = await db.execute(sql`select beta from screener_stocks where ticker = ${sym}`);
    const b = Number((beta.rows ?? beta)[0]?.beta);

    const lastClose = Number(r.last_close);
    const annual = metaOk ? Number(m.annual_dividend) : NaN;

    // ── SEC-DERIVED FUNDAMENTALS ────────────────────────────────────────────
    //
    // ⚠️ READ FROM OUR OWN TABLE, NOT FROM SEC. This route is on the ticker page's critical path and was
    // the subject of a measured performance fix; an SEC request here would undo it. The fundamentals are
    // ingested ahead of time by scripts/ingest-sec-fundamentals.mjs — one frames request per concept for
    // the whole market — and this is one indexed read of the result.
    //
    // ⚠️ AND IT IS GATED ON PROVENANCE, like every other stored value this page serves. 4,477 rows in this
    // table predate the licensing work and were Polygon-derived with a NULL source; they are not servable,
    // and `source = 'sec'` is the only value that is.
    const fund = await db.execute(sql`
      select eps_diluted_ttm, eps_basic_ttm, revenue_ttm_sec, net_income_ttm, free_cash_flow,
             pe_basis, ttm_end_date::text as ttm_end_date, source
        from screener_fundamentals where ticker = ${sym} and source = 'sec'`);
    const fx = (fund.rows ?? fund)[0] || {};
    const epsTtm = Number(fx.eps_diluted_ttm);
    const haveEps = Number.isFinite(epsTtm) && fx.eps_diluted_ttm !== null;

    // ⚠️ P/E IS COMPUTED HERE FROM THE LICENSED LAST CLOSE RATHER THAN STORED, because the stored value
    // ages with the price while the EPS does not. The EPS is the slow-moving SEC fact; the price is ours
    // and current. computePe owns the rules — positive denominator, stated basis — so this cannot quietly
    // publish a P/E on a loss.
    const pe = computePe({ price: lastClose, epsTtm: haveEps ? epsTtm : null });

    return {
      high52:    haveYear && Number.isFinite(Number(r.high52)) ? +Number(r.high52).toFixed(4) : null,
      low52:     haveYear && Number.isFinite(Number(r.low52)) ? +Number(r.low52).toFixed(4) : null,
      // Millions, matching the unit the page already formats.
      marketCap: metaOk && Number(m.market_cap) > 0 ? +(Number(m.market_cap) / 1e6).toFixed(2) : null,
      peTTM:     pe.ok ? +pe.value.toFixed(4) : null,
      // ⚠️ THE BASIS TRAVELS WITH THE NUMBER. A P/E with no stated basis is the thing that lets a quarterly
      // EPS be presented as an annual multiple; the ticker page can label it because it is told.
      peBasis:   pe.ok ? pe.basis : null,
      epsTTM:    haveEps ? +epsTtm.toFixed(4) : null,
      epsBasicTTM: Number.isFinite(Number(fx.eps_basic_ttm)) && fx.eps_basic_ttm !== null ? +Number(fx.eps_basic_ttm).toFixed(4) : null,
      revenueTTM: Number.isFinite(Number(fx.revenue_ttm_sec)) && fx.revenue_ttm_sec !== null ? Number(fx.revenue_ttm_sec) : null,
      netIncomeTTM: Number.isFinite(Number(fx.net_income_ttm)) && fx.net_income_ttm !== null ? Number(fx.net_income_ttm) : null,
      freeCashFlow: Number.isFinite(Number(fx.free_cash_flow)) && fx.free_cash_flow !== null ? Number(fx.free_cash_flow) : null,
      // ⚠️ THE TTM WINDOW'S END DATE, so a reader can see HOW CURRENT these are. A fundamental is as of a
      // filing, not as of now, and a page that implies otherwise is showing stale revenue as current
      // revenue — which the brief names explicitly as something this page must never do.
      ttmAsOf:   fx.ttm_end_date || null,
      beta:      Number.isFinite(b) ? +b.toFixed(3) : null,
      divYield:  (Number.isFinite(annual) && annual > 0 && lastClose > 0) ? +((annual / lastClose) * 100).toFixed(2) : null,
      avgVol10d: haveVol && Number.isFinite(Number(r.avg_vol_10d)) ? +(Number(r.avg_vol_10d) / 1e6).toFixed(4) : null,
    };
  } catch { return null; }
};

// 50-day SMA of adjusted closes from ticker_daily_candles. Lazy: if <50 candles stored,
// fetch ~90d of Tiingo daily and upsert first (mirrors /api/chart-daily). null if still <50.
async function computeFiftyDayMA(sym) {
  const last50 = () => db.select({ close: tickerDailyCandles.close })
    .from(tickerDailyCandles).where(eq(tickerDailyCandles.ticker, sym))
    .orderBy(desc(tickerDailyCandles.date)).limit(50);
  let rows = await last50();
  // ── WHY THIS IS GUARDED ──
  //
  // The trigger is "fewer than 50 stored candles", and for a legitimately thin history — a recent
  // listing, an illiquid or delisted symbol — the fetch can never make that false. The condition
  // that causes the request is one the request cannot satisfy, so every visit re-fetched forever.
  //
  // A claimed ATTEMPT (not a success) terminates it: one upstream call per cooldown per symbol,
  // whatever the vendor returns. Concurrent callers share a single flight.
  const key = `ticker-50dma:${sym}`;
  if (rows.length < 50 && TIINGO_API_KEY && await claimRefreshAttempt(key)) {
    const to = new Date(), from = new Date(to.getTime() - 90 * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const { ok, data } = await coalesce(key, () =>
      fetchTiingoDaily(sym, fmt(from), fmt(to), TIINGO_API_KEY));
    if (ok && Array.isArray(data) && data.length) {
      // Same canonical conversion as /api/chart-daily. This writer previously persisted the adj*
      // (total-return) fields too, so a 50-day average computed from it was an average of prices
      // nobody could have traded. One contract, one conversion, enforced by the guard.
      const vals = assertCanonicalCandles(
        tiingoDailyToCanonical(data, { ticker: sym, today: fmt(to) }), { ticker: sym });
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
// ⚠️ THE FINNHUB NEWS FETCHER IS GONE. It was the fallback whenever Tiingo returned fewer than six
// articles, and its contents were largely Yahoo Finance syndication — so the quiet case was licensed
// and the thin case silently was not. A short news list is a visible, honest degrade; topping it up
// from an unlicensed aggregator is not a degrade at all, it is a different problem wearing its clothes.
// TIINGO NEWS — per-ticker, diverse publishers, under our own licence.
//
// ⚠️ MIGRATED OFF POLYGON (/v2/reference/news), whose redistribution rights for public commercial
// display were never established. Tiingo's news endpoint is covered by the agreement and answers
// for the whole universe — verified on a small-cap (JAGX), not only on mega-caps, because the
// FUNDAMENTALS endpoint on this same plan IS capped to the Dow 30 and it was worth confirming
// which restriction applied where.
//
// ⚠️ ONE FIELD IS GENUINELY LOST. Polygon returned an image_url per article; Tiingo does not. It
// is reported as null rather than sourced elsewhere or guessed at — the ticker page already falls
// back to the company logo when an article has no image, so the degrade is visible and harmless.
// Inventing an image to preserve a layout would be a fabrication.
const fetchTiingoNews = async (sym) => {
  const token = process.env.TIINGO_API_KEY;
  if (!token) return null;
  try {
    const r = await fetchBounded(`https://api.tiingo.com/tiingo/news?tickers=${encodeURIComponent(String(sym).toLowerCase())}&limit=15&token=${token}`,
      { headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    if (!r || !r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    return j
      .filter(a => a.title && a.url)
      .map(a => ({
        headline: a.title,
        source:   a.source || 'Tiingo',
        url:      a.url,
        datetime: a.publishedDate || null,
        image:    null,
      }));
  } catch { return null; }
};

const NEWS_CAP = 15;
const newsTs = (n) => (n.datetime ? (Date.parse(n.datetime) || 0) : 0);

// Licensed only. `degraded` is retained because the caller uses it to pick a SHORT cache TTL when the
// licensed fetch failed, so an outage self-heals in a minute instead of being cached for five.
const fetchNews = async (sym) => {
  const primary = await fetchTiingoNews(sym);
  if (primary == null) return { items: null, degraded: true };
  return { items: primary.sort((a, b) => newsTs(b) - newsTs(a)).slice(0, NEWS_CAP), degraded: false };
};

// News cache with dynamic TTL (Polygon-fail fallback caches briefly). Mirrors cached()'s shape.
async function cachedNews(sym, preloaded) {
  const key = `${PFX}${sym}:news`;
  const hit = preloaded !== undefined ? preloaded : await kvGet(key);
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
    // SEC serves a multi-megabyte file here. It is cached for 7 days and memoised per instance, so
    // exactly one unlucky request pays for it — and that request must not be able to pay forever.
    const r = await fetchBounded('https://www.sec.gov/files/company_tickers.json', { headers: SEC_NAME_UA }, 5000);
    if (!r || !r.ok) return null;
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

/**
 * OUR OWN SECURITY MASTER — the one source that names an ETF.
 *
 * ⚠️ THE TICKER PAGE WAS THE ONLY SURFACE NOT READING IT, and it is the surface where it matters
 * most. security_identity exists precisely for "any security that files neither a Form 4 nor an 8-K —
 * closed-end funds, ETFs, ADRs, preferred lines", and screener_meta carries the exchange the vendor
 * profile omits for exactly those securities. One indexed read on two primary keys.
 */
async function masterIdentity(sym) {
  try {
    const res = await db.execute(sql`
      select i.name as name, m.exchange as exchange, m.sector as sector, m.industry as industry,
             m.asset_type as asset_type, m.shares_out as shares_out, m.source as meta_source,
             s.company as company
        from (select ${sym}::text as t) k
        left join security_identity i on i.ticker = k.t
        left join screener_meta     m on m.ticker = k.t
        left join screener_stocks   s on s.ticker = k.t`);
    const r = (res.rows ?? res)[0] || {};
    // ⚠️ THE REFERENCE COLUMNS ARE GATED ON PROVENANCE; THE NAME IS NOT, AND THE DIFFERENCE IS
    // DELIBERATE. security_identity.name comes from SEC filings and our own resolution, so it is
    // approved wherever it exists. screener_meta's exchange, sector, industry, asset type and share
    // count were Polygon reference data on every pre-audit row, and those rows record no source — so
    // they are withheld until backfillMeta rewrites them from SEC. Withholding a sector shows an em
    // dash; serving it would publish a vendor's reference data we may not redistribute.
    const metaOk = servableMetaSource(r.meta_source);
    return {
      name: r.name || r.company || null,
      exchange: metaOk ? (r.exchange || null) : null,
      sector: metaOk ? (r.sector || null) : null,
      industry: metaOk ? (r.industry || null) : null,
      assetType: metaOk ? (r.asset_type || null) : null,
      sharesOut: metaOk && Number(r.shares_out) > 0 ? Number(r.shares_out) : null,
    };
  } catch { return { name: null, exchange: null, sector: null, industry: null, assetType: null, sharesOut: null }; }
}

// validity cascade: profile2 (name) → OUR SECURITY MASTER → prefetched /quote c>0 → /search exact →
// SEC name. Content-based, since Finnhub 200s everything. The quote is fetched in parallel by the
// caller, so the happy path costs no extra call.
//
// ── ⚠️ THE ORDER IS THE DEFECT THAT WAS HERE ────────────────────────────────
//
// `if (quote && quote.c > 0) return { name: sym }` sat SECOND, so any security the vendor has no
// profile for — which is every ETF — resolved to its own ticker and short-circuited before any
// identity lookup ran. Measured in production: /ticker/SPY rendered "SPY" with a null exchange while
// security_identity held "SPDR S&P 500 ETF TRUST" and screener_meta held NYSE. Same for QQQ, IWM, VOO
// and DIA, and for 5,472 ETFs with a resolved name in our own table.
//
// The SEC fallback below could never have covered them either: company_tickers.json lists SEC
// registrants, and an ETF trust is not in it. The master is the source that knows.
//
// The bare-symbol branch is KEPT as the last resort before /search — a tradeable symbol we cannot
// name is still a valid page — but it no longer outranks knowing the answer.
async function resolveValidity(sym, profile, quote) {
  if (profile.name) return { valid: true, name: profile.name, master: null };
  const master = await masterIdentity(sym);
  if (master.name) return { valid: true, name: master.name, master };
  if (quote && quote.c > 0) return { valid: true, name: sym, master };
  // ⚠️ THE VENDOR SYMBOL SEARCH IS GONE. It was Finnhub /search, used to name a security our own master
  // and SEC both failed to name — the rarest branch of the cascade, and not worth an unlicensed call.
  // The SEC fallback below already covers every registrant; what it cannot name stays unnamed.
  const secName = await secTickerName(sym);          // SEC identity fallback — no market-data vendor
  if (secName) return { valid: true, name: secName, master };
  return { valid: false, name: null, master };
}

export async function GET(request) {
  const _rl = await apiRateLimit(request, 'ticker', 'provider');
  if (_rl) return _rl;

  try {
    const sym = (new URL(request.url).searchParams.get('symbol') || '').toUpperCase().trim();

    // format gate — reject junk with zero Finnhub calls
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) {
      return Response.json({ symbol: sym, valid: false, reason: 'format' });
    }

    // ⚠️ SERVER-SIDE STAGE TIMINGS, because the client could only ever see one number. From the
    // browser this endpoint took 4-7s while every field reported a cache HIT, which rules out the
    // vendor fan-out and leaves "somewhere between the request arriving and the response leaving".
    // These are durations in milliseconds only — no keys, no URLs, no configuration.
    const T = { t0: Date.now() };
    const mark = (k) => { T[k] = Date.now() - T.t0; };
    mark('start');

    // Every cache key this request can read, fetched in ONE Redis command instead of seven. The
    // negative-cache short-circuit still happens first and still costs nothing extra: its value
    // arrives in the same MGET.
    const KEYS = ['notfound', 'profile', 'quote', 'metric', 'news', 'ma50', 'shortint'];
    const [nf, pProfile, pQuote, pMetric, pNews, pMa50, pShortInt] =
      await kvMGet(KEYS.map((k) => `${PFX}${sym}:${k}`));
    mark('mget');

    // negative cache — recently-confirmed not-found symbols short-circuit here
    if (nf != null) {
      return Response.json({ symbol: sym, valid: false, reason: 'not_found', meta: { cache: { notfound: 'cache' } } });
    }

    // Fire profile + quote + metric + news together — none depend on profile, and validity
    // resolves from the already-fetched profile/quote. Cuts ~a Finnhub round-trip off cold loads.
    // (Trade-off: a format-valid-but-nonexistent symbol costs a few extra calls once, then it's
    //  negative-cached — junk is rare and the format gate + notfound cache absorb the common case.)
    const [prof, quote, metric, news, ma50, shortInt] = await Promise.all([
      cached(`${PFX}${sym}:profile`, TTL.profile, () => fetchProfile(sym), pProfile),
      cached(`${PFX}${sym}:quote`,   TTL.quote,   () => fetchQuote(sym), pQuote),
      cached(`${PFX}${sym}:metric`,  TTL.metric,  () => fetchMetric(sym), pMetric),
      cachedNews(sym, pNews),
      cached(`${PFX}${sym}:ma50`,    TTL.ma50,     () => computeFiftyDayMA(sym), pMa50),
      cached(`${PFX}${sym}:shortint`, TTL.shortint, () => fetchHeroShortInterest(sym), pShortInt),
    ]);

    mark('fanout');

    const v = await resolveValidity(sym, prof.value || {}, quote.value);
    mark('validity');
    if (!v.valid) {
      // only negative-cache a *confirmed* not-found (we actually reached Finnhub), never a transient blip
      if (prof.value != null || quote.value != null) await kvSet(`${PFX}${sym}:notfound`, '1', TTL.notfound);
      console.log(`[ticker_api] ${sym} not found${prof.value == null ? ' (uncached: profile fetch failed)' : ''}`);
      return Response.json({ symbol: sym, valid: false, reason: 'not_found' });
    }

    const meta = { cache: { profile: prof.source, quote: quote.source, metric: metric.source, news: news.source, ma50: ma50.source, shortInterest: shortInt.source },
      timing: { mget: T.mget, fanout: T.fanout, validity: T.validity, total: Date.now() - T.t0 } };
    console.log(`[ticker_api] ${sym} ok · cache=${JSON.stringify(meta.cache)}`);
    return Response.json({
      symbol: sym, valid: true,
      // ⚠️ THE EXCHANGE AND SECTOR FALL BACK TO THE MASTER TOO. The vendor profile is null for an ETF,
      // so the page showed no exchange at all for SPY while screener_meta held NYSE. The provider still
      // wins when it answers — this only fills what it left empty, and never invents a value.
      name: v.name,
      exchange: prof.value?.exchange ?? v.master?.exchange ?? null,
      industry: prof.value?.industry ?? v.master?.industry ?? v.master?.sector ?? null,
      logo: prof.value?.logo ?? null,
      country: prof.value?.country ?? null, ipo: prof.value?.ipo ?? null, weburl: prof.value?.weburl ?? null,
      quote: quote.value,
      // shareOutstanding lives on profile2 (not metric); merge it into metric so the UI
      // reads one place. Spread-guarded so a null metric fetch still surfaces it.
      metric: { ...(metric.value || {}), shareOutstanding: prof.value?.shareOutstanding ?? null },
      fiftyDayMA: ma50.value,          // number | null (null when <50 candles even after lazy fetch)
      shortInterest: shortInt.value,   // { settlementDate, shortIntShares, daysToCover, changePercent, pctFloat } | null
      news: news.value,
      meta,
    }, { headers: TICKER_CDN_CACHE });
  } catch (e) {
    console.log(`[ticker_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
