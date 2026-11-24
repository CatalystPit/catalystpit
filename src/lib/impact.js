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
/**
 * When was this published, in epoch ms, or null when the item does not say.
 *
 * ⚠️ TOLERANT ON PURPOSE. The same ranking runs over curated articles, wire items and filing cards,
 * and they carry their timestamp under different names and in different units — ISO strings, epoch
 * seconds, epoch milliseconds, and on the homepage a precomputed `mins` age. Guessing wrong here
 * silently reorders the front page, so every shape the pipeline actually produces is handled rather
 * than assumed.
 */
export function publishedMs(item = {}) {
  if (Number.isFinite(item.mins)) return Date.now() - item.mins * 60_000;
  const v = item.publishedAt ?? item.published ?? item.datetime ?? item.date ?? item.time ?? null;
  if (v == null) return null;
  // Epoch seconds and epoch milliseconds are both common; 2e10 separates them until the year 2603.
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 2e10 ? v * 1000 : v) : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * ⚠️ RECENCY IS THE TIE-BREAK, AND ITS ABSENCE PUT A THREE-DAY-OLD STORY ON THE FRONT PAGE.
 *
 * This sorted by impact and then by ORIGINAL ARRAY INDEX, so among equally-ranked HIGH stories the
 * one that happened to be first in the pool led — permanently, because its position never changed.
 * Measured on production: "Citi Undercounted $35 Billion in Assets at U.K. Subsidiary" held the hero
 * at 73.9 hours old while Nvidia's CEO returning, 1.3 hours old and also HIGH, sat in position two.
 *
 * Impact still decides first and is untouched; recency now decides WITHIN an impact band, which is
 * the only place a news desk would use it. Original index remains the final tie-break so the sort
 * stays stable for items published in the same instant.
 */
export function rankByImpact(items, { read = (x) => x } = {}) {
  return (Array.isArray(items) ? items : [])
    .map((x, i) => ({ x, i, r: IMPACT_RANK[impactOf(read(x))] ?? 1, t: publishedMs(read(x)) }))
    // An item with no timestamp sorts after dated ones in the same band rather than ahead of them:
    // "we do not know when this happened" is not a reason to lead the page.
    .sort((a, b) => (b.r - a.r) || ((b.t ?? 0) - (a.t ?? 0)) || (a.i - b.i))
    .map((e) => e.x);
}

/**
 * May this story stand as the hero?
 *
 * ⚠️ A HERO IS A CLAIM, NOT A SLOT TO FILL. The homepage hero is the largest thing on the page
 * and reads as "this is what matters today". Anything less than HIGH there is worse than no hero
 * at all, which is why the caller falls back to filings rather than promoting the least-bad
 * magazine feature.
 */
/**
 * ⚠️ A HERO IS ALSO A CLAIM ABOUT *WHEN*. The largest element on the page reads as "this is what
 * matters today", and a three-day-old banking story under that heading is wrong even when its impact
 * is genuinely high. Twenty-four hours is the window: long enough that a Friday evening story still
 * leads on Saturday morning, short enough that nothing from the week before can.
 *
 * Past the window the caller falls through to verified filings and then to a quiet-news state, which
 * is the honest alternative to filling a hero with something stale.
 */
export const HERO_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isHeroWorthy(item, { now = Date.now(), maxAgeMs = HERO_MAX_AGE_MS } = {}) {
  if (impactOf(item) !== 'high') return false;
  const t = publishedMs(item);
  // ⚠️ THE WINDOW EXCLUDES WHAT IS PROVABLY STALE, NOT WHAT IS MERELY UNDATED.
  //
  // My first version allowed an undated item only when it was an issuer filing, reasoning that an
  // article's age is exactly the thing in question. The existing suite showed that reasoning costs
  // more than it buys: a scheduled macro print — "Minutes of the Federal Open Market Committee",
  // which belongs to no issuer and carries no article timestamp in this pipeline — stopped being
  // hero-worthy, and the module fell through to the filings floor on a day the FOMC reported.
  //
  // Staleness is a claim about a known date. With no date there is nothing to measure, and demoting
  // on an absence silently reclassified a whole category of genuinely front-page events. The defect
  // this window exists to fix had a date — 73.9 hours of it — so excluding the provable case is
  // sufficient, and it leaves the dateless ones where the impact rules already put them.
  if (t == null) return true;
  return now - t <= maxAgeMs;
}

// ── EXCEPTIONAL VERSUS MERELY MATERIAL: AN 8-K IS NOT AUTOMATICALLY THE DAY'S LEAD ──────────
//
// ⚠️ EVERY MATERIAL 8-K SCORES `high`, AND THAT CLASSIFICATION IS CORRECT. A material issuer
// filing with a resolved ticker satisfies product rule (A) exactly as written, and nothing below
// changes impactOf — the HIGH IMPACT tab, the flags and the evidence rails keep the tier they
// have always had. What was wrong was never the classification. It was treating one tier as an
// ORDERING.
//
// Measured on production, 2026-11-24, /api/news?limit=200:
//
//   102 items   20 curated articles · 42 press-release wires · 40 material 8-Ks
//   tiers       articles: 0 high, 22 notable, 39 routine
//               filings:  41 high, 0 notable, 0 routine      ← every single one
//   labels      16x Earnings · 10x Exec / board change · 9x Material agreement
//               2x Delisting risk · 2x Security-holder rights · 1x Agreement terminated
//
// So `[...rankByImpact(filings), ...rankByImpact(raw), ...]` put all 40 filings at indices 0-39
// and the first piece of journalism at index 40, and deskSelection's filings floor filled the
// homepage four-up with 8-K cards every time — not because a filing beat an article on merit, but
// because sixteen scheduled earnings releases all carry the same tier as a bankruptcy.
//
// THE PARTITION IS THE SEC'S OWN ITEM CODES, not a new opinion. The labels come from ITEM_MAP in
// lib/eightk.js, which is where an item code is turned into meaning, and each exceptional label
// maps onto an event type HIGH_KW above already names in prose: bankruptcy, delisting, a
// restatement, a change of control, a completed acquisition, a cyber incident. The routine set is
// the material-but-scheduled remainder — an earnings release, a new agreement, an officer change.
// Both sets together must cover every material label eightk.js defines; verify-impact reads that
// file and asserts it, so a new item code cannot quietly arrive unclassified.
//
// ⚠️ eightk.js IS NOT IMPORTED HERE ON PURPOSE. It opens a database connection, and this module
// ships in the client bundle — NewsFeed and CatalystPit both import it. The assertion is the bind.
export const EXCEPTIONAL_FILING_LABELS = new Set([
  'Bankruptcy',                     // 1.03
  'Cybersecurity incident',         // 1.05
  'M&A completed',                  // 2.01
  'Debt trigger event',             // 2.04
  'Material impairment',            // 2.06
  'Delisting risk',                 // 3.01
  'Auditor change',                 // 4.01
  'Financial restatement',          // 4.02
  'Change in control',              // 5.01
  'Shell-status change',            // 5.06
  'Exchange removal from listing',  // 25-NSE
  'Withdrawal from listing',        // 25
]);

/** Material, and genuinely significant to the issuer — but frequent, scheduled or administrative. */
export const ROUTINE_FILING_LABELS = new Set([
  'Material agreement',             // 1.01
  'Agreement terminated',           // 1.02
  'Earnings',                       // 2.02
  'New debt obligation',            // 2.03
  'Restructuring costs',            // 2.05
  'Equity dilution',                // 3.02
  'Security-holder rights',         // 3.03
  'Exec / board change',            // 5.02
]);

/** Is this row a filing card rather than a published article? Both item shapes are accepted. */
export function isFilingStory(item = {}) {
  const cat = `${item.category || item.tag || ''}`.toUpperCase();
  const src = String(item.source || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cat === 'SEC' || src === 'SEC8K';
}

/**
 * The SEC item label behind a filing card.
 *
 * `secLabel` is carried explicitly by both producers (news-filings.mjs and the homepage's
 * filingCards). The title fallback exists because the label is also the half of the headline after
 * the separator — "MMED · Earnings" — so a card written before that field existed still classifies
 * rather than silently becoming routine.
 */
export function filingLabelOf(item = {}) {
  if (item.secLabel) return String(item.secLabel).trim();
  const t = String(item.title || item.headline || '');
  const i = t.indexOf('\u00b7');
  return i >= 0 ? t.slice(i + 1).trim() : '';
}

/**
 * 'exceptional' | 'material' for a filing card, null for anything else.
 *
 * ⚠️ AN UNRECOGNISED LABEL IS 'material', NEVER 'exceptional'. Defaulting the other way would mean
 * a new SEC item code — or a label this file has not been taught — promoting itself onto the front
 * page on the day it first appears.
 */
export function filingTier(item = {}) {
  if (!isFilingStory(item)) return null;
  return EXCEPTIONAL_FILING_LABELS.has(filingLabelOf(item)) ? 'exceptional' : 'material';
}

// ── WHAT COUNTS AS SUBSTANCE WHEN A STORY CARRIES NO TICKER ─────────────────────────────────
//
// ⚠️ THE TICKER TEST WAS KILLING THE JOURNALISM TIER OUTRIGHT, AND THE MEASUREMENT IS BLUNT:
// of 61 articles in the live pool, 22 reached `notable` and EXACTLY ZERO of those 22 carried a
// resolvable ticker. The tier could never fire. That is why the homepage fell through to filings
// on a day with a $41bn biotech deal, a BP board exit and an Nvidia rally on the tape.
//
// A ticker remains the strongest evidence that a story is about a company someone can act on, and
// it is kept. Provenance is added beside it: an item published by a professional newsroom is
// financial journalism as a matter of fact, not of judgement. The set is the NEWS_DESK taxonomy
// this repository already defines and already measured — "a professional newsroom asserting a fact
// it will be corrected on" — in lib/evidence/company-events.mjs. verify-impact reads that file and
// asserts the two agree exactly, because two hand-kept copies is how one becomes wrong.
//
// A press-release distributor is deliberately NOT a news desk. Business Wire and PR Newswire are
// 42 of those 61 items; promoting them here is precisely "turning a promotional press release into
// breaking market news", and they keep the place the impact rules already give them.
const SOURCE_ALIAS = {
  THEWALLSTREETJOURNAL: 'WSJ', WALLSTREETJOURNAL: 'WSJ', DOWJONESNEWSWIRES: 'WSJ',
  FINANCIALTIMES: 'FT', THEFINANCIALTIMES: 'FT',
};
const NEWS_DESK_SOURCES = new Set([
  'BLOOMBERG', 'WALTERBLOOMBERG', 'FINANCIALJUICE', 'BREAKINGMARKETNEWS', 'REUTERS',
  'WSJ', 'CNBC', 'FT', 'MARKETWATCH', 'NASDAQ', 'SEC', 'DOJ', 'FDA', 'FTC', 'CFTC', 'BIOSPACE',
]);
const sourceCode = (s) => {
  const c = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  return SOURCE_ALIAS[c] || c;
};
export function isNewsDesk(item = {}) {
  return NEWS_DESK_SOURCES.has(sourceCode(item.source ?? item.publisher));
}
/** Is there evidence this story is about the market, beyond a keyword having fired? */
export function hasDeskSubstance(item = {}) {
  return !!resolvedTicker(item) || isNewsDesk(item);
}

/**
 * THE NEWS RIVER, IN THREE NAMED BLOCKS.
 *
 * ⚠️ ONE MERGED SORT WAS TRIED FIRST AND IS WRONG. Filings are the freshest rows on the tape — an
 * 8-K arrives minutes after it is filed — so sorting the whole pool by significance then recency
 * floats sixteen earnings notices above every article written this morning, which is the reported
 * defect wearing a different hat. The blocks are the fix the brief asks for: journalism leads, the
 * filings stay a clearly identified section of their own, and nothing is dropped.
 *
 *   1. curated articles + EXCEPTIONAL filings, ranked together
 *      An exceptional filing can still lead the page on its own importance — that is rule (A),
 *      unchanged — but it earns the position by being a bankruptcy or a delisting, not by being
 *      an 8-K.
 *   2. the remaining material filings, newest first
 *      Every one of them, still present, still linking to its own EDGAR document.
 *   3. the press-release wires
 *      Below the primary-source documents, which is where issuer PR belongs relative to an
 *      issuer's own filed disclosure.
 *
 * "Enriched stories outrank wires" — the guarantee the previous fix established — is preserved:
 * block 1 is still entirely above block 3.
 */
export function composeRiver({ curated = [], wire = [], filings = [] } = {}, { now = Date.now() } = {}) {
  const pool = Array.isArray(filings) ? filings : [];
  const exceptional = pool.filter((f) => filingTier(f) === 'exceptional');
  const routine = pool.filter((f) => filingTier(f) !== 'exceptional');
  return [
    ...rankCurrentFirst([...(Array.isArray(curated) ? curated : []), ...exceptional], { now }),
    ...rankByImpact(routine),
    ...rankByImpact(Array.isArray(wire) ? wire : []),
  ];
}

/**
 * Rank by significance, but never above something that is provably stale.
 *
 * ⚠️ MEASURED ON PRODUCTION AFTER THE FIRST DEPLOY OF composeRiver, AND IT WAS STILL WRONG.
 * The river came back:
 *
 *   0  SEC 8-K      2026-11-23T23:42  DRVN · Delisting risk
 *   1  SEC 8-K      2026-11-23T22:20  SAFX · Delisting risk
 *   2  WSJ          2026-11-20T16:59  Citi Undercounted $35 Billion in Assets at U.K. Subsidiary
 *   3  MarketWatch  2026-11-24T12:50  The biggest biotech deal in nearly three years…
 *
 * Index 2 is FOUR DAYS OLD and it was sitting above everything published that morning, because
 * rankByImpact sorts by tier and only then by recency — and that one story is the pool's lone
 * `high` (its category is SEC), so every `notable` article from today ranked below it however
 * fresh. This is the same story, and the same 73.9-hour staleness, that once held the homepage
 * hero and is the reason HERO_MAX_AGE_MS exists; the window was applied to the front door and not
 * to the river.
 *
 * So currency is the FIRST comparison and significance the second: anything inside the window
 * outranks anything provably outside it, and within each group the existing desk order applies
 * unchanged. Nothing is dropped and nothing is demoted out of its block — the Citi story stays in
 * the journalism block, above every filing, just not at the top of the page four days on.
 *
 * ⚠️ UNDATED IS NOT STALE, which is the same distinction isHeroWorthy draws and for the same
 * reason: staleness is a claim about a known date, and demoting on an absence silently reclassified
 * a whole category of genuine front-page events — a scheduled macro print carries no article
 * timestamp in this pipeline.
 */
export function rankCurrentFirst(items, { now = Date.now(), maxAgeMs = HERO_MAX_AGE_MS } = {}) {
  const list = Array.isArray(items) ? items : [];
  const current = (x) => { const t = publishedMs(x); return t == null || now - t <= maxAgeMs; };
  return [
    ...rankByImpact(list.filter(current)),
    ...rankByImpact(list.filter((x) => !current(x))),
  ];
}

/** Hero plus supporting tiles. Four slots, and none of them may be padded. */
export const DESK_SLOTS = 4;

/**
 * WHAT THE FRONT DOOR IS ALLOWED TO SHOW.
 *
 * ⚠️ RANKING WAS NOT ENOUGH, AND THIS IS THE SECOND TIME THAT LESSON HAS COST A DEPLOY. Sorting
 * the pool put the best item first but left the rest of the module to be filled in order, so the
 * homepage still ran a WSJ Fed feature as its hero with credit-card and crypto-advice columns in
 * the supporting tiles. A four-up is four claims, not one claim and three spacers.
 *
 * So selection is a FILTER, not a sort: only HIGH — a material event at a listed issuer, or a
 * scheduled macro print — may occupy a slot. When nothing qualifies, the module shows canonical
 * filings instead. When neither exists it shows fewer cards, or none, and the module's own empty
 * state says the desk is quiet.
 *
 * ⚠️ IT MAY RETURN FEWER THAN FOUR, AND MUST NEVER PAD TO REACH FOUR. The old render repeated
 * `news[i % …]` to fill the grid, which is how one story became four photographs of itself. Three
 * real filings and a gap is a true page; four slots filled with advice columns is not.
 */
/**
 * WHAT THE FRONT DOOR IS ALLOWED TO SHOW.
 *
 * ⚠️ SELECTION IS A FILTER, NOT A SORT, and that part was right. Sorting the pool put the best
 * item first but left the rest of the module to be filled in order, so the homepage ran a WSJ Fed
 * feature as its hero with credit-card and crypto-advice columns in the supporting tiles. A
 * four-up is four claims, not one claim and three spacers. Only an item that earns a slot gets
 * one; fewer than four cards is a true page and the module must never pad to look full.
 *
 * ⚠️ WHAT CHANGED: THE TIERS WERE A WATERFALL, AND THE WATERFALL WAS THE BUG.
 *
 * It read: fresh HIGH stories, else ANY fresh filing, else fresh notable stories with a ticker.
 * Both story tiers were unreachable — 0 of 61 articles scored high, and 0 of the 22 notable ones
 * carried a ticker — so every load landed on the middle rung and the front door showed four 8-K
 * cards. Worse, the waterfall could never mix: one qualifying filing took all four slots while
 * twenty-two notable articles sat unused.
 *
 * So there is one pool and one ordering, by what a desk would actually lead with:
 *
 *   band 3  a fresh HIGH story, or a fresh EXCEPTIONAL filing     → may hold the hero
 *   band 2  a fresh notable story with substance (ticker or desk)  → earns a tile
 *   band 1  a fresh material filing                               → fills a tile nothing above wants
 *   band 0  everything else                                       → never selected, never padded
 *
 * Within a band, newest first. A material 8-K therefore no longer outranks financial reporting —
 * it sits below it and appears only in the slots journalism has not filled — while a bankruptcy or
 * a delisting notice still competes for the lead on its own merit.
 *
 * Nothing here relaxes what HIGH means, and nothing is promoted to fill a gap: band 0 is excluded
 * entirely, and every band requires the same freshness window the hero has always used.
 */
export function deskSelection(stories, filings, { limit = DESK_SLOTS, now = Date.now() } = {}) {
  const all = Array.isArray(stories) ? stories : [];
  const pool = Array.isArray(filings) ? filings : [];

  // Same rule as isHeroWorthy's window, and for the same reason: exclude what is PROVABLY stale,
  // not what is merely undated. An item with no timestamp is left where the impact rules put it.
  const fresh = (s) => {
    const t = publishedMs(s);
    return t == null || now - t <= HERO_MAX_AGE_MS;
  };

  const band = (s) => {
    if (isFilingStory(s)) return filingTier(s) === 'exceptional' ? 3 : 1;
    const r = IMPACT_RANK[impactOf(s)] ?? 1;
    if (r >= IMPACT_RANK.high) return 3;
    if (r >= IMPACT_RANK.notable && hasDeskSubstance(s)) return 2;
    return 0;
  };

  const scored = [...all, ...pool]
    .map((s, i) => ({ s, i, b: fresh(s) ? band(s) : 0, t: publishedMs(s) }))
    .filter((e) => e.b > 0)
    // Band decides, then recency within the band, then arrival order so the sort stays stable.
    .sort((x, y) => (y.b - x.b) || ((y.t ?? 0) - (x.t ?? 0)) || (x.i - y.i));

  // ⚠️ A ROUTINE FILING IS A FLOOR, NOT A FILLER, AND THE SUITE IS WHAT SETTLED THAT.
  //
  // Mixing bands freely was the first version, and it put one qualifying article in the hero with
  // three scheduled-earnings 8-K cards beside it. Those cards are real — a ticker, an item type, an
  // EDGAR link — so it is not padding in the sense this module forbids. It is still wrong: the brief
  // asks for the filings to stay a clearly identified section rather than seep into the module whose
  // job is to say what was REPORTED today, and a reader cannot tell which of the two they are
  // looking at when the section mixes them and the badge speaks only for the lead.
  //
  // So the module shows one thing or the other, and WHICH ONE turns on whether any REPORTING
  // qualifies at all — not on whether the top band happens to be occupied.
  //
  //   reporting qualifies    the module is the day's reporting. Bands 3 and 2 fill it together, so
  //                          an exceptional filing still competes for the lead beside it, and the
  //                          routine material filings stay out.
  //   nothing reported       the module is the filings floor, and shows the qualifying filings
  //                          ranked exceptional-first. It is labelled 8-K FILINGS and says so.
  //
  // ⚠️ "ANY BAND >= 2" WAS THE FIRST VERSION AND THE SUITE REJECTED IT: one exceptional filing and
  // one routine filing, with no reporting at all, returned a single card and left the other real
  // filing out. The mixing this guards against is filings seeping into REPORTING. On a day with
  // nothing reported there is nothing to seep into, and a filings module that hides filings is just
  // a module with a hole in it.
  const reported = scored.some((e) => e.b >= 2 && !isFilingStory(e.s));
  const picked = (reported ? scored.filter((e) => e.b >= 2) : scored).slice(0, limit);

  if (!picked.length) return { items: [], leadingWithFilings: false, heroWorthy: false };
  return {
    items: picked.map((e) => e.s),
    // Said out loud rather than swapped silently: the badge means "you are looking at filings,
    // not reporting", so it answers for the item actually holding the lead.
    leadingWithFilings: isFilingStory(picked[0].s),
    // The big slot is earned. Band 2 is real news worth a tile but not a front-page claim, so the
    // section renders a compact list instead of promoting one of them.
    heroWorthy: picked[0].b === 3,
  };
}

// Editorial flag styling — subtle colored tag, no number, no emoji. null = don't render a flag.
export const IMPACT_STYLE = {
  high:    { label: 'HIGH IMPACT', bg: '#FCE9E7', fg: '#B23B2E' },
  notable: { label: 'NOTABLE',     bg: '#FFF6E8', fg: '#7A5018' },
  routine: null,
};
