import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { pitProfiles } from '../../../lib/schema';
import { eq } from 'drizzle-orm';
import { followUser, unfollowUser, getFollowState } from '../../../lib/community';
import { normalizeHandle } from '../../../lib/profiles';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Resolve a target handle → userId.
async function targetUserId(handle) {
  const h = normalizeHandle(handle);
  if (!h) return null;
  const [row] = await db.select({ userId: pitProfiles.userId }).from(pitProfiles).where(eq(pitProfiles.handle, h)).limit(1);
  return row?.userId || null;
}

// POST { handle } → follow.   DELETE ?handle= → unfollow.  Both return updated follow state.
export async function POST(request) {
  return act(request, true);
}
export async function DELETE(request) {
  return act(request, false);
}

async function act(request, follow) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    let handle = null;
    if (follow) { ({ handle } = await request.json().catch(() => ({}))); }
    else { handle = new URL(request.url).searchParams.get('handle'); }

    const target = await targetUserId(handle);
    if (!target) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
    if (target === userId) return Response.json({ error: 'self' }, { status: 400, headers: NO_STORE });

    if (follow) await followUser(userId, target);
    else await unfollowUser(userId, target);

    const state = await getFollowState(userId, target);
    return Response.json(state, { headers: NO_STORE });
  } catch (e) {
    console.log(`[follow] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
