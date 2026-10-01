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
// ⚠️ THIS IMPORT WAS MISSING, AND THE CATCH HID IT. callerHasRealtime calls tiingoRealtimeStopped inside a
// try whose catch returns false — so an unimported symbol threw a ReferenceError that was swallowed, and
// EVERY Pro and Elite caller silently lost real-time. The build passed because a free identifier is a
// runtime fault, not a compile one. This is the identical failure this file already documents above about
// the isRealtime re-export: "the TypeError went into the catch written for anonymous callers, so realtime
// stayed false and PRO AND ELITE USERS WERE SERVED DELAYED DATA THEY HAD PAID NOT TO GET."
// verify-freshness-entitlement caught it, which is what that suite exists for.
import { tiingoRealtimeStopped } from './market/tiingo.mjs';
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
    return accessFromClerkUser(await client.users.getUser(userId));
  } catch {
    return { tier: 'free', beta: false };   // Clerk hiccup → fail safe to Free
  }
}

/**
 * THE TIER RULE ITSELF, as a pure function over a Clerk user.
 *
 * ⚠️ EXTRACTED SO THERE IS STILL EXACTLY ONE RULE. Evidence Alerts have to know a subscriber's tier
 * at DELIVERY time, in a cron with no request and therefore no auth() — and the tempting shortcut is
 * a second "is this user Pro?" written inside the worker. That is how two answers to one question
 * start disagreeing, and the one in the background job is the copy nobody notices has drifted. Both
 * resolveUserAccess (request-scoped, via auth()) and resolveAccessByIds (by user id, for workers)
 * now call this, so a change to the rule reaches both or neither.
 *
 * @returns {{ tier: 'free'|'pro'|'elite', beta: boolean }}
 */
export function accessFromClerkUser(user) {
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
}

/**
 * RESOLVE MANY USERS' ENTITLEMENTS BY ID — for background workers, which have no request.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. A stored subscription is a record of what somebody once asked for, not
 * proof of what they are entitled to today. The Evidence Alert worker read every enabled row and
 * delivered, so a subscriber who cancelled Pro in March kept receiving Pro alerts indefinitely —
 * entitlement was checked when the subscription was CREATED and never again.
 *
 * ⚠️ BATCHED, BECAUSE THE ALTERNATIVE IS AN N+1 AGAINST A THIRD PARTY. getUserList takes a list of
 * ids, so a hundred subscribers cost one Clerk call rather than a hundred. Chunked at 100, which is
 * the page size the API accepts.
 *
 * ⚠️ AND IT FAILS CLOSED, LOUDLY ENOUGH TO NOTICE. A Clerk outage resolves everyone to Free, which
 * means alerts are withheld rather than sent to people who may no longer be entitled. Withholding is
 * recoverable on the next run; sending is not. The caller is told how many it could not resolve so a
 * silent zero-delivery day is distinguishable from a quiet one.
 *
 * @returns {Promise<{ access: Map<string, {tier: string, beta: boolean}>, unresolved: number }>}
 */
export async function resolveAccessByIds(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const access = new Map();
  if (!ids.length) return { access, unresolved: 0 };
  let unresolved = 0;
  const client = await clerkClient().catch(() => null);
  if (!client) return { access, unresolved: ids.length };
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const res = await client.users.getUserList({ userId: chunk, limit: chunk.length });
      // Clerk v5 returns { data, totalCount }; older shapes returned a bare array.
      const users = Array.isArray(res) ? res : (res?.data || []);
      for (const u of users) if (u?.id) access.set(u.id, accessFromClerkUser(u));
      // An id the list did not return — deleted account, or simply absent — stays unresolved rather
      // than defaulting to anything.
      unresolved += chunk.filter((id) => !access.has(id)).length;
    } catch {
      unresolved += chunk.length;
    }
  }
  return { access, unresolved };
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
  return (await callerRealtimeAccess()).realtime;
}

/**
 * The same answer, WITH the tier that produced it — one Clerk round trip, not two.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. Almost every caller needs only the boolean, and callerHasRealtime is the
 * right shape for them. /api/chart-intraday needs BOTH: the tier decides whether intraday is served at
 * all (a Pro feature, and a 403 naming the allowed intervals when it is not), while the licence decides
 * whether the bars arrive untruncated and may be called real-time. Asking twice meant two
 * clerkClient().users.getUser() calls on a route that runs on every chart load, and writing the rule a
 * second time inside the route is exactly the drift this module exists to prevent.
 *
 * So the rule lives here once and both shapes read it: callerHasRealtime is now a projection of this.
 *
 * @returns {Promise<{ tier: 'free'|'pro'|'elite', beta: boolean, realtime: boolean }>}
 */
export async function callerRealtimeAccess() {
  try {
    const { tier, beta } = await resolveUserAccess();
    if (!isRealtimeRule(tier) || beta) return { tier, beta, realtime: false };
    // ⚠️ THE LICENSING STOP ORDER IS PART OF THE ANSWER, AND THAT WAS THE GAP.
    //
    // market:tiingo:realtime_stop was consulted in exactly ONE place — getQuotes() in market/tiingo.mjs
    // — which is enough to stop a live PRICE reaching a page. It was not enough to stop the CLAIM: every
    // caller that asked "is this reader entitled to real-time?" answered yes from tier alone, and that
    // flag is what selects the freshness label, the capability descriptor served to the client, and in
    // board-payload whether the realtime snapshot path is read at all.
    //
    // So with the switch thrown, a Pro subscriber received previous-close prices described as real-time.
    // Licensing had been withdrawn for the data and left standing for the assertion about the data,
    // which is the half a reader actually acts on.
    //
    // Resolved here because this is the single answer to that question — see the SEVEN call sites that
    // used to inline `isRealtime(tier) && !beta` and now call this instead. The KV read is cached for
    // 30s inside tiingoRealtimeStopped, and it fails CLOSED: an unreadable stop key reads as stopped.
    //
    // ⚠️ THE SEVENTH WAS FOUND BY THE FINAL VERIFICATION PASS, NOT BY THE CONSOLIDATION. Six routes were
    // enumerated and fixed; /api/chart-intraday was not among them, and it is the one where `entitled`
    // chooses between the untruncated tail of today's bars and a delay-truncated set. It surfaced only
    // because an assertion in verify-delayed-market-data still pointed at the inlined form there.
    return { tier, beta, realtime: !(await tiingoRealtimeStopped()) };
  } catch {
    // ⚠️ NEVER GRANT A LICENSED ENTITLEMENT ON AN ERROR PATH, and do not invent a tier either: an
    // unresolvable caller is Free, which is the safe direction for both decisions.
    return { tier: 'free', beta: false, realtime: false };
  }
}
