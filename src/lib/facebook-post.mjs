// WALTER BLOOMBERG → CATALYST PIT FACEBOOK PAGE: the decisions, with no I/O.
//
// Pure. No database, no network, no credentials. The caller supplies the ingested event; this says
// whether it may go to Facebook and exactly what text to send. Keeping it pure is what lets the
// tests exercise the same code production runs, and it guarantees no token can pass through here.

/** Only this source. One entry, by instruction; adding another is a deliberate edit. */
import { editorialVoice } from './facebook-voice.mjs';
import { facebookRelevance } from './facebook-relevance.mjs';

export const FB_SOURCE_WHITELIST = new Set(['WALTERBLOOMBERG', 'ZEROHEDGE']);

/**
 * Sources published in CATALYST PIT'S OWN WORDS rather than their own.
 *
 * Walter is a headline relay: republishing his line, with the presentation cleaned up, is the
 * arrangement. ZeroHedge is a publisher with original copyrighted prose and a strong editorial
 * voice — "Explodes", "Blast", "Fabrications & Lies" — and putting that on the Page verbatim would
 * put their voice and their politics there too. For these sources the post is built from `headline`,
 * the model's own rewrite, which has already passed the grounding gate in headline-writer.
 *
 * The consequence is a WAIT: `headline` only holds our wording once enrichment has run, so an event
 * from one of these sources is not eligible at ingest. See queueRewordedFacebook().
 */
export const FB_REWORDED_SOURCES = new Set(['ZEROHEDGE']);

/** The statuses that mean `headline` is Catalyst Pit's wording, not the publisher's. */
export const FB_CATALYST_WORDING = new Set(['original', 'composed']);

/** Whether this event must be published in our words rather than the source's. */
export const isRewordedSource = (ev) =>
  FB_REWORDED_SOURCES.has(String(ev?.source || '').toUpperCase());

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

/**
 * Links are removed from every post.
 *
 * Walter's items carry t.co shorteners and ZeroHedge's carry article URLs; neither belongs on the
 * Page. A bare link sends the reader away, and Facebook's own preview unfurl would rewrite how the
 * post looks. It also removes a defect the editorial pass had created: the terminal full stop was
 * being appended to a bare URL ("https://t.co/3TXWilnZWT."), which breaks the link in some clients.
 *
 * Removed BEFORE the editorial pass, so facebook-voice's fact guard compares the same text on both
 * sides and does not read a stripped link as a dropped fact.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

export function stripLinks(text) {
  return String(text ?? '')
    .replace(URL_RE, ' ')
    // A link often sat alone on its own line, or after a comma: tidy what removing it left behind.
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]*([,;:])\s*$/gm, '')
    .replace(/\(\s*\)/g, '')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

export function facebookText(ev) {
  // A REWORDED SOURCE PUBLISHES OUR SENTENCE, NOT THEIRS. `headline` is the model's rewrite; it is
  // only Catalyst Pit's wording once enrichment has run, which facebookEligibility enforces, so
  // there is no path here that puts a publisher's prose on the Page as our own.
  const raw = isRewordedSource(ev)
    ? String(ev?.headline ?? '')
    : (String(ev?.source_headline ?? '') || String(ev?.headline ?? ''));
  if (!raw) return null;
  const normalised = raw
    .replace(/\r\n?/g, '\n')          // CRLF and CR both become LF
    .replace(/ /g, ' ')          // non-breaking space -> space
    .replace(/[​-‍﻿]/g, '')  // zero-width joiners and BOM
    .replace(/[ \t]+\n/g, '\n')       // trailing spaces on a line
    .replace(/\n{3,}/g, '\n\n')       // runs of blank lines
    .replace(WALTER_ATTRIBUTION, '')  // the public credit, dropped
    .trim();
  // Links out, before the editorial pass sees the text.
  const linkless = stripLinks(normalised);
  if (!linkless) return null;
  // CATALYST PIT'S VOICE. Presentation only — capitalisation, the flash asterisk, the trailing
  // outlet tag, terminal punctuation. editorialVoice is total and failure-safe: it returns the input
  // unchanged on a throw, an empty result, or any fact that moved, so it can never be the reason a
  // post fails to publish. See facebook-voice.mjs.
  const edited = editorialVoice(linkless) || linkless;
  return withHashtags(edited);
}

/**
 * The standing hashtag block, appended to every Facebook post.
 *
 * Fixed and identical on every post by request — not derived from the story, so there is no way for
 * it to assert a topic the post does not support. They are added AFTER the editorial pass, so
 * facebook-voice's fact guard compares the story against the story and never sees them.
 */
export const FB_HASHTAGS = ['#stockmarket', '#investing', '#daytrading', '#stocks'];
const HASHTAG_BLOCK = FB_HASHTAGS.join(' ');
// Anchored to the end, and tolerant of spacing, so re-running this on text that already carries the
// block cannot produce it twice.
const HASHTAG_BLOCK_RE = new RegExp(
  '\\n*\\s*' + FB_HASHTAGS.map((h) => '\\' + h).join('\\s+') + '\\s*$', 'i');

/** The published text with the standing block removed — i.e. the story on its own. */
export const withoutHashtags = (text) =>
  String(text ?? '').replace(HASHTAG_BLOCK_RE, '').trimEnd();

export function withHashtags(text) {
  const body = withoutHashtags(text);
  if (!body) return text;
  const withTags = `${body}\n\n${HASHTAG_BLOCK}`;
  // A POST IS NEVER LOST TO MAKE ROOM FOR HASHTAGS. Eligibility measures this exact string, so if
  // the block would carry a long post past the limit, the story ships without it.
  return withTags.length <= FB_MAX_CHARS ? withTags : body;
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
  // A REWORDED SOURCE WAITS FOR OUR SENTENCE. Until enrichment has produced Catalyst Pit wording,
  // `headline` still holds the publisher's line, and publishing that as our own is the one thing
  // this path exists to prevent. Not a rejection — a wait; queueRewordedFacebook() reconsiders it.
  if (isRewordedSource(ev) && !FB_CATALYST_WORDING.has(String(ev.headline_status || ''))) {
    return no(`awaiting Catalyst wording (${ev.headline_status || 'none'})`);
  }
  if (isBackfill) return no('backfill or replay, not a live ingest');
  if (!isNew) return no('not a new row');
  if (!isCanonical) return no('duplicate folded into an existing event');

  const text = facebookText(ev);
  if (!text) return no('no text to publish');
  // THE MINIMUM MEASURES THE STORY, NOT THE PUBLISHED STRING. The standing hashtag block adds ~43
  // characters to every post, which would carry a two-character junk item past a ten-character floor
  // and publish it. The floor is a judgement about content, so it is applied to the content.
  const story = withoutHashtags(text);
  if (story.length < FB_MIN_CHARS) return no(`text too short (${story.length})`);
  // THE PAGE IS ABOUT ECONOMICS AND MARKETS. An allowlist, applied to BOTH sources — measured on
  // live rows it drops about half of ZeroHedge (military, electoral, cultural) and about a quarter
  // of Walter. See facebook-relevance.mjs for why it is an allowlist rather than a blocklist.
  const rel = facebookRelevance(story, ev.tickers || []);
  if (!rel.relevant) return no(rel.reason);
  // The maximum measures what is actually sent, because that is what Facebook limits.
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
    //
    // TWO CREDENTIAL MODES, and the System User one is the correct production shape.
    //
    //   FACEBOOK_SYSTEM_USER_TOKEN   a Business Manager System User token, expiry "Never". It is a
    //                                USER-type token, so it cannot post to a Page directly — see
    //                                resolvePageToken(). Exchanged at runtime for the Page token.
    //   FACEBOOK_PAGE_ACCESS_TOKEN   a Page-type token, used as-is.
    //
    // The System User token wins when both are set, because it is the one that does not expire and
    // the one whose derived Page token can be re-derived automatically after an invalidation.
    systemUserToken: env.FACEBOOK_SYSTEM_USER_TOKEN || null,
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
    hasSystemUserToken: !!cfg.systemUserToken,
    // Which credential the publisher will actually use. Booleans and a mode name only — this is the
    // field an operator reads to confirm the System User path is live, so it must never widen into
    // anything that carries the credential itself.
    credentialMode: cfg.systemUserToken ? 'system_user' : (cfg.token ? 'page_token' : 'none'),
    graphVersion: cfg.graphVersion,
    ready: cfg.enabled && !!cfg.pageId && (!!cfg.token || !!cfg.systemUserToken),
  };
}
