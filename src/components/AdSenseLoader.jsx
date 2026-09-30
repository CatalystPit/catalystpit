'use client';

import { useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';
import { runAdsGate } from '../lib/adsense.mjs';

/**
 * THE ADSENSE LOADER, GATED ON ENTITLEMENT.
 *
 * ── ⚠️ WHAT WAS WRONG ────────────────────────────────────────────────────────────────────────────
 *
 * The loader was a plain `<script async>` in the root layout's <head>, rendered for every visitor
 * including Pro subscribers. The Terms promise "Pro subscribers will not be shown advertising… This is
 * part of what a Pro subscription buys", and nothing in the product enforced it. It read as harmless
 * only because Google's auto-ad placements were all coming back unfilled — a fill rate is not an
 * entitlement gate, and it can change with no deployment on our side.
 *
 * ── ⚠️ WHY NOT RENDER IT SERVER-SIDE AND OMIT IT FOR PRO ─────────────────────────────────────────
 *
 * That was the first design, and it is worse. Resolving the tier in the root layout means calling
 * auth() there, which opts EVERY page into dynamic rendering — 142 statically generated pages, the
 * ticker pages' SEO and the edge cache all paying for an advertising decision. And resolveUserAccess()
 * makes a Clerk API round-trip, so it would put a third-party network call in front of first byte on
 * every navigation. Advertising is secondary to the product; it does not get to hold the door.
 *
 * ── ⚠️ THIS FILE IS DELIBERATELY ALMOST EMPTY ────────────────────────────────────────────────────
 *
 * The decision lives in runAdsGate in lib/adsense.mjs, which takes its document, its storage and its
 * fetch as arguments. That is not indirection for its own sake: it is what lets verify-pro-adfree
 * EXECUTE every branch — Pro, Elite, Free, signed out, mid-hydration, 500, offline, hanging, junk
 * response, throwing storage — and assert that no script element was created. A guard that is only ever
 * read is a guard nobody has run, and this one is a promise we sell.
 */
export default function AdSenseLoader() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    const { cancel } = runAdsGate({
      isLoaded,
      isSignedIn,
      doc: document,
      fetchImpl: (...a) => fetch(...a),
    });
    return cancel;
    // ⚠️ userId IS IN THE DEPENDENCIES ON PURPOSE, though the gate no longer takes it. It is what makes
    // an identity change re-run the decision: sign in, sign out or switch account and the previous run
    // is cancelled and re-asked. Without it, a session that changed under us would keep the entitlement
    // answer from whoever was signed in before.
  }, [isLoaded, isSignedIn, userId]);

  return null;
}
