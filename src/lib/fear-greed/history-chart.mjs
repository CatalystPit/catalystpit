// THE HISTORY CHART'S ARITHMETIC — pure, so a chart of 504 real observations cannot quietly
// become a chart of something else.
//
// ── ⚠️ THIS FILE MAY NOT INVENT A SINGLE OBSERVATION ────────────────────────
//
// Everything here FILTERS and FORMATS a series that was materialised elsewhere. Nothing resamples,
// interpolates, forward-fills, or extends the line past the data. A chart is trusted far more than
// a table — a reader takes a smooth line as evidence the market was smooth — so a gap in coverage
// has to stay a gap. `filterHistory` only ever removes points, and `availableTimeframes` refuses to
// offer a window the stored history cannot fill.
//
// ── ⚠️ THE Y AXIS IS FIXED AT 0-100, NOT FITTED TO THE DATA ─────────────────
//
// This is the one decision that makes the chart readable at a glance. Auto-scaling to the observed
// range would redraw the same two years as a dramatic mountain whenever the index happened to sit
// in a narrow band, and — worse — it would move the fear and greed zones up and down the frame
// between one page load and the next. The scale is the index's scale, always.

import { ZONE_BANDS, zoneFor, finite } from './model.mjs';

/** The zone bands, on the same 0-100 axis the Y scale uses. Derived from ZONES, never retyped. */
export const BANDS = ZONE_BANDS;

/** The Y axis, fixed. See the note above: these are NOT computed from the data. */
export const Y_TICKS = Object.freeze([0, 25, 50, 75, 100]);
export const Y_MIN = 0;
export const Y_MAX = 100;

/** The windows a reader can choose between, shortest first. */
export const TIMEFRAMES = Object.freeze([
  Object.freeze({ key: '3M', months: 3 }),
  Object.freeze({ key: '6M', months: 6 }),
  Object.freeze({ key: '1Y', months: 12 }),
  Object.freeze({ key: '2Y', months: 24 }),
]);

const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/**
 * ⚠️ DATES ARE PARSED BY HAND, NOT BY `new Date('2026-09-24')`.
 *
 * That constructor reads a bare ISO date as UTC midnight, and every `getMonth()`/`getDate()` call
 * on the result then answers in the VIEWER'S timezone. West of Greenwich — which is most of this
 * audience — UTC midnight is the previous evening, so every tick on the axis and every date in the
 * tooltip would render one day early. The stored dates are calendar days with no time in them, so
 * they are treated as calendar days here.
 */
export function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

const pad = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** An ISO date `months` before `iso`, clamping the day so 31 March minus one month is 28 February. */
export function shiftMonths(iso, months) {
  const p = parseISO(iso);
  if (!p) return null;
  const total = (p.y * 12 + (p.m - 1)) - months;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12 + 1;
  return `${y}-${pad(m)}-${pad(Math.min(p.d, daysInMonth(y, m)))}`;
}

/**
 * The stored observations, oldest first, with anything unusable dropped.
 *
 * ⚠️ A MISSING SCORE IS NOT A ZERO. `Number(null)` is 0 and `Number.isFinite(0)` is true, so
 * the obvious filter silently promotes a null observation to the bottom of the scale and plots a
 * day the index never published as the deepest EXTREME FEAR in the series. This is the same
 * coercion that once had `zoneFor(null)` answering EXTREME FEAR, so the index's own `finite` guard
 * is reused here rather than re-derived and the chart cannot drift from it.
 */
export function cleanHistory(history) {
  return (history || [])
    .map((p) => (p && parseISO(p.date) ? { date: p.date, score: finite(p.score) } : null))
    .filter((p) => p !== null && p.score !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The first date a window would need, measured back from the newest observation. */
export function cutoffFor(points, months) {
  const last = points.at(-1);
  return last ? shiftMonths(last.date, months) : null;
}

/**
 * Which windows the stored history can actually fill.
 *
 * ⚠️ NO WINDOW IS OFFERED THAT THE DATA CANNOT FILL, except the shortest one that overruns it —
 * that one is kept because it is how a reader asks for "everything". Offering 2Y on six months of
 * history would draw the same six months under four different labels and imply the other eighteen
 * were flat rather than absent.
 */
export function availableTimeframes(points) {
  const pts = cleanHistory(points);
  if (pts.length < 2) return [];
  const first = pts[0].date;
  const out = [];
  for (const tf of TIMEFRAMES) {
    out.push(tf);
    if (cutoffFor(pts, tf.months) < first) break; // this one already reaches past the data
  }
  return out;
}

/** The longest window the data supports — what the chart opens on. */
export function defaultTimeframe(points) {
  const avail = availableTimeframes(points);
  return avail.length ? avail.at(-1).key : null;
}

/** The stored observations inside a window. Only ever a subset — nothing is generated. */
export function filterHistory(points, tfKey) {
  const pts = cleanHistory(points);
  const tf = TIMEFRAMES.find((t) => t.key === tfKey);
  if (!tf || pts.length === 0) return pts;
  const cutoff = cutoffFor(pts, tf.months);
  return cutoff ? pts.filter((p) => p.date >= cutoff) : pts;
}

/**
 * How many date labels the axis can carry at a given pixel width.
 *
 * ⚠️ NARROW SCREENS LOSE DATE TICKS, NEVER THE Y AXIS. The numbers up the side are what turn the
 * line into a reading; the dates only say when. Dropping the wrong one leaves a chart that is
 * pretty and unreadable.
 */
export function tickCountFor(width) {
  const w = Number(width) || 0;
  if (w < 360) return 3;
  if (w < 560) return 4;
  return 6;
}

/** Evenly spaced positions along the series, always including the first and last observation. */
export function xTickIndexes(n, count) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const c = Math.max(2, Math.min(count, n));
  const out = [];
  for (let i = 0; i < c; i++) {
    const idx = Math.round((i * (n - 1)) / (c - 1));
    if (out.at(-1) !== idx) out.push(idx);
  }
  return out;
}

/** A date as an axis tick: day-level inside a few months, month-level across years. */
export function formatTick(iso, tfKey) {
  const p = parseISO(iso);
  if (!p) return '';
  const short = tfKey === '3M' || tfKey === '6M';
  return short ? `${MONTHS[p.m - 1]} ${p.d}` : `${MONTHS[p.m - 1]} '${pad(p.y % 100)}`;
}

/** A date as the tooltip prints it. */
export function formatFull(iso) {
  const p = parseISO(iso);
  return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : '';
}

/** The observation nearest a horizontal position, given as a 0-1 fraction of the plot. */
export function nearestIndex(fraction, n) {
  if (n <= 0) return -1;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Math.round(f * (n - 1));
}

/**
 * The zone a stored score belongs to.
 *
 * ⚠️ CLASSIFIED BY THE INDEX'S OWN FUNCTION. The tooltip says "39 · FEAR"; if the chart decided
 * that for itself, the word beside a number here could disagree with the word beside the same
 * number in the gauge, and only one of them would be the product's answer.
 */
export function zoneLabel(score) {
  return zoneFor(score)?.label ?? null;
}
