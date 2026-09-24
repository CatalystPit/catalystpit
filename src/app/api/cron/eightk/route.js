import { auth, clerkClient } from '@clerk/nextjs/server';
import { ingestEightK } from '../../../../lib/eightk';
import { ingestForm25 } from '../../../../lib/form25';
import { ingestForm144 } from '../../../../lib/form144.mjs';
import { recordJobRun } from '../../../../lib/job-heartbeat';

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
    // ⚠️ SAME CRON, SAME TABLE, SEPARATE FEED. Form 25 is the one SEC current-report form that
    // reaches foreign private issuers, which file 20-F/6-K and can never produce an 8-K catalyst.
    // Failure here must not fail the 8-K ingest that already committed.
    let f25 = { scanned: 0, inserted: 0 };
    try { f25 = await ingestForm25(); } catch { /* best effort */ }
    // ⚠️ AND FORM 144 — notice of a PROPOSED sale, which is a different fact from a Form 4 and was
    // ingested by nothing at all. Its own table, the same engine. See lib/form144.mjs.
    let f144 = { scanned: 0, inserted: 0 };
    try { f144 = await ingestForm144(); } catch { /* best effort */ }
    console.log(`[eightk] scanned ${res.scanned} · inserted ${res.inserted}`);
    // `inserted: 0` is the normal answer outside filing hours — the heartbeat records that we
    // ASKED, which is the fact that cannot be recovered from the data afterwards.
    await recordJobRun('eightk', { ok: true, seen: (res.inserted ?? 0) + (f25.inserted ?? 0) + (f144.inserted ?? 0), note: `scanned ${res.scanned} 8-K, ${f25.scanned} form-25, ${f144.scanned} form-144` });
    return Response.json({ ok: true, ...res, form25: f25, form144: f144 });
  } catch (e) {
    console.log(`[eightk] ingest failed: ${e.message}`);
    await recordJobRun('eightk', { ok: false, note: 'ingest threw' });
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
