import { auth, clerkClient } from '@clerk/nextjs/server';
import { priceFor, normalizeInterval } from '../../../../lib/billing/plan.mjs';

export const runtime = 'nodejs';

// C5 — start a Stripe subscription checkout (Pro). Stripe REST (no SDK). The Clerk userId rides on
// client_reference_id so the webhook can stamp the plan back onto the right user.
//
// ── ⚠️ ONE INTERVAL, ONE PRICE, AND NEVER A SUBSTITUTION ────────────────────
//
// This used to read:
//
//     const PRICE_ID = (interval === 'annual' && PRICE_ANNUAL) ? PRICE_ANNUAL : PRICE;
//
// which quietly sold the MONTHLY plan to anyone who asked for annual while STRIPE_PRICE_ID_ANNUAL
// was unset. A customer clicking "$199/year" would have been charged $20/month, seen a monthly
// Checkout, and had no way to tell from our side that anything had gone wrong. A missing price is a
// configuration failure and has to be reported as one — substituting the other billing interval's
// price is worse than not selling at all, because the customer has already decided what they want.
//
// The rule is now absolute: each interval resolves to its OWN price or the request fails. There is
// no path through this file where an annual request produces a monthly session, or the reverse.
const SECRET = process.env.STRIPE_SECRET_KEY;
const SITE   = process.env.NEXT_PUBLIC_SITE_URL || 'https://catalystpit.com';

/** Each interval bound to its own price. The no-substitution rule lives in lib/billing/plan.mjs. */
export const PRICE_BY_INTERVAL = Object.freeze({
  monthly: process.env.STRIPE_PRICE_ID,
  annual: process.env.STRIPE_PRICE_ID_ANNUAL,
});

/** Bound to the live env mapping; the rule itself is asserted directly in the suite. */
const resolvePrice = (interval) => priceFor(interval, PRICE_BY_INTERVAL);

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body = null;
  try { body = await request.json(); } catch { /* no body → monthly */ }
  const { interval, ok } = normalizeInterval(body?.interval);
  if (!ok) return Response.json({ error: 'bad_interval' }, { status: 400 });

  const PRICE_ID = resolvePrice(interval);
  // ⚠️ THE INTERVAL IS ECHOED so a 503 says WHICH plan is unsellable rather than "billing is off".
  if (!SECRET || !PRICE_ID) return Response.json({ error: 'not_configured', interval }, { status: 503 });

  let email = null;
  try {
    const c = await clerkClient();
    const u = await c.users.getUser(userId);
    email = u.emailAddresses.find(e => e.id === u.primaryEmailAddressId)?.emailAddress || u.emailAddresses[0]?.emailAddress || null;
  } catch { /* email optional */ }

  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', PRICE_ID);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', `${SITE}/account?upgraded=1`);
  form.set('cancel_url', `${SITE}/?checkout=cancelled`);
  form.set('client_reference_id', userId);
  form.set('allow_promotion_codes', 'true');
  if (email) form.set('customer_email', email);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) {
      console.log(`[stripe_checkout] ${interval} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return Response.json({ error: 'checkout_failed' }, { status: 502 });
    }
    return Response.json({ url: j.url, interval });
  } catch (e) {
    console.log(`[stripe_checkout] ${interval} ${e.message}`);
    return Response.json({ error: 'checkout_failed' }, { status: 502 });
  }
}
