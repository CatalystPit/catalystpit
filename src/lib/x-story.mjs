// X story continuity guard. PURE — no DB, no network. The caller supplies prior posts.
//
// This is X-ONLY and sits AFTER the publication quality gate. It does not touch, read or influence
// Pit Wire's canonical dedupe, which is correct to keep every one of a developing story's events:
// a trader scanning the tape wants them all. A public account does not. Over six days the Saudi
// pipeline attack produced 35 publishable candidates, 51% of everything that would have gone out.
//
// The rule: a developing story gets ONE post, and a follow-up only for a materially new verified
// fact. Fails closed — when it cannot tell whether something is new, it does not post.

import { normWords } from './event-cluster.mjs';
import { numericFacts } from './news-normalize.mjs';

export const STORY_WINDOW_MS = 24 * 60 * 60 * 1000;
// A hard ceiling regardless of how much genuinely new information a story produces. Even a real
// escalation does not justify an account posting about one subject more often than this.
export const MAX_POSTS_PER_STORY = 3;
// Minimum spacing between two posts on one story. A burst of sources reporting the same development
// within a few minutes is the single most common shape of repetition.
export const MIN_STORY_GAP_MS = 45 * 60 * 1000;

// ── market prints ────────────────────────────────────────────────────────────
// A price update is a different kind of story from an event, and the anchor logic could not see it.
// The account posted "Brent crude rises 3.5% to $108.23" at 23:03 and "Brent crude reaches $108" at
// 05:37 the next morning: the same instrument at the same level, six hours apart, the second one
// LESS precise than the first. They read as separate stories only because their other anchors
// differed (middle/east vs saudi/pipeline), which is exactly the wrong thing to key a price on.
//
// So a print is identified by its INSTRUMENT, and a follow-up needs a real move rather than a new
// sentence about the same number. The instrument vocabulary below is a vocabulary, not a special
// case: aliases collapse to one identity the way "brent", "WTI" and "crude" are all the oil price.
const INSTRUMENTS = [
  ['oil', /\b(?:brent|wti|crude|oil price|oil futures)\b/i],
  ['natgas', /\b(?:nat(?:ural)?\s?gas|henry hub|ttf)\b/i],
  ['gold', /\b(?:gold|bullion)\b/i],
  ['silver', /\bsilver\b/i],
  ['copper', /\bcopper\b/i],
  ['bitcoin', /\b(?:bitcoin|btc)\b/i],
  ['ether', /\b(?:ethereum|ether|eth)\b/i],
  ['sp500', /\b(?:s&p\s?500|spx)\b/i],
  ['nasdaq', /\b(?:nasdaq(?:\s?100)?|ndx)\b/i],
  ['dow', /\b(?:dow jones|the dow)\b/i],
  ['dollar', /\b(?:dollar index|dxy|greenback|u\.?s\.? dollar)\b/i],
  ['treasury', /\b(?:treasury|treasuries|10-?year yield|2-?year yield|bond yield)\b/i],
];
// A movement verb plus a level or a percentage. This is the shape of a price update, as opposed to
// an event that happens to mention a price.
const PRINT_MOVE = /\b(?:rises?|rose|climbs?|climbed|gains?|jumps?|jumped|surges?|surged|advances?|falls?|fell|drops?|dropped|declines?|declined|slides?|slid|sinks?|sank|tumbles?|plunges?|reaches?|reached|hits?|hit|tops?|topped|holds?|steadies|trades?|settles?)\b/i;
const LEVEL = /(?:\$|usd\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/;

export function instrumentOf(text) {
  const s = String(text || '');
  for (const [key, re] of INSTRUMENTS) if (re.test(s)) return key;
  return null;
}

/** Is this headline a market price update rather than an event? */
export function isPricePrint(text) {
  const s = String(text || '');
  if (!instrumentOf(s)) return false;
  if (!PRINT_MOVE.test(s)) return false;
  return /\d/.test(s);
}

// The price level a print asserts: the largest money-like figure in it, which is the level rather
// than the percentage move.
export function printLevel(text) {
  const s = String(text || '');
  const nums = [];
  for (const m of s.matchAll(/(?:\$|usd\s*)(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/gi)) nums.push(Number(m[1].replace(/,/g, '')));
  if (!nums.length) {
    // No currency mark: take the largest bare number that is not a percentage.
    for (const m of s.matchAll(/\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\b(?!\s*%)/g)) nums.push(Number(m[1].replace(/,/g, '')));
  }
  return nums.length ? Math.max(...nums) : null;
}

// How far a price has to move before it is worth telling the same story again.
export const MATERIAL_MOVE_PCT = 1.5;

// ── story identity ───────────────────────────────────────────────────────────
// Anchored on the distinctive NAMES a headline carries, not on overall word overlap. Overlap alone
// fails on exactly the case that matters: "Saudi Arabia shuts East-West pipeline after drone
// attacks" and "Saudi pipeline outage affects 4% of global oil supply" share only two words out of
// thirteen, a Jaccard of 0.15, while being unmistakably the same story.
//
// Proper nouns come from the ORIGINAL cased headline, so they are the source's own capitalisation
// rather than a guess. A short list of domain nouns is added because "pipeline", "refinery" and
// "strait" identify a story as strongly as a place name does.
const DOMAIN_ANCHORS = /\b(?:pipeline|refinery|refineries|terminal|strait|chokepoint|oilfield|reactor|grid|port|tanker|shipyard|bourse|exchange)\b/i;
const STOP_ANCHORS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'breaking', 'update',
  'us', 'u.s.', 'uk', 'eu', 'new', 'first', 'second', 'third', 'more', 'other', 'its', 'his', 'her']);

export function storyAnchors(headline) {
  const raw = String(headline || '');
  const out = new Set();
  // Capitalised tokens, INCLUDING the first word. Excluding sentence-initial words looked careful
  // and was wrong: headlines lead with the subject, so it threw away the single most identifying
  // name in the sentence. "Saudi Arabia shuts East-West pipeline" and "Saudi pipeline outage
  // affects 4% of global oil supply" then shared one anchor instead of two and read as separate
  // stories, which is the exact failure this guard exists to prevent.
  for (const m of raw.matchAll(/\b([A-Z][A-Za-z'’\-]{2,})\b/g)) {
    const w = m[1].toLowerCase().replace(/['’]s$/, '');
    if (STOP_ANCHORS.has(w)) continue;
    out.add(w);
  }
  for (const m of raw.matchAll(new RegExp(DOMAIN_ANCHORS.source, 'gi'))) out.add(m[0].toLowerCase());
  return out;
}

/** Do two headlines describe the same developing story? */
export function sameStory(a, b) {
  const A = storyAnchors(a), B = storyAnchors(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  if (shared >= 2) return true;
  // One shared name is enough only when the rest of the sentence also matches closely.
  if (shared === 1) {
    const wa = new Set(normWords(a)), wb = new Set(normWords(b));
    let n = 0; for (const w of wa) if (wb.has(w)) n++;
    return n / Math.max(1, Math.min(wa.size, wb.size)) >= 0.5;
  }
  return false;
}

// ── material novelty ─────────────────────────────────────────────────────────
// A follow-up has to carry a verified figure the story has not already published. Rewording is not
// news: "Saudi pipeline outage affects 4% of global oil supply" and "...threatens 4% of global oil
// supply" are the same sentence twice, and the second must never go out.
// numericFacts() captures money, percentages and basis points, which is the right vocabulary for
// dedupe. A developing story also turns on quantities it does not cover: "could remain offline for
// 3-5 WEEKS" is the single most material follow-up the Saudi cluster produced and carries no money,
// no percentage and no basis points. So the story guard extracts a wider set — and only here, so
// canonical dedupe keeps the exact fact vocabulary it was tuned on.
const UNIT_FACT = /\b(\d+(?:\.\d+)?)\s*(?:to\s*\d+(?:\.\d+)?\s*)?(weeks?|days?|months?|years?|hours?|barrels?|bpd|mb\/d|tonnes?|tons?|gw|mw|people|deaths?|vessels?|ships?|aircraft|jobs?|bps)\b/gi;
const RANGE_FACT = /\b(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\b/g;

export function factsOf(text) {
  const s = String(text || '');
  const out = new Set(numericFacts(s));
  for (const m of s.matchAll(UNIT_FACT)) out.add(`u${m[1]}${m[2].toLowerCase().replace(/s$/, '')}`);
  for (const m of s.matchAll(RANGE_FACT)) out.add(`r${m[1]}_${m[2]}`);
  return out;
}

export function materiallyNew(headline, alreadyPublishedFacts) {
  const facts = factsOf(headline);
  if (!facts.size) return false;                    // nothing measurable to add
  for (const f of facts) if (!alreadyPublishedFacts.has(f)) return true;
  return false;
}

/**
 * Should this candidate post, given what the account has already said about its story?
 *
 * @param cand   { headline, text, at }  the proposed post
 * @param priors [{ headline, post_facts, created_at, story_key }]  prior X posts, newest first
 * @returns {{ post:boolean, reason:string|null, storyKey:string }}
 */
export function storyVerdict(cand, priors = [], now = Date.now()) {
  const headline = String(cand?.headline || '');

  // A price print is keyed on its instrument, not on the rest of the sentence, and needs a real
  // move to say anything again. Everything else falls through to the anchor logic below.
  if (isPricePrint(headline)) {
    const inst = instrumentOf(headline);
    const storyKey = `price:${inst}`;
    const level = printLevel(headline);
    const recent = priors.filter((p) => {
      const t = Date.parse(p.created_at ?? p.at ?? NaN);
      return Number.isFinite(t) && now - t <= STORY_WINDOW_MS
        && (p.story_key === storyKey || instrumentOf(p.headline || '') === inst);
    });
    if (!recent.length) return { post: true, reason: null, storyKey, priors: 0 };
    if (recent.length >= MAX_POSTS_PER_STORY) {
      return { post: false, priors: recent.length, reason: `instrument already posted ${recent.length} times in 24h`, storyKey };
    }
    const newest = recent.reduce((a, p) => Math.max(a, Date.parse(p.created_at ?? p.at ?? 0)), 0);
    if (now - newest < MIN_STORY_GAP_MS) {
      return { post: false, priors: recent.length, reason: 'repetitive price update within the minimum gap', storyKey };
    }
    const priorLevels = recent.map((p) => printLevel(p.headline || '')).filter((v) => Number.isFinite(v));
    if (level == null || !priorLevels.length) {
      return { post: false, priors: recent.length, reason: 'no comparable price level for this instrument', storyKey };
    }
    const nearest = priorLevels.reduce((a, b) => (Math.abs(b - level) < Math.abs(a - level) ? b : a));
    const movePct = nearest ? Math.abs(level - nearest) / nearest * 100 : 0;
    if (movePct < MATERIAL_MOVE_PCT) {
      return { post: false, priors: recent.length, reason: `price unchanged since the last post (${movePct.toFixed(1)}% move)`, storyKey };
    }
    return { post: true, reason: null, storyKey, priors: recent.length };
  }

  const anchors = [...storyAnchors(headline)].sort();
  // A headline with no identifiable anchor cannot be tracked as a story, so it is treated as its
  // own one-off. That is the fail-closed direction: it can post once and never recurs.
  const storyKey = anchors.length ? anchors.slice(0, 4).join('+') : `solo:${normWords(headline).slice(0, 4).join('-')}`;

  const recent = priors.filter((p) => {
    const t = Date.parse(p.created_at ?? p.at ?? NaN);
    return Number.isFinite(t) && now - t <= STORY_WINDOW_MS && sameStory(headline, p.headline || '');
  });
  if (!recent.length) return { post: true, reason: null, storyKey, priors: recent.length };

  if (recent.length >= MAX_POSTS_PER_STORY) {
    return { post: false, priors: recent.length, reason: `story already posted ${recent.length} times in 24h`, storyKey };
  }
  const newest = recent.reduce((a, p) => Math.max(a, Date.parse(p.created_at ?? p.at ?? 0)), 0);
  if (now - newest < MIN_STORY_GAP_MS) {
    return { post: false, priors: recent.length, reason: 'repetitive story update within the minimum gap', storyKey };
  }
  // Everything the account has already stated about this story.
  const published = new Set();
  for (const p of recent) {
    for (const f of factsOf(p.headline || '')) published.add(f);
    for (const f of String(p.post_facts || '').split(',').filter(Boolean)) published.add(f);
  }
  if (!materiallyNew(headline, published)) {
    return { post: false, priors: recent.length, reason: 'no materially new fact for this story', storyKey };
  }
  return { post: true, reason: null, storyKey, priors: recent.length };
}
