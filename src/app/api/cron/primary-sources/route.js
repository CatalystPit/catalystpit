import { runPrimarySources, runEnrichment, parkExhausted, adoptClusterWording, applyTrustedFloor, projectHalts, detectedHalts } from '../../../../lib/primary-events';
import { recordJobRun } from '../../../../lib/job-heartbeat';
import { fetchHalts, kvSetHalts, haltKey, mergeDetected } from '../../../../lib/halts.mjs';

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

// ⚠️ Bookkeeping only — it never throws into the job it describes.
const beat = async (ok, seen, note) => {
  try { await recordJobRun('primary-sources', { ok, seen: Number(seen) || 0, note: note ? String(note).slice(0, 180) : null }); }
  catch { /* never fail the job on its own telemetry */ }
};

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

    // ── ⚠️ HALTS RIDE THIS CRON, BECAUSE THERE IS NO ROOM FOR THEIR OWN ─────────────────────────
    //
    // projectHalts() was reachable only from /api/halts, and the Terminal was that route's only
    // caller — so halts entered the durable wire ONLY while somebody had the Terminal open. On 29 Sep
    // production captured zero. A dedicated cron was the obvious fix and there is no room for one:
    // vercel.json holds exactly 40 entries, the Vercel Pro cap, and deleting a production job to make
    // space is not a trade worth making.
    //
    // This job is the right host rather than a convenient one: it already fires every minute, already
    // writes to primary_events, and already projects another pipeline (SEC 8-K) into the same stream.
    // The 45-second KV cache means once-a-minute costs one upstream request per minute and a reader
    // opening the Terminal inside that window is served the cached copy.
    //
    // ⚠️ AND IT CANNOT TAKE THE WIRE DOWN WITH IT. The sweep above has already committed its rows by
    // the time this runs; a halt-feed outage is recorded in the response and changes nothing else.
    const halts = { fetched: 0, projected: 0, error: null };
    try {
      const res = await fetchHalts();
      if (res.error || !res.halts) {
        halts.error = res.error || 'no halts returned';
      } else {
        halts.fetched = res.halts.length;
        const detected = mergeDetected(res.halts, await detectedHalts().catch(() => []));
        await kvSetHalts({
          halts: [...detected, ...res.halts].sort((a, b) => haltKey(b) - haltKey(a)),
          asOf: new Date().toISOString(),
        });
        halts.projected = await projectHalts(res.halts);
      }
    } catch (e) {
      halts.error = String(e?.message || 'halt sweep failed').slice(0, 120);
    }

    console.log(`[primary-sources] ${JSON.stringify({ written: res.written, folded: res.folded, sweeps: res.sweeps, enrich, ms: res.ms })}`);
    // ⚠️ written: 0 IS A HEALTHY RUN AND MUST STILL TICK THE CLOCK. This is the Pit Wire: most
    // minutes there is genuinely nothing new to write, and a heartbeat that only fired on a non-empty
    // run would read as an outage every quiet hour — the exact confusion between "no events" and "not
    // asking" that this whole mechanism exists to remove.
    await beat(true, res.written, `written ${res.written} · folded ${res.folded} · ${res.ms}ms`);
    return Response.json({ ok: true, ...res, enrich, parked, adopted, floored, halts }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('[primary-sources]', e);
    await beat(false, 0, 'sweep threw');
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
