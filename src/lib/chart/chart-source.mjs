// THE CHART / MARKET-DATA BOUNDARY.
//
// Everything the chart knows about where bars come from lives in this file. The component asks for
// a symbol and a timeframe and receives one normalised shape; it never learns which vendor answered,
// which endpoint was called, or how a session is defined. Swapping Tiingo or Polygon for another
// provider — or putting a single unified bars endpoint in front of both — is an edit here and
// nowhere else.
//
// Pure. No React, no network calls of its own: it builds the request and normalises the response, so
// the whole contract is unit-testable without a browser or a key.
//
// WHAT ACTUALLY BACKS THIS TODAY (measured, not assumed):
//   daily      /api/chart-daily     Tiingo, cached in ticker_daily_candles. 1M 3M 6M YTD 1Y 5Y all.
//   intraday   /api/chart-intraday  Polygon minute aggregates. 1D and 5D only.
//
// Polygon's plan is 15-minute delayed, which the endpoint reports as meta.delayed, and the chart
// labels. There is no streaming source in this codebase — see REALTIME below.

/** One row, whatever the vendor. `time` follows Lightweight Charts' own convention. */
/** @typedef {{ time: number|string, open: number, high: number, low: number, close: number, volume: number|null }} Bar */

/**
 * The timeframes the product offers, and what genuinely serves each one.
 *
 * `barSeconds` is the real spacing of the returned bars, not an aspiration: it is what the endpoint
 * currently produces. A timeframe is listed here only when data for it exists today.
 */
export const TIMEFRAMES = [
  { id: '1D',  label: '1D',  kind: 'intraday', endpoint: 'intraday', barSeconds: 300,    extendedCapable: true },
  { id: '5D',  label: '5D',  kind: 'intraday', endpoint: 'intraday', barSeconds: 900,    extendedCapable: true },
  { id: '1M',  label: '1M',  kind: 'daily',    endpoint: 'daily',    barSeconds: 86400,  extendedCapable: false },
  { id: '3M',  label: '3M',  kind: 'daily',    endpoint: 'daily',    barSeconds: 86400,  extendedCapable: false },
  { id: '6M',  label: '6M',  kind: 'daily',    endpoint: 'daily',    barSeconds: 86400,  extendedCapable: false },
  { id: 'YTD', label: 'YTD', kind: 'daily',    endpoint: 'daily',    barSeconds: 86400,  extendedCapable: false },
  { id: '1Y',  label: '1Y',  kind: 'daily',    endpoint: 'daily',    barSeconds: 86400,  extendedCapable: false },
  { id: '5Y',  label: '5Y',  kind: 'daily',    endpoint: 'daily',    barSeconds: 86400,  extendedCapable: false },
  { id: 'All', label: 'All', kind: 'daily',    endpoint: 'daily',    barSeconds: 86400,  extendedCapable: false },
];

export const DEFAULT_TIMEFRAME = '3M';
const BY_ID = new Map(TIMEFRAMES.map((t) => [t.id, t]));

export const timeframe = (id) => BY_ID.get(id) || null;
export const isIntraday = (id) => timeframe(id)?.kind === 'intraday';
/** Extended hours are only meaningful on an intraday timeframe; a daily bar spans the whole day. */
export const supportsExtendedHours = (id) => timeframe(id)?.extendedCapable === true;

// The daily route spells "All" in lowercase; every other id matches one for one.
const routeRange = (id) => (id === 'All' ? 'all' : id);

/** Same gate the API routes apply, so an unusable symbol never becomes a request. */
export const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
export const isValidSymbol = (s) => SYMBOL_RE.test(String(s || '').toUpperCase().trim());

/**
 * Build the request URL for one symbol and timeframe.
 *
 * `session: 'extended'` is passed through to the intraday route, which decides whether it can honour
 * it. Asking for extended hours on a daily timeframe is not an error; it is simply meaningless, so
 * the parameter is omitted rather than sent and ignored.
 */
export function barsUrl(symbol, timeframeId, { session = 'regular' } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  const tf = timeframe(timeframeId);
  if (!tf || !isValidSymbol(sym)) return null;
  const q = new URLSearchParams({ ticker: sym });
  if (tf.endpoint === 'intraday') {
    q.set('range', tf.id);
    if (session === 'extended' && tf.extendedCapable) q.set('session', 'extended');
    return `/api/chart-intraday?${q}`;
  }
  q.set('range', routeRange(tf.id));
  return `/api/chart-daily?${q}`;
}

// Number(null) is 0 and Number('') is 0, both finite — so a bare Number() check turns a MISSING
// price into a real one at zero, and a missing volume into "no volume traded". Absence is checked
// before conversion for exactly that reason.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalise either endpoint's payload into one array of bars plus a meta block.
 *
 * The two routes disagree on almost everything — one returns `bars` keyed on UNIX seconds, the other
 * `candles` keyed on a date string — and that disagreement stops here. A row missing any of OHLC is
 * dropped rather than repaired: a chart that invents a price is worse than a chart with a gap.
 */
export function normalizeBars(payload, timeframeId) {
  const tf = timeframe(timeframeId);
  const intraday = tf?.kind === 'intraday';
  const raw = Array.isArray(payload?.bars) ? payload.bars
    : Array.isArray(payload?.candles) ? payload.candles
      : [];
  const bars = [];
  for (const r of raw) {
    const time = intraday ? num(r.time) : (r.date || r.time);
    const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
    if (time == null || open == null || high == null || low == null || close == null) continue;
    bars.push({ time, open, high, low, close, volume: num(r.volume) });
  }
  // Ascending, and deduplicated on time: Lightweight Charts requires both and throws on either.
  bars.sort((a, b) => (typeof a.time === 'number' ? a.time - b.time : String(a.time).localeCompare(String(b.time))));
  const out = [];
  for (const b of bars) {
    if (out.length && out[out.length - 1].time === b.time) { out[out.length - 1] = b; continue; }
    out.push(b);
  }
  return {
    bars: out,
    meta: {
      kind: intraday ? 'intraday' : 'daily',
      timeframe: tf?.id ?? null,
      // Delayed is asserted by the endpoint; it is never guessed here, and a missing value is
      // reported as unknown rather than as live.
      delayed: typeof payload?.meta?.delayed === 'boolean' ? payload.meta.delayed : null,
      source: payload?.meta?.source ?? null,
      session: payload?.meta?.session ?? 'regular',
      barSeconds: tf?.barSeconds ?? null,
      error: payload?.error ? String(payload.error) : null,
    },
  };
}

/**
 * REALTIME.
 *
 * There is no streaming market-data source in this codebase: no WebSocket, no SSE, no push. The
 * intraday endpoint is a cached REST read of 15-minute-delayed Polygon aggregates. So the honest
 * refresh model is polling, and this is the one place that decides how often.
 *
 * Polling a delayed feed faster than the delay buys nothing but load, so the interval is tied to the
 * bar size rather than to how live the chart should feel. Returns null when there is nothing worth
 * re-fetching — a five-year daily chart does not change during a session.
 */
export function refreshIntervalMs(timeframeId) {
  const tf = timeframe(timeframeId);
  if (!tf || tf.kind !== 'intraday') return null;
  return Math.max(60_000, tf.barSeconds * 1000);
}

/**
 * Fold a freshly fetched bar list into the one already drawn, returning only what changed.
 *
 * This is what makes a refresh incremental: Lightweight Charts' `update()` redraws a single bar,
 * where `setData()` rebuilds the series and throws away the user's zoom and pan. Returns the bars to
 * update in order, or null when the shape changed enough that a full reset is the honest answer.
 */
export function diffBars(prev, next) {
  if (!Array.isArray(prev) || !prev.length || !Array.isArray(next) || !next.length) return null;
  const prevLast = prev[prev.length - 1];
  const firstChanged = next.findIndex((b) => b.time > prevLast.time);
  // The tail bar can also move: the current session's candle updates in place until it closes.
  const tailUpdated = next.find((b) => b.time === prevLast.time);
  const appended = firstChanged >= 0 ? next.slice(firstChanged) : [];
  if (!tailUpdated && !appended.length) return null;           // nothing new
  if (next[0].time !== prev[0].time) return null;              // the window moved: reset, do not patch
  const changed = [];
  if (tailUpdated && (tailUpdated.close !== prevLast.close || tailUpdated.high !== prevLast.high
    || tailUpdated.low !== prevLast.low || tailUpdated.volume !== prevLast.volume)) changed.push(tailUpdated);
  changed.push(...appended);
  return changed.length ? changed : null;
}
