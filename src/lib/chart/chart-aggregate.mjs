// FOLDING DAILY CANDLES INTO CALENDAR PERIODS.
//
// A monthly candle is not "the last month of daily candles". It is ONE candle whose open is the
// month's first open, whose close is the month's last close, whose high and low are the month's
// extremes, and whose volume is the month's total. The chart's long timeframes used to mean the
// former — a window of daily bars — which is why "1M" drew thirty candles instead of one.
//
// This is the arithmetic for the latter, and nothing else. It never samples, never averages, never
// interpolates and never invents a bar for a period the data does not cover: a month with no trading
// days simply has no candle.
//
// PURE STRING MATH ON PURPOSE. A daily bar's time is 'YYYY-MM-DD' — a calendar date with no clock
// and no zone. Parsing it into a Date to find its month would attach one, and the answer would then
// depend on where the reader is sitting: 2024-01-01 becomes 2023-12-31 anywhere west of UTC, and a
// January candle silently joins December. So the period is read off the characters.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n) => String(n).padStart(2, '0');

/** The periods a long timeframe can fold into. Quarters are calendar quarters, not rolling ones. */
export const PERIODS = new Set(['week', 'month', 'quarter', 'year']);

// ── the calendar, as integers ────────────────────────────────────────────────
// A week boundary cannot be found by string slicing the way a month can, and it must not be found
// with a Date for the reason above. So the two conversions below are Hinnant's civil-date algorithm:
// pure integer arithmetic, no zone, no clock, exact for every date either direction.

/** Days since 1970-01-01 for a civil date. */
export function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;                                   // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse: a civil date from days since 1970-01-01. */
export function civilFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;                                // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/**
 * The Monday that opens the trading week a date falls in.
 *
 * A TRADING WEEK IS MONDAY TO FRIDAY, and the candle is stamped with its Monday even when the market
 * was shut that day. That is what makes a holiday-shortened week one candle rather than two, and it
 * keeps every symbol's weekly candles on the same axis regardless of which days each happened to
 * trade. 1970-01-01 was a Thursday, so shifting by 3 puts Monday at 0.
 */
export function weekStart(y, m, d) {
  const z = daysFromCivil(y, m, d);
  const monday = z - (((z + 3) % 7) + 7) % 7;
  const c = civilFromDays(monday);
  return `${c.y}-${pad2(c.m)}-${pad2(c.d)}`;
}

/**
 * Calendar parts of a bar's time, however the endpoint expressed it.
 *
 * Daily candles arrive as 'YYYY-MM-DD'. An epoch-seconds bar is read in UTC — the one zone that is
 * the same for everybody — rather than in the reader's local time.
 */
export function partsOf(time) {
  if (typeof time === 'string') {
    const m = DATE_RE.exec(time.trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, m: mo, d };
  }
  if (typeof time === 'number' && Number.isFinite(time)) {
    const dt = new Date(time * 1000);
    if (Number.isNaN(dt.getTime())) return null;
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  return null;
}

/**
 * The canonical first day of the calendar period a bar belongs to.
 *
 * This doubles as the bucket's identity and as the candle's timestamp, which is what keeps the
 * series strictly increasing and free of duplicates: every bar in March 2024 yields '2024-03-01',
 * and no other period can produce that string.
 *
 * The date is the PERIOD's start, not the first trading day in it — so a month whose 1st is a
 * weekend still labels its candle with the month itself, and two symbols that began trading on
 * different days still line up on the same axis.
 */
export function bucketStart(time, period) {
  const p = partsOf(time);
  if (!p || !PERIODS.has(period)) return null;
  if (period === 'week') return weekStart(p.y, p.m, p.d);
  if (period === 'year') return `${p.y}-01-01`;
  if (period === 'quarter') {
    const startMonth = Math.floor((p.m - 1) / 3) * 3 + 1;   // 1, 4, 7, 10
    return `${p.y}-${pad2(startMonth)}-01`;
  }
  return `${p.y}-${pad2(p.m)}-01`;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Fold bars into one candle per calendar period.
 *
 * `bars` must already be ascending and unique — `normalizeBars` guarantees both before this runs.
 *
 *   OPEN    the first chronological bar's open
 *   HIGH    the maximum high
 *   LOW     the minimum low
 *   CLOSE   the last chronological bar's close
 *   VOLUME  the sum
 *
 * A partial period is a real candle, not a defect: the month an issuer IPO'd in covers only the days
 * it traded, and the current month covers only the days so far. Both are correct, and the second
 * grows as the sessions arrive.
 *
 * VOLUME IS NULL, NOT ZERO, when no constituent bar reported any. A zero would read as "nothing
 * traded that year", which is a different and false claim.
 */
export function aggregateBars(bars, period) {
  if (!Array.isArray(bars) || !PERIODS.has(period)) return [];
  const out = [];
  let cur = null;

  for (const b of bars) {
    const key = bucketStart(b.time, period);
    // A bar whose date cannot be read belongs to no period. Dropping it is the honest move: putting
    // it in the wrong month would corrupt that month's open, close or extremes.
    if (key == null) continue;
    const open = num(b.open), high = num(b.high), low = num(b.low), close = num(b.close);
    if (open == null || high == null || low == null || close == null) continue;
    const vol = num(b.volume);

    if (!cur || cur.time !== key) {
      if (cur) out.push(cur);
      cur = { time: key, open, high, low, close, volume: vol };
      continue;
    }
    // Same period: extend it. Open is never touched again — it belongs to the first bar.
    if (high > cur.high) cur.high = high;
    if (low < cur.low) cur.low = low;
    cur.close = close;                                    // the latest close wins, every time
    if (vol != null) cur.volume = (cur.volume ?? 0) + vol;
  }
  if (cur) out.push(cur);
  return out;
}
