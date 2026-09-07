import { auth } from '@clerk/nextjs/server';
import { resolveUserTier } from '../../../../lib/entitlements';
import { getIdentity, isAdminUser } from '../../../../lib/pit';
import { addComment, listComments, deleteComment } from '../../../../lib/community';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET ?postId= → comments for a post (anyone can read).
export async function GET(request) {
  try {
    const id = parseInt(new URL(request.url).searchParams.get('postId') ?? '', 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });
    const comments = await listComments(id);
    return Response.json({ comments }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[comment] GET failed: ${e.message}`);
    return Response.json({ comments: [] }, { status: 200, headers: NO_STORE });
  }
}

// POST { postId, body } → add a comment. Pro/Elite or admin (matches posting gate).
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const tier = await resolveUserTier();
    const isPro = tier === 'pro' || tier === 'elite';
    if (!isPro && !(await isAdminUser(userId)))
      return Response.json({ error: 'pro_required' }, { status: 403, headers: NO_STORE });

    const { postId, body } = await request.json().catch(() => ({}));
    const id = parseInt(postId, 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });

    const identity = await getIdentity(userId);
    const comment = await addComment(id, userId, identity, body);
    if (!comment) return Response.json({ error: 'empty' }, { status: 400, headers: NO_STORE });
    return Response.json({ comment }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[comment] POST failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

// DELETE ?id= → author or admin removes a comment.
export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });
    const id = parseInt(new URL(request.url).searchParams.get('id') ?? '', 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });
    const res = await deleteComment(id, userId, await isAdminUser(userId));
    if (!res.ok) return Response.json({ error: res.error }, { status: res.error === 'forbidden' ? 403 : 404, headers: NO_STORE });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[comment] DELETE failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
