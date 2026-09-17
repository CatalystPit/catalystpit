import { runEnrichment, parkExhausted, adoptClusterWording, applyTrustedFloor, rewriteHealth } from '../../../../lib/primary-events';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Stage 2 of the news pipeline: turn captured rows into finished Catalyst Pit events.
//
// The ingest cron rewrites NEW rows inline the moment it writes them, so a breaking item never waits
// for this cron. This one owns the BACKLOG: delayed retries, rows the inline worker missed, and
// everything left after an Anthropic outage. It batches, because a model call's fixed instructions
// are shared by up to fifteen items: a pass waits for at least MIN_BATCH due rows unless one of them
// is urgent (HIGH importance, trusted, or already waiting too long). It never fetches a feed and
// never touches SEC rows.
//
// It also measures, once a minute, whether ingestion is running while rewrites have stalled, and
// persists that verdict to feed_state `_rewrite_health`. `?health=1` returns only that check.
const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_LIMIT = 45;          // up to three full batches a minute
const MIN_BATCH = 5;
const MAX_WAIT_SECONDS = 180;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('health')) {
      return Response.json({ ok: true, health: await rewriteHealth() }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const limit = Number(params.get('limit') || BATCH_LIMIT);
    const res = await runEnrichment({ limit, scope: 'backlog', minBatch: MIN_BATCH, maxWaitSeconds: MAX_WAIT_SECONDS });
    const parked = await parkExhausted();
    const adopted = await adoptClusterWording();
    const floored = await applyTrustedFloor();
    let health = null;
    try { health = await rewriteHealth(); } catch (e) { console.error('[news-enrich] health check failed:', String(e?.message || e).slice(0, 120)); }
    if (res.claimed || res.claimError || (res.unavailable && !res.circuitOpen)) console.log(`[news-enrich] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res, parked, adopted, floored, health }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('[news-enrich]', e);
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}

