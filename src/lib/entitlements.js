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

// Single source of truth for Free/Pro tier resolution, server-side. Reads the
// Clerk session via the same auth() import the watchlist route uses, and returns
// 'free' | 'pro' | 'elite'. Signed-out callers (userId null) resolve cleanly to
// 'free' — auth() does not throw — so callers never special-case the anonymous case.
export async function resolveUserTier() {
  const { userId } = await auth();   // no-throw when signed out
  if (!userId) return 'free';
  // Plan lives in Clerk publicMetadata.plan, stamped by the Stripe webhook (C5).
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    // Admin (ADMIN_EMAIL) always resolves to the top tier — full entitlements without a Stripe plan.
    const email = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress
      || user?.emailAddresses?.[0]?.emailAddress;
    if (email && process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase()) return 'elite';
    const plan = user?.publicMetadata?.plan;
    return plan === 'pro' || plan === 'elite' ? plan : 'free';
  } catch {
    return 'free';   // Clerk hiccup → fail safe to Free
  }
}
