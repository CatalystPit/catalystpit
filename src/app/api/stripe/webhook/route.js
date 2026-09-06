import crypto from 'node:crypto';
import { clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';

// C5 — Stripe webhook. Verifies the signature against STRIPE_WEBHOOK_SECRET (no SDK), then
// stamps Clerk publicMetadata.plan so resolveUserTier reflects the subscription. Idempotent:
// re-delivered events just re-set the same plan. Returns 200 even on handler hiccups (logged)
// so Stripe doesn't hammer retries; 400 only for a bad/missing signature.
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SECRET = process.env.STRIPE_SECRET_KEY;

function verify(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch { return false; }
}

async function setPlan(userId, plan, customerId) {
  if (!userId) return;
  const meta = { publicMetadata: { plan } };                 // plan is client-readable
  if (customerId) meta.privateMetadata = { stripeCustomerId: customerId };  // server-only, for the billing portal
  try { const c = await clerkClient(); await c.users.updateUser(userId, meta); }
  catch (e) { console.log(`[stripe_webhook] setPlan ${userId}=${plan} failed: ${e.message}`); }
}

// Later subscription events carry a customer id but no client_reference_id → resolve the
// userId we stamped onto the customer's metadata at checkout.
async function userIdFromCustomer(customerId) {
  if (!customerId || !SECRET) return null;
  try {
    const r = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    const j = await r.json().catch(() => ({}));
    return j?.metadata?.userId || null;
  } catch { return null; }
}

export async function POST(request) {
  if (!WEBHOOK_SECRET) return Response.json({ error: 'not_configured' }, { status: 503 });
  const payload = await request.text();           // RAW body — required for signature verification
  if (!verify(payload, request.headers.get('stripe-signature'), WEBHOOK_SECRET))
    return Response.json({ error: 'bad signature' }, { status: 400 });

  let event;
  try { event = JSON.parse(payload); } catch { return Response.json({ error: 'bad payload' }, { status: 400 }); }

  try {
    const obj = event.data?.object || {};
    if (event.type === 'checkout.session.completed') {
      const userId = obj.client_reference_id || await userIdFromCustomer(obj.customer);
      if (obj.customer && userId && SECRET) {       // stamp userId on the customer for future events
        await fetch(`https://api.stripe.com/v1/customers/${obj.customer}`, {
          method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ 'metadata[userId]': userId }).toString(),
        }).catch(() => {});
      }
      await setPlan(userId, 'pro', obj.customer);
    } else if (event.type === 'customer.subscription.deleted') {
      await setPlan(await userIdFromCustomer(obj.customer), 'free');
    } else if (event.type === 'customer.subscription.updated') {
      const active = obj.status === 'active' || obj.status === 'trialing';
      await setPlan(await userIdFromCustomer(obj.customer), active ? 'pro' : 'free');
    }
  } catch (e) {
    console.log(`[stripe_webhook] handler error: ${e.message}`);
  }
  return Response.json({ received: true });
}
