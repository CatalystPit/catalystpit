import { auth } from '@clerk/nextjs/server';
import { getLists, createList, renameList, deleteList } from '../../../../lib/watchlists';
import { resolveUserTier } from '../../../../lib/entitlements';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET → the user's named watchlists (+ default id + per-list counts).
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json(await getLists(userId), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

// POST { name } → create a list (Pro-gated via the per-tier list cap). 403 when the cap is hit.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const tier = await resolveUserTier();
    const res = await createList(userId, body?.name, tier);
    if (res.error) return Response.json(res, { status: 403, headers: NO_STORE });
    return Response.json(await getLists(userId), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

// PATCH { id, name } → rename.
export async function PATCH(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const id = parseInt(body?.id, 10);
    if (!id) return Response.json({ error: 'id required' }, { status: 400, headers: NO_STORE });
    const res = await renameList(userId, id, body?.name);
    if (res.error) return Response.json(res, { status: 400, headers: NO_STORE });
    return Response.json(await getLists(userId), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

// DELETE ?id= → delete a non-default list and its tickers.
export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
    if (!id) return Response.json({ error: 'id required' }, { status: 400, headers: NO_STORE });
    const res = await deleteList(userId, id);
    if (res.error) return Response.json(res, { status: 400, headers: NO_STORE });
    return Response.json(await getLists(userId), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
