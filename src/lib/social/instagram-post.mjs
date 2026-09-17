// INSTAGRAM: the decisions, with no I/O.
//
// Pure. No database, no network, no credentials. Nothing in production imports this yet.
//
// WHAT INSTAGRAM IS FOR HERE. Instagram has no text-only post: every publish needs media. So the
// caption is built from the canonical Catalyst Pit sentence, and the IMAGE is a Catalyst Pit card
// rendered from that same verified sentence. Two rules follow from the brief and are enforced here:
//
//   NO SOURCE NAMES ON THE GRAPHIC. The card carries the Catalyst Pit line and Catalyst Pit's own
//   marks. Provenance stays in the product, where it is a link and a record, not on an image.
//   NO FABRICATION. The caption restates the canonical headline and may add only figures that were
//   already verified upstream. It never adds context, never explains, never speculates.
//
// Media specifications below are Meta's current published values for the Instagram content
// publishing API; they are encoded so a card renderer can be checked against them offline.

import { editorialVoice } from '../facebook-voice.mjs';
import { facebookRelevance } from '../facebook-relevance.mjs';
import { stripLinks, withoutHashtags, FB_CATALYST_WORDING } from '../facebook-post.mjs';
import { normalizeSocialText } from './social-text.mjs';

export const IG_CAPTION_MAX_CHARS = 2200;
export const IG_MAX_HASHTAGS = 30;
export const IG_MAX_AT_TAGS = 20;
export const IG_MIN_CHARS = 10;

/** Meta's published image rules for API publishing. JPEG only is theirs, not a preference of ours. */
export const IG_IMAGE_SPEC = Object.freeze({
  formats: ['image/jpeg'],
  maxBytes: 8 * 1024 * 1024,
  minWidth: 320,
  maxWidth: 1440,
  minAspect: 4 / 5,        // 0.8, portrait limit
  maxAspect: 1.91,         // landscape limit
  colorSpace: 'sRGB',
  mustBePubliclyFetchable: true,
});

export const IG_CATALYST_WORDING = FB_CATALYST_WORDING;

/** Fixed, identical on every post — the same standing block Facebook carries, for the same reason:
 *  derived tags would assert a topic the post does not support. Four tags, far below Meta's 30. */
export const IG_HASHTAGS = ['#stockmarket', '#investing', '#daytrading', '#stocks'];

/**
 * Does a rendered card satisfy Meta's requirements? Returns every failure, not just the first, so a
 * renderer can be corrected in one pass.
 */
export function validateInstagramImage({ contentType, bytes, width, height } = {}) {
  const problems = [];
  if (!IG_IMAGE_SPEC.formats.includes(String(contentType || '').toLowerCase())) {
    problems.push(`format must be JPEG (got ${contentType || 'none'})`);
  }
  if (!(Number(bytes) > 0) || Number(bytes) > IG_IMAGE_SPEC.maxBytes) {
    problems.push(`size must be 1..${IG_IMAGE_SPEC.maxBytes} bytes (got ${bytes ?? 'none'})`);
  }
  const w = Number(width), h = Number(height);
  if (!(w > 0) || !(h > 0)) problems.push('width and height are required');
  else {
    if (w < IG_IMAGE_SPEC.minWidth || w > IG_IMAGE_SPEC.maxWidth) {
      problems.push(`width must be ${IG_IMAGE_SPEC.minWidth}..${IG_IMAGE_SPEC.maxWidth} (got ${w})`);
    }
    const aspect = w / h;
    if (aspect < IG_IMAGE_SPEC.minAspect || aspect > IG_IMAGE_SPEC.maxAspect) {
      problems.push(`aspect ratio must be ${IG_IMAGE_SPEC.minAspect}..${IG_IMAGE_SPEC.maxAspect} (got ${aspect.toFixed(3)})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** A publicly fetchable https URL, which is what Meta requires — it cURLs the URL itself. */
export function isPublicMediaUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return false;
    if (!u.hostname.includes('.')) return false;                       // localhost and friends
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(u.hostname)) return false;
    return true;
  } catch { return false; }
}

/**
 * The caption: the canonical sentence, then the standing hashtag block.
 *
 * The card already carries the sentence, and repeating it in the caption is what every market
 * account does, because a caption is what search and screen readers get.
 */
export function instagramCaption(ev) {
  const raw = String(ev?.headline ?? '').trim();
  if (!raw) return null;
  const normalised = normalizeSocialText(raw);
  const linkless = stripLinks(normalised);            // a caption link is not clickable on Instagram
  if (!linkless) return null;
  const edited = editorialVoice(linkless) || linkless;
  const caption = `${edited.trim()}\n\n${IG_HASHTAGS.join(' ')}`;
  // If the block would push a long line past the ceiling, the story wins and the tags are dropped.
  return caption.length <= IG_CAPTION_MAX_CHARS ? caption : edited.trim();
}

export const countHashtags = (s) => (String(s ?? '').match(/(^|\s)#[A-Za-z0-9_]+/g) || []).length;
export const countAtTags = (s) => (String(s ?? '').match(/(^|\s)@[A-Za-z0-9_.]+/g) || []).length;

/**
 * May this canonical event go to Instagram?
 *
 * Identical event gates to Threads, plus the one Instagram adds: there is no post without media, so
 * an event with no valid card is not eligible — a WAIT, like awaiting wording, because the card is
 * produced by our own renderer and can be retried.
 */
export function instagramEligibility(ev, { isNew, isCanonical, qualifies = true, image = null } = {}) {
  const no = (reason) => ({ eligible: false, reason });
  if (!ev) return no('no event');
  if (!qualifies) return no('event does not qualify for Instagram');
  if (!isNew) return no('not a new row');
  if (!isCanonical) return no('duplicate folded into an existing event');
  if (!IG_CATALYST_WORDING.has(String(ev.headline_status || ''))) {
    return no(`awaiting Catalyst wording (${ev.headline_status || 'none'})`);
  }
  const caption = instagramCaption(ev);
  if (!caption) return no('no caption to publish');
  const story = withoutHashtags(caption);
  if (story.trim().length < IG_MIN_CHARS) return no(`caption too short (${story.trim().length})`);
  const rel = facebookRelevance(story, ev.tickers || []);
  if (!rel.relevant) return no(rel.reason);
  if (caption.length > IG_CAPTION_MAX_CHARS) return no(`caption too long (${caption.length})`);
  if (countHashtags(caption) > IG_MAX_HASHTAGS) return no('too many hashtags');
  if (countAtTags(caption) > IG_MAX_AT_TAGS) return no('too many @ tags');
  if (!image) return no('awaiting card render');
  if (!isPublicMediaUrl(image.url)) return no('card url is not publicly fetchable');
  const v = validateInstagramImage(image);
  if (!v.ok) return no(`card fails Instagram media rules: ${v.problems.join('; ')}`);
  return { eligible: true, reason: null };
}

export function instagramConfig(env = process.env) {
  return {
    enabled: String(env.INSTAGRAM_AUTO_POST_ENABLED ?? '') === 'true',
    igUserId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID || null,
    // Reuses the Facebook credential deliberately: the Instagram professional account hangs off the
    // same Page, in the same Business portfolio, reachable with the same System User token.
    systemUserToken: env.FACEBOOK_SYSTEM_USER_TOKEN || null,
    pageToken: env.FACEBOOK_PAGE_ACCESS_TOKEN || null,
    graphVersion: env.FACEBOOK_GRAPH_VERSION || 'v26.0',
  };
}

export function instagramReadiness(cfg) {
  return {
    enabled: !!cfg.enabled,
    hasIgUserId: !!cfg.igUserId,
    credentialMode: cfg.systemUserToken ? 'system_user' : (cfg.pageToken ? 'page_token' : 'none'),
    graphVersion: cfg.graphVersion,
    ready: !!(cfg.igUserId && (cfg.systemUserToken || cfg.pageToken)),
  };
}

/**
 * The three calls Instagram publishing needs, as data. The container id returned by step 1 is the
 * idempotency handle: a worker that dies after creating it can publish the SAME container rather
 * than creating a second post, which is what Facebook's /feed cannot offer.
 */
export function instagramPublishPlan({ igUserId, imageUrl, caption, graphVersion = 'v26.0' }) {
  const base = `https://graph.facebook.com/${graphVersion}/${igUserId}`;
  return {
    createContainer: { method: 'POST', url: `${base}/media`, body: { image_url: imageUrl, caption } },
    checkStatus: { method: 'GET', url: `https://graph.facebook.com/${graphVersion}/<container-id>?fields=status_code`,
      readyWhen: 'FINISHED', terminal: ['ERROR', 'EXPIRED'] },
    publish: { method: 'POST', url: `${base}/media_publish`, body: { creation_id: '<container-id>' } },
    // Meta's published limits, encoded so the scheduler can respect them without a doc lookup.
    containerExpiryHours: 24,
    postsPer24h: 100,
    containersPer24h: 400,
  };
}
