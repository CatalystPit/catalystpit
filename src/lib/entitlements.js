import { auth } from '@clerk/nextjs/server';

// Number of bull/bear bullets a Free user sees per side; the rest are stripped
// from the response server-side (never sent to the client).
export const FREE_BULLSBEARS_VISIBLE = 1;

// Single source of truth for Free/Pro tier resolution, server-side. Reads the
// Clerk session via the same auth() import the watchlist route uses, and returns
// 'free' | 'pro' | 'elite'. Signed-out callers (userId null) resolve cleanly to
// 'free' — auth() does not throw — so callers never special-case the anonymous case.
export async function resolveUserTier() {
  await auth();   // reads the Clerk session (no-throw when signed out)

  // M7 TODO: read publicMetadata.plan once Clerk prod + Stripe are wired; return 'pro'/'elite' accordingly. Single source of truth for all tier gates.
  return 'free';  // for now everyone — signed-in or signed-out — is Free
}
