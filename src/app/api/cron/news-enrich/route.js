import { runEnrichment, parkExhausted, adoptClusterWording, applyTrustedFloor } from '../../../../lib/primary-events';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Stage 2 of the news pipeline: turn captured rows into finished Catalyst Pit events.
//
// The ingest cron already calls runEnrichment() inline the moment it writes something, so in normal
// operation this cron finds nothing to do. It exists as the SAFETY NET — for rows whose inline
// enrichment failed, for a backlog after an Anthropic outage, and for anything re-queued by hand.
// It never fetches a feed and never touches SEC rows.
const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const limit = Number(new URL(request.url).searchParams.get('limit') || 30);
    const res = await runEnrichment({ limit });
    const parked = await parkExhausted();
    const adopted = await adoptClusterWording();
    const floored = await applyTrustedFloor();
    if (res.claimed || res.claimError || res.unavailable) console.log(`[news-enrich] ${JSON.stringify(res)}`);
    return Response.json({ ok: true, ...res, parked, adopted, floored }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('[news-enrich]', e);
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
