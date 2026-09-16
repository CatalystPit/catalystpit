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
//   intraday   /api/chart-intraday  Polygon aggregates at any MINUTE multiple, driven by the
//                                   registry below — the route reads the requested timeframe's own
//                                   bar multiplier and window rather than hard-coding two of them.
//
// Polygon's plan is 15-minute delayed, which the endpoint reports as meta.delayed, and the chart
// labels. There is no streaming source in this codebase — see REALTIME below.

/** One row, whatever the vendor. `time` follows Lightweight Charts' own convention. */
/** @typedef {{ time: number|string, open: number, high: number, low: number, close: number, volume: number|null }} Bar */

/**
 * THE TIMEFRAME REGISTRY.
 *
 * TWO INDEPENDENT THINGS, DECLARED SEPARATELY. A timeframe is a display WINDOW ("how much history is
 * on screen") and a bar RESOLUTION ("how wide is one candle"). Conflating them is what leads to
 * asking a vendor for a million one-minute bars to draw five years, so every entry states both:
 *
 *   barSeconds    the spacing of one bar — the resolution the provider must deliver
 *   window        how much history to show, as { sessions } intraday or { days | 'ytd' | 'all' }
 *
 * The two groups read from opposite ends of that pair, which is the point:
 *   MINUTES / HOURS pick a RESOLUTION, and carry a sensible default window with them.
 *   DAYS / LONGER pick a WINDOW, and carry the coarsest resolution that renders it honestly.
 * So "15 minutes" and "1 week" both show five sessions and differ only in candle width.
 *
 * WHAT A PROVIDER ADAPTER NEEDS is entirely in `request`: for intraday, the bar multiplier in
 * minutes, how many trading sessions to keep, and how many calendar days to ask for (wider than the
 * sessions kept, so weekends and holidays still yield a full window). A new commercial feed supplies
 * those without this file — or the menu, or the chart — changing. Adding an interval is one entry.
 *
 * NOTHING HERE IS ASPIRATIONAL. An entry exists only when a real adapter can serve it; resolutions
 * we cannot yet produce are listed in PLANNED_TIMEFRAMES instead, so the roadmap lives in the code
 * without putting a row in the menu that would draw invented candles.
 */
export const TIMEFRAME_GROUPS = [
  { id: 'minutes', label: 'Minutes' },
  { id: 'hours',   label: 'Hours' },
  { id: 'days',    label: 'Days / longer timeframes' },
];

// Intraday entries are Polygon aggregates at an arbitrary MINUTE multiplier — 240 minutes is the
// four-hour bar, there is no separate hour endpoint. `sessions` is trading days kept; `lookbackDays`
// is the calendar span requested, always wider so a long weekend cannot shorten the window.
const intra = (id, label, short, group, barMinutes, sessions, lookbackDays) => ({
  id, label, short, group, kind: 'intraday', endpoint: 'intraday',
  barSeconds: barMinutes * 60,
  window: { sessions },
  request: { barMinutes, sessions, lookbackDays },
  extendedCapable: true,
});

// Daily entries are Tiingo daily candles over a named range the daily route already understands.
const day = (id, label, short, window, range) => ({
  id, label, short, group: 'days', kind: 'daily', endpoint: 'daily',
  barSeconds: 86400,
  window,
  request: { range },
  extendedCapable: false,
});

export const TIMEFRAMES = [
  //     id      label          short  group      barMin  sessions  lookback
  intra('1m',  '1 minute',   '1m',  'minutes',    1,     1,   5),
  intra('2m',  '2 minutes',  '2m',  'minutes',    2,     1,   5),
  intra('3m',  '3 minutes',  '3m',  'minutes',    3,     1,   5),
  intra('5m',  '5 minutes',  '5m',  'minutes',    5,     1,   5),
  intra('10m', '10 minutes', '10m', 'minutes',   10,     2,   9),
  intra('15m', '15 minutes', '15m', 'minutes',   15,     5,   9),
  intra('30m', '30 minutes', '30m', 'minutes',   30,    10,  18),
  intra('45m', '45 minutes', '45m', 'minutes',   45,    10,  18),

  intra('1h',  '1 hour',     '1h',  'hours',     60,    20,  35),
  intra('2h',  '2 hours',    '2h',  'hours',    120,    40,  65),
  intra('3h',  '3 hours',    '3h',  'hours',    180,    60,  95),
  intra('4h',  '4 hours',    '4h',  'hours',    240,    60,  95),

  // A day and a week are WINDOWS, so they keep an intraday resolution — a one-day chart of daily
  // bars is a single candle. From a month out, a daily bar is the honest unit.
  intra('1D',  '1 day',      '1D',  'days',       5,     1,   5),
  intra('1W',  '1 week',     '1W',  'days',      30,     5,   9),
  day('1M',  '1 month',  '1M',  { days: 30 },  '1M'),
  day('3M',  '3 months', '3M',  { days: 90 },  '3M'),
  day('6M',  '6 months', '6M',  { days: 180 }, '6M'),
  day('YTD', 'YTD',      'YTD', 'ytd',         'YTD'),
  day('1Y',  '1 year',   '1Y',  { days: 365 }, '1Y'),
  day('All', 'All',      'All', 'all',         'all'),
];

export const DEFAULT_TIMEFRAME = '3M';
const BY_ID = new Map(TIMEFRAMES.map((t) => [t.id, t]));

export const timeframe = (id) => BY_ID.get(id) || null;
export const isIntraday = (id) => timeframe(id)?.kind === 'intraday';
/** Extended hours are only meaningful on an intraday timeframe; a daily bar spans the whole day. */
export const supportsExtendedHours = (id) => timeframe(id)?.extendedCapable === true;

/** The menu's shape: groups in order, each with its entries, skipping any group left empty. */
export const timeframesByGroup = () => TIMEFRAME_GROUPS
  .map((g) => ({ ...g, items: TIMEFRAMES.filter((t) => t.group === g.id) }))
  .filter((g) => g.items.length > 0);

/**
 * WHAT TODAY'S ADAPTER CAN ACTUALLY SERVE.
 *
 * Declared rather than assumed, and checked against every entry, so the day a registry entry asks
 * for something the current feed cannot produce it is reported as unavailable instead of quietly
 * rendering whatever the endpoint happened to return.
 *
 *   intraday  Polygon aggregates: any minute multiple up to a day, bounded history.
 *   daily     Tiingo daily candles, at the named ranges the daily route implements.
 */
export const ADAPTER = {
  intraday: { minBarMinutes: 1, maxBarMinutes: 1440, maxSessions: 60 },
  daily: { ranges: new Set(['1M', '3M', '6M', 'YTD', '1Y', '5Y', 'all']) },
};

/** Why a timeframe cannot be served right now, or null when it can. */
export function unavailableReason(id) {
  const tf = timeframe(id);
  if (!tf) return 'Unknown timeframe';
  if (tf.kind === 'intraday') {
    const { barMinutes, sessions } = tf.request;
    if (barMinutes < ADAPTER.intraday.minBarMinutes || barMinutes > ADAPTER.intraday.maxBarMinutes) {
      return 'Bar size not available from the current data provider';
    }
    if (sessions > ADAPTER.intraday.maxSessions) return 'Intraday history is limited on the current data provider';
    return null;
  }
  if (!ADAPTER.daily.ranges.has(tf.request.range)) return 'Range not available from the current data provider';
  return null;
}
export const isServable = (id) => unavailableReason(id) === null;

/**
 * Declared, not built. Weekly and monthly BARS (as distinct from week- and month-long windows, which
 * are in the registry above) need a resolution neither endpoint produces: they would have to be
 * folded up from daily candles. That is honest arithmetic, not invention, but it is a real piece of
 * work and it is written down here rather than being discovered when somebody picks it from a menu.
 */
export const PLANNED_TIMEFRAMES = [
  { id: '1Wbar', label: 'Weekly bars', barSeconds: 604800, needs: 'daily candles folded into ISO weeks' },
  { id: '1Mbar', label: 'Monthly bars', barSeconds: 2592000, needs: 'daily candles folded into calendar months' },
];

// The daily route spells "all" in lowercase; the registry carries the exact spelling each range
// wants, so no id has to be translated on its way out.
const routeRange = (id) => timeframe(id)?.request?.range ?? id;

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
  // A timeframe the current adapter cannot serve never becomes a request. Returning null here is
  // what stops an unavailable interval from being answered with whatever the endpoint falls back to
  // — the chart shows nothing rather than the wrong resolution wearing the right label.
  if (!isServable(timeframeId)) return null;
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

// The exchange calendar day, in market time. Every viewer sees the same boundary regardless of where
// they are, which is the only way a session-anchored figure can agree between two people.
const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * The session-boundary function for VWAP and anything else that resets each day.
 *
 * Returns null for a daily timeframe: a daily bar already spans a whole session, so there is no
 * boundary to find and a session-anchored indicator is not meaningful.
 *
 * The boundary is the ET CALENDAR DAY, not the 09:30 open. When the chart is showing extended hours,
 * the 04:00 pre-market bars belong to that day's session and are included — which is what a platform
 * anchored at 04:00 shows. When the chart is showing the regular session, those bars are not in the
 * data at all, so the same rule anchors at 09:30 without needing a second code path.
 */
export function sessionKeyFor(timeframeId) {
  if (!isIntraday(timeframeId)) return null;
  return (bar) => (typeof bar.time === 'number' ? ET_DAY.format(new Date(bar.time * 1000)) : String(bar.time));
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
