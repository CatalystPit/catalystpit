import { auth, clerkClient } from '@clerk/nextjs/server';
import { backfillMeta } from '../../../../lib/screener-data';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Populates screener_meta (market cap / sector / exchange / asset type) from Polygon ticker-details.
// Bounded per run, prioritized by volume, accumulates full coverage over a few runs. Nightly + admin.
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

  const cap = Math.min(12000, Math.max(200, parseInt(new URL(request.url).searchParams.get('cap') || '6000', 10) || 6000));
  try {
    const res = await backfillMeta({ cap });
    console.log(`[screener-meta] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[screener-meta] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
