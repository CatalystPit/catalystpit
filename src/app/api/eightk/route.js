import { recentEightK } from '../../../lib/eightk';

export const runtime = 'nodejs';
export const maxDuration = 15;
const NO_STORE = { 'Cache-Control': 'public, max-age=60, s-maxage=60' };

// GET ?all=1 → include routine 8-Ks; default = material catalysts only. ?limit= (max 80).
export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const materialOnly = sp.get('all') !== '1';
    const limit = Math.min(80, Math.max(1, parseInt(sp.get('limit') || '40', 10) || 40));
    const list = await recentEightK({ materialOnly, limit });
    return Response.json({ list, materialOnly }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[eightk-api] ${e.message}`);
    return Response.json({ list: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
