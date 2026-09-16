// WALTER BLOOMBERG → CATALYST PIT FACEBOOK PAGE: the decisions, with no I/O.
//
// Pure. No database, no network, no credentials. The caller supplies the ingested event; this says
// whether it may go to Facebook and exactly what text to send. Keeping it pure is what lets the
// tests exercise the same code production runs, and it guarantees no token can pass through here.

/** Only this source. One entry, by instruction; adding another is a deliberate edit. */
export const FB_SOURCE_WHITELIST = new Set(['WALTERBLOOMBERG']);

// Facebook's own ceiling is ~63k characters. This is far below it and exists for a different reason:
// a post longer than this is not a Walter flash, it is something that went wrong upstream, and
// publishing it unread is worse than skipping it. Nothing is ever truncated — truncating a headline
// changes what it says.
export const FB_MAX_CHARS = 5000;
export const FB_MIN_CHARS = 10;

/**
 * The exact text to publish.
 *
 * `source_headline` is the ingested text EXACTLY as Walter published it. `headline` is the Catalyst
 * Pit display line, which the deterministic composer and later the rewriter may have rephrased — it
 * is the right thing for Pit Wire and the wrong thing here, because this automation republishes
 * Walter verbatim rather than our reading of him. So the canonical headline is only ever a fallback
 * for a row that somehow has no source text, and a row with neither is skipped.
 *
 * Two transformations, and no others. Transport normalisation Meta requires: CRLF to LF,
 * non-breaking and zero-width characters that survive a Telegram copy/paste removed, trailing
 * whitespace trimmed. And the trailing source attribution is dropped — see below. No word is
 * otherwise added, removed or reordered.
 */

/**
 * The attribution Walter appends to his own posts, removed from the PUBLIC text only.
 *
 * This says nothing about where a post may come from. Walter remains the sole permitted source and
 * that is enforced by FB_SOURCE_WHITELIST against `ev.source`, which is provenance carried by the
 * ingested row — never by anything in the text. Stripping the visible credit cannot widen the source
 * rule, because the source rule has never read the text.
 *
 * Anchored to the END and to this handle specifically. Measured over all 105 ingested Walter events,
 * every one ends with exactly "(@WalterBloomberg)" and not a single character follows it, so a
 * trailing match covers the whole corpus. It is deliberately NOT a general "(@anything)" strip: a
 * headline that genuinely ends by quoting another account's handle is content, not attribution.
 */
const WALTER_ATTRIBUTION = /\s*\(\s*@WalterBloomberg\s*\)\s*$/i;

export function facebookText(ev) {
  const raw = String(ev?.source_headline ?? '') || String(ev?.headline ?? '');
  if (!raw) return null;
  const normalised = raw
    .replace(/\r\n?/g, '\n')          // CRLF and CR both become LF
    .replace(/ /g, ' ')          // non-breaking space -> space
    .replace(/[​-‍﻿]/g, '')  // zero-width joiners and BOM
    .replace(/[ \t]+\n/g, '\n')       // trailing spaces on a line
    .replace(/\n{3,}/g, '\n\n')       // runs of blank lines
    .replace(WALTER_ATTRIBUTION, '')  // the public credit, dropped
    .trim();
  return normalised || null;
}

/**
 * May this ingested event go to the Facebook Page?
 *
 * Returns { eligible, reason }. `reason` is always populated so every skip is auditable.
 *
 * `isNew` and `isCanonical` come from the INSERT itself, not from a later read: an event is eligible
 * only when the insert actually wrote a row (so a replay or a re-ingest of the same item conflicts
 * away and never reaches here) and when it is the canonical event rather than a duplicate folding
 * into one. That is the same signal Pit Wire already uses to decide what is a new unique story.
 */
export function facebookEligibility(ev, { isNew, isCanonical, isBackfill = false } = {}) {
  const no = (reason) => ({ eligible: false, reason });
  if (!ev) return no('no event');
  if (!FB_SOURCE_WHITELIST.has(String(ev.source || '').toUpperCase())) return no('source not whitelisted');
  if (isBackfill) return no('backfill or replay, not a live ingest');
  if (!isNew) return no('not a new row');
  if (!isCanonical) return no('duplicate folded into an existing event');

  const text = facebookText(ev);
  if (!text) return no('no text to publish');
  if (text.length < FB_MIN_CHARS) return no(`text too short (${text.length})`);
  if (text.length > FB_MAX_CHARS) return no(`text too long (${text.length} > ${FB_MAX_CHARS})`);
  return { eligible: true, reason: null };
}

/**
 * Configuration, read from the environment so the kill switch takes effect without a deployment.
 *
 * FAILS CLOSED. Only the exact string 'true' enables publishing: unset, empty, '1', 'TRUE' and 'yes'
 * all leave it off. A switch that can be turned on by a typo is not a switch.
 */
export function facebookConfig(env = process.env) {
  return {
    enabled: String(env.FACEBOOK_AUTO_POST_ENABLED ?? '') === 'true',
    pageId: env.FACEBOOK_PAGE_ID || null,
    // Read here and never returned, logged or rendered. See the note in facebook-publisher.js.
    token: env.FACEBOOK_PAGE_ACCESS_TOKEN || null,
    graphVersion: env.FACEBOOK_GRAPH_VERSION || 'v26.0',
  };
}

/**
 * Meta's dedicated OAuth error code. Every credential problem arrives under it — expired session,
 * revoked token, wrong token type — distinguished further by error_subcode (463 is expiry).
 */
export const META_OAUTH_ERROR_CODE = 190;

/**
 * Meta's PERMISSION error code, which is a credential problem wearing different clothes.
 *
 * 190 is raised when the token is expired or revoked. 200 is raised when the token is VALID but is
 * not allowed to do this — the commonest cause being a User token where a Page token is required,
 * or a Page token whose System User was never assigned the Page. Both are fixed the same way, by an
 * operator replacing the credential, and neither says anything about the post.
 *
 * Learned in production on 2026-09-16. A replaced token took effect on the next deployment and was
 * refused with "(#200) ... requires ... pages_manage_posts permission with page token". Because 200
 * fell through to the 403 branch below, every Walter item queued during the outage was marked
 * permanently failed seconds after arriving and was unreachable by the drain even after the
 * credential was fixed. Posts were destroyed at roughly one per 20 minutes for the length of it.
 */
export const META_PERMISSION_ERROR_CODE = 200;

// The codes that mean "the credential is wrong", as opposed to "the post is wrong". Matched as
// whole numbers via a Set, so 19, 90, 1190, 1900 and 2000 are not swept in by prefix or substring.
const CREDENTIAL_ERROR_CODES = new Set([META_OAUTH_ERROR_CODE, META_PERMISSION_ERROR_CODE]);

/** Whether a Meta rejection is about the CREDENTIAL rather than the post. */
export const isAuthFailure = (errorCode) => CREDENTIAL_ERROR_CODES.has(Number(errorCode));

/**
 * Is a Meta rejection permanent FOR THIS POST, or worth another attempt while it is still fresh?
 *
 * A 400 or 403 about the CONTENT will fail identically forever, so the candidate stops rather than
 * burning retries. A 400 about the CREDENTIAL will not: it says nothing about the post, it is fixed
 * outside this process by replacing the token, and the queued item stays valid until the 30-minute
 * freshness limit expires it.
 *
 * Treating the two alike cost a real post. On 2026-09-15 the Page token expired at 18:00:00 UTC;
 * the 18:04 Walter item was queued correctly, attempted 55 seconds later, rejected with code 190
 * subcode 463, and marked permanently failed while still four minutes old — unreachable by the
 * drain even once the credential was replaced. During a longer outage that loses every post rather
 * than delaying them.
 *
 * This ONLY moves a candidate from terminal to retryable. It does not add attempts (still capped at
 * MAX_FB_ATTEMPTS), does not extend the freshness window, and does not retry anything Meta refused
 * on its merits.
 */
export function isPermanentFailure(httpStatus, errorCode) {
  if (isAuthFailure(errorCode)) return false;
  return httpStatus === 400 || httpStatus === 403;
}

/**
 * Does this failure spend one of the candidate's publishing attempts?
 *
 * Ordinary transient failures do — a rate limit or a 5xx is about this request, and three tries is
 * the right budget before giving up. A CREDENTIAL failure does not. It is not a property of the
 * request at all, it will fail identically on every attempt until a human replaces the token, and
 * spending the budget on it means a post is dead three minutes into an outage that might last hours.
 *
 * So an auth failure leaves the count where it was and the candidate stays retryable. What bounds it
 * is the freshness window, which is the right bound: the post goes out if the credential is fixed
 * while it is still current news, and expires quietly if it is not. Nothing here can extend that
 * window, and nothing here makes a candidate eligible that was not already eligible.
 */
export const failureSpendsAttempt = (errorCode) => !isAuthFailure(errorCode);

/**
 * Strip anything token-shaped out of text that came from Meta before it is stored or returned.
 *
 * NOT paranoia. Meta's "Malformed access token" error echoes the SUBMITTED TOKEN back inside
 * error.message, and postToPage puts error.message straight into failure_reason, which is persisted
 * and returned by the cron route. One malformed-token rejection would therefore write a live
 * credential into the database and hand it back over HTTP.
 *
 * Two shapes: Meta's own EAA-prefixed tokens, and any long unbroken credential-like run. The 40-char
 * floor is above anything that occurs in Meta's prose, so ordinary error text is left readable.
 */
export const redactCredential = (s) => String(s || '')
  .replace(/EAA[A-Za-z0-9_-]{20,}/g, '[redacted]')
  .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');

/** Whether we hold everything needed to publish. Never reveals the token, only whether it is set. */
export function facebookReadiness(cfg) {
  return {
    enabled: cfg.enabled,
    hasPageId: !!cfg.pageId,
    hasToken: !!cfg.token,
    graphVersion: cfg.graphVersion,
    ready: cfg.enabled && !!cfg.pageId && !!cfg.token,
  };
}
