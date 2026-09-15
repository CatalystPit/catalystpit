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
