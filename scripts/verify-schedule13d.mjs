// SCHEDULE 13D — regression suite for the parser, the Item 4 extractor and the significance rule.
//
// Every fixture is a REAL filing pulled from EDGAR and verified against its own primary_doc.xml,
// including each false positive that the first pass produced. The percentages, share counts and
// Item 4 sentences below are quoted, not invented, so a change that breaks one of them breaks a
// statement Catalyst Pit would have shown a trader.
//
// Run: node scripts/verify-schedule13d.mjs

import {
  parseSchedule13D, parseEventDate, primaryPerson, groupKey, classifyItem4,
  ITEM4_DISCLOSURES, MAX_PLAUSIBLE_PCT,
} from '../src/lib/schedule13d-parse.mjs';
import {
  schedule13dSignificance, describeDelta, MATERIAL_DELTA_PCT, REPORTING_THRESHOLD_PCT,
} from '../src/lib/evidence/schedule13d-significance.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── real document bodies, trimmed to the elements we read ────────────────────

/** Vail Resorts / Oasis Management — the INITIAL 13D, accession 0000902664-26-003832. */
const VAIL_INITIAL = `<edgarSubmission><headerData><submissionType>SCHEDULE 13D</submissionType></headerData>
<formData><coverPageHeader><securitiesClassTitle>Common Stock, par value $0.01 per share</securitiesClassTitle>
<dateOfEvent>09/11/2026</dateOfEvent><previouslyFiledFlag>false</previouslyFiledFlag>
<issuerInfo><issuerCIK>0000812011</issuerCIK><issuerCusips><issuerCusipNumber>91879Q109</issuerCusipNumber></issuerCusips>
<issuerName>VAIL RESORTS INC</issuerName></issuerInfo></coverPageHeader>
<reportingPersons>
<reportingPersonInfo><reportingPersonCIK>0001317904</reportingPersonCIK><reportingPersonName>Oasis Management Co Ltd.</reportingPersonName>
<aggregateAmountOwned>2199016.00</aggregateAmountOwned><percentOfClass>6.2</percentOfClass><typeOfReportingPerson>IA</typeOfReportingPerson></reportingPersonInfo>
<reportingPersonInfo><reportingPersonName>Seth Fischer</reportingPersonName>
<aggregateAmountOwned>2199016.00</aggregateAmountOwned><percentOfClass>6.2</percentOfClass><typeOfReportingPerson>IN</typeOfReportingPerson></reportingPersonInfo>
</reportingPersons></formData></edgarSubmission>`;

/** TriplePoint Venture Growth — the max percentage belongs to a person who is NOT the lead filer. */
const TRIPLEPOINT = `<edgarSubmission><headerData><submissionType>SCHEDULE 13D</submissionType></headerData>
<formData><coverPageHeader><securitiesClassTitle>Common Stock, par value $0.01 per share</securitiesClassTitle>
<dateOfEvent>12/11/2025</dateOfEvent><issuerInfo><issuerCIK>0001580345</issuerCIK>
<issuerName>TriplePoint Venture Growth BDC Corp.</issuerName></issuerInfo></coverPageHeader>
<reportingPersons>
<reportingPersonInfo><reportingPersonName>TriplePoint Capital LLC</reportingPersonName><aggregateAmountOwned>2312354.22</aggregateAmountOwned><percentOfClass>5.68</percentOfClass><typeOfReportingPerson>OO</typeOfReportingPerson></reportingPersonInfo>
<reportingPersonInfo><reportingPersonName>Madera Ventures LLC</reportingPersonName><aggregateAmountOwned>2997846.89</aggregateAmountOwned><percentOfClass>7.36</percentOfClass><typeOfReportingPerson>HC</typeOfReportingPerson></reportingPersonInfo>
<reportingPersonInfo><reportingPersonName>Michael Gontar</reportingPersonName><aggregateAmountOwned>3020781.67</aggregateAmountOwned><percentOfClass>7.42</percentOfClass><typeOfReportingPerson>IN</typeOfReportingPerson></reportingPersonInfo>
</reportingPersons><items1To7><item4>The information set forth in Item 3 of this Schedule 13D is incorporated by reference into this Item 4. TPC acquired the reported securities for investment purposes.</item4></items1To7></formData></edgarSubmission>`;

// ── 1. PARSING ───────────────────────────────────────────────────────────────
sec('PARSING — READ, NOT INFERRED');

const vail = parseSchedule13D(VAIL_INITIAL);
check('the submission type', vail.formType === 'SCHEDULE 13D');
check('an initial filing is not an amendment', vail.isAmendment === false);
check('the ISSUER cik, not the filer\'s', vail.issuerCik === '812011');
check('the issuer name', vail.issuerName === 'VAIL RESORTS INC');
check('the cusip', vail.cusip === '91879Q109');
check('the security class', vail.securityClass === 'Common Stock, par value $0.01 per share');
check('⚠️ the date of event is NOT the filing date', vail.dateOfEvent === '2026-09-11');
check('both reporting persons are kept', vail.persons.length === 2);
check('each person keeps its own percentage', vail.persons[0].pctOfClass === 6.2);
check('and its own share count', vail.persons[0].shares === 2199016);
check('and its own reporting-person type', vail.persons[0].personType === 'IA');
check('the filer cik where given', vail.persons[0].cik === '1317904');
check('a person without a cik is still kept', vail.persons[1].cik === null && vail.persons[1].name === 'Seth Fischer');

const tp = parseSchedule13D(TRIPLEPOINT);
check('an amendment flag is false on the initial form', tp.isAmendment === false);
check('an event date years before the filing parses', tp.dateOfEvent === '2025-12-11');
check('all six persons are kept', tp.persons.length === 3);

const amend = parseSchedule13D('<submissionType>SCHEDULE 13D/A</submissionType><issuerCIK>0000812011</issuerCIK>');
check('an amendment is recognised', amend.isAmendment === true && amend.formType === 'SCHEDULE 13D/A');

sec('⚠️ NAME AND NUMBER TRAVEL TOGETHER');
const pp = primaryPerson(tp.persons);
check('the quoted person is the one reporting the largest position', pp.name === 'Michael Gontar');
check('...with THEIR percentage', pp.pctOfClass === 7.42);
check('...and THEIR share count', pp.shares === 3020781.67);
check('the lead filer\'s smaller number is never quoted under the larger name',
  !(pp.name === 'TriplePoint Capital LLC' && pp.pctOfClass === 7.42));
check('a filing with no usable percentage still names someone',
  primaryPerson([{ name: 'Acme GP', pctOfClass: null }])?.name === 'Acme GP');
check('an empty person list yields nothing', primaryPerson([]) === null);

sec('FAIL CLOSED ON WHAT CANNOT BE READ');
check('a percentage above 100 is refused, not reported',
  parseSchedule13D('<reportingPersonInfo><reportingPersonName>X</reportingPersonName><percentOfClass>140</percentOfClass></reportingPersonInfo>').persons[0].pctOfClass === null);
check('...and exactly 100 is kept, because a holder can own a whole class',
  parseSchedule13D('<reportingPersonInfo><reportingPersonName>X</reportingPersonName><percentOfClass>100</percentOfClass></reportingPersonInfo>').persons[0].pctOfClass === MAX_PLAUSIBLE_PCT);
check('a missing percentage is null, never zero',
  parseSchedule13D('<reportingPersonInfo><reportingPersonName>X</reportingPersonName></reportingPersonInfo>').persons[0].pctOfClass === null);
check('a malformed event date is refused', parseEventDate('2026-09-11') === null && parseEventDate('') === null);
check('a US-order event date parses', parseEventDate('09/11/2026') === '2026-09-11');
check('an absent Item 4 is null, not an empty claim', vail.item4 === null);
check('XML entities are decoded',
  parseSchedule13D('<reportingPersonInfo><reportingPersonName>SEIDMAN &amp; ASSOCIATES LLC</reportingPersonName></reportingPersonInfo>').persons[0].name === 'SEIDMAN & ASSOCIATES LLC');

sec('GROUP KEY — WHAT MAKES AN AMENDMENT COMPARABLE');
check('the lead filer, not the max-percent one, forms the key',
  groupKey('TPVG', tp.persons) === 'TPVG|triplepointcapitalllc');
check('punctuation and case do not split a position',
  groupKey('MTN', [{ name: 'Oasis Management Co Ltd.' }]) === groupKey('MTN', [{ name: 'OASIS MANAGEMENT CO LTD' }]));
check('"et al" does not split a position',
  groupKey('X', [{ name: 'SEIDMAN & ASSOCIATES LLC ET AL' }]) === groupKey('X', [{ name: 'Seidman & Associates LLC' }]));
check('two different filers on one issuer are different positions',
  groupKey('MTN', [{ name: 'Oasis Management' }]) !== groupKey('MTN', [{ name: 'Fund 1 Investments' }]));
check('the same filer on two issuers is two positions',
  groupKey('MTN', [{ name: 'Oasis Management' }]) !== groupKey('GPI', [{ name: 'Oasis Management' }]));

// ── 2. ITEM 4 ────────────────────────────────────────────────────────────────
sec('⚠️ ITEM 4 — QUOTED, NEVER INFERRED');

const codes = (t) => classifyItem4(t).map((d) => d.code).sort();

// The template paragraph that appears in most Schedule 13Ds. Saba Capital / Japan Smaller Cap.
const BOILERPLATE = `The Reporting Persons acquired the Common Shares to which this Schedule 13D/A relates in the
ordinary course of business for investment purposes because they believe that the Common Shares are undervalued and
represent an attractive investment opportunity. The Reporting Persons may engage in discussions with management, the
Board of Directors (the "Board"), other shareholders of the Issuer and other relevant parties concerning the Reporting
Persons' investment in the Common Shares and the Issuer, including matters concerning the Issuer's business, operations,
board appointments, governance, performance, management, capitalization and strategic plans.`;
check('⚠️ the reservation-of-rights paragraph establishes NOTHING', codes(BOILERPLATE).length === 0,
  `got ${codes(BOILERPLATE)}`);

const SEIDMAN = `The Reporting Persons originally purchased the Shares based on the Reporting Persons' belief that the
Shares, when purchased, were undervalued. Depending upon overall market conditions, the Reporting Persons may endeavor to
increase or decrease their position in the Issuer through the purchase or sale of Shares on the open market.`;
check('⚠️ "may endeavor to increase or decrease" is not a disclosure', codes(SEIDMAN).length === 0);

check('an empty Item 4 yields nothing', codes('') .length === 0 && codes(null).length === 0);
check('a too-short Item 4 yields nothing', codes('Investment purposes.').length === 0);

// ⚠️ THE THREE GUARDS, EACH ISOLATED. The paragraph above is refused for several reasons at once,
// which means it cannot tell us whether any INDIVIDUAL guard still works. Each fixture below is
// written so that exactly one gate stands between it and a false disclosure.

// Only the modal stops this one: the nouns and a definite verb are both present.
const HEDGED_ONLY = `Depending upon market conditions, the Reporting Persons may seek additional shares and have agreed
to discuss a possible cooperation agreement with the Issuer at some future time.`;
check('⚠️ GUARD 1: a hedged sentence establishes nothing even when it names the agreement',
  codes(HEDGED_ONLY).length === 0, `got ${codes(HEDGED_ONLY)}`);

// Only the missing verb stops this one: no modal, and the nouns are all there.
const NO_VERB_ONLY = `The cooperation agreement with the Issuer, described in the Original Schedule 13D, remains in
effect in accordance with its terms.`;
check('⚠️ GUARD 2: a sentence that states no completed act establishes nothing',
  codes(NO_VERB_ONLY).length === 0, `got ${codes(NO_VERB_ONLY)}`);

// Only the per-sentence split stops this one: read as one blob, the Board and the appointment come
// from the hedged sentence and the word "agreement" from an unrelated one.
// ⚠️ NO MODAL ANYWHERE IN THIS FIXTURE, deliberately: if a hedge appeared, the hedge guard would
// refuse the blob too and the split would go untested. Only the sentence boundary stands here.
const SPLIT_ACROSS_SENTENCES = `The Reporting Persons requested that the Board appoint a director designated by them.
The Reporting Persons entered into a confidentiality agreement with an unaffiliated third party.`;
check('⚠️ GUARD 3: nouns from one sentence may not combine with a verb from another',
  !codes(SPLIT_ACROSS_SENTENCES).includes('board_representation'), `got ${codes(SPLIT_ACROSS_SENTENCES)}`);

// Cevian Capital / Pearson plc, accession 0000902664-26-003927.
const CEVIAN = `On September 22, 2026, the Reporting Person entered into a relationship agreement (the "Relationship
Agreement") with the Issuer pursuant to which the Issuer agreed, subject to the terms and conditions of the Relationship
Agreement, to appoint Alexander Svensson (the "Shareholder Director") to serve as a non-executive director of the
Issuer's board of directors.`;
check('a signed agreement with the issuer is a disclosure',
  codes(CEVIAN).includes('issuer_agreement'));
check('...and so is the board seat it creates',
  codes(CEVIAN).includes('board_representation'));

// Jack in the Box / GreenWood, accession from 2026-09-21.
const CONSULT = `Pursuant to the First Amendment, in the event the Board seeks to add a new director, the Issuer has
agreed to consult with GreenWood in good faith regarding such prospective director prior to his or her appointment or
nomination.`;
check('⚠️ a consultation right is NOT board representation',
  !codes(CONSULT).includes('board_representation'), `got ${codes(CONSULT)}`);

// Kinetik Holdings / ISQ — an amendment restating what the ORIGINAL 13D already said.
const RESTATED = `As disclosed in the Original Schedule 13D, ISQ is a party to the Voting Agreement, pursuant to which
ISQ agreed to vote all shares of Common Stock held of record by it in favor of individuals designated to the Board
pursuant to the A&R SHA.`;
check('⚠️ restating an earlier filing is not a new disclosure',
  !codes(RESTATED).includes('board_representation'), `got ${codes(RESTATED)}`);

// Mistras Group — a voting agreement with the ACQUIRER, not with the issuer.
const VOTING_WITH_PARENT = `Concurrently with the execution of the Merger Agreement, each Reporting Person entered into a
voting and support agreement with Parent, pursuant to which the Reporting Persons agreed to vote their shares of Common
Stock against any alternative acquisition proposal.`;
check('⚠️ an agreement with the ACQUIRER is not an agreement with the issuer',
  !codes(VOTING_WITH_PARENT).includes('issuer_agreement'), `got ${codes(VOTING_WITH_PARENT)}`);
check('⚠️ "against any alternative acquisition proposal" is not a bid BY the filer',
  !codes(VOTING_WITH_PARENT).includes('acquisition_proposal'), `got ${codes(VOTING_WITH_PARENT)}`);

const MERGER = `On September 17, 2026, the Issuer entered into an Agreement and Plan of Merger (the "Merger Agreement")
with Athena Purchaser, LLC ("Parent") and Athena Merger Sub, Inc., a wholly owned subsidiary of Parent.`;
check('⚠️ a signed merger agreement is its own fact, not "a proposal"',
  codes(MERGER).includes('merger_agreement') && !codes(MERGER).includes('acquisition_proposal'));

// 111, Inc. / Junling Liu consortium, accession 0001104659-26-108385.
const PROPOSAL = `On September 16, 2026, Gang Yu, Junling Liu and Huadeng Tech BioArray Ventures Ltd submitted a
non-binding proposal (the Proposal) to the Issuer's board of directors related to the proposed acquisition of all Class A
ordinary shares not beneficially owned by the Consortium.`;
check('a non-binding proposal to acquire IS a disclosure', codes(PROPOSAL).includes('acquisition_proposal'));

// PDS Biotechnology / Nant Capital.
const APPOINTED = `On September 14, 2026, the Reporting Person, who is the sole member of Nant Capital, and James Banaag
were each appointed to the Issuer's board of directors.`;
check('an executed board appointment is a disclosure', codes(APPOINTED).includes('board_representation'));

// enVVeno Medical / Braeden Lichti.
const SOLD = `The Reporting Person sold all of the remaining shares of Common Stock held by him and no longer
beneficially owns any securities of the Issuer.`;
check('a disposition of the whole position is a disclosure', codes(SOLD).includes('position_sold'));

check('⚠️ no label anywhere calls a filer an activist',
  ITEM4_DISCLOSURES.every((d) => !/activis|takeover|push|will\s+seek|intends/i.test(d.label)));
check('⚠️ nor does any label predict what the investor will do',
  ITEM4_DISCLOSURES.every((d) => /^discloses\b/.test(d.label)));

// ── 3. SIGNIFICANCE ──────────────────────────────────────────────────────────
sec('INITIAL 13D');

const initial = (pct) => schedule13dSignificance({ isAmendment: false, pctOfClass: pct, item4Codes: [] }, null);
check('an initial 13D above 5% is evidence', initial(9.6).promote === true);
check('...at the higher materiality', initial(9.6).materiality === 0.75);
check('...with a factual context', initial(9.6).context.text === 'newly reported holder above 5%');
check('a filing exactly at the threshold counts', initial(REPORTING_THRESHOLD_PCT).promote === true);
check('an initial 13D below 5% is still the filing, at lower materiality',
  initial(3.1).promote === true && initial(3.1).materiality === 0.60);
check('⚠️ ...and claims nothing about the threshold', initial(3.1).context === null);
check('⚠️ an unparsed percentage makes NO ownership claim',
  initial(null).promote === true && initial(null).context === null && initial(null).materiality === 0.60);

sec('13D/A — THE NEWS IS THE CHANGE, AND THERE MAY NOT BE ONE');

const amendSig = (pct, priorPct, item4 = []) => schedule13dSignificance(
  { isAmendment: true, pctOfClass: pct, item4Codes: item4 },
  priorPct == null ? null : { pctOfClass: priorPct });

// Oasis Management / Vail Resorts, 6.2% -> 7.4%, both filings held.
check('a material increase is evidence', amendSig(7.4, 6.2).promote === true);
check('...labelled as an increase', amendSig(7.4, 6.2).reason === 'stake_increase');
check('...with both numbers quoted from filings we hold',
  amendSig(7.4, 6.2).context.text === 'stake increased from 6.2% to 7.4%');
// Kaspi.kz / D-MARKET, 88.95% -> 93.51%.
check('a large holder increasing further is evidence',
  amendSig(93.51, 88.95).context.text === 'stake increased from 88.95% to 93.51%');
check('a material decrease is evidence', amendSig(9.1, 12.4).reason === 'stake_decrease');
check('...and is worded as a reduction',
  amendSig(9.1, 12.4).context.text === 'stake reduced from 12.4% to 9.1%');
check('⚠️ an increase and a decrease are scored the same',
  amendSig(9.1, 12.4).materiality === amendSig(12.4, 9.1).materiality);
check('dropping below the reporting threshold is evidence',
  amendSig(3.2, 7.8).promote === true && amendSig(3.2, 7.8).reason === 'below_threshold');
check('exiting entirely is evidence', amendSig(0, 6.5).promote === true);

sec('⚠️ ROUTINE AMENDMENTS MUST NOT BECOME CATALYSTS');
// Steel Partners / Spruce Power, 17.8% -> 18.1%. Real, and not news.
check('a 0.3-point drift is not an event', amendSig(18.1, 17.8).promote === false);
check('...for the stated reason', amendSig(18.1, 17.8).reason === 'no_material_change');
check('a 0.1-point drift is not an event', amendSig(30.0, 29.9).promote === false);
check('no movement at all is not an event', amendSig(23.1, 23.1).promote === false);
check('the threshold is a full percentage point', MATERIAL_DELTA_PCT === 1.0);
check('just under the threshold is refused', amendSig(10.9, 10.0).promote === false);
check('exactly the threshold is admitted', amendSig(11.0, 10.0).promote === true);

sec('⚠️ FAIL CLOSED WHEN THERE IS NOTHING TO COMPARE AGAINST');
check('an amendment with no prior filing we hold produces nothing',
  amendSig(9.8, null).promote === false);
check('...for the stated reason', amendSig(9.8, null).reason === 'no_prior_filing');
check('⚠️ and it never invents a baseline', amendSig(9.8, null).context === null);
check('an amendment whose percentage would not parse produces nothing',
  amendSig(null, 7.1).promote === false && amendSig(null, 7.1).reason === 'no_percentage');

sec('AN ITEM 4 DISCLOSURE OUTRANKS ARITHMETIC');
check('a disclosure promotes an otherwise routine amendment',
  amendSig(18.1, 17.8, ['board_representation']).promote === true);
check('...at the highest materiality of the three paths',
  amendSig(18.1, 17.8, ['board_representation']).materiality === 0.80);
check('...even with no prior filing to compare against',
  amendSig(19.4, null, ['issuer_agreement']).promote === true);
check('...and it still states no delta it cannot prove',
  amendSig(19.4, null, ['issuer_agreement']).context === null);

sec('CONTEXT SHAPE AND CLAIMS');
check('⚠️ context is an object with .text, like every other family',
  typeof amendSig(7.4, 6.2).context === 'object' && typeof amendSig(7.4, 6.2).context.text === 'string');
check('it carries the numbers it quotes', amendSig(7.4, 6.2).context.priorPct === 6.2);
check('a zero delta produces no context', describeDelta(7.1, 7.1, 0) === null);
check('a missing side produces no context', describeDelta(null, 7.1, 1.2) === null);
check('⚠️ no context ever claims rarity',
  [amendSig(7.4, 6.2), amendSig(9.1, 12.4), initial(9.6)]
    .every((s) => !/largest|first\s+ever|record|biggest|unprecedented/i.test(s.context?.text || '')));
check('⚠️ no context and no reason ever says "activist"',
  [amendSig(7.4, 6.2), initial(9.6), amendSig(18.1, 17.8, ['board_representation'])]
    .every((s) => !/activis/i.test(`${s.context?.text || ''} ${s.reason}`)));

// ── 4. DEDUPE ────────────────────────────────────────────────────────────────
sec('DEDUPE — ONE ACCESSION, ONE EVENT');
// The resolver keys evidence on the accession, which is the SEC's own unique identifier and the
// unique index on schedule13d_filings. Processing a filing twice must be idempotent, and a 13D and
// its later amendment must stay two events.
check('the same filing evaluated twice gives the same verdict',
  JSON.stringify(amendSig(7.4, 6.2)) === JSON.stringify(amendSig(7.4, 6.2)));
check('⚠️ an initial and its amendment are different types',
  initial(6.2).reason !== amendSig(7.4, 6.2).reason);
check('...and the amendment does not restate the initial percentage',
  amendSig(7.4, 6.2).context.pct === 7.4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
