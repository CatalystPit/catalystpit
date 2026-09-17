import { runPrimarySources, runEnrichment, parkExhausted, adoptClusterWording, applyTrustedFloor } from '../../../../lib/primary-events';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Polls the official primary-source feeds and projects the pipelines we already run (SEC 8-K) into
// the normalized stream. Every feed uses a conditional GET, so a routine sweep is a handful of 304s.
//
// Vercel cron cannot fire more than once a minute, which would cap first-event latency at 60s. So
// one invocation SWEEPS for most of a minute instead of polling once: priority feeds are re-checked
// every few seconds, and detection latency collapses to the feed's own cadence. A 304 costs no body,
// which is what makes that affordable.
//
// New rows are handed straight to enrichment inside the sweep rather than waiting for the enrichment
// cron, so a captured event becomes a finished Catalyst Pit event seconds later. Enrichment failing
// cannot affect capture: the row is already stored, already deduped and already canonical.
const CRON_SECRET = process.env.CRON_SECRET;
const SWEEP_BUDGET_MS = 50_000;   // leaves headroom inside maxDuration for the 8-K projection

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const params = new URL(request.url).searchParams;
    const only = params.get('only');
    // ?once=1 runs a single pass — used by verification scripts so they do not sit for a minute.
    const budgetMs = params.get('once') ? 0 : Number(params.get('budget') ?? SWEEP_BUDGET_MS);

    const enrich = { runs: 0, ready: 0, original: 0, fallback: 0 };
    const res = await runPrimarySources({
      only,
      budgetMs,
      // Scope 'fresh': only rows captured in the last few minutes, so a new event is worded the moment
      // it lands. Older due rows are the enrichment cron's backlog, sent in full batches.
      onNew: async () => {
        const r = await runEnrichment({ scope: 'fresh' });
        enrich.runs++; enrich.ready += r.ready; enrich.original += r.original; enrich.fallback += r.fallback;
        if (r.unavailable) enrich.unavailable = r.unavailable;
      },
    });
    const parked = await parkExhausted();
    const adopted = await adoptClusterWording();
    const floored = await applyTrustedFloor();

    console.log(`[primary-sources] ${JSON.stringify({ written: res.written, folded: res.folded, sweeps: res.sweeps, enrich, ms: res.ms })}`);
    return Response.json({ ok: true, ...res, enrich, parked, adopted, floored }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('[primary-sources]', e);
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
