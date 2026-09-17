// THREADS: the decisions, with no I/O.
//
// Pure. No database, no network, no credentials. Nothing in production imports this yet — it is the
// formatter half of the Instagram/Threads plan, written so the editorial questions can be settled and
// tested before any Meta configuration exists.
//
// WHAT THREADS IS FOR HERE. Text-first market news in Catalyst Pit's own sentence. The canonical
// event already carries a verified, grounded headline; this restates nothing and invents nothing.
// Media is optional on Threads and is deliberately NOT part of the first cut.
//
// Everything reused from the Facebook path is reused deliberately: the same relevance allowlist, the
// same editorial voice pass with its fact guard, the same link stripping. The differences are the
// platform's: a 500-character ceiling measured in UTF-8 bytes, and no standing hashtag block.

import { editorialVoice } from '../facebook-voice.mjs';
import { facebookRelevance } from '../facebook-relevance.mjs';
import { stripLinks, withoutHashtags, FB_CATALYST_WORDING } from '../facebook-post.mjs';
import { normalizeSocialText } from './social-text.mjs';

/**
 * Threads counts a post against 500 CHARACTERS, but its own documentation notes that emoji are
 * counted as their UTF-8 bytes. Nothing here emits emoji, and market copy is overwhelmingly ASCII,
 * so the byte count is the safe measure: it can only ever be >= the character count.
 */
export const THREADS_MAX_CHARS = 500;
export const THREADS_MIN_CHARS = 10;
export const utf8Length = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

/** Sources whose own words may never be published as ours — the same rule Facebook applies. */
export const THREADS_CATALYST_WORDING = FB_CATALYST_WORDING;

/**
 * The post text: the canonical Catalyst Pit sentence, cleaned for presentation, and nothing else.
 *
 * NO HASHTAG BLOCK. Facebook carries a fixed four-tag block by instruction; on Threads a standing
 * block reads as spam and Threads' own topic tags assert a topic, which is a claim we would be
 * making about the story rather than quoting from it.
 *
 * NO EMOJI, ever, and no link: a link would make this a link post rather than a market line, and the
 * canonical event's URL belongs on Pit Wire, not in the copy.
 */
export function threadsText(ev) {
  const raw = String(ev?.headline ?? '').trim();
  if (!raw) return null;
  const normalised = normalizeSocialText(raw);
  const linkless = stripLinks(normalised);
  if (!linkless) return null;
  // Presentation only, and failure-safe: editorialVoice returns its input unchanged if anything moved.
  const edited = editorialVoice(linkless) || linkless;
  return edited.trim() || null;
}

/**
 * May this canonical event go to Threads?
 *
 * The gates are the Facebook gates minus Facebook's source whitelist: Threads is a Catalyst Pit
 * channel for our own wording, so what qualifies is the EVENT (importance or trusted evidence),
 * never a particular publisher's copy. Callers supply `qualifies` — the eligibility decision made by
 * the platform's own scan — so this module stays pure and has no opinion about which events matter.
 */
export function threadsEligibility(ev, { isNew, isCanonical, qualifies = true } = {}) {
  const no = (reason) => ({ eligible: false, reason });
  if (!ev) return no('no event');
  if (!qualifies) return no('event does not qualify for Threads');
  if (!isNew) return no('not a new row');
  if (!isCanonical) return no('duplicate folded into an existing event');
  // OUR SENTENCE ONLY. Until enrichment has produced Catalyst wording, `headline` is still the
  // publisher's line. A wait, not a rejection — the scan reconsiders it.
  if (!THREADS_CATALYST_WORDING.has(String(ev.headline_status || ''))) {
    return no(`awaiting Catalyst wording (${ev.headline_status || 'none'})`);
  }
  const text = threadsText(ev);
  if (!text) return no('no text to publish');
  const story = withoutHashtags(text);
  if (story.length < THREADS_MIN_CHARS) return no(`text too short (${story.length})`);
  const rel = facebookRelevance(story, ev.tickers || []);
  if (!rel.relevant) return no(rel.reason);
  // NOTHING IS EVER TRUNCATED: cutting a headline changes what it says. A line this long is a sign
  // something upstream went wrong, and skipping it is better than publishing half of it.
  if (utf8Length(text) > THREADS_MAX_CHARS) return no(`text too long (${utf8Length(text)} > ${THREADS_MAX_CHARS})`);
  return { eligible: true, reason: null };
}

/** Configuration, read from the environment so the kill switch takes effect without a deployment. */
export function threadsConfig(env = process.env) {
  return {
    // FAILS CLOSED, exactly like Facebook's: only the literal string 'true' enables publishing.
    enabled: String(env.THREADS_AUTO_POST_ENABLED ?? '') === 'true',
    userId: env.THREADS_USER_ID || null,
    token: env.THREADS_ACCESS_TOKEN || null,
    apiVersion: env.THREADS_API_VERSION || 'v1.0',
    host: env.THREADS_API_HOST || 'graph.threads.net',
  };
}

export function threadsReadiness(cfg) {
  return {
    enabled: !!cfg.enabled,
    hasUserId: !!cfg.userId,
    hasToken: !!cfg.token,
    apiVersion: cfg.apiVersion,
    ready: !!(cfg.userId && cfg.token),
  };
}

/**
 * The two calls Threads publishing needs, as data rather than as requests, so the shape can be tested
 * without a credential. The caller performs them; `creation_id` from the first is the idempotency
 * handle for the second.
 */
export function threadsPublishPlan({ userId, text, apiVersion = 'v1.0', host = 'graph.threads.net' }) {
  const base = `https://${host}/${apiVersion}/${userId}`;
  return {
    createContainer: { method: 'POST', url: `${base}/threads`, body: { media_type: 'TEXT', text } },
    publish: { method: 'POST', url: `${base}/threads_publish`, body: { creation_id: '<from step 1>' } },
    // Meta's own guidance for Threads containers. Not a guess: their publishing page states it.
    recommendedWaitMs: 30_000,
  };
}
