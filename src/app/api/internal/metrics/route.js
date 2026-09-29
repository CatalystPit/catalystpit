import { auth, clerkClient } from '@clerk/nextjs/server';
import { readBillingFunnel } from '../../../../lib/billing/events';
import { readSignupFunnel } from '../../../../lib/monitoring/signup-events';
import { TRACKED_JOBS, readJobHeartbeats } from '../../../../lib/job-heartbeat';

export const runtime = 'nodejs';
export const maxDuration = 20;

// THE LAUNCH FUNNEL, FOR THE OWNER ONLY.
//
// ── WHY THIS IS NOT ON /api/health ──────────────────────────────────────────
//
// /api/health is public on purpose: it answers "is the product up" in aggregate booleans and ages,
// and nothing there is worth hiding. Subscription counts are a different class of fact. How many
// people converted last week is commercially sensitive, it tells a competitor the size of the
// business, and it belongs behind the same door as the Stripe dashboard. So liveness stays public
// and the numbers live here, behind a secret.
//
// ⚠️ AUTH BEFORE ANY QUERY. An unauthorised caller must not be able to time this endpoint into
// telling them whether rows exist, so nothing is read until the caller is established.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// ⚠️ NOT REVENUE, AND IT SAYS SO IN ITS OWN PAYLOAD. These are counts of events our webhook
// PROCESSED. A subscription Stripe later refunded still has its created event here, and an event
// Stripe never delivered is absent no matter what the customer paid. Stripe's own reporting stays
// authoritative for money; this exists to answer the question Stripe cannot — did OUR side see it,
// and did it reach a CatalystPit user.

const CRON_SECRET = process.env.CRON_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const NO_STORE = { 'Cache-Control': 'no-store' };

/** The signed-in owner, so this is readable from a browser without pasting a secret into a URL. */
async function isAdmin() {
  try {
    const { userId } = await auth();
    if (!userId || !ADMIN_EMAIL) return false;
    const c = await clerkClient();
    const u = await c.users.getUser(userId);
    return (u?.emailAddresses || []).some((e) => e.emailAddress?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  } catch { return false; }
}

export async function GET(request) {
  // ⚠️ THE SECRET IS READ FROM A HEADER, NEVER A QUERY STRING. A ?key= lands in Vercel's request
  // logs and in any referrer, which would leak the same credential the check exists to protect.
  const bearer = request.headers.get('authorization') === `Bearer ${CRON_SECRET}`;
  const authorized = (!!CRON_SECRET && bearer) || await isAdmin();
  if (!authorized) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

  const days = Math.min(365, Math.max(1, parseInt(new URL(request.url).searchParams.get('days') || '30', 10) || 30));

  let billing = null, billingError = null;
  try { billing = await readBillingFunnel({ days }); }
  catch (e) { billingError = e.message?.includes('billing_events') ? 'table_missing' : 'query_failed'; }

  // ⚠️ SIGNUPS SIT BESIDE CONVERSIONS BECAUSE THE RATIO IS THE POINT. "42 signups" and "3 upgrades"
  // are each half of the only number that matters at launch, and putting them on one response means
  // nobody has to join two dashboards by hand to get it.
  let signups = null, signupsError = null;
  try { signups = await readSignupFunnel({ days }); }
  catch (e) { signupsError = e.message?.includes('signup_events') ? 'table_missing' : 'query_failed'; }

  let jobs = [];
  try {
    const beats = await readJobHeartbeats();
    jobs = TRACKED_JOBS.map((j) => {
      const b = beats.get(j.name) || null;
      return {
        job: j.name,
        lastSuccess: b?.last_success_at ?? null,
        lastPolled: b?.last_polled_at ?? null,
        consecutiveFailures: b?.consecutive_failures ?? null,
        eventsSeen: b?.events_seen ?? null,
        note: b?.note ?? null,
      };
    });
  } catch { /* the funnel is still worth returning without it */ }

  return Response.json({
    ok: true,
    basis: 'Counts of Stripe events this deployment processed. Stripe remains authoritative for revenue.',
    windowDays: days,
    billing, billingError,
    signups, signupsError,
    // ⚠️ WHETHER, NOT WHAT. A boolean saying the signing secrets exist, never a prefix or a length —
    // and behind this endpoint's auth rather than on the public health document, because which parts
    // of the plumbing are wired is configuration detail even when the values stay hidden. This is how
    // "the Clerk webhook is not set up yet" is visible without an anonymous POST being able to prove
    // it, which is exactly what made recording that state as a job failure the wrong design.
    configured: {
      clerkWebhook: !!process.env.CLERK_WEBHOOK_SIGNING_SECRET,
      stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
      stripeMonthly: !!process.env.STRIPE_PRICE_ID,
      stripeAnnual: !!process.env.STRIPE_PRICE_ID_ANNUAL,
    },
    jobs,
    at: new Date().toISOString(),
  }, { headers: NO_STORE });
}
