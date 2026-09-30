import { auth } from '@clerk/nextjs/server';
import { listAlerts, unreadAlertCount, markRead } from '../../../../lib/alerts/evidence-alert-store';
import { errorResponse } from '../../../../lib/user-error.mjs';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// The Evidence Alert INBOX.
//
//   GET  → { alerts, unread }
//   POST { id } | { all: true } → mark read
//
// ⚠️ THIS READS PERSISTED ROWS AND NEVER THE EVIDENCE ENGINE. The engine resolved this evidence
// once, in the worker, when it became public; re-resolving it on every bell poll would put a
// multi-family evidence build behind a 60-second interval on every signed-in page.
//
// ⚠️ NO ENTITLEMENT GATE ON READING. The alerts were created while the person was entitled and
// they are the person's own records. Hiding them on a lapsed subscription would look like the
// product lost their data; what a lapse stops is CREATING subscriptions, which the sibling route
// enforces.
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ alerts: [], unread: 0 }, { headers: NO_STORE });
    const [alerts, unread] = await Promise.all([listAlerts(userId), unreadAlertCount(userId)]);
    return Response.json({ alerts, unread }, { headers: NO_STORE });
  } catch (e) {
    // ⚠️ THE WORST FAILURE MODE A NOTIFICATION SYSTEM HAS. A failed read returned
    // { alerts: [], unread: 0 } with HTTP 200 — an authoritative "nothing has happened", produced by
    // our own outage, on the one surface whose entire job is to say that something did.
    //
    // The bell in cp-shared reads `r.ok ? await r.json() : null` and applies only a truthy body, so a
    // 503 leaves the last known count on screen rather than zeroing it.
    console.log(`[evidence-alerts:inbox] GET ${String(e?.message || e)}`);
    return Response.json({ error: 'inbox_unavailable' }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
    const b = await request.json().catch(() => ({}));
    await markRead(userId, { id: b?.id, all: b?.all === true });
    return Response.json({ unread: await unreadAlertCount(userId) }, { headers: NO_STORE });
  } catch (e) {
    // Marking read takes no user input that can be invalid, so a throw here is ours, not theirs —
    // and a 400 would have told the client its own request was malformed.
    const { body, status } = errorResponse(e, 'inbox_unavailable');
    if (status !== 400) console.log(`[evidence-alerts:inbox] POST ${String(e?.message || e)}`);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
