// The market-data layer. The rest of the app asks for quotes via getQuotes() and never talks to a
// vendor directly. `realtime` is the entitlement hint (Pro = true); the provider returns real-time only
// when the plan and the licence both allow it, otherwise its best (delayed) data.
//
// There is exactly ONE provider. See the note on PROVIDER below for what used to be here, and why a
// configurable provider list was itself the defect.

import { getQuotes as tiingoQuotes, tiingoConfigured, tiingoRealtimeEnabled } from './market/tiingo.mjs';
import { APPROVED_COMMERCIAL_PROVIDER } from './licensing/providers.mjs';

/**
 * THERE IS ONE PROVIDER, AND NO ENVIRONMENT VARIABLE CAN CHANGE THAT.
 *
 * ── ⚠️ WHAT WAS WRONG, AND IT NEEDED NO CODE CHANGE TO FIRE ──────────────────
 *
 * The provider was chosen at import time by this expression:
 *
 *   process.env.MARKET_DATA_PROVIDER || (tiingoConfigured() ? 'tiingo' : TWELVE_KEY ? 'twelvedata' : 'polygon')
 *
 * which is three different ways to serve quotes from a vendor we hold no redistribution rights for.
 * Setting MARKET_DATA_PROVIDER=twelvedata did it. So did adding TWELVE_DATA_API_KEY at any moment when
 * the Tiingo key was absent — i.e. precisely during a Tiingo outage, the one time nobody is reading
 * configuration carefully. The fallback was documented as deliberate ("removing a working path before
 * its replacement is entitled is how a feature goes dark"), which was a reasonable engineering instinct
 * and the wrong call: a path that works without a licence is not a working path.
 *
 * It is now a constant. `marketDataProvider()` is kept because callers and the health probe read it,
 * and it can only ever answer with the approved provider.
 */
const PROVIDER = APPROVED_COMMERCIAL_PROVIDER;

export function marketDataProvider() { return PROVIDER; }

/**
 * symbols: string[]. Returns { TICKER: { price, changePct, volume, ... } }, missing tickers omitted.
 *
 * ── THE ENTITLEMENT BOUNDARY IS HERE, SERVER-SIDE ───────────────────────────
 *
 * `realtime` is the caller's ENTITLEMENT (Pro = true), not a request for a specific feed. A provider
 * returns realtime only when its plan actually supports it, so a caller cannot obtain live data by
 * passing a flag — which is what keeps the boundary from depending on the frontend remembering to
 * hide something.
 *
 * On the current Tiingo account realtime is not entitled: every quote comes back EOD and says so in
 * its own `freshness` field. Each quote therefore carries its own provenance rather than the caller
 * inferring it from which function was called.
 */
export async function getQuotes(symbols, { realtime = false } = {}) {
  const syms = [...new Set((symbols || []).map((s) => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 100);
  if (!syms.length) return {};

  // ⚠️ ONE PROVIDER, ONE ATTEMPT, AND AN HONEST EMPTY RESULT.
  if (tiingoConfigured()) {
    try {
      // The entitlement narrows what may be served; it can never widen it. Asking for realtime when
      // the plan is EOD yields EOD, labelled EOD.
      const wantLive = realtime && tiingoRealtimeEnabled();
      const res = await tiingoQuotes(syms, { realtime: wantLive });
      if (res.ok && Object.keys(res.quotes).length) return res.quotes;
    } catch { /* fall through to the empty result below — never to another vendor */ }
  }

  // ⚠️ NOTHING FOLLOWS THIS. Two fallbacks used to: a Polygon snapshot batch first, then a Twelve
  // branch. Both served customer-facing prices from providers whose redistribution rights were never
  // established, and both fired only when Tiingo was already failing — the worst moment to discover a
  // licensing problem, and the one least likely to be noticed.
  //
  // Returning {} is the honest degrade and every caller already handles it: /api/quotes falls back to
  // the licensed delayed snapshot and then to stored end-of-day closes, the watchlist falls back to our
  // own last licensed candle, and the tape refuses to overwrite its last good value. A missing price is
  // a visible, recoverable state; an unlicensed one is neither.
  return {};
}

// ⚠️ polygonQuotes() AND twelveQuotes() ARE DELETED, NOT PARKED.
//
// Both were ~40 lines of working vendor client, retained "for a future licensed use" — and a retained
// client is an invitation: it needs only one caller to become an exposure again, and the Twelve Data
// branch above is precisely what that looks like in practice. If either provider is ever licensed the
// code is one revert away, and the agreement was always the hard part rather than the fetch.
