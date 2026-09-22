// THE SHARED REALTIME HEATMAP SNAPSHOT — one provider refresh per 15 seconds, not per viewer.
//
// ⚠️ WHAT THIS CACHES IS THE PROVIDER WORK, AND ONLY THAT. Not the board, not the tiles, not the
// sectors — just the ticker→price map that the 1D numerator needs. The board is still assembled
// per request from the stored closes and the universe, so nothing about sizing, sectors or the
// baseline session is frozen by this; the only thing being shared is the expensive, rate-limited,
// identical-for-everyone half.
//
// ⚠️ AND IT IS A SEPARATE NAMESPACE FROM EVERY OTHER CACHE IN THE PRODUCT, DELIBERATELY:
//
//     cp:hm:rt:<limit>     this snapshot — Pro only, 15s
//     quotes rt:<symbols>  NEVER STORED (in-flight coalescing only) — see /api/quotes
//     quotes eod:<symbols> the shared delayed quote cache
//     heatmap EOD          the CDN's public cache on the route itself
//
// A collision between any two of those is a Pro board reaching a Free reader, so the prefix is
// unique and carries `rt` explicitly rather than relying on the universe size to disambiguate.
//
// ⚠️ THIS STORE IS NEVER READ ON AN UNENTITLED PATH. The caller resolves the session first and
// only then asks; nothing here checks entitlement, because a cache that decides who may read it is
// a second entitlement system waiting to disagree with the first.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

/** ⚠️ THE TTL IS THE PRODUCT PROMISE. A snapshot older than this is not "slightly stale realtime",
 *  it is end-of-day data wearing a live label, and the caller degrades rather than serving it. */
export const SNAPSHOT_TTL_SEC = 15;
/** Belt to the TTL's braces: even if the store hands back something expired, this rejects it. */
export const SNAPSHOT_MAX_AGE_MS = 20_000;

export const snapshotKey = (limit) => `cp:hm:rt:${Number(limit) || 0}`;

const kv = async (path, body) => {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
};

/**
 * Is this snapshot still describing the market NOW?
 *
 * Exported and pure so the staleness rule is testable without a network — it is the difference
 * between a REALTIME label and a lie, and it should not live only inside an async function.
 */
export function snapshotIsFresh(snap, { now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  if (!snap || !snap.calculatedAt) return false;
  const t = Date.parse(snap.calculatedAt);
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  // A snapshot from the future is a clock fault, not a fresh one.
  return age >= -maxAgeMs && age <= maxAgeMs && snap.prices && Object.keys(snap.prices).length > 0;
}

export async function readSnapshot(limit) {
  const r = await kv(`/get/${encodeURIComponent(snapshotKey(limit))}`);
  const raw = r?.result;
  if (!raw) return null;
  try {
    const snap = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return snapshotIsFresh(snap) ? snap : null;
  } catch { return null; }
}

export async function writeSnapshot(limit, prices, { provider = 'tiingo' } = {}) {
  if (!prices || !Object.keys(prices).length) return null;
  const snap = {
    prices,
    calculatedAt: new Date().toISOString(),
    provider,
    count: Object.keys(prices).length,
    // Stamped so a reader of the raw store can tell what it is without consulting this file.
    kind: 'heatmap-realtime-1d',
  };
  await kv(`/set/${encodeURIComponent(snapshotKey(limit))}?EX=${SNAPSHOT_TTL_SEC}`, snap);
  return snap;
}
