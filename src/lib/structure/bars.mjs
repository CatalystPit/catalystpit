// TIMEFRAME BARS — deriving weekly and monthly structure from canonical daily candles. PURE.
//
// One vendor, one adjusted daily history, three timeframes. Weekly and monthly bars are FOLDED from
// ticker_daily_candles rather than sourced separately: a second vendor series would drift from the
// daily one, and the moment weekly disagrees with daily about the same week, every level built on
// either becomes unarguable.
//
// ── THE COMPLETE / PARTIAL DISTINCTION IS THE POINT-IN-TIME RULE ────────────
//
// A weekly bar mid-week is not a weekly bar. Its high and low are whatever has happened so far, and
// treating it as settled structure means a Wednesday swing low can "confirm" and then vanish on
// Thursday. So every folded bar carries `complete`, decided by the CALENDAR — the period is over
// when the next period has begun — and research consumes completed bars only.
//
// The current period is still returned, flagged, because a live product needs to show where price
// is inside the forming bar. What it must never do is let a forming bar confirm a pivot.
//
// ── EXTENSIBILITY ───────────────────────────────────────────────────────────
//
// Timeframes are a registry, not a set of branches. Adding 4H/1H/15M later is an entry here plus an
// intraday bar source; nothing downstream — swings, levels, zones, trend — knows how a bar was made.
// Those entries are deliberately absent until the live-data architecture exists.

/**
 * The timeframe registry.
 *
 * `pivotWidth` is how many bars on each side a swing needs to confirm, and it is NOT the same
 * number for every timeframe: 200 monthly bars is seventeen years of history, so a 3-bar shoulder
 * that is reasonable on daily would discard most monthly structure. Chosen from how much history
 * each timeframe actually has, and documented per entry.
 */
export const TIMEFRAMES = Object.freeze({
  daily: Object.freeze({
    id: 'daily', label: 'DAILY', order: 1,
    pivotWidth: 3,           // ~1.5 trading weeks of shoulder
    minBars: 60,             // a quarter of sessions before trend is assertable
    trendWindow: 250,        // ~1 year: trend is read from RECENT swings, not from 2014's
    levelLookback: 260,      // ~1 year of daily pivots are levels anyone still watches
    derivedFrom: null,       // canonical
  }),
  weekly: Object.freeze({
    id: 'weekly', label: 'WEEKLY', order: 2,
    pivotWidth: 2,           // a 5-week window; a 7-week one erases most swing structure
    minBars: 40,             // ~10 months
    trendWindow: 104,        // ~2 years
    levelLookback: 156,      // ~3 years
    derivedFrom: 'daily',
  }),
  monthly: Object.freeze({
    id: 'monthly', label: 'MONTHLY', order: 3,
    pivotWidth: 2,           // a 5-month window
    minBars: 36,             // three years
    trendWindow: 60,         // ~5 years
    levelLookback: 120,      // ~10 years
    derivedFrom: 'daily',
  }),
});

export const TIMEFRAME_IDS = Object.freeze(['daily', 'weekly', 'monthly']);

const asUTC = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

// ── period identity ──────────────────────────────────────────────────────────

/**
 * The Monday of the week a date falls in.
 *
 * ISO weeks, Monday-start, because the US cash session runs Monday to Friday: a Sunday-start week
 * would split nothing but would label the week by a day the market is shut.
 */
export function weekStart(iso) {
  const t = asUTC(iso);
  if (!Number.isFinite(t)) return null;
  const dow = new Date(t).getUTCDay();          // 0 Sun … 6 Sat
  const backToMonday = (dow + 6) % 7;           // Mon->0, Sun->6
  return isoOf(t - backToMonday * DAY);
}

/** The first day of the month a date falls in. */
export function monthStart(iso) {
  const s = String(iso).slice(0, 10);
  return `${s.slice(0, 7)}-01`;
}

/** The first day of the period AFTER the one this date falls in — the completeness boundary. */
export function nextPeriodStart(iso, timeframe) {
  if (timeframe === 'daily') return isoOf(asUTC(iso) + DAY);
  if (timeframe === 'weekly') return isoOf(asUTC(weekStart(iso)) + 7 * DAY);
  if (timeframe === 'monthly') {
    const y = Number(String(iso).slice(0, 4));
    const m = Number(String(iso).slice(5, 7));
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return null;
}

/** The key that groups daily bars into one period. */
export function periodKey(iso, timeframe) {
  if (timeframe === 'daily') return String(iso).slice(0, 10);
  if (timeframe === 'weekly') return weekStart(iso);
  if (timeframe === 'monthly') return monthStart(iso);
  return null;
}

// ── aggregation ──────────────────────────────────────────────────────────────

/**
 * Fold canonical daily bars into a timeframe.
 *
 * SEMANTICS, stated exactly because every level downstream depends on them:
 *   open    the FIRST session's open in the period
 *   high    the maximum session high
 *   low     the minimum session low
 *   close   the LAST session's close in the period
 *   volume  the sum of session volumes
 *   date    the period's first calendar day (its key), so bars sort naturally
 *   lastSession  the last session actually inside the bar — what the close belongs to
 *   sessions     how many daily bars folded in, so a holiday-shortened week is visible
 *   complete     the calendar period has ended relative to asOf
 *
 * A period with no sessions produces NO bar. Market holidays and suspensions leave real gaps, and
 * inventing a flat bar to fill one would create a swing pivot out of nothing.
 */
export function aggregateBars(dailyBars, timeframe, { asOf = null } = {}) {
  const tf = TIMEFRAMES[timeframe];
  if (!tf) return [];
  const src = (Array.isArray(dailyBars) ? dailyBars : [])
    .filter((b) => b && b.date && Number.isFinite(Number(b.close)))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!src.length) return [];
  if (timeframe === 'daily') return src.map((b) => normaliseDaily(b, asOf));

  const out = [];
  let cur = null;
  for (const b of src) {
    const key = periodKey(b.date, timeframe);
    if (!cur || cur.date !== key) {
      if (cur) out.push(cur);
      cur = {
        date: key, timeframe,
        open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
        volume: Number(b.volume) || 0,
        firstSession: String(b.date), lastSession: String(b.date), sessions: 1,
      };
      continue;
    }
    cur.high = Math.max(cur.high, Number(b.high));
    cur.low = Math.min(cur.low, Number(b.low));
    cur.close = Number(b.close);                 // the LAST session's close, by construction
    cur.volume += Number(b.volume) || 0;
    cur.lastSession = String(b.date);
    cur.sessions += 1;
  }
  if (cur) out.push(cur);

  // Completeness is a CALENDAR fact, not a data-availability one. Deciding it from "do we have bars
  // after this" would mark the last complete week partial for the whole weekend.
  const boundary = asOf ? String(asOf).slice(0, 10) : isoOf(Date.now());
  for (const bar of out) {
    bar.complete = nextPeriodStart(bar.date, timeframe) <= boundary;
  }
  return out;
}

function normaliseDaily(b, asOf) {
  const date = String(b.date).slice(0, 10);
  const boundary = asOf ? String(asOf).slice(0, 10) : isoOf(Date.now());
  return {
    date, timeframe: 'daily',
    open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
    volume: Number(b.volume) || 0,
    firstSession: date, lastSession: date, sessions: 1,
    // A daily bar is complete once its own day has passed. The session in progress is not settled.
    complete: date < boundary,
  };
}

/** Completed bars only — what research and swing confirmation are allowed to see. */
export const completedOnly = (bars) => (Array.isArray(bars) ? bars.filter((b) => b.complete) : []);

/**
 * Every timeframe from one daily history.
 *
 * Returned as a map so a caller never has to know that weekly was folded rather than fetched.
 */
export function buildTimeframes(dailyBars, { asOf = null, timeframes = TIMEFRAME_IDS } = {}) {
  const out = {};
  for (const id of timeframes) out[id] = aggregateBars(dailyBars, id, { asOf });
  return out;
}

// ── volatility, the unit every zone width is quoted in ───────────────────────

/**
 * Average True Range over `period` bars of whatever timeframe it is handed.
 *
 * True range rather than high-low, so an overnight gap counts as the move it was. This is the unit
 * zone widths scale with — a $6 stock and a $600 stock cannot share a dollar width, and percentage
 * alone ignores that two $500 stocks can have very different daily ranges.
 */
export function atr(bars, period = 14) {
  const b = Array.isArray(bars) ? bars.filter((x) => Number.isFinite(x.high) && Number.isFinite(x.low)) : [];
  if (b.length < 2) return null;
  const trs = [];
  for (let i = 1; i < b.length; i++) {
    const prevClose = b[i - 1].close;
    trs.push(Math.max(
      b[i].high - b[i].low,
      Math.abs(b[i].high - prevClose),
      Math.abs(b[i].low - prevClose),
    ));
  }
  const use = trs.slice(-period);
  if (!use.length) return null;
  const v = use.reduce((s, x) => s + x, 0) / use.length;
  return Number.isFinite(v) && v > 0 ? v : null;
}
