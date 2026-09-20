// Catalyst-importance tiers — editorial flags, NOT a numeric score. Pure heuristic (free, no LLM):
// event-type keywords + category + 8-K material flag, dampened for routine boilerplate.
// Used by the news feed flags and the Top Catalysts module. tier ∈ 'high' | 'notable' | 'routine'.
//
// ── HOW A KEYWORD MATCHES, AND WHY IT IS NOT `includes()` ────────────────────
//
// It used to be `title.includes(keyword)`, which matches inside longer, unrelated words. Measured
// across 52,685 real headlines, that was wrong constantly:
//
//   'eps'      → "stepstone", "keeps buy", "steps down"           220 false hits
//   'merges'   → "emerges as election kingmaker"                   30
//   'quarter'  → "relocates global headquarters"                   23
//   'appoint'  → "results disappoint on operating expenses"        19
//   'misses'   → "analyst dismisses robotaxi concerns"             17
//   'ceo'      → "perdoceo education to acquire…"                  12
//   'wins'     → "twins"                                            6
//
// The obvious repair — whole-word matching — is WORSE, and the same measurement proves it. These
// keywords are deliberately STEMS: 'dividend' is meant to catch "dividends" (1,254 headlines),
// 'fda approv' to catch "fda approves" (89), 'delist' to catch "delisting", 'restate' to catch
// "restatement", 'subpoena' to catch "subpoenaed", 'upgrade' to catch "upgrades" (262). Requiring
// a trailing boundary would silently delete all of those.
//
// So the rule is PREFIX-ANCHORED: a keyword must begin at a word boundary, and may be followed by
// more letters. "quarter" still matches "quarterly" but not "headquarters"; "appoint" still
// matches "appointment" but not "disappointing". Measured: every stem above survives unchanged.
//
// ⚠️ NO LOOKBEHIND. This module ships in the client bundle, and `(?<!…)` is a relatively recent
// addition to Safari. The leading boundary is expressed as an ordinary alternation instead.

// Market-moving: structural change to the company or a hard surprise.
const HIGH_KW = [
  'bankrupt', 'chapter 11', 'going concern', 'delist', 'restate', 'restatement',
  'to acquire', 'acquisition of', 'acquires', 'to be acquired', 'merger', 'merges', 'buyout', 'takeover', 'm&a',
  'fda approv', 'fda reject', 'complete response letter', 'breakthrough therapy', 'meets primary endpoint',
  'phase 3', 'topline', 'fails to meet', 'misses primary', 'halted', 'trading halt',
  'cuts guidance', 'raises guidance', 'withdraws guidance', 'profit warning', 'slashes',
  'sec charges', 'sec investigation', 'subpoena', 'recall', 'data breach', 'cyberattack',
  'strategic alternatives', 'explores sale',
];
// Meaningful but expected / second-order.
const NOTABLE_KW = [
  'earnings', 'results', 'quarter', 'quarterly', 'revenue', 'eps', 'beats', 'misses', 'guidance',
  'offering', 'convertible', 'private placement', 'registered direct', 'notes offering',
  // ⚠️ 'prices' ON ITS OWN IS A COMMODITY NOUN, NOT A CORPORATE EVENT. The bare keyword fired on
  // 817 headlines, of which only ~90 were a company pricing a deal; the other 727 were "oil
  // prices jump", "diesel prices hit $8.14", "rising oil prices". Every one of those was being
  // flagged NOTABLE on the news feed. The verb sense always names what is being priced, so it is
  // listed as phrases — which also keeps "prices hit $8.14" out, because that is "prices hit",
  // not "prices $".
  'prices $', 'prices upsized', 'prices public offering', 'prices offering', 'prices underwritten',
  'prices secondary', 'prices private placement', 'prices ipo', 'prices notes', 'prices senior',
  'prices convertible', 'prices registered direct',
  'ceo', 'cfo', 'resign', 'appoint', 'steps down', 'names new', 'interim',
  'buyback', 'repurchase', 'dividend', 'special dividend', 'partnership', 'collaboration',
  'contract', 'awarded', 'wins', 'upgrade', 'downgrade', 'initiates coverage', 'price target',
];

// ── COLUMNS ARE NOT CATALYSTS ───────────────────────────────────────────────
//
// A personal-finance column can carry every word a corporate disaster does. The one that started
// this: "I have $125,000 in credit-card debt. Will $17,000 a month in income, including
// disability, affect my bankruptcy?" — HIGH IMPACT, top of the news feed, because 'bankrupt' is
// a substring of "bankruptcy".
//
// No boundary rule fixes that: the word IS "bankruptcy" and it IS about a bankruptcy. What is
// wrong is the voice. Advice speaks in the first and second person and asks the reader questions;
// a filing never does. So these patterns suppress HIGH only — an advice piece can still be
// NOTABLE, it just cannot lead the page.
//
// Measured on 52,685 headlines: flags 0.95%, with ONE corporate headline touched (a SpaceX-Tesla
// merger story quoting someone saying "I'm going to support"). Deliberately NOT included: "what
// to know" (caught "what to know as Rocket Lab inches closer to Iridium acquisition") and a
// headline-initial "my" (caught "My Size, Inc. · 8-K" — a company whose name begins with My).
const ADVICE_VOICE = [
  /(?:^|[^a-z])i(?:'m| am| have| own| owe| lost| need| want)\b/,
  /\b(?:should|can|shall|must|do|did|will|would|could) i\b/,
  /(?:^|[^a-z])you(?:'re| are| will| can| should|'ll)\b/,
  // A non-letter must precede it, which also means it cannot be the first word — see "My Size".
  /[^a-z]my (?:\d|\$|[a-z]+)/,
  /\bhere(?:'s| is) (?:how|why|what|my)\b/,
  /\bhow (?:to|i|we|you)\b/,
  /\bdear [a-z]+[,:]/,
  /\bwhy\b[^.]{0,40}\b(?:startups|companies|businesses|investors|retirees|americans|people|workers)\b/,
  /\b(?:your|you) (?:money|retirement|portfolio|savings|401\(?k\)?|taxes)\b/,
];
// Boilerplate that pulls importance back down (unless a HIGH keyword already fired).
const ROUTINE_KW = [
  'to present', 'to attend', 'to participate', 'webcast', 'conference call', 'to report',
  'to host', 'investor day', 'schedules', 'announces date', 'will present', 'to speak',
];

const CAT_HIGH = new Set(['M&A', 'SEC']);
const CAT_NOTABLE = new Set(['EARNINGS', 'IPO', 'FED']);

// Curly apostrophes are everywhere in real headlines ("you’re", "here’s"), and they are a
// different code point from the typewriter form the patterns are written with. Normalised once,
// so every rule below can be written the readable way.
const normalize = (s) => String(s || '').toLowerCase().replace(/[‘’ʼ]/g, "'");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KW_RE = new Map();
/**
 * Does `text` contain `kw` starting at a word boundary?
 *
 * Trailing letters are allowed on purpose — the keywords are stems. See the header for the
 * measurement behind that choice.
 */
export function matchesKeyword(text, kw) {
  let re = KW_RE.get(kw);
  if (!re) { re = new RegExp(`(^|[^a-z0-9])${escapeRe(kw)}`); KW_RE.set(kw, re); }
  return re.test(text);
}

export function impactOf(item = {}) {
  const t = normalize(item.title || item.headline || '');
  const cat = `${item.category || item.tag || ''}`.toUpperCase();
  const material = item.material === true;

  // ⚠️ AN ISSUER FILING IS NEVER AN ADVICE COLUMN. A material 8-K, or anything the pipeline has
  // already categorised as an SEC filing, is a company speaking about itself — whatever its title
  // happens to read like. The damper is skipped entirely for those, which is what keeps
  // "My Size, Inc. · 8-K" eligible for HIGH.
  const issuerFiling = material || cat === 'SEC';
  const adviceVoice = !issuerFiling && ADVICE_VOICE.some((re) => re.test(t));

  const hitHigh = HIGH_KW.some((k) => matchesKeyword(t, k)) || CAT_HIGH.has(cat);
  // Advice suppresses HIGH only. A column about dividends is still perfectly NOTABLE; it just
  // does not get to lead the page over an actual filing.
  if (hitHigh && !adviceVoice) return 'high';

  const routine = ROUTINE_KW.some((k) => matchesKeyword(t, k));
  const hitNotable = NOTABLE_KW.some((k) => matchesKeyword(t, k)) || CAT_NOTABLE.has(cat) || material;
  if (hitNotable && !routine) return 'notable';

  return 'routine';
}

export const IMPACT_RANK = { high: 3, notable: 2, routine: 1 };

// Editorial flag styling — subtle colored tag, no number, no emoji. null = don't render a flag.
export const IMPACT_STYLE = {
  high:    { label: 'HIGH IMPACT', bg: '#FCE9E7', fg: '#B23B2E' },
  notable: { label: 'NOTABLE',     bg: '#FFF6E8', fg: '#7A5018' },
  routine: null,
};
