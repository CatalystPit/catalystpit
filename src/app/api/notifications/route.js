import { auth } from '@clerk/nextjs/server';
import { listNotifications, unreadCount, markAllRead } from '../../../lib/notifications';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET → the signed-in user's recent notifications + unread count.
export async function GET() {
  let userId = null;
  try { ({ userId } = await auth()); } catch { /* signed out */ }
  try {
    if (!userId) return Response.json({ notifications: [], unread: 0, loggedIn: false }, { headers: NO_STORE });
    const [notifications, unread] = await Promise.all([listNotifications(userId), unreadCount(userId)]);
    return Response.json({ notifications, unread, loggedIn: true }, { headers: NO_STORE });
  } catch (e) {
    // ⚠️ THIS IS THE BELL, AND IT REPORTED AN OUTAGE AS "NOTHING FOR YOU". `unread: 0` with an
    // explicit HTTP 200 is a positive claim, and the badge believed it: a person with nine unread
    // notifications watched the count drop to zero because a query failed. The consumer already
    // leaves its current state alone on a non-ok response, which is the honest outcome.
    console.log(`[notifications] GET failed: ${e.message}`);
    return Response.json({ error: 'notifications_unavailable' }, { status: 503, headers: NO_STORE });
  }
}

// POST → mark all as read.
export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });
    await markAllRead(userId);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    // The 500 was right; the exception text was not.
    console.log(`[notifications] POST failed: ${e.message}`);
    return Response.json({ error: 'notifications_unavailable' }, { status: 500, headers: NO_STORE });
  }
}
