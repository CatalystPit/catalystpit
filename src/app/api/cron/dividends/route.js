import { syncDividends } from '../../../../lib/dividends/dividend-ingest';
import { recordJobRun } from '../../../../lib/job-heartbeat';

// Daily dividend synchronisation.
//
// This is the ONLY path that talks to a dividend provider. The calendar page and its API read the
// stored table and nothing else — the request-time provider fetch is the mistake this codebase has
// already paid for twice, and it is not repeated here.
//
// Idempotent: the window overlaps yesterday's, and the upsert is keyed on the provider's event id,
// so a re-run corrects revised dividends instead of duplicating them. Safe to trigger manually.

export const runtime = 'nodejs';
export const maxDuration = 120;

const CRON_SECRET = process.env.CRON_SECRET;

// ⚠️ Bookkeeping only — it never throws into the job it describes.
const beat = async (ok, seen, note) => {
  try { await recordJobRun('dividends', { ok, seen: Number(seen) || 0, note: note ? String(note).slice(0, 180) : null }); }
  catch { /* never fail the job on its own telemetry */ }
};

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const out = await syncDividends();
    console.log(`[dividends] ${JSON.stringify(out)}`);
    // ⚠️ THE SYNC REPORTS ITS OWN VERDICT, so the heartbeat follows out.ok rather than "we reached
    // this line". A 502 from the provider returns here normally with ok:false — recording that as a
    // success would put a green clock on a feed that fetched nothing.
    // ⚠️ `written` IS THE FIELD THIS FUNCTION RETURNS. It read `out.upserts ?? out.rows`, neither of
    // which exists, so every run recorded events_seen = 0 — including a run that wrote 22,331 events.
    // A heartbeat that always says zero cannot distinguish a quiet day from a broken feed.
    await beat(!!out?.ok, out?.written, JSON.stringify(out).slice(0, 180));
    return Response.json(out, { status: out.ok ? 200 : 502 });
  } catch (e) {
    // A FIXED STRING, as every other cron in this codebase does. /api/health serves these notes
    // publicly, and this is the one caller that passed an exception through — which is how a dumped
    // INSERT statement came to be published. lib/job-heartbeat.js now also sanitises at the write,
    // but the convention belongs here too.
    console.log(`[dividends] ERROR ${e.message}`);
    await beat(false, 0, 'sync threw');
    return Response.json({ ok: false, error: 'sync_failed' }, { status: 500 });
  }
}
