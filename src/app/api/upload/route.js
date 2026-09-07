import { auth } from '@clerk/nextjs/server';
import { put } from '@vercel/blob';
import { resolveUserTier } from '../../../lib/entitlements';
import { isAdminUser } from '../../../lib/pit';

export const runtime = 'nodejs';
export const maxDuration = 30;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const MAX_BYTES = 4 * 1024 * 1024;   // 4MB (server upload body limit on Vercel)
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// POST multipart { file } → uploads an image to Vercel Blob, returns its public URL.
// Pro/Elite or admin only (same gate as posting). Requires BLOB_READ_WRITE_TOKEN in the env.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const tier = await resolveUserTier();
    const isPro = tier === 'pro' || tier === 'elite';
    if (!isPro && !(await isAdminUser(userId)))
      return Response.json({ error: 'pro_required' }, { status: 403, headers: NO_STORE });

    if (!process.env.BLOB_READ_WRITE_TOKEN)
      return Response.json({ error: 'uploads_not_configured' }, { status: 503, headers: NO_STORE });

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return Response.json({ error: 'no_file' }, { status: 400, headers: NO_STORE });
    if (!OK_TYPES.includes(file.type)) return Response.json({ error: 'bad_type' }, { status: 400, headers: NO_STORE });
    if (file.size > MAX_BYTES) return Response.json({ error: 'too_large' }, { status: 400, headers: NO_STORE });

    const safeName = (file.name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
    const blob = await put(`feed/${userId}/${safeName}`, file, { access: 'public', addRandomSuffix: true });
    return Response.json({ url: blob.url }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[upload] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
