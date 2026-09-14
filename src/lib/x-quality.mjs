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

import { macroImpact, criticalPredicate, isCompletePhrase } from './news-normalize.mjs';
import { materiallyNonEnglish } from './language.mjs';
import { isPricePrint } from './x-story.mjs';
import { classifyCatalyst, refusalReason } from './x-relevance.mjs';

// ── how old is too old to call it breaking market information ────────────────
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;

// ── halts ────────────────────────────────────────────────────────────────────
// LULD is the exchange's automatic circuit breaker: it fires on any security that moves fast, which
// on a micro-cap is most days. A halt pending news, or a regulatory suspension, is a decision
// somebody made about that company, and that is the one worth an account's attention.
const ROUTINE_HALT = /\bvolatility pause\b|\bLULD\b|\bcode\s*M\b|\(M\)\s*$/i;
const NEWS_HALT = /\bnews\b|\bT1\b|\bregulatory\b|\bSEC (?:trading )?suspension\b|\bhalted pending\b/i;
// Size is read from the market cap the engine already holds for the symbol. It is never guessed: a
// symbol with no cap on file is treated as too small to override a routine pause, which is the
// fail-closed direction.
export const HALT_CAP_FLOOR = 2e9;
const bigEnoughToMatter = (ev) => Number(ev?.market_cap) >= HALT_CAP_FLOOR;

// Structural identification of a halt: what the engine CLASSIFIED it as, never what the sentence
// says. source_type is set by the Nasdaq adapter, category by the engine, wireType by the shared
// taxonomy. Any of the three is decisive, so a halt cannot slip through by being worded unusually.
// Pit Wire's own HIGH. An event it scored this far is posted; the account does not re-litigate it.
export const HIGH_IMPORTANCE = 2;

// Whether a post carries the BREAKING label. Extracted so the HIGH/CRITICAL path and the ordinary
// path cannot drift apart: four shapes can never carry it, whatever else is true of them.
//   a CONSEQUENCE piece   "Saudi pipeline outage threatens to raise gas prices further", posted 43
//                         hours after the shutdown it describes
//   a HEDGED outcome      "could", "may", "risks", "set to" — it has not happened
//   a PRICE UPDATE        "Brent crude reaches $108" — the market moving is not an event breaking
//   a FOLLOW-UP           the account has already told this story
export function computeBreaking({ headline, macro, predicate, hasTicker, maWorded, storyHasPriors }) {
  const consequence = CONSEQUENCE.test(headline) || RESTATEMENT.test(headline);
  if (COMMENTARY.test(headline) || consequence || isPricePrint(headline) || storyHasPriors) return false;
  return !!(
    macro === 3                                  // chokepoint/producer disruption, sovereign emergency
    || predicate === 'emergency_action'
    || (predicate === 'halt' && hasTicker)
    || HARD_CORPORATE.has(predicate)             // bankruptcy, default, delisting, FDA decision, indictment
    || (maWorded && hasTicker && !SPECULATIVE.test(headline))   // a definitive public-company deal
    || ((predicate === 'fomc' || predicate === 'fomc_long' || predicate === 'rate_decision')
        && DECIDED.test(headline))
  );
}

export const isHaltEvent = (ev) =>
  String(ev?.source_type || '').toLowerCase() === 'halt'
  || String(ev?.category || '').toUpperCase() === 'HALT'
  || String(ev?.wireType || '').toLowerCase() === 'halt'
  || String(ev?.wireCategory || '').toUpperCase() === 'HALT';

// ── speculation and commentary ───────────────────────────────────────────────
// A deal that might happen is not a deal. From the sample: "Salesforce considers acquiring Listen
// Labs", "Brookfield in talks to acquire PGP Glass", "Michael Dell's family office nears deal to
// acquire Baldwin Insurance", "Euronext CEO says merger with Deutsche Boerse would make sense".
const SPECULATIVE = /\b(?:consider(?:s|ing)|in (?:advanced )?talks|nears? (?:a )?deal|weigh(?:s|ing)|explor(?:es|ing)|mulls?|reportedly|rumou?r\w*|said to be|is said to|may (?:acquire|buy|sell|cut|raise)|could (?:acquire|buy|sell)|would make sense|signals?\b|plans to explore|letter of intent|non-?binding|preliminary (?:talks|discussions)|potential(?:ly)? (?:acquir|merg|buy))/i;

// The event admitting it does not know its own outcome.
const UNCERTAIN = /\b(?:unclear|unknown|not (?:yet )?(?:clear|known|confirmed)|no details|details? (?:to follow|awaited)|remains? to be seen|yet to be (?:determined|confirmed))\b/i;

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
const HAS_SUBSTANCE = /\$[\d.,]+|\b\d+(?:\.\d+)?\s?(?:%|bps|basis points|million|billion|m\b|bn\b)|\b\d{2,}\b|\b(?:approves?|approved|rejects?|halted|files? for chapter|delisted|delisting|deregistration|defaults?|resigns?|acquires?|agreed to (?:be )?acquir|to be acquired|definitive (?:merger )?agreement|tender offer|exchange offer|going private|take-?private|breakthrough therapy|fast track|orphan drug|priority review|cuts? rates?|raises? rates?|hikes? rates?)\b/i;

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

// An actual decision, as opposed to a meeting on the calendar.
const DECIDED = /\b(?:cuts?|cut|raises?|raised|hikes?|hiked|holds?|held|leaves?|left|lowers?|lowered|announces?|announced|delivers?|delivered|votes?|voted)\b/i;

// ── what BREAKING is not ─────────────────────────────────────────────────────
// A consequence or a hedge. The event already happened, or has not happened at all: "Saudi pipeline
// outage THREATENS to raise gas prices further" is a 43-hour-old shutdown being re-described, and
// "could", "may" and "risks" are outcomes nobody has observed.
const CONSEQUENCE = /\b(?:threatens?|threatening|could|may|might|risks?|set to|poised|likely to|expected to|seen \w+ing|deepens?|worsens?|adds? to|fuels?|raises? (?:fears|concerns)|weighs? on|puts? pressure|casts? doubt)\b/i;
// Restating a position already held is not new. "NextEra Energy reaffirms 2026 earnings guidance
// and merger timeline" was labelled BREAKING purely because the word "merger" appeared in it.
const RESTATEMENT = /\b(?:reaffirms?|reaffirmed|reiterates?|reiterated|affirms?|affirmed|maintains?|maintained|confirms? (?:its|the|prior|previous)|on track|unchanged|no change)\b/i;

// ── does it read like a professional wire line ───────────────────────────────
// A canonical headline is sometimes a press-release fragment. "FDA approves Reduced Monitoring
// Time" is grammatical but says nothing about whose drug or for what, and published under the
// account's name it reads as a machine emptying a queue. Where the facts are too thin to form a
// sentence a professional would write, the instruction is to suppress rather than publish awkwardly.
const FINITE_VERB = /\b(?:is|are|was|were|has|have|had|says?|said|will|shuts?|closes?|opens?|cuts?|raises?|holds?|hits?|falls?|rises?|climbs?|drops?|gains?|slides?|jumps?|sinks?|surges?|plunges?|approves?|rejects?|clears?|halts?|halted|files?|filed|wins?|won|loses?|lost|acquires?|acquired|agrees?|agreed|announces?|announced|reports?|reported|launches?|launched|plans?|seizes?|seized|strikes?|struck|attacks?|attacked|warns?|warned|expects?|reaches?|reached|remains?|blocks?|blocked|suspends?|suspended|resigns?|resigned|names?|named|raises?|issues?|adds?|expands?|begins?|starts?|ends?|delivers?|leaves?|left|votes?|voted|denies?|denied|confirms?|confirmed|declares?|declared|takes? effect|to take effect|comes? into force|enters? into force|signs?|signed|sets?|set|receives?|received|grants?|granted|secures?|secured|posts?|posted|reaffirms?|reaffirmed|reiterates?|reiterated|affirms?|affirmed|maintains?|maintained|withdraws?|withdrew|terminates?|terminated|prices?|priced|upsizes?|upsized|resumes?|resumed|discontinues?|discontinued|initiates?|initiated|completes?|completed)\b/i;
// The tail of that list was added after the gate called "NextEra Energy reaffirms 2026 earnings
// guidance and merger timeline" fragmentary. It is a complete sentence; the list simply did not
// know the verb, and a missing verb reads to this gate exactly like a missing predicate.
// A trailing Title Case noun phrase with no qualifier is the signature of a truncated PR headline.
const TRAILING_FRAGMENT = /\b(?:[A-Z][a-z]+\s+){1,}[A-Z][a-z]+\s*$/;

export const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

export function readsAsSentence(headline) {
  const s = String(headline || '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 5) return false;                        // too thin to be a sentence
  // Truncated wording can never be published, whatever else is right about it. This is the same
  // completeness test the engine applies before STORING a canonical headline — an ellipsis, a
  // dangling connector, an unfinished date, an unclosed bracket. Held here too so the account fails
  // closed on any row that predates that fix or arrives broken by some other route.
  if (!isCompletePhrase(s)) return false;
  if (!FINITE_VERB.test(s)) return false;                    // no assertion
  if (/\b(?:the|a|an|of|for|to|in|on|with|and|or|its|their)\s*$/i.test(s)) return false;  // dangling
  // "FDA approves Reduced Monitoring Time" - ends in a bare Title Case phrase, and the sentence is
  // short enough that the phrase IS the object rather than a proper name inside a longer clause.
  if (words.length <= 7 && TRAILING_FRAGMENT.test(s) && !/[.%$\d]/.test(s)) return false;
  return true;
}

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

  // ── halts are never auto-posted ────────────────────────────────────────────
  // A deterministic exclusion on the event's own CATEGORY and TYPE, not on words in the headline.
  // It overrides impact entirely: a halt is CRITICAL on the tape because a trader scanning for
  // tradeable events needs it immediately, and that is exactly the kind of mechanical, high-volume,
  // short-lived notice a public account should not carry. LULD pauses alone ran 46 in 72 hours.
  if (isHaltEvent(ev)) return no('halts are not auto-posted');

  // ── exchange halts ─────────────────────────────────────────────────────────
  // A halt is a market fact with its own editorial bar, so it is judged here rather than by the
  // rules below, which are written for prose. Measured over 72h the feed produced 46 halts, every
  // one a routine LULD volatility pause, and seven of them were the SAME micro-cap. Posting that is
  // fifteen tweets a day of mechanical noise. What a trader actually wants is the halt that means
  // something: news pending, a regulatory or SEC trading suspension, or a pause in a security big
  // enough that the market cares. A routine auto-triggered pause is not news.
  if (String(ev?.source_type || '') === 'halt') {
    const t = (ev?.tickers || [])[0];
    if (!t) return no('halt with no resolved symbol');
    if (ROUTINE_HALT.test(headline) && !bigEnoughToMatter(ev)) return no('routine volatility pause');
    return { publish: true, reason: null, breaking: NEWS_HALT.test(headline), terminal: false };
  }

  // 0. ENGLISH, OR NOTHING. This runs before every other test because it is not a judgement about
  // the event: an untranslated source line is not a Catalyst Pit sentence at all, whatever it says.
  // Pit Wire already holds these back from public display; the account must fail closed on the same
  // evidence rather than trusting that it never receives one.
  const lang = materiallyNonEnglish(headline, ev?.summary);
  if (lang.nonEnglish) return no('untranslated non-English source text');

  // 2. Current enough to publish as breaking market information.
  const at = Date.parse(ev?.published_at ?? NaN);
  if (!Number.isFinite(at)) return no('no timestamp');
  if (now - at > MAX_AGE_MS) return no('stale');

  // ── HIGH and CRITICAL publish ──────────────────────────────────────────────
  // Everything ABOVE this line is an INTEGRITY check and still applies to every event: a headline
  // must exist, be English, be complete, be current, and not be a halt. Everything BELOW is
  // editorial judgement — speculation, vagueness, PR noise, substance, relevance — and for an event
  // Pit Wire has already scored HIGH or CRITICAL that second, stricter opinion was keeping real
  // market news off the account.
  //
  // Completeness is asserted here rather than left below, because a broken sentence is not a matter
  // of taste: it is malformed feed text, which must never be published at any impact.
  if (Number(ev?.importance) >= HIGH_IMPORTANCE) {
    // isCompletePhrase, NOT readsAsSentence. The latter also demands a verb from a fixed list and
    // rejects trailing noun phrases, which is editorial taste; this asks only whether the sentence
    // is broken — an ellipsis, a dangling connector, an unfinished date, an unclosed bracket.
    if (!isCompletePhrase(headline)) return no('incomplete or fragmentary wording');
    // A truncated PR fragment is broken FEED TEXT, not a matter of taste: "FDA approves Reduced
    // Monitoring Time" names neither whose drug nor for what. Short, all Title Case, no figure.
    if (words(headline) <= 7 && TRAILING_FRAGMENT.test(headline) && !/[.%$\d]/.test(headline)) {
      return no('incomplete or fragmentary wording');
    }

    // ── RELEVANCE: the event must be a catalyst somebody can trade ───────────
    // HIGH used to be the whole test, on the reasoning that Pit Wire had already judged the event
    // and the account held no second vote. Measured on the live account that did not hold up: the
    // score is saturated — 60 of 61 posted events came back category MARKETS at importance HIGH,
    // the same score carried by "Fireplace expert discusses how remodeling can upgrade a home".
    // A threshold on a number that says HIGH about both a lifestyle PR piece and an FDA approval
    // cannot separate them.
    //
    // So the question changed from "how important is this" to "WHAT KIND OF EVENT IS THIS", which
    // is answered deterministically from fields the pipeline already produces — no extra model
    // call, and nothing read that Pit Wire did not already compute.
    const catalyst = classifyCatalyst(ev);
    if (!catalyst) return no(refusalReason(ev));

    return {
      publish: true,
      reason: null,
      catalyst,
      breaking: computeBreaking({
        headline,
        macro: macroImpact(headline),
        predicate: criticalPredicate(hay),
        hasTicker: (ev?.tickers || []).filter(Boolean).length > 0,
        maWorded: MA_WORDED.test(headline),
        storyHasPriors: !!ev?.storyHasPriors,
      }),
      terminal: false,
    };
  }

  // 1. A concrete factual event, not commentary or speculation.
  // An admission that we do not know what happened is not publishable under any label. "Saudi
  // Arabia under attack; oil market impact unclear" tells a trader nothing and says so itself.
  if (UNCERTAIN.test(headline)) return no('outcome unclear in the event itself');
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

  // BREAKING is a brand promise and it is now SCARCE. The previous rule granted it to 68 of 68
  // publishable candidates, which is the same as not having a label at all.
  //
  // It means: something urgent just happened that moves markets. A routine economic print is real,
  // publishable and useful, and it is not that — "Canada inflation holds at 3.0% year-over-year"
  // and "Spot gold falls nearly 1% to $4,306.19" go out as plain trader-wire lines. Walter
  // provenance earns consideration, never the label.
  // Four shapes can never carry the label, whatever else is true of them:
  //   a CONSEQUENCE piece   "Saudi pipeline outage threatens to raise gas prices further" — posted
  //                         43 hours after the shutdown it is describing
  //   a HEDGED outcome      "could", "may", "risks", "set to" — it has not happened
  //   a PRICE UPDATE        "Brent crude reaches $108" — the market moving is not an event breaking
  //   a FOLLOW-UP           the account has already told this story; the second post is not news
  const breaking = computeBreaking({ headline, macro, predicate, hasTicker, maWorded,
    storyHasPriors: !!ev?.storyHasPriors });

  // A post that is not BREAKING still has to be worth reading. It needs either a ticker or a
  // measured macro fact; a vague no-ticker line with no figure is neither urgent nor informative.
  if (!breaking && !hasTicker && !(walterMacro && hasFigure(headline)) && macro < 2) {
    return no('not breaking, no ticker, no measured fact');
  }

  // 5. The text must read as something a professional wire would publish. A canonical headline can
  // be a press-release fragment — "FDA approves Reduced Monitoring Time" says nothing about whose
  // drug or for what — and an awkward half-sentence is worse for the brand than silence.
  if (!readsAsSentence(headline)) return no('incomplete or fragmentary wording');

  return { publish: true, reason: null, breaking, terminal: false };
}
