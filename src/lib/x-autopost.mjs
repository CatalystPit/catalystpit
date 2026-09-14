// Catalyst Pit X auto-poster — PURE logic. No DB, no network, no credentials.
//
// Everything that decides WHETHER to post and WHAT the post says lives here, so all of it is unit
// testable without touching X or the database. src/lib/x-publisher.js owns persistence and the API.
//
// The governing rule of this file is that it never invents anything. The post text is assembled
// from a canonical event's own Catalyst Pit wording and its own resolved ticker, and nothing else.
// No implications, no context, no prices we did not measure, no "investors are watching closely".

import { publicationVerdict } from './x-quality.mjs';
import { isTaxonomyLabel } from './news-normalize.mjs';
import { storyVerdict, factsOf } from './x-story.mjs';

export const MODES = ['off', 'dry_run', 'live'];

// Fail closed, and STRICTLY. An exact match against the three declared values — no trimming, no
// case folding, no aliases. Anything else, including "LIVE", "live " and "dry-run", is OFF.
//
// Forgiving parsing is the wrong instinct for a switch that starts publishing to a public account:
// a stray space should mean "not live", never "close enough to live".
export function resolveMode(raw) {
  return MODES.includes(raw) ? raw : 'off';
}

// The single gate on contacting X. Kept here, pure and exhaustively tested, so the proof that dry
// run cannot publish does not depend on being able to import the database layer.
export const canPublish = (rawMode) => resolveMode(rawMode) === 'live';

// ── eligibility ──────────────────────────────────────────────────────────────
// A canonical event qualifies when EITHER
//   A. it scored CRITICAL, or
//   B. any record in its cluster came from Walter Bloomberg, whatever the score.
//
// and in both cases the headline must already be CATALYST PIT'S OWN WORDING. That is the gate that
// makes "never post Walter Bloomberg's original wording" structural rather than a promise:
//   original  - rewritten by the model
//   composed  - written deterministically from an extracted assertion
//   rewrite_pending - still the source's sentence. NEVER eligible; it waits.
//   not_required    - the source's wording is final by design (SEC filings, exchange halt notices).
//                     Also never eligible: it is not ours to publish as our own.
const CATALYST_WORDING = new Set(['original', 'composed']);

export const WALTER_SOURCE = 'WALTERBLOOMBERG';
export const CRITICAL = 3;

/**
 * @param {object} ev canonical event: { importance, headline_status, source_kind, sources[] }
 *   `sources` is every source code in the cluster, the canonical row's own included.
 * @returns {{eligible: boolean, reason: string|null, blocked: string|null}}
 */
export function evaluate(ev) {
  const sources = (ev?.sources || []).map((s) => String(s || '').toUpperCase());
  const isCritical = Number(ev?.importance) === CRITICAL;
  const hasWalter = sources.includes(WALTER_SOURCE);

  if (!isCritical && !hasWalter) return { eligible: false, reason: null, blocked: 'not critical, no Walter provenance' };
  // SEC is never auto-posted. Its wording is the filing's, and its handling is out of scope here.
  if (ev?.source_kind === 'sec') return { eligible: false, reason: null, blocked: 'SEC' };
  if (!CATALYST_WORDING.has(String(ev?.headline_status || ''))) {
    // Not a rejection — a WAIT. The rewrite queue will reach it and the next pass reconsiders.
    return { eligible: false, reason: null, blocked: `awaiting Catalyst wording (${ev?.headline_status})` };
  }
  const reason = isCritical && hasWalter ? 'critical+walter' : isCritical ? 'critical' : 'walter';
  return { eligible: true, reason, blocked: null };
}

// ── text hygiene ─────────────────────────────────────────────────────────────
// Characters the operator has ruled out, plus everything that makes an automated post look
// automated. Applied to the event's own words; it only ever REMOVES, never adds.
const EM_DASH = /[—―]/g;          // — ―
const FORBIDDEN = /[~|—―]/;        // asserted absent after sanitising
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;
const HASHTAG = /(^|\s)#[A-Za-z0-9_]+/g;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

export function sanitize(text) {
  return String(text || '')
    .replace(URL, ' ')
    .replace(EMOJI, ' ')
    .replace(HASHTAG, '$1')
    .replace(EM_DASH, ', ')                 // an em dash becomes ordinary punctuation, not a gap
    .replace(/[~|]/g, ' ')
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:.\-]+/, '')
    .trim();
}

// X's limit is 280. Stopping short leaves room for a reaction line and for any future suffix without
// re-testing the whole formatter.
export const MAX_POST = 270;

// Cut on a word boundary and never leave dangling punctuation. An ellipsis is added only when
// something was actually removed, so the reader can tell.
function clamp(text, budget) {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > budget * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-]+$/, '')}…`;
}

// ── market reaction ──────────────────────────────────────────────────────────
// A second line is allowed ONLY from a measurement we actually hold, and only when it is fresh
// enough to be a reaction to this event rather than a stale daily figure. Nothing is computed or
// estimated here. If no reading qualifies the post goes out as one line, immediately — the reaction
// is never worth waiting for.
export const REACTION_MAX_AGE_MS = 30 * 60 * 1000;

export function reactionLine(reading, now = Date.now()) {
  if (!reading) return null;
  const { label, changePct, asOf } = reading;
  if (!label || !Number.isFinite(Number(changePct))) return null;
  const age = now - Number(asOf ?? NaN);
  if (!Number.isFinite(age) || age < 0 || age > REACTION_MAX_AGE_MS) return null;   // stale = omitted
  const pct = Number(changePct);
  if (Math.abs(pct) < 0.1) return null;                       // noise, not a reaction
  return `${sanitize(label)} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// ── formatting ───────────────────────────────────────────────────────────────
// Three shapes, exactly as specified:
//   macro / geopolitical        BREAKING: <event>
//   ticker-specific             $TICKER: <event>
//   exceptional ticker event    BREAKING: $TICKER <event>   (exceptional = CRITICAL)
export function formatPost(ev, reading = null, now = Date.now(), breaking = null) {
  // A desk label is not a cashtag. The resolver no longer stores one, but a row ingested before
  // that fix still carries tickers:['MACRO'], and "$MACRO" on the public account would be a symbol
  // that does not exist. The account fails closed on its own, independently of the stored row.
  const first = (ev?.tickers || [])[0];
  const ticker = first && !isTaxonomyLabel(first) ? String(first).toUpperCase() : null;
  let body = sanitize(ev?.headline);
  if (!body) return { ok: false, error: 'no headline' };

  // canonicalHeadline prefixes a resolved symbol ("MSFT: Microsoft sets limits…"). Left in it would
  // read "$MSFT: MSFT: Microsoft…".
  if (ticker) body = body.replace(new RegExp(`^\\$?${ticker}\\s*[:\\-]\\s*`, 'i'), '');
  body = body.replace(/^breaking\s*[:\-]\s*/i, '').trim();
  if (!body) return { ok: false, error: 'nothing left after sanitising' };

  // BREAKING is decided by the publication gate, not by the impact score. Passing null keeps the
  // old score-based behaviour for direct callers and tests that predate the gate.
  const brk = breaking === null ? Number(ev?.importance) === CRITICAL : !!breaking;
  // FOUR shapes, not three. A measured macro print that is real and useful but not urgent —
  // "Canada inflation holds at 3.0% year-over-year in August" — goes out as a plain trader-wire
  // line. Without this shape every no-ticker post had to be labelled BREAKING, which is how the
  // label ended up on 68 of 68 candidates and stopped meaning anything.
  const prefix = ticker ? (brk ? `BREAKING: $${ticker} ` : `$${ticker}: `) : (brk ? 'BREAKING: ' : '');

  const reaction = reactionLine(reading, now);
  const tail = reaction ? `\n${reaction}` : '';
  const text = prefix + clamp(body, MAX_POST - prefix.length - tail.length) + tail;

  if (FORBIDDEN.test(text)) return { ok: false, error: 'forbidden character survived sanitising' };
  if (text.length > MAX_POST) return { ok: false, error: `too long (${text.length})` };
  if (/#[A-Za-z0-9_]/.test(text)) return { ok: false, error: 'hashtag survived sanitising' };
  if (URL.test(text)) return { ok: false, error: 'url survived sanitising' };
  const shape = ticker ? (brk ? 'breaking_ticker' : 'ticker') : (brk ? 'breaking' : 'plain');
  return { ok: true, text, chars: text.length, shape };
}

// The whole decision in one call: eligible, then PUBLISHABLE, then formatted.
//
// Eligibility and publication are separate on purpose. Eligibility answers "may Catalyst Pit post
// this", publication answers "should it", and only the second one knows what the account is for.
// A `suppressed` result is terminal and carries an auditable reason; a `blocked` result beginning
// "awaiting" is transient and the event is reconsidered on the next pass.
export function buildCandidate(ev, reading = null, now = Date.now(), priorPosts = null) {
  const verdict = evaluate(ev);
  if (!verdict.eligible) return { eligible: false, reason: null, blocked: verdict.blocked };

  const quality = publicationVerdict(ev, now);
  if (!quality.publish) {
    return { eligible: true, publishable: false, reason: verdict.reason,
      suppressed: quality.reason, terminal: quality.terminal };
  }

  const post = formatPost(ev, reading, now, quality.breaking);
  if (!post.ok) return { eligible: true, publishable: false, reason: verdict.reason,
    suppressed: post.error, terminal: true };

  // LAST gate: has the account already told this story? Only applied when the caller supplies the
  // history, so a pure formatting call stays pure. X-only — Pit Wire's canonical dedupe is not
  // consulted and not affected.
  const story = priorPosts ? storyVerdict({ headline: ev.headline, text: post.text }, priorPosts, now)
    : { post: true, reason: null, storyKey: null };
  if (!story.post) {
    return { eligible: true, publishable: false, reason: verdict.reason,
      suppressed: story.reason, terminal: true, storyKey: story.storyKey };
  }

  return { eligible: true, publishable: true, reason: verdict.reason, breaking: quality.breaking,
    storyKey: story.storyKey, facts: [...factsOf(ev.headline)].join(','), ...post };
}
