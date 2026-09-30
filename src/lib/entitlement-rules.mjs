// FREE vs PRO RULES — pure, so they can be tested without Next or Clerk.
//
// ⚠️ SPLIT OUT FOR A REASON. entitlements.js imports Clerk, which cannot load outside the Next
// runtime, so every assertion about the EOD boundary or the interval gate would have needed a
// deployed request to run. The rules depend on nothing but the calendar and the timeframe registry;
// entitlements.js re-exports them, so callers are unchanged and there is still one source of truth.
import { lastCompletedSession, closeMinute, etInstant } from './market/market-session.mjs';
import { TIMEFRAMES } from './chart/chart-source.mjs';

// ─── FREE vs PRO: FRESHNESS AND CHART INTERVALS ─────────────────────────────
//
// Both rules live here, beside the tier resolution, because a second place that decides what a tier
// may see is how the two drift apart. Routes ask; they do not re-derive.

export const isProTier = (tier) => tier === 'pro' || tier === 'elite';

/**
 * ⚠️ THE EOD BOUNDARY IS A SESSION CLOSE, NOT AN AGE. "Older than 24 hours" is wrong in both
 * directions: on a Monday morning it hides Friday's completed session, and after a Monday holiday it
 * exposes work that no completed session has covered. This walks the real exchange calendar, so
 * weekends, holidays and early closes are handled by the same code the rest of the product uses.
 *
 * Free sees a record only once the session it arrived in has CLOSED. A Form 4 processed at 18:00 ET
 * on Monday is after Monday's close, so it stays Pro-only until Tuesday's close passes — which is
 * exactly "the latest completed EOD snapshot" rather than a rolling delay.
 *
 * @returns {string|null} ISO instant; null for Pro/Elite, meaning no cutoff at all.
 */
export function eodCutoffIso(tier, now = Date.now()) {
  if (isProTier(tier)) return null;
  const session = lastCompletedSession(now);
  return new Date(etInstant(session, closeMinute(session))).toISOString();
}

/**
 * Chart intervals a tier may request.
 *
 * ⚠️ DERIVED FROM THE REGISTRY, so adding a timeframe cannot silently hand Free an intraday one.
 * Free gets every NON-INTRADAY timeframe — daily, weekly, monthly, quarterly, 6M, YTD, yearly and
 * All. Those are all built from the same end-of-day candles, so restricting them further would
 * remove research value without protecting anything; what is monetised is intraday.
 */
export const INTRADAY_INTERVALS = Object.freeze(
  TIMEFRAMES.filter((t) => t.kind === 'intraday').map((t) => t.id),
);
export const FREE_CHART_INTERVALS = Object.freeze(
  TIMEFRAMES.filter((t) => t.kind !== 'intraday').map((t) => t.id),
);
export const isIntradayInterval = (id) => INTRADAY_INTERVALS.includes(String(id));
export function chartIntervalAllowed(tier, id) {
  return isProTier(tier) ? true : !isIntradayInterval(id);
}

// Watchlist size cap per tier (C2). Free = 15 names / 1 list — the free-tier hook that
// powers insider alerts. Pro/Elite lift the cap (wired once Stripe lands in C5).
export const WATCHLIST_LIMIT = { free: 15, pro: 250, elite: 1000 };

// Number of named watchlists per tier. Multiple lists is a Pro perk — Free gets the single
// default list; Pro/Elite can create additional named lists (rename/organize).
export const WATCHLIST_LISTS_LIMIT = { free: 1, pro: 10, elite: 25 };

// Market-data entitlement — single source of truth so every route/component applies the same rule:
// Free = delayed, Pro/Elite = real-time (when the provider's plan supports it). The delay duration is
// CONFIGURABLE (not hard-coded to 15 min) via MARKET_DATA_DELAY_MINUTES.
export const MARKET_DATA_DELAY_MIN = parseInt(process.env.MARKET_DATA_DELAY_MINUTES || '15', 10);
export function marketDataAccess(tier) { return tier === 'pro' || tier === 'elite' ? 'realtime' : 'delayed'; }
export function isRealtime(tier) { return marketDataAccess(tier) === 'realtime'; }

