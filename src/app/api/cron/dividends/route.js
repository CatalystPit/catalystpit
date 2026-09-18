import { syncDividends } from '../../../../lib/dividends/dividend-ingest';

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

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const out = await syncDividends();
    console.log(`[dividends] ${JSON.stringify(out)}`);
    return Response.json(out, { status: out.ok ? 200 : 502 });
  } catch (e) {
    console.log(`[dividends] ERROR ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
