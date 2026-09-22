// THE SHARED REALTIME HEATMAP SNAPSHOT — one provider refresh per 15 minutes, for everybody.
//
// ⚠️ THE ECONOMICS ARE THE POINT. Upstream work must be a function of TIME, not of audience:
//
//     500 symbols / 100 per request  =   5 Tiingo requests per rebuild
//     4 rebuilds per hour            =  ~20 Tiingo requests/hour
//
// and that number is the same whether ten people are looking at the board or ten thousand. A
// design where each viewer's request can rebuild the snapshot has upstream cost proportional to
// traffic, which is the one shape that cannot survive growth.
//
// ⚠️ WHAT IS CACHED IS THE PROVIDER WORK, AND ONLY THAT. Not the board, not the tiles, not the
// sectors — just the ticker→price map the 1D numerator needs. The board is still assembled per
// request from the stored closes and the universe, so sizing, sectors and the baseline session are
// never frozen by this.
//
// ⚠️ AND IT IS A SEPARATE NAMESPACE FROM EVERY OTHER CACHE IN THE PRODUCT:
//
//     cp:hm:rt:<limit>     this snapshot — Pro only, 15 minutes
//     quotes rt:<symbols>  NEVER STORED (in-flight coalescing only) — see /api/quotes
//     quotes eod:<symbols> the shared delayed quote cache
//     heatmap EOD          the CDN's public cache on the route itself
//
// A collision between any two of those is a Pro board reaching a Free reader, so the prefix is
// unique and carries `rt` explicitly. This store checks no entitlement: the caller resolves the
// session first and only then asks, because a cache that decides who may read it is a second
// entitlement system waiting to disagree with the first.

/** How long a snapshot is the CURRENT answer. */
export const SNAPSHOT_TTL_SEC = 15 * 60;
export const SNAPSHOT_FRESH_MS = SNAPSHOT_TTL_SEC * 1000;

/**
 * ⚠️ HOW LONG IT SURVIVES IN THE STORE, WHICH IS DELIBERATELY LONGER THAN ITS LIFE AS THE ANSWER.
 *
 * If the provider fails at the moment a rebuild is due, the choice is between a blank board, a
 * fabricated one, and the last thing we genuinely knew. The third is the only honest option — but
 * only if it is LABELLED as what it is, which is why freshness is judged from `calculatedAt`
 * rather than from the key still existing. Expiring the key at the TTL would throw away the
 * fallback exactly when it is needed.
 */
// ⚠️ LONG ENOUGH TO SURVIVE THE WHOLE CLOSED PERIOD, WHICH IS WHY IT IS A DAY AND NOT AN HOUR.
// After the closing bell the last snapshot of the session becomes the frozen board and is served
// until the official completed-session close lands — hours later, and across a weekend, days
// later. An hour's retention would drop it at 5pm and hand the evening a blank intraday board.
// Correctness does not rest on this number: the reader keyed by `sessionDate` refuses a snapshot
// from a different session no matter how long it survived.
export const SNAPSHOT_KEEP_SEC = 26 * 60 * 60;
export const SNAPSHOT_STALE_LIMIT_MS = SNAPSHOT_KEEP_SEC * 1000;

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * ⚠️ A NAMESPACE SO THAT NOTHING RUN LOCALLY CAN TOUCH THE PRODUCTION BOARD.
 *
 * `.env.local` points at the SAME Upstash instance as production. A probe run from a laptop
 * therefore reads, rewrites and expires the keys real viewers are being served from — which is
 * exactly what happened while this feature was being verified: a local run replaced the live
 * snapshot, and an earlier one came within a branch of marking the whole trading day suspended.
 *
 * Every heatmap key now carries this prefix segment. Production leaves it unset and keeps the
 * original key names; any probe, test or script sets CP_HEATMAP_KV_NAMESPACE and is then
 * physically unable to name a production key, whatever it asks for. A guard rather than a
 * convention: there is no spelling of `snapshotKey` under a namespace that collides with the
 * un-namespaced one.
 */
const NS = String(process.env.CP_HEATMAP_KV_NAMESPACE || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
const PREFIX = NS ? `cp:hm:${NS}` : 'cp:hm';

/** True when this process is namespaced away from production. Exported so probes can assert it. */
export const kvNamespace = () => NS || null;

export const snapshotKey = (limit) => `${PREFIX}:rt:${Number(limit) || 0}`;

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

/** Age in ms, or null when the stamp is missing or unparseable. */
export function snapshotAgeMs(snap, { now = Date.now() } = {}) {
  if (!snap?.calculatedAt) return null;
  const t = Date.parse(snap.calculatedAt);
  if (!Number.isFinite(t)) return null;
  return now - t;
}

/**
 * What this snapshot is right now: 'fresh', 'stale', or null when it is unusable.
 *
 * Exported and pure because this single decision is the difference between a board labelled
 * honestly and one that is not.
 */
export function snapshotState(snap, { now = Date.now() } = {}) {
  if (!snap?.prices || !Object.keys(snap.prices).length) return null;
  const age = snapshotAgeMs(snap, { now });
  if (age == null) return null;
  // A snapshot from the future is a clock fault, not a fresh one.
  if (age < -SNAPSHOT_FRESH_MS) return null;
  if (age <= SNAPSHOT_FRESH_MS) return 'fresh';
  if (age <= SNAPSHOT_STALE_LIMIT_MS) return 'stale';
  return null;
}

/**
 * Read the snapshot.
 *
 * Returns `{ snap, state }`. A caller wanting only a current answer checks `state === 'fresh'`;
 * the rebuild path uses `'stale'` as its fallback when the provider is unreachable.
 */
export async function readSnapshot(limit) {
  const r = await kv(`/get/${encodeURIComponent(snapshotKey(limit))}`);
  const raw = r?.result;
  if (!raw) return { snap: null, state: null };
  try {
    const snap = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { snap, state: snapshotState(snap) };
  } catch { return { snap: null, state: null }; }
}

export async function writeSnapshot(limit, prices, { provider = 'tiingo', calculatedAt, sessionDate = null } = {}) {
  if (!prices || !Object.keys(prices).length) return null;
  const snap = {
    prices,
    // The builder passes the instant it captured the batch, so the stored snapshot and the board
    // that just built it report the SAME "last updated" time. Defaulted for direct callers.
    calculatedAt: calculatedAt || new Date().toISOString(),
    // ⚠️ WHICH SESSION THESE PRICES BELONG TO — the field that makes freezing safe. After the bell
    // the board serves this snapshot for hours, so age cannot be the test of whether it is the
    // right one; the session it was captured in is. Without it, Saturday traffic would be served
    // Thursday's prices under Friday's date.
    sessionDate,
    provider,
    count: Object.keys(prices).length,
    kind: 'heatmap-realtime-1d',
  };
  await kv(`/set/${encodeURIComponent(snapshotKey(limit))}?EX=${SNAPSHOT_KEEP_SEC}`, snap);
  return snap;
}

/**
 * ⚠️ SINGLE FLIGHT ACROSS PROCESSES, NOT JUST WITHIN ONE.
 *
 * In-process coalescing collapses concurrent requests inside ONE serverless instance and does
 * nothing about the other instances answering the same burst — which is precisely the situation a
 * traffic spike creates. A short KV lock means that when a snapshot expires under load, ONE
 * instance rebuilds and the rest serve the previous snapshot for a few seconds rather than each
 * launching their own five-request batch.
 *
 * The lock is short and self-expiring: a crashed holder delays the next rebuild by seconds, never
 * blocks it. Failing to ACQUIRE is not an error — it means somebody else is already doing the work.
 */
export const REBUILD_LOCK_SEC = 30;
export const lockKey = (limit) => `${PREFIX}:rt:lock:${Number(limit) || 0}`;

export async function acquireRebuildLock(limit) {
  // SET NX: succeeds only if absent, so exactly one caller wins.
  //
  // ⚠️ `NX`, NOT `NX=true` — AND THIS EXACT CHARACTER DIFFERENCE IS A SILENT TOTAL FAILURE. The
  // REST API rejects `NX=true` with `400 {"error":"ERR syntax error"}`, which this helper turns
  // into null, which reads here as "somebody else holds the lock". Every instance would then
  // decline to rebuild, forever: the snapshot would never be written, every board would fall back
  // to completed-session prices, and nothing would log an error — a Pro heatmap permanently stuck
  // on EOD with every unit test still green. Found by counting real upstream requests, which is
  // the only check that could have found it.
  const r = await kv(`/set/${encodeURIComponent(lockKey(limit))}/1?NX&EX=${REBUILD_LOCK_SEC}`);
  return r?.result === 'OK';
}

/**
 * ⚠️ THE UNSCHEDULED CLOSURE, WHICH NO CALENDAR CAN CONTAIN.
 *
 * market-session.mjs derives every SCHEDULED NYSE closure exactly, and that is all a rule set can
 * honestly do. A national day of mourning, a weather closure or a trading halt obeys no rule, so on
 * such a day the clock reports "regular session" against a market that never opened.
 *
 * Rather than guess, that case is DETECTED: a rebuild that returns nothing the entitlement gate
 * calls realtime is evidence the market is not trading, and the day is marked here. Subsequent
 * requests exit before any batch, so an unforeseen closure costs ONE futile set of requests for the
 * whole day instead of one per rebuild.
 *
 * Keyed by ET CALENDAR DATE and expiring inside a day, so the next morning starts clean on its own
 * — a suspension can never outlive the day that justified it.
 */
export const SUSPEND_KEEP_SEC = 18 * 60 * 60;
export const suspendKey = (etDate) => `${PREFIX}:rt:nosession:${etDate}`;

export async function suspendSession(etDate) {
  if (!etDate) return false;
  const r = await kv(`/set/${encodeURIComponent(suspendKey(etDate))}/1?EX=${SUSPEND_KEEP_SEC}`);
  return r?.result === 'OK';
}

export async function isSessionSuspended(etDate) {
  if (!etDate) return false;
  const r = await kv(`/get/${encodeURIComponent(suspendKey(etDate))}`);
  return r?.result != null;
}
