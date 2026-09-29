import { auth, clerkClient } from '@clerk/nextjs/server';
import { backfillTechnicals } from '../../../../lib/screener-data';
import { recordJobRun } from '../../../../lib/job-heartbeat';

// ⚠️ TELEMETRY NEVER THROWS INTO THE JOB. Both helpers swallow their own errors: the backfill has
// already done its work by the time either runs, and losing a timestamp must not turn a successful
// 118-second run into a 500.
const beat = async (name, ok, seen, note) => {
  try { await recordJobRun(name, { ok, seen: Number(seen) || 0, note: note ? String(note).slice(0, 180) : null }); }
  catch { /* bookkeeping only */ }
};

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
    // ⚠️ MARKET BREADTH RIDES ALONG, AND NOT FOR TIDINESS. Vercel caps a project at 40 cron jobs and
    // this one already runs 39, so breadth gets one schedule of its own (the post-close run) and takes
    // its nightly refresh from here. This is the right moment anyway: breadth reads the same daily
    // candles this job has just finished reading, so it cannot run against a half-updated history.
    // Non-fatal — a breadth failure must not fail the technicals run that preceded it.
    let breadth = null;
    try {
      const { computeMarketBreadth } = await import('../../../../lib/market-breadth.server.mjs');
      breadth = await computeMarketBreadth();
      console.log(`[screener-tech] breadth ${JSON.stringify(breadth)}`);
      // ⚠️ THE RIDE-ALONG TICKS THE BREADTH CLOCK TOO. Its own cron runs weekdays only, so without
      // this the heartbeat would go quiet every Saturday and a 26h threshold would report a weekend
      // as an outage — while the refresh that actually ran here went unrecorded. The job is judged on
      // when it last succeeded, so every path that succeeds has to say so.
      await beat('market-breadth', true, breadth?.universe, `via screener-technicals · ${breadth?.as_of_session}`);
    } catch (e) {
      console.log(`[screener-tech] breadth failed: ${e.message}`);
      await beat('market-breadth', false, 0, `via screener-technicals: ${e.message}`);
    }
    await beat('screener-technicals', true, res?.updated ?? res?.rows, JSON.stringify(res).slice(0, 180));
    return Response.json({ ok: true, ...res, breadth });
  } catch (e) {
    console.log(`[screener-tech] failed: ${e.message}`);
    await beat('screener-technicals', false, 0, e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
