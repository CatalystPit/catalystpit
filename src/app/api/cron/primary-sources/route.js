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

/**
 * THE HALT SWEEP, AS ITS OWN SUBTASK WITH ITS OWN HEARTBEAT.
 *
 * ── ⚠️ WHY IT IS A SEPARATE FUNCTION AND A SEPARATE HEARTBEAT ───────────────
 *
 * Halts ride this cron because vercel.json holds exactly 40 entries — the Vercel Pro cap — and
 * deleting a production job to make room is not a trade worth making. Before that, projectHalts() was
 * reachable only from /api/halts and the Terminal was that route's only caller, so halts entered the
 * durable wire ONLY while somebody had the Terminal open; on 29 Sep production captured zero.
 *
 * Sharing a cron is fine. Sharing a HEARTBEAT was not, and that was the remaining defect: the halt
 * outcome was reported in the HTTP response and nowhere else, while the monitored heartbeat carried
 * only wire counters. A halt feed erroring every minute for a week would have left /api/health
 * completely green — the response nobody reads said "error", and the thing we actually watch said
 * "written 0 · folded 0", which is a healthy quiet minute. That is exactly the "giant opaque
 * heartbeat" this codebase keeps having to take apart.
 *
 * So the halt subtask now records `job:halts` itself: its own last-attempted and last-successful
 * clocks, its own events_seen, its own consecutive_failures. A halt-source outage marks HALTS failing
 * and leaves the wire green, and a wire failure leaves the halt clock alone.
 *
 * ⚠️ AND AN EMPTY FEED IS A SUCCESS. Most minutes nothing is halted. Recording that as a failure would
 * be the same confusion between "no events" and "not asking" that the wire's own comment warns about —
 * only a fetch or parse error is a failure here.
 *
 * ⚠️ IT ALSO CANNOT BE SKIPPED BY THE WIRE FAILING. This used to sit inside the same try as
 * runPrimarySources, so a wire throw returned 500 before the halt sweep was reached — one subtask's
 * failure silently suppressing the other, for the one pipeline whose whole point is that it does not
 * depend on anything else running. It is now called on both paths.
 */
async function sweepHalts() {
  const out = { fetched: 0, projected: 0, error: null };
  try {
    const res = await fetchHalts();
    if (res.error || !res.halts) {
      out.error = res.error || 'no halts returned';
    } else {
      out.fetched = res.halts.length;
      const detected = mergeDetected(res.halts, await detectedHalts().catch(() => []));
      await kvSetHalts({
        halts: [...detected, ...res.halts].sort((a, b) => haltKey(b) - haltKey(a)),
        asOf: new Date().toISOString(),
      });
      out.projected = await projectHalts(res.halts);
    }
  } catch (e) {
    out.error = String(e?.message || 'halt sweep failed').slice(0, 120);
  }
  try {
    await recordJobRun('halts', {
      ok: !out.error,
      seen: out.projected,
      note: out.error
        ? `halt source failed · ${out.error}`
        : `fetched ${out.fetched} · projected ${out.projected}`,
    });
  } catch { /* never fail the sweep on its own telemetry */ }
  return out;
}

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

    // ⚠️ HALTS RIDE THIS CRON BECAUSE THERE IS NO ROOM FOR THEIR OWN — see sweepHalts() for why this
    // job is the right host rather than merely a convenient one, and why the subtask keeps its own
    // heartbeat. It runs AFTER the wire has committed its rows, so it can never take the wire with it.
    const halts = await sweepHalts();

    console.log(`[primary-sources] ${JSON.stringify({ written: res.written, folded: res.folded, sweeps: res.sweeps, enrich, halts, ms: res.ms })}`);
    // ⚠️ written: 0 IS A HEALTHY RUN AND MUST STILL TICK THE CLOCK. This is the Pit Wire: most
    // minutes there is genuinely nothing new to write, and a heartbeat that only fired on a non-empty
    // run would read as an outage every quiet hour — the exact confusion between "no events" and "not
    // asking" that this whole mechanism exists to remove.
    await beat(true, res.written, `written ${res.written} · folded ${res.folded} · ${res.ms}ms`);
    return Response.json({ ok: true, ...res, enrich, parked, adopted, floored, halts }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('[primary-sources]', e);
    await beat(false, 0, 'sweep threw');
    // ⚠️ THE HALT SWEEP STILL RUNS. It used to sit inside the try above, so a wire throw returned 500
    // having never touched the halt feed — the wire failing silently suppressed the one pipeline whose
    // entire purpose is to be independent of whether anything else is working. Halts do not need the
    // wire to have succeeded; they need a minute to have passed.
    const halts = await sweepHalts();
    return Response.json({ error: String(e?.message || e).slice(0, 200), halts }, { status: 500 });
  }
}
