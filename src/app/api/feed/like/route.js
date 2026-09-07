import { auth } from '@clerk/nextjs/server';
import { toggleLike } from '../../../../lib/community';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// POST { postId, on } → like (on=true) / unlike (on=false). Any signed-in user (free or Pro).
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const { postId, on } = await request.json().catch(() => ({}));
    const id = parseInt(postId, 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });

    const res = await toggleLike(id, userId, !!on);
    return Response.json(res, { headers: NO_STORE });
  } catch (e) {
    console.log(`[feed_like] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
