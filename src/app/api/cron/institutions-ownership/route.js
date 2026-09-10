import { auth, clerkClient } from '@clerk/nextjs/server';
import { runOwnershipAggregate } from '../../../../lib/institutions-universe';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Nightly recompute of 13F-reported institutional ownership per ticker (sum common shares across each
// fund's latest filed quarter ÷ shares outstanding). Pure SQL, cheap. Runs after the universe ingest.
// Auth: x-vercel-cron OR Bearer CRON_SECRET OR admin (ADMIN_EMAIL).
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
    const res = await runOwnershipAggregate();
    console.log(`[institutions-ownership] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[institutions-ownership] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
