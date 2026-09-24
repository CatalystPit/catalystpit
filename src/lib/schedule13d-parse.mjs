// SCHEDULE 13D FIELD EXTRACTION — pure, so it can be tested without a database.
//
// ── ⚠️ WHAT A SCHEDULE 13D ESTABLISHES ──────────────────────────────────────
//
//   13D filed   =  this person reports beneficial ownership of this much of this class,
//                  and has made the disclosures the form requires
//   13D filed  !=  "activist stake"
//   13D filed  !=  "investor will push for a sale"
//   13D filed  !=  "takeover planned"
//
// A Schedule 13D is required of anyone crossing 5% who does NOT qualify for the passive 13G. That
// is a legal category, not a character assessment. Plenty of 13D filers are founders, sponsors,
// lenders taking equity, or holders whose position simply stopped being passive. Every word this
// file produces is either a number copied out of the form or a clause quoted from Item 4, and
// there is no third category.
//
// ── ⚠️ THE FORM IS XML, WHICH IS WHY THIS IS NOT SCRAPING ───────────────────
//
// SEC made structured filing mandatory for Schedule 13D/G, so primary_doc.xml carries:
//
//   submissionType                         SCHEDULE 13D | SCHEDULE 13D/A
//   issuerCIK / issuerName / issuerCusip   WHO it is about
//   securitiesClassTitle                   WHICH class the cover page reports
//   dateOfEvent                            the event date — NOT the filing date
//   reportingPersonInfo[]                  one block per person, each with its OWN
//                                          percentOfClass and aggregateAmountOwned
//   items1To7/item4                        the purpose disclosure, in the filer's words
//
// ── ⚠️ PERCENTAGES ARE PER PERSON AND MUST BE READ PER PERSON ───────────────
//
// A global regex for percentOfClass is wrong and was measured to be wrong: URSB Bancorp's filing
// yields eight values for eight persons, Group members reporting 0.29%–5.40% of the SAME position.
// Summing them double-counts; taking the first picks an arbitrary member. The block-scoped parse
// below keeps each number with the person who reported it, and the summary names the person whose
// number it quotes — so "SEIDMAN LAWRENCE B reports 5.4%" is true and attributable, where
// "the reporting persons report 5.4%" would not be.

const strip = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const tag = (xml, name) => {
  const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : null;
};

const numOf = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "09/22/2026" -> "2026-09-22". Anything else is refused rather than guessed. */
export function parseEventDate(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * ⚠️ A PERCENTAGE OVER 100 IS NOT A PERCENTAGE.
 *
 * Fail closed: the filing is still worth keeping, but no ownership claim is made from a number
 * that cannot be one. Exactly 100 is legitimate — a holder can own a whole class.
 */
export const MAX_PLAUSIBLE_PCT = 100;

/**
 * Parse one Schedule 13D / 13D-A document.
 *
 * @returns {{formType,isAmendment,issuerCik,issuerName,cusip,securityClass,dateOfEvent,
 *            previouslyFiled,persons:Array,item4:string|null}}
 */
export function parseSchedule13D(xml) {
  const s = String(xml || '');
  const formType = (tag(s, 'submissionType') || '').toUpperCase();
  const issuerCik = tag(s, 'issuerCIK');
  const persons = [];
  for (const m of s.matchAll(/<reportingPersonInfo>([\s\S]*?)<\/reportingPersonInfo>/gi)) {
    const b = m[1];
    const name = tag(b, 'reportingPersonName');
    if (!name) continue;
    const pct = numOf(tag(b, 'percentOfClass'));
    persons.push({
      name,
      cik: tag(b, 'reportingPersonCIK') ? String(Number(tag(b, 'reportingPersonCIK'))) : null,
      // ⚠️ AN IMPLAUSIBLE PERCENTAGE BECOMES NULL, NOT A CLAIM. See MAX_PLAUSIBLE_PCT.
      pctOfClass: pct != null && pct >= 0 && pct <= MAX_PLAUSIBLE_PCT ? pct : null,
      shares: numOf(tag(b, 'aggregateAmountOwned')),
      personType: tag(b, 'typeOfReportingPerson'),
    });
  }
  // ⚠️ item4 IS ROUTINELY EMPTY ON AMENDMENTS. Measured: Vail Resorts and Funko both filed 13D/A
  // with a zero-length item4, because the substance was carried in an exhibit. Absence of Item 4
  // text means we say nothing about purpose — it never means "no purpose".
  const item4 = tag(s, 'item4') || null;
  return {
    formType,
    isAmendment: /\/A\b/.test(formType),
    issuerCik: issuerCik ? String(Number(issuerCik)) : null,
    issuerName: tag(s, 'issuerName'),
    cusip: tag(s, 'issuerCusipNumber'),
    securityClass: tag(s, 'securitiesClassTitle'),
    dateOfEvent: parseEventDate(tag(s, 'dateOfEvent')),
    previouslyFiled: /^true$/i.test(tag(s, 'previouslyFiledFlag') || ''),
    persons,
    item4: item4 && item4.length ? item4 : null,
  };
}

/**
 * The person whose numbers the summary is allowed to quote: the one reporting the largest position.
 *
 * ⚠️ NAME AND NUMBER TRAVEL TOGETHER. In TriplePoint's filing the lead filer reports 5.68% and
 * another person reports 7.42%; quoting the larger number under the lead filer's name would be a
 * false statement about both of them.
 */
export function primaryPerson(persons = []) {
  let best = null;
  for (const p of persons) {
    if (p.pctOfClass == null) continue;
    if (!best || p.pctOfClass > best.pctOfClass) best = p;
  }
  // Nobody reported a usable percentage — fall back to the first NAMED person, with no number.
  return best || persons.find((p) => p.name) || null;
}

/**
 * A stable identity for "the same position, filed on again".
 *
 * ⚠️ THIS IS WHAT MAKES AN AMENDMENT COMPARABLE. A 13D/A is only meaningful against the position
 * it amends, and the filer is the only thing that connects them. The lead reporting person's name
 * is used rather than the max-percent one, because the max can move between group members between
 * filings while the lead filer does not.
 */
export function groupKey(ticker, persons = []) {
  const lead = persons.find((p) => p.name);
  const name = String(lead?.name || '')
    .toLowerCase()
    .replace(/\bet al\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 48);
  return `${String(ticker || '').toUpperCase()}|${name}`;
}

// ── ITEM 4 — QUOTED, NEVER INFERRED ──────────────────────────────────────────
//
// ── ⚠️ ALMOST ALL OF ITEM 4 IS TEMPLATE LANGUAGE ────────────────────────────
//
// Nearly every Schedule 13D contains a paragraph like Saba Capital's:
//
//   "The Reporting Persons MAY engage in discussions with management, the Board of Directors,
//    other shareholders ... concerning the Issuer's business, operations, board appointments,
//    governance, performance, management, capitalization ... and strategic plans"
//
// It names the board, governance and strategy, and it establishes NOTHING. It is the standard
// reservation of rights every securities lawyer writes. A rule that fires on "board" or
// "strategic alternatives" would report an intention on behalf of almost every 13D filer in the
// market, which is precisely the unsupported "activist" language this task forbids.
//
// ── ⚠️ SO THE TEST IS THE VERB, NOT THE NOUN ────────────────────────────────
//
// What separates Cevian/Pearson ("the Reporting Person ENTERED INTO a relationship agreement with
// the Issuer pursuant to which the Issuer AGREED to appoint ... to the board") from the template is
// that something HAPPENED. A disclosure is only extracted from a sentence that states a completed
// act, and any sentence carrying a modal or a conditional is discarded before matching.

/** A sentence containing any of these is a reservation of rights, not a disclosure. */
const HEDGED = /\b(?:may|might|could|would|intends?\s+to|plans?\s+to|expects?\s+to|from\s+time\s+to\s+time|depending\s+upon|reserves?\s+the\s+right|no\s+present\s+plans?|does\s+not\s+have\s+any\s+(?:present\s+)?plans?)\b/i;

/** And it has to say something happened. */
const DEFINITE = /\b(?:entered\s+into|has\s+entered|agreed\s+to|has\s+agreed|appointed|has\s+appointed|nominated|has\s+nominated|delivered|submitted|made\s+a\s+(?:proposal|offer)|commenced|executed|consummated|completed|acquired|sold|announced)\b/i;

/**
 * The disclosures we will quote, each requiring its own specific object.
 *
 * ⚠️ EVERY `label` IS A STATEMENT ABOUT THE FILING, NOT ABOUT THE FUTURE. "discloses an agreement
 * entered into with the issuer" says a document exists. It does not say what the investor wants.
 */
export const ITEM4_DISCLOSURES = Object.freeze([
  // ⚠️ A SIGNED MERGER AGREEMENT IS NOT A PROPOSAL, and reading it as one understates it.
  { code: 'merger_agreement', label: 'discloses a merger agreement entered into by the issuer',
    all: [/\b(?:agreement\s+and\s+plan\s+of\s+merger|merger\s+agreement)\b/i] },

  // ⚠️ "AGAINST ANY ALTERNATIVE ACQUISITION PROPOSAL" IS VOTING-AGREEMENT BOILERPLATE.
  // Measured on Mistras Group: a support agreement promising to vote against competing bids was
  // read as the filer proposing to acquire the company — the reverse of what it says.
  { code: 'acquisition_proposal', label: 'discloses a proposal to acquire the issuer',
    // ⚠️ "PROPOSED ACQUISITION OF" IS THE COMMONER PHRASING. 111, Inc.'s consortium wrote
    // "a non-binding proposal ... related to the proposed acquisition of all Class A ordinary
    // shares"; a rule keyed only on the infinitive "to acquire" silently missed a take-private bid.
    all: [/\b(?:proposal|offer)\b/i,
          /\bto\s+acquire\b|\bacquisition\s+of\b|\bbusiness\s+combination\b|\bgoing[-\s]private\b/i],
    none: [/\b(?:alternative|competing|superior)\s+(?:acquisition\s+)?proposal\b/i] },

  // ⚠️ A CONSULTATION RIGHT IS NOT BOARD REPRESENTATION, and neither is a restated old disclosure.
  // Measured: Jack in the Box's amendment says the issuer "agreed to consult with GreenWood in good
  // faith regarding such prospective director" — a courtesy, not a seat. Kinetik's says "As
  // disclosed in the Original Schedule 13D, ISQ is a party to the Voting Agreement" — the news in
  // that filing was those agreements TERMINATING.
  { code: 'board_representation', label: 'discloses board representation agreed with the issuer',
    all: [/\bboard\s+of\s+directors\b|\bthe\s+Board\b/i, /\b(?:appoint|appointed|designate|designated|nominee|director)\b/i,
          /\bagree(?:d|ment)\b|\bappointed\b/i],
    none: [/\bconsult/i, /\bas\s+(?:previously\s+)?disclosed\s+in\s+the\s+(?:original|prior|initial)\b/i] },

  // ⚠️ AND THE COUNTERPARTY HAS TO BE THE ISSUER. Mistras's voting agreement was with the
  // ACQUIRER's parent, which is a different fact about a different company.
  { code: 'issuer_agreement', label: 'discloses an agreement entered into with the issuer',
    all: [/\b(?:cooperation|standstill|stockholder|shareholder|relationship|support|settlement)\s+agreement\b/i,
          /\bwith\s+the\s+Issuer\b|\bthe\s+Issuer\s+and\b|\bIssuer\s+entered\s+into\b|\bIssuer\s+and\s+certain\b/i] },

  { code: 'strategic_alternatives', label: 'discloses a stated request for a review of strategic alternatives',
    all: [/\bstrategic\s+alternatives\b/i, /\b(?:delivered|submitted|sent|demanded|requested|urged)\b/i] },

  { code: 'position_sold', label: 'discloses a disposition of the reported position',
    all: [/\bsold\b|\bdisposed\s+of\b/i, /\b(?:all|remaining|entire)\b/i, /\bshares?\b|\bposition\b/i] },
]);

/**
 * Disclosures a Schedule 13D's Item 4 actually establishes.
 *
 * @param {string} item4 the Item 4 text as filed
 * @returns {Array<{code,label}>} empty whenever Item 4 states only intentions, or is absent
 */
export function classifyItem4(item4) {
  const text = String(item4 || '');
  if (text.length < 40) return [];
  // ⚠️ SENTENCE BY SENTENCE. A filing can carry the template paragraph AND a real disclosure, and
  // testing the whole blob would let either one contaminate the other.
  const sentences = text.split(/(?<=[.;])\s+/).filter((s) => s.length > 25);
  const out = [];
  const seen = new Set();
  for (const s of sentences) {
    if (HEDGED.test(s)) continue;
    if (!DEFINITE.test(s)) continue;
    for (const d of ITEM4_DISCLOSURES) {
      if (seen.has(d.code)) continue;
      if (!d.all.every((r) => r.test(s))) continue;
      if (d.none?.some((r) => r.test(s))) continue;
      seen.add(d.code);
      out.push({ code: d.code, label: d.label });
    }
  }
  return out;
}
