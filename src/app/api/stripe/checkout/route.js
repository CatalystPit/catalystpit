import { auth, clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';

// C5 — start a Stripe subscription checkout (Pro). Stripe REST (no SDK). Gated on
// STRIPE_SECRET_KEY + STRIPE_PRICE_ID → 503 until set. The Clerk userId rides on
// client_reference_id so the webhook can stamp the plan back onto the right user.
const SECRET        = process.env.STRIPE_SECRET_KEY;
const PRICE         = process.env.STRIPE_PRICE_ID;          // monthly
const PRICE_ANNUAL  = process.env.STRIPE_PRICE_ID_ANNUAL;   // yearly (optional)
const SITE          = process.env.NEXT_PUBLIC_SITE_URL || 'https://catalystpit.com';

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let interval = 'monthly';
  try { const b = await request.json(); if (b?.interval === 'annual') interval = 'annual'; } catch { /* no body → monthly */ }
  const PRICE_ID = (interval === 'annual' && PRICE_ANNUAL) ? PRICE_ANNUAL : PRICE;
  if (!SECRET || !PRICE_ID) return Response.json({ error: 'not_configured' }, { status: 503 });

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
      console.log(`[stripe_checkout] ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return Response.json({ error: 'checkout_failed' }, { status: 502 });
    }
    return Response.json({ url: j.url });
  } catch (e) {
    console.log(`[stripe_checkout] ${e.message}`);
    return Response.json({ error: 'checkout_failed' }, { status: 502 });
  }
}
