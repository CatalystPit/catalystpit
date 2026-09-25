import { auth, clerkClient } from '@clerk/nextjs/server';
import { runEvidenceAlerts } from '../../../../lib/alerts/evidence-alert-worker.mjs';
import { recordJobRun } from '../../../../lib/job-heartbeat';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Generates Evidence Alerts for every active subscription. Cron auth follows the existing
// convention in /api/cron/alerts: x-vercel-cron OR Bearer CRON_SECRET OR admin (ADMIN_EMAIL).
//
// ⚠️ SAFE TO CALL AGAIN AT ANY TIME. Delivery is idempotent on (user_id, evidence_id), so an
// overlapping schedule, a manual admin run and a retry after a timeout all converge on the same
// rows. There is no cursor to corrupt.
const CRON_SECRET = process.env.CRON_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

async function isAdmin() {
  try {
    const { userId } = await auth();
    if (!userId || !ADMIN_EMAIL) return false;
    const u = await (await clerkClient()).users.getUser(userId);
    const email = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress || u.emailAddresses[0]?.emailAddress;
    return !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  } catch { return false; }
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  let authorized = isVercelCron || request.headers.get('authorization') === `Bearer ${CRON_SECRET}`;
  if (!authorized) authorized = await isAdmin();
  if (!authorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // Leaves ~15s of the 60s budget for the prune and the response.
    const out = await runEvidenceAlerts({ budgetMs: 45_000 });
    try {
      await recordJobRun('evidence-alerts', {
        ok: true,
        seen: out.created,
        note: `${out.tickers} tickers · ${out.subscriptions} subs · ${out.created} new · ${out.failed} failed · ${out.ms}ms`,
      });
    } catch { /* a heartbeat is not delivery; never fail the run on it */ }
    return Response.json({ ok: true, ...out });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
