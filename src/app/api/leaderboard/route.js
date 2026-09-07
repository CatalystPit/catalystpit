import { getLeaderboard } from '../../../lib/leaderboard';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// GET ?window=week|all → ranked community "Pit Score" leaderboard. Public (read-only).
export async function GET(request) {
  try {
    const window = new URL(request.url).searchParams.get('window') === 'week' ? 'week' : 'all';
    const leaders = await getLeaderboard(window);
    return Response.json({ leaders, window }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[leaderboard] failed: ${e.message}`);
    return Response.json({ leaders: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
