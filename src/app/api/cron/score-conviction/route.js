import { auth, clerkClient } from '@clerk/nextjs/server';
import { neon } from '@neondatabase/serverless';
import { refreshContext, scoreUngraded, convictionCoverage } from '../../../../lib/insider/conviction-pipeline.mjs';
import { recordJobRun } from '../../../../lib/job-heartbeat';

export const runtime = 'nodejs';
export const maxDuration = 300;

// THE SCHEDULED CONVICTION RUN — the automation the pipeline never had.
//
// ⚠️ THIS IS THE FIX FOR A JOB THAT WAS NEVER SCHEDULED, NOT FOR A JOB THAT BROKE. The engine, its
// inputs and its last run were all correct; scoring simply stopped when the developer stopped
// typing `node scripts/score-conviction.mjs`. Everything below is plumbing around the unchanged
// engine in lib/conviction.server.js.
//
// ⚠️ SAFE TO CALL AGAIN AT ANY TIME. The work queue is `conviction IS NULL`, so a second run finds
// nothing, writes nothing and returns scored: 0. A run killed at maxDuration leaves the remainder
// still selected for the next one. There is no cursor.
//
// Cron auth follows the existing convention: x-vercel-cron OR Bearer CRON_SECRET OR admin.
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

  if (!process.env.DATABASE_URL) return Response.json({ ok: false, error: 'no_database' }, { status: 503 });
  const q = neon(process.env.DATABASE_URL);
  const run = (text, params = []) => q.query(text, params);

  const url = new URL(request.url);
  // Bounds, overridable for a deliberate backfill. Defaults suit a routine incremental run.
  const limit = Math.min(60_000, Math.max(1, Number(url.searchParams.get('limit')) || 20_000));
  const skipContext = url.searchParams.get('context') === '0';

  const started = Date.now();
  try {
    // ⚠️ CONTEXT FIRST, BECAUSE THE SCORE READS IT. The engine degrades to documented neutral
    // defaults when a context column is null — it does not fail — but running scoring before the
    // context refresh would bake those defaults into rows whose real history is computable.
    let context = null;
    if (!skipContext) {
      try { context = await refreshContext(run); }
      catch (e) { context = { error: e.message }; }
    }

    // Leave room under maxDuration for the coverage read and the response.
    const budgetMs = Math.max(20_000, 270_000 - (Date.now() - started));
    const result = await scoreUngraded(run, { limit, budgetMs });
    const coverage = await convictionCoverage(run);

    try {
      await recordJobRun('score-conviction', {
        ok: true,
        seen: result.scored,
        note: `scored ${result.scored} · skipped ${result.skipped} · pending ${coverage.pendingEligible} · lag ${coverage.lagDays}d · ${result.ms}ms`,
      });
    } catch { /* a heartbeat is not the work; never fail the run on it */ }

    return Response.json({ ok: true, context, ...result, coverage });
  } catch (e) {
    try { await recordJobRun('score-conviction', { ok: false, note: e.message }); } catch { /* ignore */ }
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
