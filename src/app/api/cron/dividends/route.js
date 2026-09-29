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
    await beat(!!out?.ok, out?.upserts ?? out?.rows, JSON.stringify(out).slice(0, 180));
    return Response.json(out, { status: out.ok ? 200 : 502 });
  } catch (e) {
    console.log(`[dividends] ERROR ${e.message}`);
    await beat(false, 0, e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
