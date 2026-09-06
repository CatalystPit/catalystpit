import { resolveUserTier } from '../../../../lib/entitlements';

export const runtime = 'nodejs';

// Current user's tier ('free' | 'pro' | 'elite') for client UI (account plan badge).
// Varies per user → never CDN-cached.
export async function GET() {
  const tier = await resolveUserTier();
  return Response.json({ tier }, { headers: { 'Cache-Control': 'private, no-store' } });
}
