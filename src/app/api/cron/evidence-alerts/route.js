import { runEvidenceAlerts } from '../../../../lib/evidence-alerts';
import { recordJobRun } from '../../../../lib/job-heartbeat';

export const runtime = 'nodejs';
export const maxDuration = 120;

// EVIDENCE ALERTS — notify watchers when something public lands on a name they watch.
//
// Watched tickers only. Every alert is a filing with a document behind it: a material 8-K, an
// unusual Form 4, a Congress disclosure. No price, no volume, no RVOL — realtime is not entitled,
// so a "moving now" alert could only be a claim about a stale quote.
//
// ⚠️ SAFE TO RUN AS OFTEN AS YOU LIKE, AND SAFE TO MISS. Delivery is claimed by a primary key on
// (user_id, alert_key), so overlapping runs, retries and a generous re-check window all collapse
// to one alert per event per person. That is why this has no watermark to lose.

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const res = await runEvidenceAlerts();
    console.log(`[evidence-alerts] ${JSON.stringify(res)}`);
    // `fired: 0` is the normal answer — most passes find nothing new, and the heartbeat records
    // that we ASKED rather than that anything happened.
    await recordJobRun('evidence-alerts', {
      ok: true, seen: res.fired,
      note: `${res.users} watchers, ${res.tickers} tickers${res.capped ? ', capped' : ''}`,
    });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    console.log(`[evidence-alerts] failed: ${e.message}`);
    await recordJobRun('evidence-alerts', { ok: false, note: 'run threw' });
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
