import { auth, clerkClient } from '@clerk/nextjs/server';
import { lastCompletedSession, closeMinute, easternNow } from './market/market-session.mjs';
import { TIMEFRAMES } from './chart/chart-source.mjs';

// Number of bull/bear bullets a Free user sees per side; the rest are stripped
// from the response server-side (never sent to the client).
export const FREE_BULLSBEARS_VISIBLE = 1;

// The Free/Pro rules live in entitlement-rules.mjs (pure, testable) and are re-exported here so
// every existing caller keeps importing one module.
//
// ⚠️ THE RE-EXPORT LIST MUST NAME EVERY SYMBOL THAT MOVED, AND FOR THREE OF THEM IT DID NOT.
//
// 050af15a moved isRealtime, WATCHLIST_LIMIT and WATCHLIST_LISTS_LIMIT into entitlement-rules.mjs
// and listed only the other six here. Nothing failed at build time — an ES re-export of a name that
// is not listed is simply absent, and importers get undefined — so the breakage was entirely at
// runtime and entirely silent:
//
//   isRealtime            6 call sites, every one of the shape `isRealtime(tier) && !beta` inside a
//                         `try { ... } catch { /* signed-out → delayed */ }`. The TypeError went
//                         into the catch written for anonymous callers, so realtime stayed false and
//                         PRO AND ELITE USERS WERE SERVED DELAYED DATA THEY HAD PAID NOT TO GET.
//   WATCHLIST_LIMIT       `WATCHLIST_LIMIT[tier] ?? WATCHLIST_LIMIT.free` — a read off undefined,
//   WATCHLIST_LISTS_LIMIT so these threw rather than degraded.
//
// verify-entitlement-exports.mjs now imports this module and asserts every name is live, because a
// grep for `isRealtime(tier) && !beta` finds the call site whether or not the function exists — which
// is exactly why the gating suite's 118 assertions stayed green through all of it.
import { isRealtime as isRealtimeRule } from './entitlement-rules.mjs';
export { isProTier, eodCutoffIso, chartIntervalAllowed, isIntradayInterval,
  FREE_CHART_INTERVALS, INTRADAY_INTERVALS,
  isRealtime, marketDataAccess, WATCHLIST_LIMIT, WATCHLIST_LISTS_LIMIT } from './entitlement-rules.mjs';

// Single source of truth for Free/Pro tier resolution, server-side. Reads the
// Clerk session via the same auth() import the watchlist route uses, and returns
// 'free' | 'pro' | 'elite'. Signed-out callers (userId null) resolve cleanly to
// 'free' — auth() does not throw — so callers never special-case the anonymous case.
export async function resolveUserTier() {
  return (await resolveUserAccess()).tier;
}

/**
 * The same resolution, with the reason attached. `beta` is true only for a manually flagged tester,
 * and it is what lets a caller treat a beta user differently from a paying one WITHOUT changing the
 * tier they get. Today that matters in exactly one place: real-time market data is a licensed
 * entitlement, so a beta tester gets Pro's features on delayed data.
 *
 * @returns {{ tier: 'free'|'pro'|'elite', beta: boolean }}
 */
export async function resolveUserAccess() {
  const { userId } = await auth();   // no-throw when signed out
  if (!userId) return { tier: 'free', beta: false };
  // Plan lives in Clerk publicMetadata.plan, stamped by the Stripe webhook (C5).
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    // Admin (ADMIN_EMAIL) always resolves to the top tier — full entitlements without a Stripe plan.
    const email = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress
      || user?.emailAddresses?.[0]?.emailAddress;
    if (email && process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase()) {
      return { tier: 'elite', beta: false };
    }
    const plan = user?.publicMetadata?.plan;
    if (plan === 'pro' || plan === 'elite') return { tier: plan, beta: false };
    // MANUAL BETA ACCESS. A flag set by hand on one Clerk user, read here and nowhere else.
    //
    // It deliberately does NOT touch publicMetadata.plan: a beta tester has no Stripe subscription
    // and must never appear as one in a member count or a revenue report, which is exactly what
    // setting `plan` would have done. Revoking is deleting the key in Clerk — it takes effect on
    // their next request, with no deploy.
    //
    // Strict `=== true`, so a stray "true", 1 or "yes" grants nothing.
    if (user?.publicMetadata?.beta === true) return { tier: 'pro', beta: true };
    return { tier: 'free', beta: false };
  } catch {
    return { tier: 'free', beta: false };   // Clerk hiccup → fail safe to Free
  }
}

/**
 * IS THIS CALLER ENTITLED TO REAL-TIME MARKET DATA, server-side, for this request.
 *
 * ── ⚠️ WHY THIS EXISTS RATHER THAN THREE COPIES OF THE SAME FOUR LINES ──────
 *
 * /api/quotes already decided real-time entitlement correctly — `isRealtime(tier) && !beta`, with a
 * signed-out caller falling through to delayed. But /api/screener and /api/pitscan were each
 * DESCRIBING the feed to the caller without asking the same question, so the metadata they served
 * described the ACCOUNT's capability rather than the caller's entitlement: an anonymous request to
 * /api/screener?meta=1 was told `quoteFreshness: "realtime"` while receiving the 15-minute delayed
 * snapshot, and a beta-flagged Pro user was told the same while /api/quotes deliberately served them
 * delayed data.
 *
 * Three call sites answering one licensing question is how two of them eventually disagree, so the
 * answer lives here.
 *
 * ⚠️ NOTHING IS READ FROM THE REQUEST. The tier comes from the Clerk session via resolveUserAccess();
 * no header, cookie, query parameter or body field participates, so a forged `x-tier: pro` cannot
 * reach this decision. A Clerk failure resolves to Free, which is the safe direction.
 *
 * ⚠️ AND BETA IS NOT REAL-TIME. Real-time is licensed per entitled user, so a manually flagged tester
 * gets every Pro FEATURE on delayed data and is not counted against the provider's entitled-user
 * terms. That rule is stated once, in resolveUserAccess, and applied once, here.
 *
 * @returns {Promise<boolean>}
 */
export async function callerHasRealtime() {
  try {
    const { tier, beta } = await resolveUserAccess();
    return isRealtimeRule(tier) && !beta;
  } catch {
    return false;                 // never grant a licensed entitlement on an error path
  }
}
