/**
 * THE ADSENSE IDENTITY AND THE ENTITLEMENT GATE IN FRONT OF IT.
 *
 * ⚠️ THE ID IS PUBLIC. A publisher id appears in the markup of every AdSense site by design; it is an
 * account identifier, not a secret, and there is nothing here to keep server-side.
 *
 * ⚠️ THE GATE LIVES HERE, NOT INSIDE THE COMPONENT'S EFFECT, SO IT CAN BE EXECUTED. A guard that is
 * only ever read — by me, or by a suite matching its source text — is a guard nobody has run. This is
 * the promise the Terms sell ("Pro subscribers will not be shown advertising"), so every branch of it is
 * exercised against a stub document in verify-pro-adfree: Pro, Elite, Free, signed out, still hydrating,
 * endpoint 500, endpoint offline, endpoint hanging, endpoint returning junk. Text assertions cannot tell
 * you that a `!isLoaded` guard actually stops an element being created; running it can.
 */
export const ADSENSE_CLIENT = 'ca-pub-8341744464373905';

export const ADSENSE_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;

/**
 * ⚠️ DEDUPE BY src, NOT BY A CUSTOM ATTRIBUTE ON THE ADSENSE TAG.
 *
 * The first version marked our tag with `data-cp-adsense="1"` so a second mount could recognise it.
 * AdSense objected, in the live console on production:
 *
 *     AdSense head tag doesn't support data-cp-adsense attribute.
 *
 * The loader validates the attributes on its own script element and warns about ones it does not
 * recognise. It is the only site-side complaint Google makes about this integration, and it was
 * self-inflicted — so the marker is gone. The src is already unique and already ours to match on,
 * which makes the dedupe both standard and one fewer thing for the loader to object to.
 */
export const ADS_LOADER_SELECTOR = `script[src="${ADSENSE_SRC}"]`;

/**
 * ⚠️ PAGES WHERE ADVERTISING IS NOT APPROPRIATE, AND THE CHECK IS A PREFIX MATCH ON PURPOSE.
 *
 * Account management, authentication and anything that could become a payment flow. Two separate
 * reasons, and both matter:
 *
 *   Policy — Google's own guidance is against advertising on pages whose purpose is a transaction or
 *   a credential entry, and an ad beside a password field is the kind of thing that reads as
 *   deceptive placement whatever the intent.
 *
 *   Ours — these pages are where a member manages the subscription that removes advertising. Showing
 *   them an ad while they are on the cancel screen is the worst possible moment for it.
 *
 * A PREFIX match, because `/account` has sub-routes and a denylist that only matched exact paths
 * would quietly fail on `/account/billing` — the single most important page in the list.
 */
export const AD_EXCLUDED_PREFIXES = Object.freeze([
  '/account', '/sign-in', '/sign-up', '/checkout', '/billing', '/api',
]);

/** Is advertising allowed on this path at all, before entitlement is even considered? */
export function adsAllowedOnPath(pathname) {
  if (typeof pathname !== 'string' || !pathname) return false;
  const p = pathname.toLowerCase();
  return !AD_EXCLUDED_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`));
}

/**
 * ⚠️ AD UNIT IDS COME FROM THE ADSENSE DASHBOARD, AND THERE IS NO WAY TO INVENT ONE.
 *
 * A manual display unit needs a `data-ad-slot` that exists in the account. A made-up number does not
 * fail loudly — it renders an empty `ins` that never fills, which is indistinguishable from the
 * problem we are already trying to diagnose, and an empty unit is itself a policy smell.
 *
 * So each placement is configured, and a placement with no id RENDERS NOTHING. The layout is
 * therefore correct in both states: today, with no ids set, the markup is absent entirely; the moment
 * real ids are added to the environment, the same components start serving with no code change.
 *
 * Auto ads need no id and are unaffected by any of this — they are enabled per site in the dashboard
 * and placed by Google.
 */
export const AD_SLOT_IDS = Object.freeze({
  top: process.env.NEXT_PUBLIC_ADSENSE_SLOT_TOP || '',
  bottom: process.env.NEXT_PUBLIC_ADSENSE_SLOT_BOTTOM || '',
  inContent: process.env.NEXT_PUBLIC_ADSENSE_SLOT_IN_CONTENT || '',
  inFeed: process.env.NEXT_PUBLIC_ADSENSE_SLOT_IN_FEED || '',
  sidebar: process.env.NEXT_PUBLIC_ADSENSE_SLOT_SIDEBAR || '',
});

/** The configured unit id for a placement, or '' when the owner has not created that unit yet. */
export function adSlotId(placement) {
  const v = AD_SLOT_IDS[placement];
  return typeof v === 'string' ? v.trim() : '';
}

/** How long to wait for the plan endpoint before giving up on advertising for this page view. */
export const ADS_PLAN_TIMEOUT_MS = 8000;

/**
 * IS THIS RESOLVED TIER ELIGIBLE TO BE SHOWN ADVERTISING?
 *
 * ⚠️ THE ALLOW-LIST IS EXPLICIT, AND THAT IS THE WHOLE POINT. Written as `tier !== 'pro'` a new paid
 * tier would default to being shown ads — the failure would be silent, in the direction that breaks a
 * promise we sell, and nobody would look for it. Only a tier named here is eligible, so an unknown
 * value, a null, a typo or a tier added next quarter all resolve to "no advertising".
 */
export function adsEligibleTier(tier) {
  return tier === 'free';
}

/** Create the loader tag. Idempotent — two loaders on one document is an AdSense policy problem. */
export function injectAdsLoader(doc) {
  if (doc.querySelector(ADS_LOADER_SELECTOR)) return false;
  const s = doc.createElement('script');
  s.async = true;
  s.src = ADSENSE_SRC;
  s.crossOrigin = 'anonymous';
  doc.head.appendChild(s);
  return true;
}

/**
 * DECIDE WHETHER THIS VISITOR MAY BE SHOWN ADVERTISING, AND IF SO, LOAD IT.
 *
 * ── ⚠️ UNKNOWN MEANS NO ──────────────────────────────────────────────────────────────────────────
 *
 * Every path that is not an explicit, server-confirmed "free" ends in no advertising:
 *
 *   still hydrating (!isLoaded)          → 'wait'. This is the race the whole gate exists for: load
 *                                          first and discover Pro second is exactly what must not
 *                                          happen, and the only way to guarantee it is to treat "not
 *                                          yet known" as "not eligible".
 *   signed out                           → 'allow'. No entitlement to protect, and it is the majority
 *                                          case, so it costs no request at all.
 *   signed in, tier resolves 'free'      → 'allow'.
 *   signed in, tier resolves pro/elite   → 'deny'.
 *   signed in, lookup fails/times out/   → 'deny'. A Clerk hiccup must not be the reason a paying
 *     returns junk                         subscriber gets an advertisement.
 *
 * Nothing is loaded and then unloaded. For a Pro user no script element is ever constructed, so no
 * request is made and no cookie is set. Removing a tag afterwards would not be equivalent — by then the
 * script has executed.
 *
 * ── ⚠️ THERE IS DELIBERATELY NO CACHE, AND THAT IS A REVERSAL ────────────────────────────────────
 *
 * The first version remembered "this user is Pro" in sessionStorage to save the request. Mutation
 * testing killed it: with the deny cached, the fast path returned before ever asking again, so the
 * clear-on-free branch was unreachable and a PRO → FREE downgrade could not become eligible again for
 * the rest of the browser session. The clearing code existed, read correctly, and was dead.
 *
 * The cache was buying one 230ms request per page load, for signed-in users only, off the critical path
 * — against a staleness bug in entitlement state and a pile of per-user-key and storage-throws-in-
 * private-mode edge cases. So it is gone. Every page load asks, both transition directions take effect
 * immediately, and there is no client-side entitlement state to go stale or be tampered with.
 *
 * ── ⚠️ THE TIER COMES FROM THE SERVER ────────────────────────────────────────────────────────────
 *
 * publicMetadata.plan is readable in the browser and therefore editable in devtools. This asks
 * /api/me/plan, which resolves through resolveUserAccess() — the same call every gated route uses — so
 * there is ONE Pro detection system and this is a reader of it, not a second implementation.
 *
 * @returns {{ decision: Promise<'wait'|'allow'|'deny'>, cancel: () => void }}
 */
export function runAdsGate({
  isLoaded, isSignedIn, doc, fetchImpl, timeoutMs = ADS_PLAN_TIMEOUT_MS,
}) {
  const noop = () => {};
  if (!isLoaded) return { decision: Promise.resolve('wait'), cancel: noop };

  if (!isSignedIn) {
    injectAdsLoader(doc);
    return { decision: Promise.resolve('allow'), cancel: noop };
  }

  let alive = true;
  const ac = new AbortController();
  // ⚠️ A CEILING, SO A HANGING REQUEST FAILS CLOSED RATHER THAN HANGING OPEN. Without it a stalled plan
  // lookup leaves the decision pending forever — safe for Pro, but a Free user would then silently never
  // see advertising with no signal that anything was wrong.
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const cancel = () => { alive = false; clearTimeout(timer); ac.abort(); };

  const decision = Promise.resolve()
    .then(() => fetchImpl('/api/me/plan', { cache: 'no-store', signal: ac.signal }))
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => {
      // ⚠️ A CANCELLED RUN DENIES. The component unmounted or the identity changed under us; injecting
      // on the way out would attach advertising to a page whose entitlement we no longer know.
      if (!alive) return 'deny';
      if (!adsEligibleTier(j && j.tier)) return 'deny';
      injectAdsLoader(doc);
      return 'allow';
    })
    .catch(() => 'deny')   // aborted, offline, 5xx, malformed JSON → no advertising this page view
    .finally(() => clearTimeout(timer));

  return { decision, cancel };
}
