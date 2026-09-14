// X PUBLICATION QUALITY GATE. PURE — no DB, no network.
//
// Eligibility says an event MAY be posted. This says whether it SHOULD be. They are different
// questions with different jobs: Pit Wire is a complete tape a trader scans, and missing something
// there is a failure. The X account is a public brand, and posting something weak there is the
// failure. Nothing in this file touches Pit Wire scoring, dedupe or ingestion.
//
// It runs AFTER eligibility and BEFORE a candidate exists, and it FAILS CLOSED: anything it cannot
// positively justify is suppressed with a specific, auditable reason.
//
// Every rule here was written against a real 179-candidate dry run. The examples in the comments
// are verbatim from that sample.

import { macroImpact, criticalPredicate } from './news-normalize.mjs';

// ── how old is too old to call it breaking market information ────────────────
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;

// ── speculation and commentary ───────────────────────────────────────────────
// A deal that might happen is not a deal. From the sample: "Salesforce considers acquiring Listen
// Labs", "Brookfield in talks to acquire PGP Glass", "Michael Dell's family office nears deal to
// acquire Baldwin Insurance", "Euronext CEO says merger with Deutsche Boerse would make sense".
const SPECULATIVE = /\b(?:consider(?:s|ing)|in (?:advanced )?talks|nears? (?:a )?deal|weigh(?:s|ing)|explor(?:es|ing)|mulls?|reportedly|rumou?r\w*|said to be|is said to|may (?:acquire|buy|sell|cut|raise)|could (?:acquire|buy|sell)|would make sense|signals?\b|plans to explore|letter of intent|non-?binding|preliminary (?:talks|discussions)|potential(?:ly)? (?:acquir|merg|buy))/i;

// Someone's opinion about an event is not the event.
const COMMENTARY = /\b(?:says?|said|believes?|thinks?|argues?|expects? that|comments?|opinion|analysis|outlook for|what (?:it|this) means|why \w+|here'?s (?:why|what|how))\b/i;

// ── PR-wire and administrative noise ─────────────────────────────────────────
// All of these produced a candidate in the sample and none belongs on a trader-facing account.
const PR_NOISE = [
  // "Robbins Geller announces investor deadline for Regeneron class action"
  /\b(?:class action|investor deadline|lead plaintiff|law (?:firm|offices)|robbins geller|pomerantz|rosen law|bragar|levi & korsinsky)\b/i,
  // "Realtor.com identifies September 27-October 3 as best time to buy home in 2026"
  /\b(?:best time to (?:buy|sell)|identifies? .{0,30}as best|tips? for|guide to|how to)\b/i,
  // "Irgang Group announces new retail leases in Arizona, North Carolina, Georgia"
  /\b(?:new (?:retail )?leases?|lease agreement|office space|ribbon.cutting|groundbreaking)\b/i,
  // "Pharos Energy Plc files Form 8.5 disclosure" - regulatory boilerplate, not an event
  /\bform (?:8\.[35]|8\.5|3|4|144)\b|\brule 2\.9\b|\bdisclosure (?:table|notice)\b|\btr-1\b/i,
  // "Orion Corporation acquires own shares during week 37, 2026" - routine buyback mechanics
  /\b(?:acquires? own shares|own share (?:purchase|acquisition)|transactions? in own shares|share buy-?back transactions?|week \d{1,2},? 20\d\d)\b/i,
  // Awards, conferences, appointments to advisory boards, webinars, product marketing
  /\b(?:award|honou?red|recogniz\w+|named (?:to|among|official)|advisory board|webinar|conference call|to present at|exhibit\w*|trade show|partners? with|collaborat\w+ with)\b/i,
  // Insider dribble: "Alpha Compute CEO Brittany Kaiser acquires $49,997 in shares"
  /\bacquires? \$?[\d,]{1,9}(?:\.\d+)? in shares\b/i,
];

// ── low information ──────────────────────────────────────────────────────────
// "Company announces strategic transaction" is not information. A headline that names no figure, no
// product, no counterparty and no concrete verb is not worth an account's credibility.
const VAGUE = /^(?:[A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,4}\s+)?(?:announces?|unveils?|reveals?|reports?|provides?|issues?)\s+(?:a\s+|its\s+|new\s+|an\s+)?(?:strategic\s+)?(?:transaction|update|agreement|milestone|initiative|partnership|collaboration|progress|results)\b\s*\.?$/i;

// Concrete substance: a figure, a percentage, a price, a named drug or programme, a definitive verb.
const HAS_SUBSTANCE = /\$[\d.,]+|\b\d+(?:\.\d+)?\s?(?:%|bps|basis points|million|billion|m\b|bn\b)|\b\d{2,}\b|\b(?:approves?|approved|rejects?|halted|files? for chapter|delisted|defaults?|resigns?|acquires?|agreed to (?:be )?acquir|to be acquired|definitive (?:merger )?agreement|cuts? rates?|raises? rates?|hikes? rates?)\b/i;

// ── anticipation ─────────────────────────────────────────────────────────────
// A scheduled meeting that has not happened is not breaking market information, and the sample was
// full of it: "FOMC expected to raise rates 25 basis points this week", "Federal Reserve rate
// decision expected this week", "Market prices in Fed rate hike despite potential pause".
//
// Gated on there being no ACTUAL occurrence in the same headline, because "Saudi oil pipeline
// struck, expected out of service for several weeks" is a real event that happens to describe a
// future consequence, and must survive.
const ANTICIPATION = /\b(?:expect(?:s|ed|ing|ations?)?|scheduled|poised to|on track (?:for|to)|prices? in|priced in|ahead of|forecasts?|previews?|set to \w+ (?:this|next)|due (?:this|next)|awaits?|anticipat\w+)\b/i;
const OCCURRED = /\b(?:struck|shut|shuts|closed|closes|halted|approved|approves|rejected|filed|files|resigned|seized|attacked|hit|holds|held|rose|rises|fell|falls|jumped|jumps|climbs|drops|sank|sinks|surged|gains|slides|strengthens|weakens|cut|cuts|raised|hiked|announced|announces|agreed|agrees|completed|launched|launches|reported|reports|delisted|defaulted|acquired|damaged|destroyed|pushes|drives|sends|reach(?:es|ed)?|blocks?|warns?|leaks?)\b/i;

// A trusted wire's macro print: a market instrument AND a measured figure. This is what a flash
// account exists to carry, and it is the reason a Walter event is never suppressed merely for
// having no ticker.
const hasFigure = (s) => /\d/.test(s);

// ── M&A ──────────────────────────────────────────────────────────────────────
// The single worst source of noise in the sample: 50 of 156 CRITICAL candidates tripped the `ma`
// predicate and only 7 carried a resolved ticker. A private-company PR-wire acquisition has no
// listed-company relevance and must never post.
const MA_WORDED = /\bacquir\w+|\bmerger\b|\bto buy\b|\btakeover\b|\bbuyout\b|\bagreed to be acquired\b/i;
// "Straumann rises after Goldman Sachs upgrades to buy" and "best time to buy home" both trip the
// engine's `to buy`. Neither is a transaction.
const NOT_REALLY_MA = /\bupgrad\w+ to buy\b|\bto buy (?:home|house|a home|shares? of)\b|\bbest time to buy\b|\bbuy rating\b/i;

// ── market-wide predicates ───────────────────────────────────────────────────
// Events that move the whole market whether or not any symbol is attached.
const MARKET_WIDE = new Set(['fomc', 'fomc_long', 'rate_decision', 'emergency_action', 'halt']);
// Hard corporate events: consequential the moment they are true.
const HARD_CORPORATE = new Set(['chapter_7_11', 'bankruptcy', 'going_concern', 'delisting', 'default',
  'fda_decision', 'crl', 'breakthrough_therapy', 'indictment', 'fraud_charges', 'sec_charges']);

// A Walter flash is usually a macro print with no symbol. These are the terms that make one
// market-relevant without a ticker.
const MACRO_TERMS = /\b(?:fed|fomc|ecb|boj|boe|pboc|rba|rbnz|snb|central bank|rates?|yields?|treasur\w+|bonds?|cpi|ppi|pce|gdp|inflation|unemployment|payrolls?|jobless|crude|oil|wti|brent|opec|gold|futures?|index|indices|dollar|euro|yen|yuan|sterling|tariffs?|sanctions?|s&p|nasdaq|dow|vix)\b/i;

/**
 * Decide whether an eligible canonical event should be published, and whether it earns BREAKING.
 *
 * @returns {{publish:boolean, reason:string|null, breaking:boolean, terminal:boolean}}
 *   terminal=false means "not yet" (it may qualify later) rather than "no".
 */
export function publicationVerdict(ev, now = Date.now()) {
  const headline = String(ev?.headline || '');
  const hay = `${headline} ${ev?.summary || ''}`;
  const tickers = (ev?.tickers || []).filter(Boolean);
  const hasTicker = tickers.length > 0;
  const predicate = criticalPredicate(hay);
  const macro = macroImpact(headline);
  const no = (reason, terminal = true) => ({ publish: false, reason, breaking: false, terminal });

  if (!headline) return no('no headline');

  // 2. Current enough to publish as breaking market information.
  const at = Date.parse(ev?.published_at ?? NaN);
  if (!Number.isFinite(at)) return no('no timestamp');
  if (now - at > MAX_AGE_MS) return no('stale');

  // 1. A concrete factual event, not commentary or speculation.
  if (SPECULATIVE.test(headline)) return no('speculative');
  if (VAGUE.test(headline.trim())) return no('vague, no information');
  // A scheduled event that has not happened yet, with nothing that actually occurred alongside it.
  if (ANTICIPATION.test(headline) && !OCCURRED.test(headline)) return no('anticipated or scheduled event');
  // Substance can be proved three ways, and a hard corporate predicate is one of them. Without this
  // the gate suppressed "Nasus Pharma wins FDA approval" and "Scholar Rock receives FDA approval for
  // spinal muscular atrophy drug Isembyld" as having no substance, which is plainly wrong: an
  // approval IS the event. macro >= 2 is the third, for headlines like "Saudi Arabia's East-West
  // pipeline could remain offline for 3-5 weeks after drone attack" that carry no figure at all.
  const inherentlySubstantive = HARD_CORPORATE.has(predicate) || MARKET_WIDE.has(predicate);
  if (!HAS_SUBSTANCE.test(headline) && !MACRO_TERMS.test(headline) && macro < 2 && !inherentlySubstantive) {
    return no('no concrete substance');
  }

  // 6. Signal, not PR-wire noise.
  for (const re of PR_NOISE) if (re.test(hay)) return no('pr wire noise');

  // 4. Company-specific identity must be established. M&A is held to it hardest.
  const maWorded = MA_WORDED.test(headline);
  if (maWorded && NOT_REALLY_MA.test(headline)) return no('not actually a transaction');
  if (maWorded && !hasTicker) return no('ma without a listed company');

  // 3. Meaningful relevance to public-market traders.
  const marketWide = MARKET_WIDE.has(predicate) || macro >= 2;
  const walterMacro = !!ev?.trusted && MACRO_TERMS.test(headline);
  if (!hasTicker && !marketWide && !walterMacro) return no('no public-market relevance');

  // BREAKING is a brand promise, so it is granted only by a rule, never by default.
  // Commentary never gets it even when the subject matters.
  const macroPrint = walterMacro && hasFigure(headline);
  const consequential = macro === 3
    || MARKET_WIDE.has(predicate)
    || HARD_CORPORATE.has(predicate)
    || (maWorded && hasTicker)
    // A trusted wire's measured macro print — "Canada inflation holds at 3.0% year-over-year",
    // "Brent crude rises 3.5% to $108.23". This is the clause that keeps the instruction "do not
    // suppress a legitimate Walter macro flash merely because it has no ticker" true: without it
    // every one of the 24 Walter events in the sample was suppressed.
    || macroPrint;
  const breaking = consequential && !COMMENTARY.test(headline);

  // Anything that does not earn BREAKING must stand on a ticker, or it is not worth posting.
  if (!breaking && !hasTicker) return no('not breaking and no ticker');

  return { publish: true, reason: null, breaking, terminal: false };
}
