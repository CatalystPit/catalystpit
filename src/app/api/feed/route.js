import { auth } from '@clerk/nextjs/server';
import { resolveUserTier } from '../../../lib/entitlements';
import { getIdentity, isAdminUser, rateLimited } from '../../../lib/pit';
import { listFeed, createPost, deletePost } from '../../../lib/community';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET ?scope=global|following&before=ISO → feed posts + viewer context.
export async function GET(request) {
  let userId = null;
  try { ({ userId } = await auth()); } catch { /* signed out */ }
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope') === 'following' ? 'following' : 'global';
    const before = searchParams.get('before') || null;

    const tier = await resolveUserTier();
    const admin = userId ? await isAdminUser(userId) : false;
    const canPost = tier === 'pro' || tier === 'elite' || admin;

    const posts = await listFeed({ scope, viewerId: userId, before, limit: 30 });
    return Response.json(
      { posts, me: { userId, canPost, admin, loggedIn: !!userId } },
      { headers: NO_STORE },
    );
  } catch (e) {
    console.log(`[feed] GET failed: ${e.message}`);
    return Response.json({ posts: [], me: { userId, canPost: false, loggedIn: !!userId }, error: e.message }, { status: 200, headers: NO_STORE });
  }
}

// POST { body } → create a post. Pro/Elite or admin only (matches the chat gate).
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const tier = await resolveUserTier();
    const isPro = tier === 'pro' || tier === 'elite';
    if (!isPro && !(await isAdminUser(userId)))
      return Response.json({ error: 'pro_required' }, { status: 403, headers: NO_STORE });

    if (await rateLimited(`pit:feedrl:${userId}`))
      return Response.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });

    const { body, imageUrl } = await request.json().catch(() => ({}));
    // Only accept an image URL we minted (Vercel Blob public host) — never an arbitrary URL.
    const safeImage = (typeof imageUrl === 'string' && /^https:\/\/[a-z0-9.-]+\.public\.blob\.vercel-storage\.com\//.test(imageUrl))
      ? imageUrl : null;
    const identity = await getIdentity(userId);
    const post = await createPost(userId, identity, body, safeImage);
    if (!post) return Response.json({ error: 'empty' }, { status: 400, headers: NO_STORE });
    return Response.json({ post }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[feed] POST failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

// DELETE ?id= → author or admin removes a post.
export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });
    const id = parseInt(new URL(request.url).searchParams.get('id') ?? '', 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });

    const admin = await isAdminUser(userId);
    const res = await deletePost(id, userId, admin);
    if (!res.ok) return Response.json({ error: res.error }, { status: res.error === 'forbidden' ? 403 : 404, headers: NO_STORE });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[feed] DELETE failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
