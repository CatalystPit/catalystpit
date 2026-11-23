import { maybeN } from '../num.mjs';

// ONE ROW'S PRICE, ITS CHANGE, AND WHERE BOTH CAME FROM.
//
// ── ⚠️ WHY THIS IS A MODULE AND NOT TEN LINES INSIDE THE WATCHLIST ROUTE ─────────────────────────
//
// The 0.00% defect has now shipped three times, and every one of them was a different expression of
// the same arithmetic: a settled close compared against itself. `(c - pc) / pc` with `c === pc`;
// then `Number(null)` resolving to a finite zero; then `parseFloat(x) || 0` in three components.
// The rule that prevents all three is small, and it was living inside a route that needs Clerk and a
// database — so the only test available was a regex over the route's source, which is exactly the
// kind of assertion that stays green while the page is wrong.
//
// As a pure function the actual behaviour is assertable: hand it the four possible sources and read
// back the figure a row would display.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
//
// A percentage may only come from a source that genuinely compared TWO DIFFERENT MOMENTS:
//
//   an entitled quote      real-time or 15-minute delayed — it carries a current price AND a
//                          previous close, so its changePct describes an actual move.
//   the completed session  close against the close before it, from our own licensed candles.
//
// Nothing else. There is no arithmetic in this file, because every historical version of this bug
// was arithmetic performed on two values that were the same number.
//
// ⚠️ ZERO IS PRESERVED, DELIBERATELY. A stock that genuinely closed flat must render 0.00%. Only
// UNKNOWN becomes null, which the UI renders as a dash. Suppressing zeros "to be safe" would delete
// the one value that is both real and indistinguishable from the bug — see eod-change.mjs, which
// returns ABSENT rather than 0 for the same reason.

/** The basis label for a live figure, from the freshness the SERVER stamped on the quote. */
const liveBasis = (freshness) => (freshness === 'realtime' ? 'realtime' : 'delayed');

/**
 * @param {object}  args
 * @param {object?} args.entitled  { price, changePct, freshness, delayMinutes } — what THIS reader
 *                                 is entitled to receive, already resolved server-side.
 * @param {object?} args.cached    the shared `:quote:v2` entry, { c, dp, pc, ... }.
 * @param {number?} args.close     a stored daily close, the durable floor.
 * @param {object?} args.session   { changePct } from lastSessionChange().
 * @returns {{price: number|null, changePct: number|null, changeBasis: string|null,
 *            freshness: string|null, delayMinutes: number|null}}
 */
export function rowPrice({ entitled = null, cached = null, close = null, session = null } = {}) {
  const raw = session == null ? null : maybeN(session.changePct);
  const sessionPct = raw == null ? null : +raw.toFixed(4);

  // ⚠️ THE ENTITLED SOURCE WINS AND IS NEVER SECOND-GUESSED. It is the only one that can describe
  // the market as it stands right now, and it is the thing a Pro subscription pays for.
  if (entitled) {
    const price = maybeN(entitled.price);
    const live = maybeN(entitled.changePct);
    return {
      price,
      changePct: live != null ? live : sessionPct,
      changeBasis: live != null ? liveBasis(entitled.freshness) : (sessionPct != null ? 'last_session' : null),
      freshness: entitled.freshness ?? null,
      delayMinutes: maybeN(entitled.delayMinutes),
    };
  }

  // The shared cache. `dp` is written only from a provider figure, so it is a real number or null —
  // but maybeN is still the reader, because one `Number()` here is how this bug returned last time.
  if (cached) {
    const live = maybeN(cached.dp);
    return {
      price: maybeN(cached.c),
      changePct: live != null ? live : sessionPct,
      changeBasis: live != null ? 'intraday' : (sessionPct != null ? 'last_session' : null),
      // ⚠️ A SETTLED CLOSE IS 'eod' AND MUST SAY SO. The surfaces reading this used to print a
      // hardcoded "DELAYED" over it, which is a claim about latency that a previous-session close
      // does not meet in either direction.
      freshness: live != null ? 'delayed' : 'eod',
      delayMinutes: null,
    };
  }

  return {
    price: maybeN(close),
    changePct: sessionPct,
    changeBasis: sessionPct != null ? 'last_session' : null,
    freshness: 'eod',
    delayMinutes: null,
  };
}
