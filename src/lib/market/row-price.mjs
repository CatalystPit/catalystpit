import { maybeN } from '../num.mjs';
import { changeForPrice } from './settled-change.mjs';

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
// Nothing else. The arithmetic itself lives in settled-change.mjs, because every historical version
// of this bug was arithmetic performed on two values that were the same number — or, on 2026-11-23,
// on two values from DIFFERENT SESSIONS. This file decides which source speaks for a row; that
// module decides whether the chosen source actually describes the price being published.
//
// ⚠️ A SESSION FIGURE IS NOT ACCEPTED UNLESS ITS CLOSE IS THIS ROW'S PRICE. `session` comes from the
// candle table, which lags the quote feed between the closing bell and the cron that writes it. The
// previous version substituted it whenever the live figure was missing, with no comparison at all,
// which is how the homepage printed Friday's crash percentages beside Monday's rally prices.
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
  // ⚠️ THE ENTITLED SOURCE WINS AND IS NEVER SECOND-GUESSED. It is the only one that can describe
  // the market as it stands right now, and it is the thing a Pro subscription pays for.
  if (entitled) {
    const price = maybeN(entitled.price);
    // ⚠️ A SETTLED FIGURE IS NOT AN INTRADAY ONE. getQuotes now reports a real return for a settled
    // close, so "changePct is present" no longer means "the market is moving" — the quote says
    // which it is, and taking its word is the only thing that keeps the label honest.
    const live = entitled.changeBasis === 'last_session' ? null : maybeN(entitled.changePct);
    const chg = changeForPrice({
      price, prevClose: entitled.prevClose, asOf: entitled.asOf, intradayPct: live, session,
    });
    return {
      price,
      changePct: chg.changePct,
      // A live move is labelled by HOW live it is — real-time or delayed — which is the freshness
      // the server stamped. A settled one is labelled by the session it describes.
      changeBasis: chg.changeBasis === 'intraday' ? liveBasis(entitled.freshness) : chg.changeBasis,
      freshness: entitled.freshness ?? null,
      delayMinutes: maybeN(entitled.delayMinutes),
    };
  }

  // The shared cache. `dp` is written only from a provider figure, so it is a real number or null —
  // but maybeN is still the reader, because one `Number()` here is how this bug returned last time.
  if (cached) {
    const price = maybeN(cached.c);
    const live = maybeN(cached.dp);
    const chg = changeForPrice({ price, prevClose: cached.pc, intradayPct: live, session });
    return {
      price,
      changePct: chg.changePct,
      changeBasis: chg.changeBasis,
      // ⚠️ A SETTLED CLOSE IS 'eod' AND MUST SAY SO. The surfaces reading this used to print a
      // hardcoded "DELAYED" over it, which is a claim about latency that a previous-session close
      // does not meet in either direction.
      freshness: live != null ? 'delayed' : 'eod',
      delayMinutes: null,
    };
  }

  const chg = changeForPrice({ price: close, session });
  return {
    price: maybeN(close),
    changePct: chg.changePct,
    changeBasis: chg.changeBasis,
    freshness: 'eod',
    delayMinutes: null,
  };
}
