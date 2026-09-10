import { auth, clerkClient } from '@clerk/nextjs/server';
import { reviewList, reviewStats, resolveReviewItem } from '../../../../lib/security-resolver';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

async function isAdmin() {
  try {
    const { userId } = await auth();
    if (!userId || !ADMIN_EMAIL) return false;
    const u = await (await clerkClient()).users.getUser(userId);
    const email = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress || u.emailAddresses[0]?.emailAddress;
    return !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  } catch { return false; }
}

// GET → open review items + resolver stats. POST { kind, key, ticker } → resolve one. Admin only.
export async function GET() {
  if (!(await isAdmin())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const [items, stats] = await Promise.all([reviewList({ limit: 200 }), reviewStats()]);
    return Response.json({ items, stats }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: NO_STORE }); }
}

export async function POST(request) {
  if (!(await isAdmin())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const b = await request.json().catch(() => ({}));
    const kind = b?.kind === 'name' ? 'name' : 'cusip';
    if (!b?.key || !b?.ticker) return Response.json({ error: 'key and ticker required' }, { status: 400 });
    const stats = await resolveReviewItem(kind, b.key, b.ticker);
    return Response.json({ ok: true, stats }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: NO_STORE }); }
}
