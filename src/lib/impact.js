import { isIngestableSymbol } from './ticker-symbol.mjs';

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

// ── WHAT HIGH IMPACT IS ALLOWED TO MEAN ─────────────────────────────────────
//
// Keywords alone decided this, and keywords do not know who a story is ABOUT. So the feed led
// with "Lakers Buyers Lay Out Plans to Reach $30 Billion Valuation" — flagged HIGH because its
// category was M&A. It is a fundraising pitch for a basketball franchise: no listed issuer, no
// filing, nothing anyone can trade. Next to it, a personal-finance column about the reader's own
// bankruptcy.
//
// HIGH IMPACT now means one of exactly two things:
//
//   A) A MATERIAL EVENT AT A LISTED ISSUER — a resolved U.S. ticker AND evidence that this is a
//      company event: a material 8-K, an SEC-categorised item, or a material-event keyword.
//   B) A SCHEDULED MACRO PRINT — FOMC, CPI, NFP, FOMC minutes. These move every equity and belong
//      to no ticker, so demanding one would be the wrong test.
//
// No ticker and not a macro print is not HIGH. That single requirement does most of the work
// here: the Lakers story, the credit-card column, the Michelin guide, the tourism releases and
// the law-firm solicitations all fail it without needing a list of things to ban, and the rule
// stays true for the junk nobody has thought of yet.
//
// ⚠️ IT WILL BE SPARSE, AND THAT IS THE POINT. On a weekend, with no filings, HIGH IMPACT should
// be empty. An empty shelf is honest; a shelf filled with a basketball team is not.

/** The scheduled prints that are market events in their own right, with no issuer attached. */
// ⚠️ THE PRINT, NOT THE COMMENTARY. Bare 'rate hike' and 'rate cut' were in this list for one
// draft and pulled in "Warsh says Fed rate hike reflects strengthening economy" and "ECB Rate
// Hikes Don't Solve Inflation Problem, Giorgetti Says" — officials talking about policy, which is
// not a scheduled release. What stays is the release itself: the statement, the minutes, the
// projections, and the named data prints. Commentary keeps its MACRO tag and lands at NOTABLE.
const MACRO_PRINT_KW = [
  'fomc', 'federal open market committee', 'fomc minutes', 'fomc statement', 'rate decision',
  'economic projections', 'dot plot',
  'cpi', 'consumer price index', 'inflation report', 'ppi', 'producer price index',
  'nfp', 'nonfarm payroll', 'non-farm payroll', 'jobs report', 'employment report', 'unemployment rate',
  'pce', 'gdp report', 'beige book',
];
const CAT_MACRO = new Set(['FED', 'MACRO', 'ECONOMY']);

// Things that carry a ticker and still are not a market event. Kept SHORT on purpose — the ticker
// requirement above already removes the tickerless bulk, and every entry here is a category the
// ticket named that could otherwise arrive attached to a real symbol.
const NEVER_HIGH = [
  // Law-firm solicitations quote real issuers and use the language of an SEC investigation.
  /\b(?:law (?:firm|offices)|rosen law|pomerantz|bronstein|levi & korsinsky|glancy prongay|schall law)\b/,
  /\b(?:class action|shareholder alert|investor alert|securities fraud (?:investigation|class action))\b/,
  /\bencourages\b[^.]{0,40}\binvestors\b/,
  // Franchise and non-listed entertainment fundraising.
  /\b(?:lakers|knicks|celtics|yankees|dodgers|premier league|nba|nfl|mlb|nhl|fifa)\b/,
  /\b(?:franchise|team) (?:valuation|stake|sale)\b/,
  // Lifestyle, awards, tourism.
  /\b(?:michelin (?:guide|star)|best places|top \d+ (?:places|destinations)|tourism board|travel guide)\b/,
  /\b(?:wins|named|receives)\b[^.]{0,30}\b(?:award|awards|recognition|accolade)\b/,
];

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

/** Is `t` a symbol we can resolve to a listed U.S. security? */
function resolvedTicker(item) {
  const raw = item.ticker ?? item.sym ?? item.symbol ?? null;
  return isIngestableSymbol(typeof raw === 'string' ? raw : '') ? String(raw).toUpperCase() : null;
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
  const neverHigh = !issuerFiling && NEVER_HIGH.some((re) => re.test(t));

  // ── (B) A SCHEDULED MACRO PRINT ──────────────────────────────────────────
  // Deliberately first, and deliberately exempt from the ticker test: CPI belongs to no issuer.
  // It must still be TAGGED macro — the word "inflation" in a lifestyle piece is not a print.
  const macroPrint = CAT_MACRO.has(cat) && MACRO_PRINT_KW.some((k) => matchesKeyword(t, k));
  if (macroPrint && !adviceVoice) return 'high';

  // ── (A) A MATERIAL EVENT AT A LISTED ISSUER ──────────────────────────────
  // Both halves are required. The keyword says WHAT happened; the ticker says it happened to a
  // company someone can act on. Either alone is how a basketball team reached the top of a
  // trading feed.
  const eventWords = HIGH_KW.some((k) => matchesKeyword(t, k)) || CAT_HIGH.has(cat);
  const isIssuerEvent = !!resolvedTicker(item) && (eventWords || issuerFiling);
  if (isIssuerEvent && !adviceVoice && !neverHigh) return 'high';

  // ⚠️ ADVICE AND THE NEVER LIST DO NOT RANK AT ALL — SUPPRESSING ONLY `high` IS NOT ENOUGH.
  //
  // That was the first attempt, and it put the credit-card column straight back at the top. Both
  // it and the Lakers story fell to NOTABLE together, and among equals the pool's own order wins,
  // so the feed simply swapped one piece of junk for another. A column carrying the word
  // "bankruptcy" is not second-most-important news; it is not news. These land at routine and
  // stay visible under All, which is exactly where the rule says they may live.
  if (adviceVoice || neverHigh) return 'routine';

  // Everything else can still be NOTABLE — this is a demotion, not a deletion. A well-reported
  // feature with no ticker keeps its place in the river; it just cannot lead it.
  const routine = ROUTINE_KW.some((k) => matchesKeyword(t, k));
  const hitNotable = eventWords || NOTABLE_KW.some((k) => matchesKeyword(t, k))
    || CAT_NOTABLE.has(cat) || CAT_MACRO.has(cat) || material;
  if (hitNotable && !routine) return 'notable';

  return 'routine';
}

export const IMPACT_RANK = { high: 3, notable: 2, routine: 1 };

/**
 * ONE DESK. Order a list of stories by what matters, newest-first within a tier.
 *
 * ⚠️ THE FRONT DOOR AND THE NEWS PAGE MUST NOT DISAGREE. /api/news ranked its river with
 * impactOf, but the homepage read `pit_snapshot.stories` — which the cron sliced straight off
 * catalystpit:top_stories in the enrichment's arbitrary order — so the two surfaces were ranking
 * the same pool by two different rules. The News page led with FOMC minutes while the front door
 * led with a credit-card column. This is the shared implementation; if a surface ranks stories,
 * it calls this.
 *
 * Stable: equal tiers keep the order they arrived in, so this is a re-ranking of what we already
 * had, not a re-shuffle. Nothing is dropped — routine items are still there, lower down.
 */
export function rankByImpact(items, { read = (x) => x } = {}) {
  return (Array.isArray(items) ? items : [])
    .map((x, i) => ({ x, i, r: IMPACT_RANK[impactOf(read(x))] ?? 1 }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i))
    .map((e) => e.x);
}

/**
 * May this story stand as the hero?
 *
 * ⚠️ A HERO IS A CLAIM, NOT A SLOT TO FILL. The homepage hero is the largest thing on the page
 * and reads as "this is what matters today". A routine item there is worse than no hero at all,
 * which is why the caller is expected to fall back to filings rather than promote the least-bad
 * magazine feature.
 */
export function isHeroWorthy(item) {
  return impactOf(item) !== 'routine';
}

// Editorial flag styling — subtle colored tag, no number, no emoji. null = don't render a flag.
export const IMPACT_STYLE = {
  high:    { label: 'HIGH IMPACT', bg: '#FCE9E7', fg: '#B23B2E' },
  notable: { label: 'NOTABLE',     bg: '#FFF6E8', fg: '#7A5018' },
  routine: null,
};
