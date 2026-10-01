// WHICH TIERS SEE A MONETIZED LINK. One switch, in one file, because it is an OWNER DECISION that has
// not actually been made yet.
//
// ⚠️ WHAT THE POLICIES ACTUALLY SAY TODAY. Terms section 10 promises that "Pro subscribers will not be
// shown advertising for as long as their subscription is active", and it says so about third-party
// ADVERTISING — the AdSense relationship it spends the rest of the section describing. Section 11 treats
// affiliate links as a separate matter entirely and promises nothing about who sees them.
//
// So the written policy does not answer this question. The previous implementation hid the strip from
// Pro and Elite and called it an "ad-light perk" in a code comment, which is a choice someone made in
// passing rather than a commitment the product ever published.
//
// ⚠️ THEREFORE THIS PRESERVES TODAY'S BEHAVIOUR AND NAMES IT A DECISION. Changing it would silently take
// something away from paying subscribers on the strength of a comment; inventing a promise in the Terms
// would be worse. The default below is what the site already does. It is one boolean because it should
// be one line to change once the owner has decided, and because a decision this visible should not be
// spread across components.
export const AFFILIATE_TIER_POLICY = Object.freeze({
  // true  → logged-out and Free see monetized links; Pro and Elite do not. (Current behaviour.)
  // false → every tier sees them.
  hideFromPaidTiers: true,
});

/** The paid tiers, named here rather than matched loosely, so a new tier is a deliberate edit. */
const PAID_TIERS = new Set(['pro', 'elite']);

/**
 * May a monetized link be shown to this tier?
 *
 * `tier` is null for a signed-out visitor and a string for a signed-in one. An unrecognised value is
 * treated as unpaid, which is the same thing the AdSense gate does and is the conservative reading for a
 * question about whether to SHOW something: an unknown tier is not evidence of a subscription.
 */
export function affiliatePlacementsVisibleToTier(tier) {
  if (!AFFILIATE_TIER_POLICY.hideFromPaidTiers) return true;
  return !PAID_TIERS.has(String(tier || '').toLowerCase());
}
