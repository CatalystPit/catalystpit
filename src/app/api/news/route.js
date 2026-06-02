import { auth } from '@clerk/nextjs/server';

export const runtime = 'nodejs';

// Dedicated, AUTH-VARYING news route. Reads the SAME KV key /api/claude reads for
// top_stories (catalystpit:top_stories), with the identical Upstash client +
// double-JSON-parse handling, but gates the article set server-side by LOGIN STATE
// (not tier — news is a commodity; a free login is the beta-funnel hook). Signed-in
// users of ANY tier get the full feed; signed-out users get the teaser. /api/claude
// stays public + CDN-cached (s-maxage) for the homepage; THIS route varies per user
// and MUST NOT be CDN-cached — Cache-Control: private, no-store.
//
// NOTE: this gate is intentionally AUTH-based, distinct from the Bulls/Bears gate
// which is correctly TIER-based (resolveUserTier). Two different gates by design.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const SIGNED_OUT_ROW_COUNT = 5;                       // hero (1) + 5 rows for signed-out visitors
const SIGNED_OUT_VISIBLE = 1 + SIGNED_OUT_ROW_COUNT;  // first 6 raw elements

// Mirrors /api/claude's kvGet (same Upstash REST client). cache:'no-store' so the
// per-user route never serves a stale shared fetch result after a cron refresh.
async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: 'no-store',
  });
  const data = await res.json();
  return data.result;
}

export async function GET() {
  // Auth state only — logged-in-or-not, NOT tier. Signed-out → userId null (auth() does not throw).
  const { userId } = await auth();
  const loggedIn = !!userId;

  let raw = [];
  let source = 'empty';
  let lastRefresh = null;
  try {
    let val = await kvGet('catalystpit:top_stories');
    lastRefresh = await kvGet('catalystpit:last_refresh');
    // Copy /api/claude's parse handling: Upstash returns a string; may be double-encoded.
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { val = null; } }
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { val = null; } }
    if (Array.isArray(val) && val.length) { raw = val; source = 'cache'; }
  } catch { /* KV error → treat as empty, never throw */ }

  // Slice the RAW array (no reorder/normalize — element 0 stays the hero) so
  // NewsFeed's existing client-side normalization works unchanged. Signed-in users
  // get the full feed; signed-out get the teaser and the locked rows never ship.
  const data = loggedIn ? raw : raw.slice(0, SIGNED_OUT_VISIBLE);
  const lockedCount = loggedIn ? 0 : Math.max(0, raw.length - SIGNED_OUT_VISIBLE);

  return Response.json(
    { data, lockedCount, loggedIn, source, lastRefresh },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
