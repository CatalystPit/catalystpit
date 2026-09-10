import { auth } from '@clerk/nextjs/server';
import { createAlert, listAlerts, deleteAlert, setAlertActive, ALERT_TYPES } from '../../../lib/alerts';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET → { alerts, types }. POST { symbol, type, threshold, note } → create. PATCH { id, active } →
// toggle/re-arm. DELETE ?id= → remove. All per authenticated user.
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ alerts: [], types: ALERT_TYPES }, { headers: NO_STORE });
    return Response.json({ alerts: await listAlerts(userId), types: ALERT_TYPES }, { headers: NO_STORE });
  } catch (e) { return Response.json({ alerts: [], types: ALERT_TYPES, error: e.message }, { status: 200, headers: NO_STORE }); }
}

export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const b = await request.json().catch(() => ({}));
    return Response.json({ alerts: await createAlert(userId, b) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
}

export async function PATCH(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b?.id, 10);
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    return Response.json({ alerts: await setAlertActive(userId, id, !!b.active) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
}

export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    return Response.json({ alerts: await deleteAlert(userId, id) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
}
