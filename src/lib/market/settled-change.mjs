import { maybeN } from '../num.mjs';

/**
 * ⚠️ THE PERCENTAGE BESIDE A PRICE MUST DESCRIBE THAT PRICE.
 *
 * ── THE BUG THIS EXISTS TO FIX ───────────────────────────────────────────────────────────────────
 *
 * On 2026-11-23 — the largest one-day dollar gain in market history — catalystpit.com showed:
 *
 *   NVDA  165.05  -14.01%        real session: +31.48%
 *   GOOGL 282.10   -2.70%        real session:  +6.34%
 *   SPY   722.29   -3.64%        real session:  +4.71%
 *   QQQ   651.03   -5.67%        real session:  +7.00%
 *
 * Every PRICE was right. Every PERCENTAGE was Friday's, and Friday was a crash — so the whole board
 * was red on a day the market had its best session since 2025, and the sign was inverted on every
 * row.
 *
 * The cause was two sources with different clocks and nothing comparing them:
 *
 *   price       ← getQuotes(), the licensed quote feed, which carries TODAY's settled close
 *   changePct   ← lastSessionChange(), the stored daily candles, which lag the feed by a session
 *
 * The candle table is written by a cron that runs after the close, so between the closing bell and
 * that run the newest stored session is YESTERDAY's. The assembling code paired whatever price the
 * feed gave with whatever percentage the candles gave and stamped the result 'last_session',
 * truthfully labelling it as a settled return while silently meaning a DIFFERENT settled session
 * from the one the price came from.
 *
 * ── WHY THE FEED'S OWN FIGURE WAS NOT USED ───────────────────────────────────────────────────────
 *
 * getQuotes() reported changePct: null for every settled quote, on the stated premise that
 * "outside session hours Tiingo returns tngoLast === prevClose, both being the same close" — so
 * subtracting them could only ever yield zero, the original 0.00% bug.
 *
 * Measured 2026-11-23 21:xx UTC, that premise is false:
 *
 *   NVDA  tngoLast 165.05   prevClose 125.53   asOf 2026-11-23T21:00:00Z
 *
 * After the close tngoLast is TODAY's close and prevClose is the one before it. Those are two
 * distinct closes from two consecutive sessions, which is precisely a complete daily return — the
 * figure a visitor looking at a settled close should be shown, and it was being thrown away.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────────────────────────────
 *
 * A percentage may be published beside a price only when it is derived from that price. So:
 *
 *   1. A live print carries its own intraday change.                        → basis 'intraday'
 *   2. A settled quote holding two DISTINCT closes is a complete session.    → basis 'last_session'
 *   3. The stored candles may stand in ONLY when their close IS this price.  → basis 'last_session'
 *   4. Otherwise the change is unknown — null, a dash, never zero.
 *
 * Rule 3 is the guard that makes this class of bug impossible regardless of which source lags:
 * a candle session whose close is not the price on screen can never be published next to it again.
 */

export const CHANGE_BASIS = { INTRADAY: 'intraday', LAST_SESSION: 'last_session' };

/** Closes are carried to 2dp; anything under half a cent is the same price. */
const SAME_PRICE_EPSILON = 0.005;

const EMPTY = Object.freeze({ change: null, changePct: null, changeBasis: null, changeSession: null });

// ⚠️ FOUR DECIMALS, NOT TWO. The tape prints two and the watchlist prints two, but rounding here
// would make this module decide a display question for every caller — and the watchlist's own
// contract was four. Each surface rounds its own output; this keeps the figure it rounds from.
const r4 = (n) => Math.round(n * 10000) / 10000;
const pctOf = (close, prior) => ((close - prior) / prior) * 100;

/**
 * The calendar session a price belongs to, read off the stamp that describes THAT price.
 * getQuotes sets asOf to the session's own closing instant for a settled price, so the date half
 * of it is the session. Returns null rather than guessing when there is no usable stamp.
 */
export function sessionOf(asOf) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(asOf ?? ''));
  return m ? m[1] : null;
}

/**
 * Rule 2 — the daily return a settled quote states about itself.
 *
 * ⚠️ price === prevClose RETURNS UNKNOWN, NOT ZERO. When no live print is available getQuotes
 * degrades `price` to `prevClose`, so the two being equal cannot be distinguished from a session
 * that genuinely closed flat. Unknown lets rule 3 answer from the candles; a zero here would be
 * indistinguishable from a real flat close and would re-ship the 0.00% bug.
 */
export function settledChange({ price = null, prevClose = null, asOf = null } = {}) {
  const p = maybeN(price);
  const pc = maybeN(prevClose);
  if (p == null || pc == null || pc <= 0) return EMPTY;
  if (Math.abs(p - pc) < SAME_PRICE_EPSILON) return EMPTY;
  return {
    change: r4(p - pc),
    changePct: r4(pctOf(p, pc)),
    changeBasis: CHANGE_BASIS.LAST_SESSION,
    changeSession: sessionOf(asOf),
  };
}

/**
 * The change to publish beside `price`, and the basis that makes it readable.
 *
 * @param {object}  args
 * @param {number?} args.price        the price actually being shown
 * @param {number?} args.prevClose    the close before it, from the SAME quote payload
 * @param {string?} args.asOf         the stamp describing `price`
 * @param {number?} args.intradayPct  an intraday move, supplied ONLY when a live print was served
 * @param {object?} args.session      { close, prevClose, session } from lastSessionChange()
 */
export function changeForPrice({ price = null, prevClose = null, asOf = null, intradayPct = null, session = null } = {}) {
  const p = maybeN(price);
  const pc = maybeN(prevClose);

  // 1. A live print states its own move against the previous close.
  const live = maybeN(intradayPct);
  if (live != null) {
    return {
      change: p != null && pc != null ? r4(p - pc) : null,
      changePct: r4(live),
      changeBasis: CHANGE_BASIS.INTRADAY,
      changeSession: null,
    };
  }

  // 2. A settled quote spanning two distinct closes is a complete session, self-consistent by
  //    construction: both legs came out of one payload for one symbol.
  const own = settledChange({ price, prevClose, asOf });
  if (own.changePct != null) return own;

  // 3. The stored candles, and ONLY when their close is the price being shown. This is the guard
  //    the original code lacked: `session.close` not matching `price` is exactly the condition
  //    that put Friday's crash beside Monday's rally.
  const sClose = session == null ? null : maybeN(session.close);
  const sPrior = session == null ? null : maybeN(session.prevClose);
  if (p != null && sClose != null && sPrior != null && sPrior > 0
      && Math.abs(sClose - p) < SAME_PRICE_EPSILON) {
    return {
      change: r4(sClose - sPrior),
      changePct: r4(pctOf(sClose, sPrior)),
      changeBasis: CHANGE_BASIS.LAST_SESSION,
      changeSession: session.session ?? null,
    };
  }

  // 4. Nothing here describes this price.
  return EMPTY;
}
