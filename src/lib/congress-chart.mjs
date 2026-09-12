// src/lib/congress-chart.mjs
//
// Price history for the congressional trading chart. Polygon-backed, cached in the existing
// ticker_daily_candles table, so this adds no second market-data system.
//
// Why Polygon rather than the Tiingo path /api/chart-daily uses: this feature charts across
// roughly 1,150 distinct congressional tickers, and Tiingo's free tier is the exact bottleneck
// that pushed congress PRICE ENRICHMENT onto Polygon already. Polygon stocks are unlimited on
// our plan and one aggregates call returns the full 3 years.
//
// Client-safe helpers (RANGES, startDateFor, clampRange) carry no secrets and no network, so the
// browser can share the range vocabulary. Fetching lives behind the API route.

// 3 years is a HARD cap for this feature: no MAX, no 5Y. The cap is enforced here rather than in
// the UI so an API caller cannot request more history than we intend to store or serve.
export const RANGES = ['1M', '3M', '6M', '1Y', '3Y'];
export const DEFAULT_RANGE = '6M';
export const MAX_RANGE = '3Y';
export const MAX_HISTORY_DAYS = 1095;

const RANGE_DAYS = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '3Y': MAX_HISTORY_DAYS };

/**
 * Resolve a requested range.
 *
 *   absent                  -> the 6M default
 *   a supported range       -> itself
 *   a real period ABOVE 3Y  -> clamped DOWN to 3Y  (5Y, 10Y, MAX, ALL)
 *   a real period below 3Y  -> the nearest supported range
 *   anything unparseable    -> invalid, for the caller to reject
 *
 * Asking for 5Y and silently receiving 6M is worse than receiving 3Y: the caller wanted MORE
 * history and would quietly get less than the default. So an over-max request is clamped to the
 * cap, and only genuinely malformed input is rejected.
 */
export function resolveRange(input) {
  if (input == null || String(input).trim() === '') return { range: DEFAULT_RANGE, clamped: false, invalid: false };
  const s = String(input).toUpperCase().trim();
  if (RANGES.includes(s)) return { range: s, clamped: false, invalid: false };
  if (s === 'MAX' || s === 'ALL') return { range: MAX_RANGE, clamped: true, invalid: false };

  const m = s.match(/^(\d{1,4})\s*([DWMY])$/);
  if (!m) return { range: null, clamped: false, invalid: true };
  const per = { D: 1, W: 7, M: 30.44, Y: 365.25 }[m[2]];
  const days = Number(m[1]) * per;
  if (!Number.isFinite(days) || days <= 0) return { range: null, clamped: false, invalid: true };
  if (days > MAX_HISTORY_DAYS) return { range: MAX_RANGE, clamped: true, invalid: false };

  // Below the cap but not one of our buttons (e.g. 2Y, 9M): snap to the nearest supported range
  // rather than rejecting a period we can legitimately serve.
  let best = RANGES[0], bestGap = Infinity;
  for (const r of RANGES) {
    const gap = Math.abs(RANGE_DAYS[r] - days);
    if (gap < bestGap) { bestGap = gap; best = r; }
  }
  return { range: best, clamped: true, invalid: false };
}

// Retained for callers that just want a usable range and never surface an error.
export const clampRange = (r) => resolveRange(r).range || DEFAULT_RANGE;

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

/** Start date for a range, never earlier than the 3-year cap. */
export function startDateFor(range, now = new Date()) {
  const days = Math.min(RANGE_DAYS[clampRange(range)] ?? RANGE_DAYS[DEFAULT_RANGE], MAX_HISTORY_DAYS);
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

// Last day Polygon will serve on our plan. A range covering ONLY today returns
// 403 NOT_AUTHORIZED because the current session is a real-time entitlement, and that
// would fire every day for every already-cached ticker once the cache is warm through
// yesterday. Today's daily bar is incomplete until the close anyway, so stopping at the
// previous day costs nothing.
export function lastFetchableDay(now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDate(d);
}

/** Oldest congressional trade date this feature will ever surface. */
export const historyFloor = (now = new Date()) => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - MAX_HISTORY_DAYS);
  return isoDate(d);
};

// ─── Polygon daily bars ─────────────────────────────────────────────────────
// adjusted=true so splits do not create artificial gaps, matching how the Tiingo path stores
// adjusted OHLC under the same column names. Mixing adjusted and raw in one table would make a
// trade marker sit at the wrong height on the price line.
export async function fetchPolygonDaily(ticker, from, to, apiKey = process.env.POLYGON_API_KEY) {
  if (!apiKey) return { ok: false, reason: 'POLYGON_API_KEY not set', bars: [] };
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`
    + `?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  let res;
  try { res = await fetch(url, { cache: 'no-store' }); }
  catch (e) { return { ok: false, reason: e.message, bars: [] }; }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, bars: [] };
  const j = await res.json().catch(() => null);
  const bars = (j?.results || [])
    .map((b) => ({
      date: new Date(b.t).toISOString().slice(0, 10),
      open: b.o, high: b.h, low: b.l, close: b.c,
      volume: Number.isFinite(b.v) ? b.v : 0,
    }))
    .filter((b) => b.date && [b.open, b.high, b.low, b.close].every(Number.isFinite));
  return { ok: true, bars };
}

/**
 * Decide the single span to fetch, given what is already cached. Mirrors the logic in
 * /api/chart-daily so both paths treat the cache the same way.
 *   cold            -> whole requested range
 *   head missing    -> whole range (covers head and tail in one call)
 *   tail missing    -> only newer days
 *   fully covered   -> nothing
 */
export function spanToFetch({ minStored, maxStored, startDate, endDate, headToleranceDays = 5 }) {
  if (!minStored) return startDate;
  const gapDays = (new Date(minStored) - new Date(startDate)) / 86400000;
  if (startDate < minStored && gapDays > headToleranceDays) return startDate;
  if (!maxStored || maxStored < endDate) {
    const d = new Date(maxStored);
    d.setUTCDate(d.getUTCDate() + 1);
    return isoDate(d);
  }
  return null;
}
