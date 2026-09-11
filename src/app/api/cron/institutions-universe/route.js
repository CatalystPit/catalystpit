import { auth, clerkClient } from '@clerk/nextjs/server';
import { runInstitutionsUniverse } from '../../../../lib/institutions-universe';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Auto-discovers EVERY SEC 13F filer from the quarterly full-index and ingests their holdings
// (amendment-aware) — no curated list. Bounded per run; drives to full coverage across runs.
// Auth: x-vercel-cron OR Bearer CRON_SECRET OR admin (ADMIN_EMAIL). Params: ?indexes= ?ingestCap= ?tickerCap=.
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

  const sp = new URL(request.url).searchParams;
  const indexes = Math.min(8, Math.max(1, parseInt(sp.get('indexes') || '2', 10) || 2));
  const ingestCap = Math.min(400, Math.max(5, parseInt(sp.get('ingestCap') || '60', 10) || 60));
  const tickerCap = Math.min(20000, Math.max(50, parseInt(sp.get('tickerCap') || '500', 10) || 500));
  const tickerOnly = sp.get('tickerOnly') === '1';   // skip ingest, just drain the ticker→logo backlog
  const cleanup = sp.get('cleanup') === '1';          // one-time purge of junk/bond "tickers"
  try {
    const res = await runInstitutionsUniverse({ indexes, ingestCap, tickerCap, tickerOnly, cleanup });
    console.log(`[institutions-universe] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[institutions-universe] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
