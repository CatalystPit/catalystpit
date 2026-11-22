// ⚠️ ONE ENTITLEMENT ANSWER, SHARED BY EVERY AD SLOT ON THE PAGE.
//
// ZERO IMPORTS DELIBERATELY, so this can be read by a server component, a client component, or a
// test with no React and no app bootstrap.
//
// ── WHY A STORE AND NOT REACT CONTEXT ────────────────────────────────────────────────────────────
//
// The gate already runs in <AdSenseLoader/>, which sits at the END of <body> for a good reason: it
// must never be in the critical path, and resolving entitlement in the root layout would opt all 141
// static pages into dynamic rendering and put a Clerk round-trip in front of first byte.
//
// A provider cannot live at the end of the body and still wrap the content above it. Context would
// mean hoisting the gate up the tree and giving back the property that made it cheap. So the
// decision is published to a tiny external store instead, and slots subscribe. Mount order stops
// mattering: a slot that renders before the decision lands shows nothing and re-renders when it
// arrives.
//
// ── ⚠️ null IS NOT false, AND BOTH RENDER NOTHING ────────────────────────────────────────────────
//
// `null` means "not resolved yet" and `false` means "resolved: not eligible". Slots treat both as no
// advertising, which is the fail-closed direction — the cost of being wrong that way is an ad we
// could have shown, and the cost of being wrong the other way is an advertisement on a page belonging
// to someone who pays us $9.99 a month not to see one. They are not comparable.
//
// The distinction is kept rather than collapsed because an identity change must be able to reset the
// answer to "unknown" and have slots immediately stop rendering, instead of holding the previous
// visitor's verdict until a new one arrives.

/** @type {boolean|null} */
let eligible = null;
const subscribers = new Set();

/** Current decision: true (show), false (do not), null (not yet known — also do not). */
export function getAdsEligible() {
  return eligible;
}

/**
 * Publish the gate's decision. Pass null to return to "unknown", which is what an identity change
 * does: the previous answer must stop applying the moment we stop being sure it is this visitor's.
 */
export function setAdsEligible(value) {
  const next = value === null ? null : value === true;
  if (next === eligible) return;
  eligible = next;
  for (const fn of subscribers) {
    // ⚠️ ONE BAD SUBSCRIBER MUST NOT STOP THE OTHERS. A slot that throws while re-rendering would
    // otherwise leave every later slot stuck on the previous answer — and "stuck on the previous
    // answer" in this system can mean an ad on a paying member's page.
    try { fn(); } catch { /* a slot's own failure is not this store's business */ }
  }
}

/** Subscribe to decision changes. Returns an unsubscribe function. */
export function subscribeAdsEligible(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * ⚠️ THE SERVER SNAPSHOT IS ALWAYS null, WHICH MEANS NO AD MARKUP IS EVER SERVER-RENDERED.
 *
 * Entitlement is not knowable during static generation — that is the whole reason the gate is a
 * client concern. If this returned anything else, prerendered HTML would carry ad markup that a Pro
 * subscriber then receives from the CDN before any JavaScript has had the chance to decide.
 */
export function getAdsEligibleServerSnapshot() {
  return null;
}
