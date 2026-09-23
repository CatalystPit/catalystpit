// THE ROLLOVER CHECK, RUN ONCE BY A JOB — NEVER BY A VIEWER.
//
// ⚠️ WHERE THIS RUNS IS THE WHOLE DEDUPLICATION DESIGN. If the heatmap route emitted the warning,
// a thousand people opening the board during an outage would emit a thousand identical alerts at
// the exact moment the logs most need to be readable. So the check is not in the read path at all:
// it is a cron (/api/cron/heatmap-gate), and a viewer cannot cause it to run, log or alert. The
// cooldown below is a second belt for the cron's own repetition, not the primary defence.
//
// ⚠️ AND IT READS THE BOARD'S OWN STATE RATHER THAN RE-DERIVING IT. canonicalSessionDate() is the
// same function heatmapBoard() calls, so the monitor cannot form a second opinion that disagrees
// with what customers are being served. It has no write path to the board and no way to promote a
// session — it takes the verdict and describes it.

import { heatmapUniverse, canonicalSessionDate } from './heatmap-store';
import { assessRollover, rolloverLogLine, ROLLOVER } from './heatmap-gate-health.mjs';

// The board this monitors is the shared Top 500 — the one both /heatmap and the homepage read.
const MONITORED_LIMIT = 500;

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// The same namespace guard the snapshot store uses: `.env.local` points at the production Upstash
// instance, so an un-namespaced local run would otherwise suppress or fire production alerts.
const NS = String(process.env.CP_HEATMAP_KV_NAMESPACE || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
const PREFIX = NS ? `cp:hm:${NS}` : 'cp:hm';

/**
 * ⚠️ KEYED BY THE SESSION, NOT JUST BY "AN ALERT FIRED". A cooldown keyed only on the condition
 * would swallow the first alert for a NEW stuck session while the previous one's window was still
 * open — the second outage in a morning would be silent, which is when you least want silence.
 */
export const alertKey = (session) => `${PREFIX}:gate:alerted:${session}`;
export const stateKey = () => `${PREFIX}:gate:abnormal`;

/** How long one stuck session stays quiet after alerting. Long enough not to fill the log. */
export const ALERT_COOLDOWN_SEC = 60 * 60;
/** The abnormal marker outlives the cooldown so recovery is still detectable a day later. */
export const STATE_KEEP_SEC = 36 * 60 * 60;

const kv = async (path, body) => {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

/**
 * Claim the right to alert for this session. True at most once per cooldown window.
 *
 * ⚠️ `NX`, NOT `NX=true`. Upstash answers `NX=true` with `400 ERR syntax error`, which this helper
 * turns into null — read here as "somebody already alerted", so EVERY alert would be suppressed
 * forever and the monitor would be silently dead. This exact character cost the heatmap its
 * rebuild lock once already; it is not being rediscovered a second time.
 */
async function claimAlert(session) {
  const r = await kv(`/set/${encodeURIComponent(alertKey(session))}/1?NX&EX=${ALERT_COOLDOWN_SEC}`);
  return r?.result === 'OK';
}

const markAbnormal = (session) =>
  kv(`/set/${encodeURIComponent(stateKey())}/${encodeURIComponent(session)}?EX=${STATE_KEEP_SEC}`);
const readAbnormal = async () => (await kv(`/get/${encodeURIComponent(stateKey())}`))?.result ?? null;
const clearAbnormal = () => kv(`/del/${encodeURIComponent(stateKey())}`);

/**
 * Run the check once.
 *
 * @returns the assessment, plus `alerted` / `recovered` describing what this run actually emitted.
 */
export async function checkRollover({ now = Date.now() } = {}) {
  const universe = await heatmapUniverse(MONITORED_LIMIT);
  const canonical = await canonicalSessionDate(universe.map((u) => u.ticker));
  const a = assessRollover({ canonical, now });
  a.universe = universe.length;

  const previously = await readAbnormal();

  if (!a.ok && a.state === ROLLOVER.STALE_INGEST) {
    await markAbnormal(a.expectedSession);
    // ⚠️ console.error, NOT console.log. Everything else in this codebase logs with console.log,
    // which means an operational fault is one line among thousands of routine ones. This is the
    // only heatmap condition that wants waking someone up for, so it gets the level that platform
    // log filters and alert rules can actually select on.
    const first = await claimAlert(a.expectedSession);
    if (first) console.error(`[heatmap-gate] STALE EOD INGEST — board held on old session. ${rolloverLogLine(a)}`);
    return {
      ...a,
      alerted: first,
      recovered: false,
      heartbeatNote: `stale EOD ingest: canonical ${a.canonicalSession} < expected ${a.expectedSession}`,
    };
  }

  // ⚠️ RECOVERY IS AUTOMATIC AND LEAVES NOTHING BEHIND. The moment the candidate reaches quorum
  // the board advances on its own, this run sees a healthy state, and the marker is deleted — no
  // manual database cleanup, no acknowledgement step, no key to remember to remove. The cooldown
  // key expires by itself on the same principle.
  let recovered = false;
  if (previously) {
    console.log(`[heatmap-gate] RESOLVED — EOD ingest caught up. ${rolloverLogLine(a)}`);
    await clearAbnormal();
    recovered = true;
  }
  return {
    ...a,
    alerted: false,
    recovered,
    heartbeatNote: a.state === ROLLOVER.AWAITING_INGEST
      ? `awaiting ingest for ${a.candidateSession} (${a.candidateCoverage}/${a.requiredCoverage})`
      : `on ${a.canonicalSession}`,
  };
}
