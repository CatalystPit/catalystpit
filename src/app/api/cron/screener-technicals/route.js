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

  // 260 TRADING DAYS, because that is what the indicators this job computes actually need. The
  // longest lookback is perf_1y at 253 closes, then sma200 at 200; the old default of 150 could not
  // produce either, so both were null market-wide (sma200 0.6%, perf_1y 0.4%) while the job reported
  // success. Measured end to end: 118s and 442 MB of heap at 250 days, 459 MB at 260, against a 300s
  // Vercel budget and a 1024 MB function. The cap allows a manual override with room to spare.
  const days = Math.min(300, Math.max(30, parseInt(new URL(request.url).searchParams.get('days') || '260', 10) || 260));
  try {
    const res = await backfillTechnicals({ days });
    console.log(`[screener-tech] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[screener-tech] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
