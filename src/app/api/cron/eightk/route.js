import { auth, clerkClient } from '@clerk/nextjs/server';
import { ingestEightK } from '../../../../lib/eightk';

export const runtime = 'nodejs';
export const maxDuration = 60;

// 8-K Catalyst Wire ingestion. Cron (every 5 min) pulls SEC's market-wide current 8-K stream,
// resolves ticker + item codes, and stores new filings. Also runnable by the admin on demand.
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
    const res = await ingestEightK();
    console.log(`[eightk] scanned ${res.scanned} · inserted ${res.inserted}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[eightk] ingest failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
