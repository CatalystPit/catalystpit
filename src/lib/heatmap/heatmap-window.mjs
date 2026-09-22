// PERFORMANCE WINDOWS — what "1W" means on a heatmap.
//
// THESE ARE NOT CANDLE INTERVALS. Elsewhere in Catalyst Pit, 1W means a weekly bar; here it means
// "how much has this moved over the past week". Same label, different question, and conflating them
// is how a heatmap ends up showing a week's worth of candles instead of a week's worth of return.
//
// EVERY WINDOW IS A RETURN BETWEEN TWO REGULAR-SESSION CLOSES:
//
//     return % = (latest eligible close / baseline close − 1) × 100
//
// The only thing a timeframe changes is WHICH baseline session. The numerator is always the latest
// eligible price — today that is the last completed session, and when the licensed provider lands it
// becomes the live price without any of this arithmetic changing.
//
// WHY CALENDAR ANCHORING RATHER THAN A TRADING-DAY COUNT. The screener already carries perf1m and
// perf1y computed as "21 closes back" and "252 closes back". That is a fine technical measure and
// the wrong answer for a heatmap: 252 trading days is not a year, it drifts against the calendar,
// and two securities with different histories can be measured over different spans. A reader
// comparing tiles is asking "since roughly this date last year", so the anchor is a CALENDAR date
// and the baseline is the nearest real session at or before it.
//
// NOTHING IS EVER MANUFACTURED. No interpolation between sessions, no carrying a price forward over
// a gap, no synthesising a listing price for a company that did not exist yet. A window with no
// honest baseline returns null and the tile says so.
//
// Pure: no database, no network, no clock of its own. Every function takes the day it reasons from.

import { daysFromCivil, civilFromDays } from '../chart/chart-aggregate.mjs';
import { returnBlocked } from '../price-continuity.mjs';

/** The windows the heatmap offers, in the order they are shown. */
export const TIMEFRAMES = Object.freeze(['1D', '1W', '1M', '1Y']);
export const DEFAULT_TIMEFRAME = '1D';
export const isTimeframe = (t) => TIMEFRAMES.includes(t);

export const TIMEFRAME_LABEL = Object.freeze({
  '1D': 'previous session',
  '1W': 'one week',
  '1M': 'one month',
  '1Y': 'one year',
});

/**
 * HOW FAR FROM ITS ANCHOR A BASELINE MAY SIT.
 *
 * "Nearest session at or before the anchor" is the right rule for a weekend, a holiday or a single
 * missing print. It is the WRONG rule for a security that stopped trading for months: its nearest
 * session before "one year ago" might be sixteen months ago, and calling that a 1Y return is a
 * mislabelled number rather than a missing one.
 *
 * 45 days is comfortably longer than any US market closure — the longest in modern history was about
 * two weeks — so a gap this wide means the SECURITY stopped trading, not the market. Measured on the
 * live universe, it withholds exactly 2 of 4,802 one-year returns, and both had baselines four
 * months or more from the anchor.
 *
 * It is also what makes the board fast: bounding the scan takes the baseline query from 1,650ms to
 * 317ms across the whole eligible universe. The correctness argument came first; the speed is a
 * consequence of asking a better-defined question.
 */
export const MAX_BASELINE_GAP_DAYS = 45;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar date string, or null. Rejects Date objects deliberately: a Date carries a timezone. */
export function asDay(v) {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, 10);
  return DAY_RE.test(s) ? s : null;
}

const partsOfDay = (day) => ({ y: +day.slice(0, 4), m: +day.slice(5, 7), d: +day.slice(8, 10) });
const fmt = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Days in a month, Gregorian, leap years included. */
export function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** `day` shifted by a whole number of calendar days. */
export function shiftDays(day, n) {
  const { y, m, d } = partsOfDay(day);
  const c = civilFromDays(daysFromCivil(y, m, d) + n);
  return fmt(c.y, c.m, c.d);
}

/**
 * `day` shifted back by whole calendar months, CLAMPED to the target month's length.
 *
 * 31 March minus one month is 28 February (29 in a leap year), not 3 March. Clamping rather than
 * overflowing is what makes "a month ago" mean the same thing for every security on the board —
 * month-end names would otherwise be measured over a different span than the rest.
 */
export function shiftMonths(day, n) {
  const { y, m, d } = partsOfDay(day);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/**
 * The CALENDAR DATE a timeframe anchors on, given the latest session on the board.
 *
 * 1D is the exception and returns null: "the previous session" is not a calendar offset, it is
 * whatever session came last, which depends on weekends and holidays rather than on arithmetic.
 * baselineFor handles it directly.
 */
export function anchorDateFor(timeframe, asOf) {
  const day = asDay(asOf);
  if (!day) return null;
  switch (timeframe) {
    case '1D': return null;                  // "the session before" — not a date offset
    case '1W': return shiftDays(day, -7);    // one calendar week
    case '1M': return shiftMonths(day, 1);   // one calendar month, clamped
    case '1Y': return shiftMonths(day, 12);  // one calendar year; 29 Feb → 28 Feb
    default: return null;
  }
}

/**
 * The latest session at or before a target date.
 *
 * `sessions` is ascending [{ date, close }] — the security's own history, so a name that did not
 * trade on a day the rest of the market did is handled by the same rule as a market holiday: take
 * the last real session, never invent one.
 *
 * Binary search, because this runs once per ticker per request over a year of daily bars.
 */
export function sessionAtOrBefore(sessions, target) {
  const day = asDay(target);
  if (!day || !Array.isArray(sessions) || !sessions.length) return null;
  let lo = 0, hi = sessions.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = asDay(sessions[mid]?.date);
    if (d && d <= day) { found = sessions[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * The baseline session a timeframe measures from, or null when there is no honest one.
 *
 * `latest` is the security's most recent session. For 1D the baseline is the session immediately
 * before it — which across a weekend is Friday, and across a holiday weekend is the Friday before
 * that, with no special-casing because the data itself carries the trading calendar.
 */
export function baselineFor(sessions, timeframe, asOf) {
  if (!Array.isArray(sessions) || sessions.length < 2) return null;
  const latest = sessions[sessions.length - 1];
  if (timeframe === '1D') {
    // Strictly before the latest session. Not "asOf minus one day": that would be a Sunday.
    const prev = sessions[sessions.length - 2];
    return asDay(prev?.date) && asDay(prev.date) < asDay(latest.date) ? prev : null;
  }
  const anchor = anchorDateFor(timeframe, asOf ?? latest.date);
  if (!anchor) return null;
  const base = sessionAtOrBefore(sessions, anchor);
  // A baseline that IS the latest session is not a baseline — it means the security has no history
  // reaching back that far (a recent listing), and a 0% return would be a fabrication.
  if (!base || asDay(base.date) >= asDay(latest.date)) return null;
  // Too far from the anchor to be the window it claims: see MAX_BASELINE_GAP_DAYS.
  if (asDay(base.date) < shiftDays(anchor, -MAX_BASELINE_GAP_DAYS)) return null;
  return base;
}

/**
 * (latest / baseline − 1) × 100, or null when either side cannot support it.
 *
 * ABSENCE IS CHECKED BEFORE CONVERSION. `Number(null)` and `Number('')` are both 0, and 0 is finite,
 * so the obvious `Number.isFinite(Number(v))` turns a MISSING close into a real price of zero — and
 * a missing latest close then reads as −100%, a catastrophic loss printed on a tile for a security
 * we simply have no price for. This codebase has already shipped that exact coercion once, on the
 * dividend calendar's filters; it is not shipping it again.
 */
const closeOf = (v) => {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function pctReturn(latestClose, baselineClose) {
  const a = closeOf(latestClose), b = closeOf(baselineClose);
  if (a === null || b === null || b <= 0) return null;
  return (a / b - 1) * 100;
}

/**
 * Why a window has no return. Reported rather than swallowed, so a tile can say "no 1Y history"
 * instead of showing a misleading zero or vanishing from the board.
 */
export const NO_RETURN = Object.freeze({
  NO_HISTORY: 'no_history',       // the security did not trade that far back (a recent listing)
  NO_PRICE: 'no_price',           // a close we hold is missing or non-positive
  SERIES_BREAK: 'series_break',   // ticker_price_quality says a return across this span is unsafe
  // ⚠️ THE BOARD IS MEASURING TODAY AND THIS ROW CANNOT. On a live 1D board every other row runs
  // from the previous official close to the current price; a symbol the snapshot returned no
  // usable price for can only be measured close-to-close, which is YESTERDAY'S move. Showing that
  // number beside today's — and worse, ranking it in Top Gainers — compares two different periods.
  NO_LIVE_PRICE: 'no_live_price',
});

/**
 * THE 1D RETURN FOR ONE ROW OF A BOARD THAT MAY OR MAY NOT BE MEASURING TODAY.
 *
 * Pure, and separated from the store so the rule can be exercised with numbers rather than
 * inspected as source. It answers one question: given what this row has, WHICH PERIOD can it
 * honestly express, and is that the same period the rest of the board is expressing?
 *
 *   isLiveBoard && a live price   →  previous official close → current price   (today)
 *   isLiveBoard && no live price  →  NOTHING. Degraded, because the only return available to it
 *                                    is close-to-close, which is the PREVIOUS session's move.
 *   !isLiveBoard                  →  close-to-close, consistently, for every row
 *
 * ⚠️ THE MIDDLE CASE IS THE DEFECT THIS EXISTS TO PREVENT. Ranking a row's yesterday-move against
 * 499 rows' today-moves puts a stale number at the top of Top Gainers, and nothing about it looks
 * wrong on the tile.
 *
 * @returns { pct, baselineDate, reason, live } — `pct` is null whenever `reason` is set.
 */
export function intradayRowReturn({
  livePrice = null, latestClose = null, latestDate = null,
  baselineClose = null, baselineDate = null, isLiveBoard = false,
} = {}) {
  const out = { pct: null, baselineDate: null, reason: null, live: false };
  const live = Number(livePrice);
  const hasLive = livePrice != null && Number.isFinite(live) && live > 0;

  if (isLiveBoard && !hasLive) { out.reason = NO_RETURN.NO_LIVE_PRICE; return out; }

  // ⚠️ BOTH HALVES MOVE TOGETHER OR NEITHER DOES. A live numerator against the completed-session
  // baseline measures two days and calls it one — the bug that once put NVDA at +2.72% against a
  // true +0.41%. The previous OFFICIAL CLOSE is `latestClose`; the window baseline is not.
  const numerator = hasLive ? live : latestClose;
  const denominator = hasLive ? latestClose : baselineClose;
  out.baselineDate = hasLive ? (latestDate ?? null) : (baselineDate ?? null);
  out.live = hasLive;

  const pct = pctReturn(numerator, denominator);
  if (pct === null) { out.reason = NO_RETURN.NO_PRICE; out.baselineDate = null; out.live = false; return out; }
  out.pct = pct;
  return out;
}

/**
 * The return for one security over one window.
 *
 * `quality` is its ticker_price_quality row (or null when unscanned). The continuity check is the
 * EXISTING one — returnBlocked() — because "may a return anchored on this date be shown" is a
 * question this codebase already answers, and a reused symbol or an unadjusted reverse split is
 * exactly the thing that makes a 1Y number a lie.
 *
 * Returns { pct, baselineDate, latestDate, reason }. `pct` is null whenever `reason` is set.
 */
export function securityReturn({ sessions, timeframe, asOf = null, quality = null } = {}) {
  const out = { pct: null, baselineDate: null, latestDate: null, reason: null };
  if (!Array.isArray(sessions) || !sessions.length) { out.reason = NO_RETURN.NO_HISTORY; return out; }

  const latest = sessions[sessions.length - 1];
  out.latestDate = asDay(latest?.date);

  const base = baselineFor(sessions, timeframe, asOf);
  if (!base) { out.reason = NO_RETURN.NO_HISTORY; return out; }
  out.baselineDate = asDay(base.date);

  // The continuity gate runs BEFORE the arithmetic: a number we would not show should not be
  // computed and then discarded somewhere downstream.
  if (returnBlocked(quality, out.baselineDate)) { out.reason = NO_RETURN.SERIES_BREAK; return out; }

  const pct = pctReturn(latest.close, base.close);
  if (pct === null) { out.reason = NO_RETURN.NO_PRICE; return out; }
  out.pct = pct;
  return out;
}
