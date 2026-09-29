// MARKET BREADTH — four indicators over a fixed U.S. common-stock universe.
//
// ⚠️ NO PROVIDER IS CALLED FROM HERE, and no new one is introduced. Every number is derived from
// ticker_daily_candles, the daily history Catalyst Pit already stores and already publishes derived
// values from (screener_stocks.sma50, hi52 and lo52 come from the same rows). There is no fetch in this
// file. That is a hard constraint rather than a preference: breadth touches the whole market, so a
// per-request provider fan-out over five thousand symbols would be both a metered bill and an outage
// waiting to happen.
//
// ── ⚠️ EACH METRIC HAS ITS OWN DENOMINATOR, AND THEY DIFFER ──────────────────
//
// A stock listed three weeks ago has a previous close and no 200-day average. Counting it in the
// SMA200 denominator would put it on the "below" side of a line that does not exist for it, which is
// how a breadth reading drifts bearish for no reason. So every metric publishes the population it
// could actually measure, and a security missing that input is EXCLUDED rather than defaulted.
// Measured on the live corpus: 5,338 in the universe, 5,334 with a previous close, 4,950 with fifty
// sessions, 4,514 with two hundred, 4,355 with a full 52 weeks.
//
// ── THE 52-WEEK WINDOW, AND THE SELF-COMPARISON TRAP ────────────────────────
//
// A new 52-week high is defined here on a CLOSING basis: the latest close is the highest close in the
// trailing 52 weeks, that window INCLUDING the latest session. Two reasons.
//
// First, it cannot produce the false positive that an intraday basis invites. If the range were built
// from daily HIGHS and then compared against the latest high, every stock that happened to close at
// its own daily high would qualify — which on a strong day is most of the market.
//
// Second, including the latest session makes the test an identity rather than a comparison across two
// differently-built numbers: the stock is at a new high exactly when its latest close IS the maximum.
// Excluding it and asking "close >= max of the prior window" is equivalent, and the inclusive form has
// no off-by-one to get wrong.
//
// A security whose history does not span the full 52 weeks is excluded from this metric entirely. It
// has not had the chance to make a 52-week high, and calling its three-week high a 52-week high is the
// error this guard exists to prevent.

/** 52 weeks, as calendar days. The window is a date range, not a session count. */
export const WEEKS_52_DAYS = 364;
/** Sessions required for each moving average. Trading days, not calendar days. */
export const SMA_SHORT = 50;
export const SMA_LONG = 200;

// ── THE UNIVERSE ────────────────────────────────────────────────────────────
//
// ⚠️ AFFIRMATIVELY CLASSIFIED U.S. COMMON STOCK, AND NOTHING ELSE. asset_type is taken from our own
// security classification; only 'Stock' is included. That excludes, because each would distort a
// breadth reading and each is separately identified in the data: ETF (5,552), ETS/ETV (197 more ETF
// share classes), ETN (45), FUND (335, closed-end and mutual), WARRANT (436), RIGHT (113), UNIT (204),
// PFD (82, preferred), SP (130, structured products), OS (944), ADRC (1,041) and GDR (8).
//
// ADRC and GDR are depositary RECEIPTS over a foreign issuer's shares, not U.S. common stock, so they
// are out — this is a U.S. common-stock reading and saying so means excluding them. The 2,655 rows with
// a NULL asset_type are also out: we cannot establish what they are, and guessing is exactly what the
// brief forbids.
//
// The exchange filter is the second half. A U.S. common stock is listed on a U.S. venue; the 949
// asset_type='Stock' rows with no exchange are overwhelmingly OTC or delisted and 947 of them have no
// price history at all. Requiring a venue takes the universe from 6,287 to 5,338 and candle coverage
// from 88% to 99.96%.
export const UNIVERSE_ASSET_TYPE = 'Stock';
export const UNIVERSE_EXCHANGES = Object.freeze(['NYSE', 'NASDAQ', 'AMEX']);

/**
 * One metric's counts, with the denominator it was actually measured over.
 *
 * ⚠️ THE DENOMINATOR IS `eligible`, NEVER THE UNIVERSE. Dividing by the universe would understate every
 * percentage by the share of securities that could not be measured, and the shortfall differs per
 * metric — 0.1% for advance/decline, 18.4% for SMA200.
 */
export function ratio({ up, down, flat = 0, eligible }) {
  const n = Number(eligible) || 0;
  const pct = (v) => (n > 0 ? (Number(v) / n) * 100 : null);
  return {
    up: Number(up) || 0,
    down: Number(down) || 0,
    flat: Number(flat) || 0,
    eligible: n,
    upPct: pct(up),
    downPct: pct(down),
    flatPct: pct(flat),
  };
}

/**
 * The share of EXTREMES that are highs — which is what a high-vs-low bar may honestly represent.
 *
 * ⚠️ NEW HIGHS AND NEW LOWS ARE NOT A PARTITION OF THE MARKET. Most stocks are neither, so a bar drawn
 * from upPct and downPct would be a sliver against a vast empty remainder, and labelling the filled
 * part "22.5% of the market made a new high" would be false. The counts are published against the
 * eligible universe, and the BAR is drawn from this — the split of the stocks that did make an extreme.
 * Null when nothing made one, because a bar with no data behind it must not render as a tie.
 */
export function extremeSplit({ up, down }) {
  const total = (Number(up) || 0) + (Number(down) || 0);
  if (total <= 0) return { total: 0, highShare: null, lowShare: null };
  return { total, highShare: ((Number(up) || 0) / total) * 100, lowShare: ((Number(down) || 0) / total) * 100 };
}

/**
 * How old the reading is, in the only terms that matter: the session it describes.
 *
 * ⚠️ IT IS NOT A LIVE READING AND MUST NOT SAY IT IS. The inputs are completed daily sessions, so
 * breadth describes the last close — during a session it is yesterday's market, correctly labelled,
 * rather than a number that pretends to move intraday.
 */
export function freshness({ asOfSession, computedAt, now = Date.now() }) {
  const session = asOfSession ? String(asOfSession).slice(0, 10) : null;
  const computed = computedAt ? Date.parse(computedAt) : null;
  const ageMs = computed ? now - computed : null;
  return {
    asOfSession: session,
    computedAt: computedAt || null,
    ageMinutes: ageMs == null ? null : Math.max(0, Math.round(ageMs / 60000)),
    // A snapshot older than two days has missed a rebuild; the UI says so rather than showing it plain.
    stale: ageMs == null ? true : ageMs > 48 * 3600 * 1000,
  };
}

/**
 * Shape a stored snapshot row into the API payload.
 *
 * Returns null for a missing row rather than a zeroed object — "no data" and "nothing advanced" are
 * different statements and the UI renders them differently.
 */
export function buildBreadthPayload(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const advancing = ratio({ up: row.adv, down: row.decl, flat: row.unch, eligible: row.adv_eligible });
  const highs = ratio({ up: row.new_high, down: row.new_low, eligible: row.hl_eligible });
  const sma50 = ratio({ up: row.above_sma50, down: row.below_sma50, flat: row.at_sma50, eligible: row.sma50_eligible });
  const sma200 = ratio({ up: row.above_sma200, down: row.below_sma200, flat: row.at_sma200, eligible: row.sma200_eligible });
  return {
    universe: Number(row.universe) || 0,
    advancing,
    highsLows: { ...highs, split: extremeSplit({ up: row.new_high, down: row.new_low }) },
    sma50,
    sma200,
    ...freshness({ asOfSession: row.as_of_session, computedAt: row.computed_at, now }),
    basis: 'closing',
  };
}
