import { auth, clerkClient } from '@clerk/nextjs/server';
import { runCongressSync, dedupeCongressCanonical } from '../../../../lib/congress-sync';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Official-source congressional-trade ingest (House Clerk PTR PDFs + Senate eFD),
// replacing FMP. Watermark-driven + bounded; drives to full history across runs.
// Auth: x-vercel-cron OR Bearer CRON_SECRET OR admin (ADMIN_EMAIL).
// Params: ?chambers=both|house|senate ?capHouse= ?capSenate=
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
  // ?dedupeOnly=1 — canonicalize/collapse existing rows without ingesting (run once after deploy).
  if (sp.get('dedupeOnly') === '1') {
    try { const res = await dedupeCongressCanonical({ apply: true }); return Response.json({ ok: true, dedupeOnly: true, ...res }); }
    catch (e) { return Response.json({ ok: false, error: e.message }, { status: 500 }); }
  }
  const chambers = ['both', 'house', 'senate'].includes(sp.get('chambers')) ? sp.get('chambers') : 'both';
  const ingestCapHouse = Math.min(600, Math.max(5, parseInt(sp.get('capHouse') || '120', 10) || 120));
  const ingestCapSenate = Math.min(400, Math.max(5, parseInt(sp.get('capSenate') || '80', 10) || 80));
  try {
    const res = await runCongressSync({ chambers, ingestCapHouse, ingestCapSenate });
    console.log(`[congress-sync] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[congress-sync] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
