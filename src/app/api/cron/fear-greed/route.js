import { buildFearGreed } from '../../../../lib/fear-greed/build.mjs';
import { recordJobRun } from '../../../../lib/job-heartbeat';

export const runtime = 'nodejs';
// The panel query aggregates ~1,000 tickers of daily history server-side; measured at ~40s of load
// plus a fraction of a second of arithmetic. 120s leaves room without approaching the ceiling.
export const maxDuration = 120;

// CATALYST PIT FEAR & GREED — the daily build.
//
// ── ⚠️ DAILY, BECAUSE THE SLOWEST COMPONENT IS DAILY ────────────────────────
//
// Every component is derived from COMPLETED daily sessions: SPY's close against its 125-session
// average, realized volatility over 21 sessions, the share of the panel above its 50-session
// average, net 252-session highs, and a 20-session credit comparison. None of it is intraday, so
// the index is published as a daily measure and is never labelled live. Running it more often
// would change the timestamp and not the number.
//
// It runs after the U.S. close, late enough for the EOD bars to have landed.

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // The clock moves before the work — a function killed mid-build otherwise leaves no trace that it
  // ever started, which is the failure mode the SEC and Consensus crons both had to learn.
  await recordJobRun('fear-greed', { ok: false, note: 'started' });

  try {
    const r = await buildFearGreed();
    if (!r.published) {
      console.warn(`[fear-greed] not published (${r.reason}) — ${r.componentCount} components`);
      await recordJobRun('fear-greed', {
        ok: false,
        note: `not published: ${r.reason} (${r.componentCount} components)`,
      });
      return Response.json({ ok: false, published: false, ...r }, { status: 500 });
    }
    console.log(`[fear-greed] ${r.score} ${r.zone} · ${r.componentCount} components · ${r.sessions} sessions · ${r.ms}ms`);
    await recordJobRun('fear-greed', {
      ok: true, seen: r.written,
      note: `${r.score} ${r.zone} · ${r.componentCount}/5 components · ${Math.round(r.ms / 1000)}s`,
    });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error(`[fear-greed] build failed: ${e.message}`);
    await recordJobRun('fear-greed', { ok: false, note: 'build failed' });
    return Response.json({ ok: false, error: 'build_failed' }, { status: 500 });
  }
}
