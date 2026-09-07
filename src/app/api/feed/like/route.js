import { auth } from '@clerk/nextjs/server';
import { setPostReaction } from '../../../../lib/community';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// POST { postId, emoji } → set a reaction (emoji from the allowed set) or remove it (emoji null).
// Any signed-in user (free or Pro). Returns the post's reaction summary.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const { postId, emoji } = await request.json().catch(() => ({}));
    const id = parseInt(postId, 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });

    const res = await setPostReaction(id, userId, emoji || null);
    return Response.json(res, { headers: NO_STORE });
  } catch (e) {
    console.log(`[feed_like] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
