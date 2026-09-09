import { auth, clerkClient } from '@clerk/nextjs/server';
import { rebuildScreener } from '../../../../lib/screener-data';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Rebuilds the screener_stocks universe from our own data (proprietary signals + candle technicals
// + short interest). Nightly cron; admin can trigger on demand to seed/refresh.
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
    const res = await rebuildScreener();
    console.log(`[screener] rebuild: ${res.universe} tickers · ${res.technicals} w/ technicals · ${res.upserts} upserts`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[screener] rebuild failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
