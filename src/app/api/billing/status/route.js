import { PRICE_BY_INTERVAL } from '../../stripe/checkout/route';
import { AD_FREE_PRICE_USD, AD_FREE_INTERVAL } from '../../../../lib/billing/ad-free.mjs';

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
// ⚠️ IT RETURNS A BOOLEAN AND NOTHING ELSE. Not the price id, not the key, not the account, not the
// amount Stripe reported — the one bit the UI needs. `!!` is load-bearing: returning the value would
// publish a Stripe identifier to every visitor in exchange for information the UI cannot use.
//
// ⚠️ PUBLICLY CACHEABLE, DELIBERATELY, which is the one thing that makes this safe for the critical
// path. The answer is identical for every visitor — it is a property of the deployment, not of the
// reader — so it carries no session, consults no entitlement and never varies by user.
//
// ── ⚠️ A CONFIGURED PRICE ID IS NOT A VERIFIED PRICE ─────────────────────────────────────────────
//
// This used to report `!!PRICE_BY_INTERVAL.monthly` — the button went live the moment the
// environment variable existed, whatever that price actually charged. The one outcome this product
// must never produce is a page that says $9.99 and a checkout that bills $20, and the old shape made
// that a one-typo mistake: paste the retired $20 price id into the new variable and the site
// cheerfully advertises $9.99 at $20.
//
// scripts/verify-stripe-price.mjs exists to catch exactly that, and it is a script someone has to
// remember to run. So the check moved to where it cannot be skipped: the button is offered only when
// STRIPE SAYS the configured price is 999 USD on a monthly recurring interval and is still active.
// Every other answer — wrong amount, wrong interval, wrong currency, archived price, unreachable
// Stripe, missing key — is NOT buyable.
//
// Fail-closed is the cheap direction here too. Refusing to sell for ten minutes costs a membership;
// charging the wrong amount costs a chargeback and a reason never to trust the price again.

// One upstream read per instance per window, shared by every visitor. The answer changes only when
// someone edits the price in Stripe, so this is deliberately slow.
const VERIFY_TTL_MS = 10 * 60_000;
let verified = { at: 0, ok: false, reason: 'not checked yet' };

async function priceIsCorrect() {
  const id = PRICE_BY_INTERVAL.monthly;
  if (!id) return { ok: false, reason: 'no price id configured' };
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { ok: false, reason: 'no stripe key' };

  const expectedCents = Math.round(AD_FREE_PRICE_USD * 100);
  try {
    const r = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { ok: false, reason: `stripe ${r.status}` };
    const p = await r.json();
    // ⚠️ EVERY FIELD THE PROMISE DEPENDS ON, compared in integer cents. A float comparison on money
    // is how 9.99 becomes 9.989999999999999 and a correct price reads as wrong.
    if (p.active !== true) return { ok: false, reason: 'price is archived' };
    if (p.unit_amount !== expectedCents) return { ok: false, reason: 'amount does not match' };
    if (String(p.currency).toLowerCase() !== 'usd') return { ok: false, reason: 'currency is not usd' };
    if (p.recurring?.interval !== 'month' || p.recurring?.interval_count !== 1) {
      return { ok: false, reason: 'not a monthly recurring price' };
    }
    if (AD_FREE_INTERVAL !== 'monthly') return { ok: false, reason: 'product interval changed' };
    return { ok: true, reason: 'verified against stripe' };
  } catch (e) {
    // Unreachable, timed out, or malformed → not buyable. A Stripe outage must not publish an
    // unverified offer.
    return { ok: false, reason: `unverified (${String(e?.name || 'error')})` };
  }
}

export async function GET() {
  const now = Date.now();
  if (now - verified.at >= VERIFY_TTL_MS) {
    const res = await priceIsCorrect();
    verified = { at: now, ok: res.ok, reason: res.reason };
  }
  return Response.json(
    { adFreeAvailable: verified.ok },
    {
      headers: {
        // Short enough that enabling Stripe shows up quickly, long enough that this is not a
        // per-pageview round trip.
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
      },
    },
  );
}
