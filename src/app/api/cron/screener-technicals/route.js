import { auth, clerkClient } from '@clerk/nextjs/server';
import { backfillTechnicals } from '../../../../lib/screener-data';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Computes market-wide technicals (RSI/SMA/52w/perf) from Polygon grouped-daily history and writes
// them onto screener_stocks. Nightly cron (after the main screener rebuild); admin-runnable.
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

  const days = Math.min(250, Math.max(30, parseInt(new URL(request.url).searchParams.get('days') || '150', 10) || 150));
  try {
    const res = await backfillTechnicals({ days });
    console.log(`[screener-tech] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[screener-tech] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
