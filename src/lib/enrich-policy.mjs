// Who gets a real-time headline rewrite, and when a failed one is tried again. Pure.
//
// COST, NOT QUALITY, DRIVES THE TIERS. Measured over 48 hours before this existed: 77% of all rewrite
// submissions went to importance-0 wire items, none of which could ever reach X, and 34% went to rows
// that failed validation three times in a row within seconds and ended with no Catalyst wording.
//
//   IMMEDIATE   importance >= 1, a trusted source, a cluster containing one, or a source Facebook
//               only posts in Catalyst wording. Sent the moment it is captured, as before.
//   DEFERRED    importance 0 otherwise. Never sent in real time: Pit Wire shows the normalised
//               source line it was ingested with (already language- and display-gated), exactly as
//               it does for any row waiting on a rewrite. If the event later becomes important —
//               a merge raises its importance, a trusted source joins its cluster — it satisfies
//               IMMEDIATE and the queue picks it up as the canonical event. No status flip is needed
//               for that transition, so no code path can forget to make it.
//
// Social qualification is untouched: X still requires Catalyst wording plus its own importance and
// editorial gates, and a deferred row never has Catalyst wording.

import { TRUSTED_SOURCES, TRUSTED_REWRITE_ATTEMPTS } from './trusted-sources.mjs';
import { FB_REWORDED_SOURCES } from './facebook-post.mjs';

export const IMMEDIATE_MIN_IMPORTANCE = 1;
export const HIGH_IMPORTANCE = 2;

// Attempt budgets. A trusted source keeps its long budget (its wording must never be what the tape
// settles on) but no longer spends it within minutes; see retryDecision.
export const ATTEMPTS_TRUSTED = TRUSTED_REWRITE_ATTEMPTS;
export const ATTEMPTS_HIGH = 3;
export const ATTEMPTS_ORDINARY = 2;

// A claim older than this belongs to a worker that crashed or timed out. The slowest claimant is
// the ingest sweep (maxDuration 120s) and a model call times out at 45s, so three minutes cannot
// steal a live claim.
export const CLAIM_STALE_SECONDS = 180;

// The ingest sweep's inline enrichment only takes rows captured this recently. Everything older is
// backlog, which the enrichment cron batches.
export const FRESH_MINUTES = 15;

// Validation reasons that describe the SHAPE of one sampled output. Another sample can plausibly
// pass, so they are retried. Grounding reasons (an ungrounded number or name, an unresolved ticker,
// an invented cause, a reversed direction) come from the model reading the same source the same
// way, so an ordinary item does not pay for them twice. HIGH-importance and trusted items still
// retry every reason, because for those the wording gates publication.
export const RESAMPLE_REASONS = new Set(['empty', 'too_long', 'multiline', 'hype', 'verbatim_copy', 'no_output', 'unparseable']);

export const isTrustedSource = (source) => TRUSTED_SOURCES.has(String(source || '').toUpperCase());
export const isRewordedSource = (source) => FB_REWORDED_SOURCES.has(String(source || '').toUpperCase());

/** @param {{importance?:number, source?:string, clusterTrusted?:boolean}} row */
export function rewriteTier(row) {
  if (isTrustedSource(row?.source) || row?.clusterTrusted) return 'immediate';
  if (isRewordedSource(row?.source)) return 'immediate';
  return (Number(row?.importance) || 0) >= IMMEDIATE_MIN_IMPORTANCE ? 'immediate' : 'deferred';
}

export function attemptBudget({ importance = 0, trusted = false } = {}) {
  if (trusted) return ATTEMPTS_TRUSTED;
  return (Number(importance) || 0) >= HIGH_IMPORTANCE ? ATTEMPTS_HIGH : ATTEMPTS_ORDINARY;
}

// Delay before attempt N+1, given N attempts made. The FIRST retry of an important item is
// immediate (the next pass, seconds away), which is what it was before — a CRITICAL flash whose
// first rewrite fails must not wait. Later retries back off instead of burning the budget at once.
const IMPORTANT_BACKOFF_S = [0, 120, 600, 1800, 3600];
export const ORDINARY_RETRY_DELAY_S = 600;

/**
 * What happens after a rewrite attempt that did NOT produce Catalyst wording.
 * @param {{importance?:number, trusted?:boolean, attempts:number, reason:string}} a
 *   attempts = attempts made INCLUDING the one that just failed
 * @returns {{retry:boolean, delaySeconds:number|null, final:boolean, why:string}}
 */
export function retryDecision({ importance = 0, trusted = false, attempts, reason }) {
  const budget = attemptBudget({ importance, trusted });
  if (attempts >= budget) return { retry: false, delaySeconds: null, final: true, why: `budget of ${budget} spent` };
  const important = trusted || (Number(importance) || 0) >= HIGH_IMPORTANCE;
  if (important) {
    const d = IMPORTANT_BACKOFF_S[Math.min(attempts - 1, IMPORTANT_BACKOFF_S.length - 1)];
    return { retry: true, delaySeconds: d, final: false, why: trusted ? 'trusted source' : 'high importance' };
  }
  if (!RESAMPLE_REASONS.has(String(reason))) {
    return { retry: false, delaySeconds: null, final: true, why: `grounding failure '${reason}' is not resampled for an ordinary item` };
  }
  return { retry: true, delaySeconds: ORDINARY_RETRY_DELAY_S, final: false, why: 'output-shape failure, one delayed resample' };
}
