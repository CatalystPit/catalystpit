// DELIVERY DECISIONS FOR THE CHANNELS BEING ADDED. Pure: no database, no network, no credentials.
//
// WHY THIS IS SHARED BY INSTAGRAM AND THREADS BUT NOT BY FACEBOOK OR X. The two new channels speak
// the same protocol — create a container, publish the container — and classify failures the same way,
// so a shared module here is one implementation of one thing. Facebook and X share nothing with them:
// different endpoints, different auth, different error envelopes, different tables, and both already
// work. facebook-publisher.js says in its own comments that it duplicates rather than shares with X
// for exactly that reason, and extending a helper across all four would be the first thing to couple
// two publishers that currently cannot break each other.
//
// Everything here is a decision ABOUT a response, never a response. The I/O lives in the two
// publishers; this is what they consult.

export const SOCIAL_CHANNELS = Object.freeze(['instagram', 'threads']);

/** The statuses the table's CHECK constraint allows, named so code cannot drift from the schema. */
export const DELIVERY_STATUS = Object.freeze({
  PENDING: 'pending',
  PUBLISHING: 'publishing',
  POSTED: 'posted',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/** How a failure is categorised. Monitoring groups by this; the drain reads it to decide retryability. */
export const FAILURE_CLASS = Object.freeze({
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
  RATE_LIMITED: 'rate_limited',
  AUTH: 'auth',
  TIMEOUT: 'timeout',
});

export const MAX_DELIVERY_ATTEMPTS = 3;

/** Per-run ceilings. A backlog must never empty itself onto a feed in one pass. */
export const MAX_PER_RUN = Object.freeze({ instagram: 2, threads: 4 });

/**
 * Meta's own published 24-hour ceilings, encoded so the drain can respect them without a doc lookup.
 * Deliberately set BELOW the documented limit: being refused by the provider is a worse way to
 * discover a limit than declining to send.
 */
export const DAILY_POST_LIMIT = Object.freeze({ instagram: 50, threads: 100 });

/** Only the literal string 'true' enables a channel — the same fail-closed rule Facebook uses. */
export const switchedOn = (value) => String(value ?? '') === 'true';

/**
 * ⚠️ WHICH STEP FAILED DECIDES WHETHER A RETRY IS SAFE, and this is the whole reason the two-phase
 * protocol is worth having.
 *
 *   'container' — nothing is published by creating a container. A failure here, of ANY kind including
 *                 a timeout, cannot have produced a post, so retrying is safe. A duplicate container
 *                 is harmless: unpublished containers expire on their own.
 *   'publish'   — this is the only call that can bring a post into existence. A timeout here is
 *                 genuinely ambiguous, so it is never retried automatically.
 */
export const PHASE = Object.freeze({ CONTAINER: 'container', PUBLISH: 'publish' });

/**
 * Classify a provider response into { class, retryable, permanent }.
 *
 * `phase` matters only for the ambiguous cases. An explicit HTTP status is an ANSWER from the
 * provider: if it answered 500 to a publish call, the publish did not happen, so that is retryable
 * even in the publish phase. A transport error or a timeout is not an answer, and in the publish
 * phase it is the one case where the provider may have accepted what we cannot confirm.
 */
export function classifyProviderFailure({ status = null, errorCode = null, phase = PHASE.PUBLISH,
  transport = false, timeout = false } = {}) {
  // Credential problems. Meta's 190 (expired/revoked) and 200 (valid but not permitted — commonly a
  // User token where a Page token is required) are both about the credential, not about this post, so
  // they must not burn the post's attempts: fixing the token should let the queue drain, not find
  // every row exhausted. Same reasoning as failureSpendsAttempt() on the Facebook path.
  const code = Number(errorCode);
  if (code === 190 || code === 200 || status === 401) {
    return { class: FAILURE_CLASS.AUTH, retryable: true, permanent: false, spendsAttempt: false };
  }
  if (status === 429) {
    return { class: FAILURE_CLASS.RATE_LIMITED, retryable: true, permanent: false, spendsAttempt: false };
  }
  if (timeout || transport) {
    // Ambiguous only when publishing. In the container phase there is nothing to be ambiguous about.
    const ambiguous = phase === PHASE.PUBLISH;
    return {
      class: timeout ? FAILURE_CLASS.TIMEOUT : FAILURE_CLASS.TRANSIENT,
      retryable: !ambiguous,
      permanent: false,
      spendsAttempt: true,
      // The caller must leave the row in `publishing` and not reclaim it. Surfaced as a named field
      // rather than inferred, because "retryable: false, permanent: false" alone reads like a bug.
      needsManualReview: ambiguous,
    };
  }
  if (status != null && status >= 500) {
    return { class: FAILURE_CLASS.TRANSIENT, retryable: true, permanent: false, spendsAttempt: true };
  }
  // Any other 4xx is about the request or the content and will fail identically forever.
  if (status != null && status >= 400) {
    return { class: FAILURE_CLASS.PERMANENT, retryable: false, permanent: true, spendsAttempt: true };
  }
  // No status, no transport flag: an unrecognised shape. Treated as transient rather than permanent,
  // because destroying a post over an unparsed response is the worse of the two mistakes.
  return { class: FAILURE_CLASS.TRANSIENT, retryable: true, permanent: false, spendsAttempt: true };
}

/**
 * Exponential backoff with a floor and a ceiling, in milliseconds. Rate limits wait longer than
 * ordinary transient failures: a 429 means the provider has told us the rate is the problem, so
 * trying again in ten seconds is just a second 429.
 */
export function backoffMs(attempts, failureClass) {
  const n = Math.max(1, Math.min(MAX_DELIVERY_ATTEMPTS, Number(attempts) || 1));
  if (failureClass === FAILURE_CLASS.RATE_LIMITED) return Math.min(60 * 60_000, 15 * 60_000 * n);
  if (failureClass === FAILURE_CLASS.AUTH) return 10 * 60_000;      // a human has to fix it
  return Math.min(10 * 60_000, 60_000 * n);
}

/**
 * Freshness, as a single decision with a stated reason.
 *
 * TWO INDEPENDENT BOUNDS, both required. The activation watermark answers "did the operator ask for
 * this event?" — anything received before the channel existed, they did not. The age window answers
 * "is it still news?". The watermark is what makes first activation safe; the window is what stops a
 * row that waited through an outage going out stale.
 */
export const MAX_AGE_MINUTES = 30;

export function freshnessDecision({ receivedAt, activatedAt, now = Date.now(),
  maxAgeMinutes = MAX_AGE_MINUTES } = {}) {
  const t = receivedAt == null ? NaN : new Date(receivedAt).getTime();
  if (!Number.isFinite(t)) return { fresh: false, reason: 'event has no received_at' };
  // No watermark means the channel has never been activated, and in that state nothing is eligible.
  // Fail closed: an absent watermark must not read as "no lower bound".
  const a = activatedAt == null ? NaN : new Date(activatedAt).getTime();
  if (!Number.isFinite(a)) return { fresh: false, reason: 'channel not activated' };
  if (t <= a) return { fresh: false, reason: 'received before the channel was activated' };
  const ageMin = (now - t) / 60_000;
  if (ageMin > maxAgeMinutes) {
    return { fresh: false, reason: `too old (${Math.round(ageMin)}m > ${maxAgeMinutes}m)` };
  }
  return { fresh: true, reason: null };
}

/**
 * May this row be attempted on this pass? Reads only the row's own durable state, so two workers
 * looking at the same row reach the same answer; the atomic claim in the publisher is what makes only
 * one of them act on it.
 */
export function readyToAttempt(row, now = Date.now()) {
  if (!row) return { ready: false, reason: 'no row' };
  if (row.provider_post_id) return { ready: false, reason: 'already posted' };
  if (row.status === DELIVERY_STATUS.POSTED) return { ready: false, reason: 'already posted' };
  if (row.status === DELIVERY_STATUS.FAILED) return { ready: false, reason: 'failed permanently' };
  if (row.status === DELIVERY_STATUS.SKIPPED) return { ready: false, reason: 'skipped' };
  // ⚠️ NEVER AUTOMATICALLY. A row left in `publishing` is one whose publish call we could not confirm;
  // picking it up again is precisely the action that double-posts.
  if (row.status === DELIVERY_STATUS.PUBLISHING) return { ready: false, reason: 'left mid-publish, needs manual review' };
  if (Number(row.attempts) >= MAX_DELIVERY_ATTEMPTS) return { ready: false, reason: 'attempts exhausted' };
  if (row.retry_after && new Date(row.retry_after).getTime() > now) {
    return { ready: false, reason: 'backing off' };
  }
  return { ready: true, reason: null };
}

/**
 * A provider error string, built from the status and the provider's own words and NOTHING else.
 *
 * `redact` is injected rather than imported so this module stays free of the Facebook path; the
 * callers pass redactCredential. It is applied BEFORE the length cap, because Meta echoes the
 * submitted token inside its "Malformed access token" message and a truncated token is still a token.
 */
export function providerErrorText({ status, errorCode = null, subcode = null, message = '', phase = '' },
  redact = (s) => s) {
  const parts = [`HTTP ${status}`];
  if (phase) parts[0] = `${phase}: HTTP ${status}`;
  if (errorCode != null) parts.push(`code ${errorCode}${subcode != null ? `/${subcode}` : ''}`);
  const msg = message ? String(redact(String(message))).slice(0, 160) : '';
  return msg ? `${parts.join(' ')}: ${msg}` : parts.join(' ');
}
