import { auth } from '@clerk/nextjs/server';
import { computeConfluence } from '../../../lib/confluence';
import { resolveUserTier } from '../../../lib/entitlements';
import { isAdminUser } from '../../../lib/pit';

export const runtime = 'nodejs';
export const maxDuration = 30;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL = 1800;              // 30 min — underlying filings move slowly
const FREE_ROWS = 5;          // public teaser

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(k, v, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/set/${encodeURIComponent(k)}?EX=${ttl}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(v) }); } catch { /* non-fatal */ }
}

// GET ?dir=bull|bear → ranked confluence list. Public teaser (first 5) for free/signed-out;
// Pro/Elite get the full board. Full list cached in KV (30 min); tier only controls the slice.
async function boardFor(dir) {
  let full = await kvGet(`confluence:${dir}`);
  if (!full) { full = await computeConfluence(dir); await kvSet(`confluence:${dir}`, full, TTL); }
  return full;
}

export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;

    // Single-ticker lookup (for ticker-page badges) — returns that name's standing on each
    // board regardless of tier; it's one ticker, and it promotes the full feature.
    const tickerParam = sp.get('ticker');
    if (tickerParam) {
      const sym = tickerParam.toUpperCase();
      const pick = async (dir) => {
        const full = await boardFor(dir);
        const idx = full.findIndex((r) => r.ticker === sym);
        return idx >= 0 ? { rank: idx + 1, ...full[idx] } : null;
      };
      const [bull, bear] = await Promise.all([pick('bull'), pick('bear')]);
      return Response.json({ ticker: sym, bull, bear }, { headers: NO_STORE });
    }

    const dir = sp.get('dir') === 'bear' ? 'bear' : 'bull';

    const full = await boardFor(dir);

    const { userId } = await auth();
    const tier = await resolveUserTier();
    const admin = userId ? await isAdminUser(userId) : false;
    const isFull = tier === 'pro' || tier === 'elite' || admin;   // admin sees the full board too
    const list = isFull ? full : full.slice(0, FREE_ROWS);
    const lockedCount = isFull ? 0 : Math.max(0, full.length - FREE_ROWS);

    return Response.json({ dir, list, lockedCount, tier, total: full.length }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[confluence] ${e.message}`);
    return Response.json({ dir: 'bull', list: [], lockedCount: 0, error: e.message }, { status: 200, headers: NO_STORE });
  }
}
