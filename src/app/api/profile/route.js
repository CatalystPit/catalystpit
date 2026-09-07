import { auth } from '@clerk/nextjs/server';
import { getOrCreateProfile, getPublicProfile, updateProfile } from '../../../lib/profiles';
import { getFollowState } from '../../../lib/community';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET ?handle=foo  → public profile view (anyone).
// GET (no handle)  → the signed-in user's OWN profile (auto-created), for the edit form.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const handle = searchParams.get('handle');

    if (handle) {
      const profile = await getPublicProfile(handle);
      if (!profile) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
      const { userId: viewerId } = await auth();
      const follow = await getFollowState(viewerId, profile.userId);
      return Response.json({ profile: { ...profile, ...follow } }, { headers: NO_STORE });
    }

    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });
    const profile = await getOrCreateProfile(userId);
    return Response.json({ profile, own: true }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[profile] GET failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

// PATCH → update own profile (handle/displayName/bio/xHandle/showWatchlist).
export async function PATCH(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const patch = await request.json().catch(() => ({}));
    const res = await updateProfile(userId, patch);
    if (!res.ok) return Response.json({ error: res.error }, { status: 400, headers: NO_STORE });
    return Response.json({ profile: res.profile }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[profile] PATCH failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
