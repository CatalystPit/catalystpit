import { auth } from '@clerk/nextjs/server';
import { placementOffers, PLACEMENT_IDS, AFFILIATE_DISCLOSURE } from '../../../../lib/affiliates/partners.mjs';
import { resolveUserTier } from '../../../../lib/entitlements';
import { AFFILIATE_TIER_POLICY, affiliatePlacementsVisibleToTier } from '../../../../lib/affiliates/tier-policy.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WHAT MAY RENDER IN A PLACEMENT, decided on the server.
//
// ⚠️ THE RESPONSE CARRIES NO DESTINATION. Keys, labels and a call to action — nothing the browser could
// turn into an outbound URL. The link the client builds is /go/<key>?placement=<id>, and the affiliate id
// stays on this side. That is the whole reason this endpoint exists rather than the component reading
// NEXT_PUBLIC_AFF_* as it did before.
//
// ⚠️ THE TIER DECISION MOVED HERE TOO, and that fixed a real defect rather than tidying one. The strip
// used to render immediately and then hide itself once a separate /api/me/plan call came back, so a Pro
// subscriber saw a flash of affiliate content on every ticker page. Deciding before anything is sent
// means there is nothing to flash.
//
// NOTHING ABOUT ENTITLEMENT TO DATA IS TOUCHED. This answers "may a monetized link appear", which is a
// presentation question. resolveUserTier is read, not written, and no gate anywhere else consults this.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request) {
  const requested = new URL(request.url).searchParams.get('placement');
  if (!PLACEMENT_IDS.includes(requested)) {
    // An unknown placement is answered as "nothing here", not as an error. A caller asking for a surface
    // we do not have is a caller that should render nothing, and a 400 would invite retries.
    return Response.json({ show: false, offers: [], reason: 'unknown placement' }, { headers: NO_STORE });
  }

  // A signed-out visitor has no tier to resolve, and resolving one would mean a Clerk round trip on a
  // page that does not need it.
  let tier = null;
  try {
    const { userId } = await auth();
    tier = userId ? await resolveUserTier() : null;
  } catch { tier = null; }   // fail towards the anonymous case, which is the more conservative one

  if (!affiliatePlacementsVisibleToTier(tier)) {
    return Response.json({ show: false, offers: [], reason: 'tier policy' }, { headers: NO_STORE });
  }

  const offers = placementOffers(requested);
  return Response.json({
    show: offers.length > 0,
    offers,
    // The disclosure travels with the offers so the component cannot render one without the other.
    disclosure: AFFILIATE_DISCLOSURE,
    policy: AFFILIATE_TIER_POLICY.hideFromPaidTiers ? 'hidden-from-paid' : 'shown-to-all',
  }, { headers: NO_STORE });
}
