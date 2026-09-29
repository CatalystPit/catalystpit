import { auth, clerkClient } from '@clerk/nextjs/server';
import { lastCompletedSession, closeMinute, easternNow } from './market/market-session.mjs';
import { TIMEFRAMES } from './chart/chart-source.mjs';

// Number of bull/bear bullets a Free user sees per side; the rest are stripped
// from the response server-side (never sent to the client).
export const FREE_BULLSBEARS_VISIBLE = 1;

// The Free/Pro rules live in entitlement-rules.mjs (pure, testable) and are re-exported here so
// every existing caller keeps importing one module.
export { isProTier, eodCutoffIso, chartIntervalAllowed, isIntradayInterval,
  FREE_CHART_INTERVALS, INTRADAY_INTERVALS } from './entitlement-rules.mjs';

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
