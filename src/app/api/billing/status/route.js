import { PRICE_BY_INTERVAL } from '../../stripe/checkout/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// IS THE AD-FREE MEMBERSHIP ACTUALLY BUYABLE RIGHT NOW?
//
// ⚠️ WHY THIS ENDPOINT EXISTS AT ALL. Checkout already fails closed — no price id means a 503
// `not_configured` — but a button that looks live and errors on click is still a published purchase
// offer the Service cannot honour. The release gate is explicit that the $9.99 buttons must be
// disabled or marked unavailable until Stripe is configured, and the client cannot know that on its
// own: the price id is server-side, and it SHOULD stay server-side.
//
// ⚠️ IT RETURNS A BOOLEAN AND NOTHING ELSE. Not the price id, not the key, not the account — the one
// bit the UI needs. `!!` is load-bearing here: returning the value would publish a Stripe identifier
// to every visitor in exchange for information the UI cannot use.
//
// ⚠️ PUBLICLY CACHEABLE, DELIBERATELY, which is the one thing that makes this safe for the critical
// path. The answer is identical for every visitor — it is a property of the deployment, not of the
// reader — so it carries no session, consults no entitlement and never varies by user. That keeps the
// performance rule intact: nothing here turns a public page into a per-user render.
export async function GET() {
  const configured = !!PRICE_BY_INTERVAL.monthly;
  return Response.json(
    { adFreeAvailable: configured },
    {
      headers: {
        // Short enough that enabling Stripe shows up quickly, long enough that this is not a
        // per-pageview round trip.
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
      },
    },
  );
}
