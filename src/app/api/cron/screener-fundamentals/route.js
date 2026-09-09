import { auth, clerkClient } from '@clerk/nextjs/server';
import { backfillFundamentals } from '../../../../lib/screener-data';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Populates screener_fundamentals (P/E inputs, margins, growth, ratios) from Polygon Financials.
// Bounded per run, prioritized by volume, accumulates. Nightly + admin-runnable.
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

  const cap = Math.min(8000, Math.max(100, parseInt(new URL(request.url).searchParams.get('cap') || '3000', 10) || 3000));
  try {
    const res = await backfillFundamentals({ cap });
    console.log(`[screener-fund] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[screener-fund] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
