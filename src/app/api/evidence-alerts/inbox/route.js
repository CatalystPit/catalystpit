import { auth } from '@clerk/nextjs/server';
import { listAlerts, unreadAlertCount, markRead } from '../../../../lib/alerts/evidence-alert-store';

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
    return Response.json({ alerts: [], unread: 0, error: e.message }, { headers: NO_STORE });
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
    return Response.json({ error: e.message }, { status: 400, headers: NO_STORE });
  }
}
