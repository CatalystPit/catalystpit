import { captureIfDue } from '../../../../lib/market/delayed-store.mjs';
import { marketPhase } from '../../../../lib/market/market-session.mjs';

// THE FREE DELAYED COLLECTOR — one market capture every 15 minutes, during the session only.
//
// ⚠️ THIS EXISTS BECAUSE FIRE-AND-FORGET FROM A REQUEST HANDLER DOES NOT WORK ON SERVERLESS, AND
// IT FAILED IN PRODUCTION BEFORE THIS ROUTE WAS WRITTEN.
//
// The first version called `captureIfDue().catch(() => {})` from /api/quotes without awaiting, so
// a viewer never waited on a 3-second market-wide collection. The platform then froze the instance
// as soon as the response was returned and the promise was killed mid-flight: `cp:dq:latest` was
// written once at 18:39 and never again, and at 15.4 minutes old nothing had been captured or
// released. An unawaited promise in a response path is not a background job, it is a hope.
//
// A cron is also the better shape on its own merits: the capture cadence should depend on the
// MARKET, not on whether somebody happened to load a page. With no traffic at 09:45 the
// traffic-driven version would collect nothing, and there would then be nothing to release at
// 10:00 either — the delay pipeline would simply never start.
//
// ⚠️ THE SCHEDULE IS A COARSE WINDOW; THE SESSION GATE IS THE RULE. The cron fires */15 across a
// UTC hour range that brackets the session either side. captureIfDue() then checks marketPhase()
// and returns without touching the provider unless the regular session is genuinely open — which
// is what makes early closes (13:00 on a half-day), holidays and DST correct without the schedule
// knowing anything about them. A firing outside the session costs one KV-free function invocation
// and zero Tiingo requests.

export const runtime = 'nodejs';
export const maxDuration = 60;           // a full-market capture measured ~3s

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  // Same guard the other cron routes use: Vercel signs its own invocations.
  if (CRON_SECRET) {
    const auth = request.headers.get('authorization') || '';
    const key = new URL(request.url).searchParams.get('key');
    if (auth !== `Bearer ${CRON_SECRET}` && key !== CRON_SECRET) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
  }

  const session = marketPhase();
  try {
    const r = await captureIfDue();
    return Response.json({
      ok: true,
      captured: r.captured,
      reason: r.reason,
      // Reported so a run that did nothing says WHY — 'session-closed' outside the bells,
      // 'not-due' inside the interval, 'locked' when another instance is already collecting.
      session: { phase: session.phase, sessionDate: session.sessionDate, earlyClose: session.earlyClose },
      symbols: r.kept ?? null,
      capturedAt: r.capturedAt ?? null,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.log(`[cron/delayed-snapshot] ${e.message}`);
    return Response.json({ ok: false, error: 'capture_failed' }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
}
