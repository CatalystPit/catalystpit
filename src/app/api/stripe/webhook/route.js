import { clerkClient } from '@clerk/nextjs/server';
import { verifySignature, planFromSubscriptions, PRO_STATUSES, SIGNATURE_TOLERANCE_SEC } from '../../../../lib/billing/plan.mjs';
import { recordBillingEvent } from '../../../../lib/billing/events';
import { recordJobRun } from '../../../../lib/job-heartbeat';

export { PRO_STATUSES, SIGNATURE_TOLERANCE_SEC };

export const runtime = 'nodejs';

// C5 — Stripe webhook. Verifies the signature against STRIPE_WEBHOOK_SECRET (no SDK), then stamps
// Clerk publicMetadata.plan so resolveUserTier reflects the subscription.
//
// ── ⚠️ THE EVENT TELLS US WHEN TO LOOK, NOT WHAT IS TRUE ────────────────────
//
// This used to read the status off the event body and write it straight to Clerk. That is correct
// only while events arrive in order, and they do not: Stripe retries with backoff, so a
// `customer.subscription.updated` carrying status `active` can land AFTER the
// `customer.subscription.deleted` that ended the very same subscription — and the late event would
// hand Pro back to someone who had already cancelled.
//
// So the event is now only a trigger. Entitlement is recomputed from an authoritative re-fetch of
// the customer's CURRENT subscriptions, which makes ordering irrelevant by construction:
//
//   * an old event replayed late reads the same live state as a new one — nothing to reorder
//   * a duplicate delivery recomputes the identical answer — idempotent for free
//   * a customer who cancels and later subscribes AGAIN comes back as Pro, because the new
//     subscription is live when we look. Timestamp bookkeeping alone would have had to be careful
//     not to strand them on Free forever; re-fetching cannot make that mistake.
//
// ⚠️ AND IT FAILS CLOSED-BUT-RETRYABLE. If the re-fetch fails we return 503 WITHOUT writing, so
// Stripe retries. Writing a guessed entitlement because one HTTP call failed is how a paying
// customer loses access at 3am.
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SECRET = process.env.STRIPE_SECRET_KEY;

/** Every subscription Stripe currently holds for this customer, any status. */
async function fetchSubscriptions(customerId) {
  const url = `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${SECRET}` } });
  if (!r.ok) throw new Error(`subscriptions ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j?.data)) throw new Error('subscriptions malformed');
  return j.data;
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

// ⚠️ OBSERVATION IS NOT HANDLING, AND MUST NOT BEHAVE LIKE IT. Both writes below swallow their own
// errors, because by the time either runs the plan has already been stamped on the Clerk user. A
// monitoring failure that turned a processed payment into a non-2xx would put Stripe into a retry
// loop over a logging problem — the exact inversion this file's refetch handling exists to avoid.
//
// The heartbeat records LIVENESS: "an event arrived and we processed it". The event row records WHAT.
// They are separate because a webhook that is up and dropping every event is a different incident
// from one that is not being called at all, and only the pair can tell them apart.
async function observed(event, { userId = null, plan = null, note = null } = {}) {
  await recordBillingEvent(event, { userId, plan });
  try { await recordJobRun('stripe-webhook', { ok: true, seen: 1, note: note || event?.type || 'event' }); }
  catch { /* bookkeeping only */ }
}

/** A processing failure, recorded so the outage is visible without reading function logs. */
async function observedFailure(note) {
  try { await recordJobRun('stripe-webhook', { ok: false, seen: 0, note: String(note).slice(0, 180) }); }
  catch { /* bookkeeping only */ }
}

export async function POST(request) {
  if (!WEBHOOK_SECRET) return Response.json({ error: 'not_configured' }, { status: 503 });
  const payload = await request.text();           // RAW body — required for signature verification
  if (!verifySignature(payload, request.headers.get('stripe-signature'), WEBHOOK_SECRET))
    return Response.json({ error: 'bad signature' }, { status: 400 });

  let event;
  try { event = JSON.parse(payload); } catch { return Response.json({ error: 'bad payload' }, { status: 400 }); }

  const obj = event.data?.object || {};
  const SUBSCRIPTION_EVENTS = ['customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.created'];

  try {
    if (event.type === 'checkout.session.completed') {
      const userId = obj.client_reference_id || await userIdFromCustomer(obj.customer);
      if (obj.customer && userId && SECRET) {       // stamp userId on the customer for future events
        await fetch(`https://api.stripe.com/v1/customers/${obj.customer}`, {
          method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ 'metadata[userId]': userId }).toString(),
        }).catch(() => {});
      }
      // ⚠️ A COMPLETED CHECKOUT IS STILL RECONCILED AGAINST LIVE STATE where we can, so a session
      // that completed into an incomplete/failed subscription does not mint Pro on its own.
      let plan = 'pro';
      if (obj.customer && SECRET) {
        try { plan = planFromSubscriptions(await fetchSubscriptions(obj.customer)); }
        catch (e) {
          console.log(`[stripe_webhook] checkout refetch failed (${e.message}) — retry requested`);
          await observedFailure(`checkout refetch failed: ${e.message}`);
          return Response.json({ error: 'refetch_failed' }, { status: 503 });
        }
      }
      await setPlan(userId, plan, obj.customer);
      // ⚠️ RECORDED AFTER THE PLAN IS STAMPED, so a row here means the entitlement was actually
      // granted — not merely that Stripe told us to grant it.
      await observed(event, { userId, plan });
      return Response.json({ received: true, plan });
    }

    if (SUBSCRIPTION_EVENTS.includes(event.type)) {
      const customerId = obj.customer;
      // ⚠️ A SKIP IS STILL AN OUTCOME, so it is recorded. A run of no_user events is how an unstamped
      // customer shows up — invisible if only the successes were logged.
      if (!customerId || !SECRET) {
        await observed(event, { note: `${event.type} skipped:no_customer` });
        return Response.json({ received: true, skipped: 'no_customer' });
      }
      const userId = await userIdFromCustomer(customerId);
      if (!userId) {
        await observed(event, { note: `${event.type} skipped:no_user` });
        return Response.json({ received: true, skipped: 'no_user' });
      }

      let plan;
      try { plan = planFromSubscriptions(await fetchSubscriptions(customerId)); }
      catch (e) {
        // ⚠️ NO WRITE ON A FAILED READ. 503 tells Stripe to retry rather than leaving us to guess.
        console.log(`[stripe_webhook] ${event.type} refetch failed (${e.message}) — retry requested`);
        await observedFailure(`${event.type} refetch failed: ${e.message}`);
        return Response.json({ error: 'refetch_failed' }, { status: 503 });
      }
      await setPlan(userId, plan);
      await observed(event, { userId, plan });
      return Response.json({ received: true, plan });
    }
  } catch (e) {
    console.log(`[stripe_webhook] handler error: ${e.message}`);
    await observedFailure(`handler error: ${e.message}`);
  }
  // ⚠️ EVENT TYPES WE DO NOT ACT ON ARE STILL RECORDED. invoice.payment_failed and the rest change
  // no entitlement here — the subscription events already reconcile that — but they are exactly the
  // signals worth counting, and recording them means enabling one in the Stripe dashboard is the
  // only step needed to start seeing it.
  await observed(event, { note: `${event?.type} unhandled` });
  return Response.json({ received: true });
}
