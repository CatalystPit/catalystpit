import { checkRollover } from '../../../../lib/heatmap/heatmap-gate-monitor';
import { recordJobRun } from '../../../../lib/job-heartbeat';

// THE HEATMAP ROLLOVER WATCHDOG — one check per hour, for everybody.
//
// ⚠️ A CRON RATHER THAN A HOOK IN THE HEATMAP ROUTE, AND THAT IS THE DEDUPLICATION. Put this check
// in the read path and a thousand people opening the board during an outage produce a thousand
// identical alerts at the exact moment the logs need to be readable. Here, alert volume is a
// function of TIME and not of audience — the same one-per-hour ceiling whether nobody is looking
// or ten thousand are. It is the same argument as the shared snapshot itself.
//
// ⚠️ IT READS AND REPORTS. NOTHING HERE CAN PROMOTE A SESSION. The monitor calls the same
// canonicalSessionDate() the board calls and describes what it finds; there is no write path to
// the board, no override, and no way to satisfy a 42/472 coverage shortfall by asking again. A
// prolonged hold is meant to be loud, not resolved.
//
// ⚠️ AND IT COSTS NO VENDOR REQUESTS. Two bounded Postgres reads — the universe and one grouped
// coverage count. It never touches Tiingo or Polygon, never builds or refreshes a snapshot, and
// never invalidates a cache.
//
// Hourly is deliberate: the condition it watches for changes at most once a day (the EOD load
// either landed or did not), so a tighter schedule would buy nothing and cost 24× the queries.

export const runtime = 'nodejs';
export const maxDuration = 20;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  // Same guard the other cron routes use: Vercel signs its own invocations.
  if (CRON_SECRET) {
    const isVercelCron = request.headers.get('x-vercel-cron') === '1';
    const auth = request.headers.get('authorization') || '';
    const key = new URL(request.url).searchParams.get('key');
    if (!isVercelCron && auth !== `Bearer ${CRON_SECRET}` && key !== CRON_SECRET) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const r = await checkRollover();
    // ⚠️ THE HEARTBEAT RECORDS THE VERDICT, NOT THE RUN — `ok: r.ok`, not `ok: true`. A check that
    // executed flawlessly and found a dead ingest is not a success, and recording it as one would
    // leave /api/health's job table green all the way through the outage this exists to surface.
    // Every other job in TRACKED_JOBS reports only "did I run"; this one reports what it found.
    await recordJobRun('heatmap-gate', { ok: r.ok, seen: 0, note: r.heartbeatNote });
    // 200 even when the board is stale: the CHECK succeeded. A non-200 here would mean "the
    // watchdog is broken", and conflating that with "the watchdog found something" is how an
    // outage gets mistaken for a flaky cron and retried instead of investigated. The verdict is in
    // the body, in the log line, and in /api/health — which is the surface that does go 503.
    return Response.json(r, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error(`[heatmap-gate] check failed: ${String(e?.message || e).slice(0, 120)}`);
    return Response.json({ ok: false, error: 'check_failed' },
      { headers: { 'Cache-Control': 'private, no-store' } });
  }
}
