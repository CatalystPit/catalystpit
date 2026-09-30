import { auth } from '@clerk/nextjs/server';
import { errorResponse } from '../../../lib/user-error.mjs';
import { createAlert, createScanAlert, listAlerts, deleteAlert, setAlertActive, CREATABLE_ALERT_TYPES } from '../../../lib/alerts';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET → { alerts, types }. POST { symbol, type, threshold, note } → create. PATCH { id, active } →
// toggle/re-arm. DELETE ?id= → remove. All per authenticated user.
//
// `types` is the CREATABLE set only — the picker must never offer a rule the engine cannot fire
// (see ALERT_TYPES in lib/alerts.js). A rule already stored under a retired type still comes back
// in `alerts`, so it stays visible and deletable rather than vanishing from the user's list.
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ alerts: [], types: CREATABLE_ALERT_TYPES }, { headers: NO_STORE });
    return Response.json({ alerts: await listAlerts(userId), types: CREATABLE_ALERT_TYPES }, { headers: NO_STORE });
  } catch (e) {
    // ⚠️ "No alerts yet" IS WHAT THE PANEL RENDERS FOR AN EMPTY LIST. Returning one with HTTP 200 on
    // a failed read told a user their armed rules did not exist — the same rules the engine is still
    // evaluating server-side. A 503 lets the panel say it could not load them.
    console.log(`[alerts] GET ${String(e?.message || e)}`);
    return Response.json({ error: 'alerts_unavailable' }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const b = await request.json().catch(() => ({}));
    // A scan alert carries a filters object ("alert when matched"); otherwise it's a symbol alert.
    const out = (b && b.filters && typeof b.filters === 'object')
      ? await createScanAlert(userId, b)
      : await createAlert(userId, b);
    return Response.json({ alerts: out }, { headers: NO_STORE });
  } catch (e) {
    // A refusal the user can act on keeps its message; our own failure does not become a 400.
    const { body, status } = errorResponse(e, 'alerts_unavailable');
    if (status !== 400) console.log(`[alerts] ${String(e?.message || e)}`);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b?.id, 10);
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    return Response.json({ alerts: await setAlertActive(userId, id, !!b.active) }, { headers: NO_STORE });
  } catch (e) {
    // A refusal the user can act on keeps its message; our own failure does not become a 400.
    const { body, status } = errorResponse(e, 'alerts_unavailable');
    if (status !== 400) console.log(`[alerts] ${String(e?.message || e)}`);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    return Response.json({ alerts: await deleteAlert(userId, id) }, { headers: NO_STORE });
  } catch (e) {
    // A refusal the user can act on keeps its message; our own failure does not become a 400.
    const { body, status } = errorResponse(e, 'alerts_unavailable');
    if (status !== 400) console.log(`[alerts] ${String(e?.message || e)}`);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
