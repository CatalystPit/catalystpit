import { auth, clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';

// Stripe Customer Portal — lets a Pro user manage/cancel their subscription. Reads the
// stripeCustomerId stashed in Clerk privateMetadata by the webhook at checkout. Requires the
// Customer Portal to be activated in the Stripe dashboard (Settings → Billing → Customer portal).
const SECRET = process.env.STRIPE_SECRET_KEY;
const SITE   = process.env.NEXT_PUBLIC_SITE_URL || 'https://catalystpit.com';

export async function POST() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!SECRET) return Response.json({ error: 'not_configured' }, { status: 503 });

  let customerId = null;
  try {
    const c = await clerkClient();
    const u = await c.users.getUser(userId);
    customerId = u.privateMetadata?.stripeCustomerId || null;
  } catch { /* fall through to no_subscription */ }
  if (!customerId) return Response.json({ error: 'no_subscription' }, { status: 400 });

  try {
    const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customer: customerId, return_url: `${SITE}/account` }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) {
      console.log(`[stripe_portal] ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return Response.json({ error: 'portal_failed' }, { status: 502 });
    }
    return Response.json({ url: j.url });
  } catch (e) {
    console.log(`[stripe_portal] ${e.message}`);
    return Response.json({ error: 'portal_failed' }, { status: 502 });
  }
}
