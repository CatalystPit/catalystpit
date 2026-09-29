import { verifyClerkSignature, signupMethod } from '../../../../lib/monitoring/clerk-webhook.mjs';
import { recordSignupEvent } from '../../../../lib/monitoring/signup-events';
import { recordJobRun } from '../../../../lib/job-heartbeat';

export const runtime = 'nodejs';

// CLERK WEBHOOK — an OBSERVER of account creation, and nothing else.
//
// ⚠️ THIS ROUTE GRANTS NOTHING AND CHANGES NO AUTHENTICATION BEHAVIOUR. Clerk stays authoritative
// for identity: it creates the user, it owns the session, and sign-in works identically whether this
// endpoint is configured, misconfigured, or returning 500. Google OAuth in particular is untouched —
// the provider is READ from the payload to answer "how did they sign up", and no OAuth flow, token
// or linkage passes through here. If this file were deleted the product would behave the same and we
// would simply stop counting signups.
//
// ⚠️ IT STORES NO PERSONAL DATA. The user.created payload contains the email address, first and last
// name, avatar URL and more. We keep the opaque Clerk user id, the signup method ("google",
// "password"), and the timestamp. Everything else is discarded on arrival rather than stored and
// later cleaned up — the Privacy Policy says we do not collect what we do not need, and this is the
// route where that is easiest to get wrong.
//
// ⚠️ CONFIGURED OR NOT, IT MUST NOT LIE. Without the signing secret it returns 503 and records a
// FAILED heartbeat: a silent 200 would make an unconfigured endpoint indistinguishable from a
// working one with no signups, which is precisely the confusion the monitoring exists to remove.

const SIGNING_SECRET = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

/** Events worth counting. Anything else is acknowledged and ignored. */
const TRACKED = new Set(['user.created', 'user.deleted']);

const beat = async (ok, seen, note) => {
  try { await recordJobRun('clerk-webhook', { ok, seen: Number(seen) || 0, note: note ? String(note).slice(0, 180) : null }); }
  catch { /* bookkeeping only — never fail the webhook on its own telemetry */ }
};

export async function POST(request) {
  // ⚠️ THE RAW BODY, READ ONCE. Re-serialising parsed JSON changes key order and whitespace, so the
  // bytes signed and the bytes verified stop matching and every delivery fails.
  const payload = await request.text();

  // ⚠️ A MISSING SECRET IS A CONFIGURATION STATE, NOT A FAILED RUN — and recording it as one was a
  // real defect, caught by a single probe of the deployed endpoint. An unconfigured route cannot
  // verify anything, so it cannot tell Clerk from anyone else on the internet; writing ok:false here
  // meant one anonymous POST set consecutive_failures and pushed /api/health to `degraded`, which
  // handed the world a one-request denial of our own dashboard. Same reasoning as the bad-signature
  // branch below, which already refused to let unauthenticated traffic drive health state.
  //
  // Whether the secret is set is a fact about the SERVER, so it is reported from server config on the
  // owner-only metrics endpoint, and the job simply stays in jobs.neverRan until a real signed
  // delivery arrives. Neither path can be driven by a stranger.
  if (!SIGNING_SECRET) {
    console.log('[clerk_webhook] refused: CLERK_WEBHOOK_SIGNING_SECRET not set');
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  const okSig = verifyClerkSignature(payload, {
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
  }, SIGNING_SECRET);
  if (!okSig) {
    // ⚠️ NOT COUNTED AS A FAILED RUN. A rejected forgery is the endpoint working, and letting
    // unauthenticated traffic drive our health state would hand anyone a way to turn the dashboard
    // red. Logged, refused, not recorded.
    console.log('[clerk_webhook] bad signature');
    return Response.json({ error: 'bad signature' }, { status: 400 });
  }

  let event;
  try { event = JSON.parse(payload); } catch { return Response.json({ error: 'bad payload' }, { status: 400 }); }

  const type = String(event?.type || 'unknown');
  const data = event?.data || {};
  const eventId = request.headers.get('svix-id');

  try {
    if (TRACKED.has(type)) {
      await recordSignupEvent({
        eventId,
        type,
        userId: data?.id ? String(data.id) : null,
        // A deletion carries no external_accounts to read a method from, and inventing one would
        // put a fictional signup method on the row.
        method: type === 'user.created' ? signupMethod(data) : null,
        eventAt: Number.isFinite(data?.created_at) ? data.created_at : Date.now(),
      });
    }
    await beat(true, TRACKED.has(type) ? 1 : 0, type);
  } catch (e) {
    console.log(`[clerk_webhook] handler error: ${e.message}`);
    await beat(false, 0, `handler error: ${e.message}`);
  }

  // ⚠️ ALWAYS 200 ONCE THE SIGNATURE IS GOOD. A non-2xx makes Svix retry, and there is nothing here
  // worth retrying — the account exists either way and the insert is idempotent.
  return Response.json({ received: true, type });
}
