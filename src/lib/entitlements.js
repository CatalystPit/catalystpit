import { auth, clerkClient } from '@clerk/nextjs/server';

// Number of bull/bear bullets a Free user sees per side; the rest are stripped
// from the response server-side (never sent to the client).
export const FREE_BULLSBEARS_VISIBLE = 1;

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
