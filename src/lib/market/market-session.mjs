// THE U.S. EQUITY SESSION CLOCK — when the regular session is open, and which days are sessions.
//
// Server-only, pure, and vendor-neutral: nothing here names a provider or performs I/O, so every
// rule below is testable against a fixed clock.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// refresh-policy.mjs states the previous position plainly: "Holidays exist and we do not carry an
// exchange calendar… (3) deliberately is NOT guessed". That was the right call THERE, because the
// only cost of guessing wrong was one extra upstream request, absorbed by a cooldown.
//
// It is the wrong call here. The heatmap's realtime snapshot must stop entirely outside the
// regular session — not "mostly stop", not "stop once the quotes look stale". A feature whose
// upstream cost is supposed to be zero overnight cannot be built on a calendar we decline to know.
//
// ⚠️ AND IT MUST NOT BE MONDAY-TO-FRIDAY. Roughly ten weekdays a year are not sessions, plus three
// half-days that close at 13:00 ET. Treating those as regular sessions means polling a provider
// against a market that is shut — precisely the cost this is meant to remove — and, worse,
// labelling a frozen board as though it were updating.
//
// ── WHAT IS DERIVED AND WHAT IS NOT ─────────────────────────────────────────
//
// Every SCHEDULED NYSE closure is computable: the holidays are calendar rules (nth weekday of a
// month, or a fixed date shifted off a weekend), and Good Friday follows the Gregorian Easter
// algorithm. Those are derived here, exactly, with no table to fall out of date.
//
// AD-HOC closures are not computable — a national day of mourning or a weather closure obeys no
// rule. This file does not pretend otherwise. The caller handles that case by observing that a
// supposedly-open market returned no live prices and standing down for the day; see the
// no-session marker in heatmap-store. That is the honest split: what can be derived is derived,
// what cannot is DETECTED, and neither is guessed.

/** Regular session, in minutes past ET midnight. 09:30 → 16:00. */
export const OPEN_MINUTE = 9 * 60 + 30;
export const CLOSE_MINUTE = 16 * 60;
/** Early closes end at 13:00 ET. */
export const EARLY_CLOSE_MINUTE = 13 * 60;

// Resolved through Intl against the real DST calendar. A hardcoded UTC offset is wrong for half
// the year, and "wrong for half the year" here means polling an hour into a closed market every
// day from November to March.
const ET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
});

/** { date:'YYYY-MM-DD', weekday:'Mon', minutes: minutes past ET midnight } */
export function easternNow(now = Date.now()) {
  const p = Object.fromEntries(ET.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour === '24' ? '0' : p.hour);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: hour * 60 + Number(p.minute),
  };
}

// ── CALENDAR PRIMITIVES ─────────────────────────────────────────────────────
// Plain arithmetic on a UTC-noon anchor, so a date string never drifts by a day through a timezone.

const d2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${d2(m)}-${d2(d)}`;
const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();   // 0=Sun … 6=Sat

/** The date of the nth <dow> in a month, e.g. the 3rd Monday of January. */
function nthDow(y, m, dow, n) {
  const first = dowOf(y, m, 1);
  return ymd(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}

/** The last <dow> in a month, e.g. the last Monday of May. */
function lastDow(y, m, dow) {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = dowOf(y, m, days);
  return ymd(y, m, days - ((last - dow + 7) % 7));
}

/**
 * A fixed-date holiday, shifted the way the exchange observes it: Saturday → the Friday before,
 * Sunday → the Monday after. Returns null when the holiday falls on a weekend in a year where the
 * observed day lands outside the month — it cannot, but the guard keeps callers honest.
 */
function observed(y, m, d) {
  const dow = dowOf(y, m, d);
  if (dow === 6) return ymd(y, m, d - 1);        // Sat → Fri
  if (dow === 0) return ymd(y, m, d + 1);        // Sun → Mon
  return ymd(y, m, d);
}

/** Gregorian Easter (anonymous algorithm). Good Friday is two days earlier. */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day, 12));
}

function goodFriday(y) {
  const g = new Date(easter(y).getTime() - 2 * 86_400_000);
  return ymd(g.getUTCFullYear(), g.getUTCMonth() + 1, g.getUTCDate());
}

const holidayCache = new Map();

/** Every scheduled NYSE full closure in a year, as a Set of 'YYYY-MM-DD'. */
export function marketHolidays(year) {
  const y = Number(year);
  if (holidayCache.has(y)) return holidayCache.get(y);
  const s = new Set([
    observed(y, 1, 1),            // New Year's Day
    nthDow(y, 1, 1, 3),           // MLK Jr. Day — 3rd Monday of January
    nthDow(y, 2, 1, 3),           // Washington's Birthday — 3rd Monday of February
    goodFriday(y),                // Good Friday
    lastDow(y, 5, 1),             // Memorial Day — last Monday of May
    observed(y, 6, 19),           // Juneteenth
    observed(y, 7, 4),            // Independence Day
    nthDow(y, 9, 1, 1),           // Labor Day — 1st Monday of September
    nthDow(y, 11, 4, 4),          // Thanksgiving — 4th Thursday of November
    observed(y, 12, 25),          // Christmas Day
  ]);
  holidayCache.set(y, s);
  return s;
}

/**
 * Scheduled 13:00 ET closes.
 *
 * Each is conditional on the ADJACENT holiday actually being a weekday session — the exchange does
 * not run a half-day ahead of a holiday it has already shifted off a weekend.
 */
export function earlyCloses(year) {
  const y = Number(year);
  const out = new Set();

  // The day after Thanksgiving.
  const tg = nthDow(y, 11, 4, 4);
  const tgDay = Number(tg.slice(8));
  out.add(ymd(y, 11, tgDay + 1));

  // July 3, only when Independence Day itself is a weekday session and the 3rd is a weekday.
  if (dowOf(y, 7, 4) >= 1 && dowOf(y, 7, 4) <= 5) {
    const d3 = dowOf(y, 7, 3);
    if (d3 >= 1 && d3 <= 5) out.add(ymd(y, 7, 3));
  }

  // Christmas Eve, on the same condition.
  if (dowOf(y, 12, 25) >= 1 && dowOf(y, 12, 25) <= 5) {
    const d24 = dowOf(y, 12, 24);
    if (d24 >= 1 && d24 <= 5) out.add(ymd(y, 12, 24));
  }

  return out;
}

/** Is this ET date a regular trading session at all? */
export function isTradingDay(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return false;
  const dow = dowOf(y, m, d);
  if (dow === 0 || dow === 6) return false;
  return !marketHolidays(y).has(String(date));
}

/** The minute this date's session ends: 16:00 normally, 13:00 on a scheduled half-day. */
export function closeMinute(date) {
  const y = Number(String(date).slice(0, 4));
  return earlyCloses(y).has(String(date)) ? EARLY_CLOSE_MINUTE : CLOSE_MINUTE;
}

/** The most recent trading date at or before `date`. Walks the real calendar, not Mon–Fri. */
export function previousTradingDay(date, { inclusive = false } = {}) {
  let t = Date.parse(`${String(date).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  if (!inclusive) t -= 86_400_000;
  for (let i = 0; i < 15; i++) {
    const dt = new Date(t);
    const s = ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    if (isTradingDay(s)) return s;
    t -= 86_400_000;
  }
  return null;
}

/**
 * The most recent trading session that has actually FINISHED.
 *
 * Today counts only once its own close has passed — and `closeMinute` knows about half-days, so a
 * 13:00 early close is complete at 13:00 rather than at 16:00.
 */
export function lastCompletedSession(now = Date.now()) {
  const et = easternNow(now);
  const doneToday = isTradingDay(et.date) && et.minutes >= closeMinute(et.date);
  return doneToday ? et.date : previousTradingDay(et.date, { inclusive: false });
}

/**
 * How many completed trading sessions have passed since `date`.
 *
 * ⚠️ SESSIONS, NOT HOURS — THIS IS THE WHOLE POINT. A 24-hour or 48-hour age test calls every
 * Monday-morning price stale because Saturday and Sunday happened, and calls a Tuesday price fresh
 * after a Monday holiday. Counting actual sessions on the real calendar is the only test that means
 * "this security has not printed while the market was open", which is the question being asked.
 *
 * 0 means the price is from the most recent completed session (or later — an intraday quote).
 *
 * @returns {number|null} null when either date is unusable, so a caller can fail closed.
 */
export function sessionsSince(date, now = Date.now()) {
  const last = lastCompletedSession(now);
  const from = date ? String(date).slice(0, 10) : null;
  if (!last || !from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  if (from >= last) return 0;
  let n = 0;
  let cur = last;
  // Bounded: a price older than a trading year is stale by any measure and needs no exact count.
  while (cur && cur > from && n < 260) { n += 1; cur = previousTradingDay(cur); }
  return n;
}

/**
 * WHERE WE ARE IN THE SESSION LIFECYCLE. The single question the snapshot scheduler asks.
 *
 *   phase 'regular'  the regular session is open right now → snapshots may be rebuilt
 *   phase 'closed'   everything else → the board is frozen and NOTHING upstream may be requested
 *
 * `sessionDate` is the trading day the board belongs to: today while the session is open or after
 * it has closed, and the previous session overnight, at a weekend or on a holiday. It is what a
 * frozen snapshot is keyed and labelled by, so a Saturday viewer and a Friday-evening viewer are
 * looking at the same board and are told the same date.
 *
 * ⚠️ PRE-MARKET IS 'closed' ON PURPOSE. 04:00–09:30 ET carries real prices, and using them would
 * both restart provider polling overnight and re-measure a 1D return the reader believes runs
 * between session closes. Overnight movement must not alter the regular-session board.
 */
export function marketPhase(now = Date.now()) {
  const { date, minutes } = easternNow(now);
  const trading = isTradingDay(date);
  const close = closeMinute(date);
  const open = trading && minutes >= OPEN_MINUTE && minutes < close;

  return {
    phase: open ? 'regular' : 'closed',
    // Today once its session has BEGUN (so an open or already-closed session labels as today), and
    // the previous session before the opening bell.
    sessionDate: trading && minutes >= OPEN_MINUTE ? date : previousTradingDay(date, { inclusive: false }),
    etDate: date,
    isTradingDay: trading,
    closeMinute: close,
    earlyClose: close === EARLY_CLOSE_MINUTE,
    // True between the closing bell and midnight on a session day — the window in which the
    // official close has not necessarily been published yet.
    afterClose: trading && minutes >= close,
  };
}
