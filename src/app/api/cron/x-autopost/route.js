import { generateCandidates, publishPending, mode } from '../../../../lib/x-publisher';

export const runtime = 'nodejs';

// Generates X post candidates from canonical Pit Wire events. It NEVER calls X's create-post
// endpoint: publishing is a separate, deliberately un-wired step in x-publisher.js, and this route
// has no path to it at all. In dry_run the full pipeline runs and the result is persisted for
// inspection; in off it does nothing.
//
// Eligibility, wording and formatting are decided in src/lib/x-autopost.mjs, which is pure and
// fully unit tested. This route is only the schedule.
const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const p = new URL(request.url).searchParams;
    const res = await generateCandidates({
      sinceHours: Number(p.get('hours') || 24),
      limit: Number(p.get('limit') || 200),
    });
    // Publishing is a SEPARATE step and gated on the mode being exactly `live`. In dry_run and off
    // this returns without reading the database or touching a credential, so the generation pass
    // above behaves identically to how it always has.
    const pub = await publishPending();
    console.log(`[x-autopost] ${JSON.stringify(res)} published=${pub.sent} mode=${pub.mode}`);
    return Response.json({ ok: true, ...res, published: pub.sent, liveCallsMade: pub.sent },
      { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('[x-autopost]', e?.message);
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
