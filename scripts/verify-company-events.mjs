// COMPANY EVENT COVERAGE — regression suite for the general event taxonomy, the Form 144 parser
// and the scheduled-date extractor.
//
// Every fixture below is a REAL headline taken from the wire or a REAL document body taken from
// EDGAR, including every false positive that was measured and fixed. The noise cases are not
// decoration: each one is something this taxonomy classified wrongly before the pattern that
// refuses it existed, and each is a regression waiting to happen the next time somebody widens a
// rule.
//
// Run: node scripts/verify-company-events.mjs

import {
  classifyCompanyEvent, extractScheduledDate, sourceQuality, isEvidenceSource,
  relevanceDays, COMPANY_EVENTS, SCHEDULED_TYPES, MAX_RELEVANCE_DAYS,
} from '../src/lib/evidence/company-events.mjs';
import { classifyBiotechEvent } from '../src/lib/evidence/biotech-events.mjs';
import { parseForm144, parseSaleDate } from '../src/lib/form144-parse.mjs';
import { parseIndexLine, dailyIndexUrl, recentDays } from '../src/lib/sec-daily-index.mjs';
import { DIRECTION } from '../src/lib/evidence/model.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

const typeOf = (h, s = '') => classifyCompanyEvent(h, s)?.type ?? null;

// ── 1. THE SOURCE GATE ───────────────────────────────────────────────────────
sec('GATE 1 — WHOSE STATEMENT IS THIS');

check('an issuer wire is evidence-grade', sourceQuality('GLOBENEWSWIRE') === 0.80);
check('PR Newswire likewise', sourceQuality('PRNEWSWIRE') === 0.80);
check('a professional desk ranks below the issuer',
  sourceQuality('BLOOMBERG') === 0.72 && sourceQuality('BLOOMBERG') < sourceQuality('PRNEWSWIRE'));
check('Seeking Alpha may not produce evidence', sourceQuality('SEEKINGALPHA') === null);
check('Yahoo may not produce evidence', sourceQuality('YAHOO') === null);
check('Investing.com may not produce evidence', sourceQuality('INVESTING') === null);
check('Barchart may not produce evidence', sourceQuality('BARCHART') === null);
check('an unknown source may not produce evidence', sourceQuality('SOMEBLOG') === null);
check('isEvidenceSource agrees with sourceQuality',
  isEvidenceSource('PRNEWSWIRE') === true && isEvidenceSource('YAHOO') === false);
check('source matching is case-insensitive', sourceQuality('prnewswire') === 0.80);

// ── 2. NOISE ─────────────────────────────────────────────────────────────────
sec('GATE 2 — NOISE IS REFUSED BEFORE ANY EVENT PATTERN');

const NOISE_CASES = [
  ['a conference appearance', 'Acme Corp to Present at the Jefferies Healthcare Conference'],
  ['a scheduled results date', 'Getty Realty Corp. to Report Third Quarter 2026 Financial Results'],
  ['an earnings call invitation', "Invitation to Autoliv's Q3, 2026 Earnings Call"],
  ['an award', 'Acme Named to Fortune 100 Best Places to Work List'],
  ['an award finalist', 'CollegeSource CEO Kerry Cooper Named Finalist for Best Global EdTech Leader'],
  ['an analyst rating', 'Analyst Initiates Coverage on Acme With Strong Buy and $90 Price Target'],
  ['law-firm investor spam', 'DEADLINE ALERT: Pomerantz Law Firm Encourages Acme Investors to Contact the Firm'],
  ['a class action notice', 'Acme Corp Securities Class Action Lawsuit Filed; Lead Plaintiff Deadline'],
  ['a Bloomberg roundup', 'Paramount Settles Merger Lawsuit, AMD on Track to Top $1T, More'],
  ['a market wrap', 'Stock Movers: Darden Falls on Results; Stitch Fix Down on Forecast'],
  ['an ETF distribution', 'Direxion Daily SpaceX Bull 2X ETF declares quarterly distribution of $0.0240'],
  ['an exchange-traded product offering', 'Royal Canadian Mint Announces Closing of Follow-On Offering of Gold Exchange-Traded Receipts'],
  ['an inducement grant', 'Atrium Therapeutics Announces Inducement Grants under Nasdaq Listing Rule 5635(c)(4)'],
  ['the EU weekly buy-back notice', 'Zealand Pharma - Transactions related to share buy-back program (week 38, 2026)'],
  ['a retail listicle', "Here's What $10,000 Invested in SpaceX Stock Could Look Like in 5 Years"],
  ['a question headline', 'Is Acme Corp Stock a Buy After the Merger Agreement?'],
  ['a sustainability report', 'Acme Publishes 2026 Sustainability Report Highlighting Progress'],
  ['a corporate milestone brag', 'Acme Highlights Record Milestone Achievement in Customer Growth'],
];
for (const [name, h] of NOISE_CASES) check(`refuses ${name}`, typeOf(h) === null, `got ${typeOf(h)}`);

// ── 3. THE HEADLINE MUST NAME THE SUBJECT ────────────────────────────────────
sec('GATE 3 — THE SUMMARY MAY CONFIRM, NOT INTRODUCE');

check('a summary alone cannot create a settlement',
  typeOf('DataMEDS AI Unveils New Corporate Website',
    'The company also noted it has settled outstanding litigation with a former supplier.') === null);
check('a summary alone cannot create a CEO departure',
  typeOf('Bob Chapek Is So Not Over Getting Fired From Disney',
    'The former chief executive resigned in 2022 after a board dispute.') === null);
check('a summary alone cannot create an asset sale',
  typeOf("After 43 Years, Frugal Fannie's Iconic Westwood Store is Closing",
    'The business division sale follows a strategic review.') === null);
check('but a summary MAY supply the verb when the headline names the subject',
  typeOf('Acme Corp Announces Full-Year Guidance Update',
    'The company raised its full-year revenue guidance for fiscal 2026.') === 'earn_guidance_raised');

// ── 4. CAPITAL STRUCTURE ─────────────────────────────────────────────────────
sec('CAPITAL STRUCTURE');

check('a priced offering is priced, not merely announced',
  typeOf('Viking Therapeutics Prices Upsized $500 Million Offering of Common Stock') === 'cap_offering_priced');
check('a pricing announcement counts as priced',
  typeOf('HCW Biologics Announces Pricing of $1.5 Million Private Placement') === 'cap_offering_priced');
check('a proposed offering is announced, not priced',
  typeOf('Biomea Fusion Announces Proposed Public Offering of Securities') === 'cap_offering_announced');
check('⚠️ a CLOSED offering is finished, not announced',
  typeOf('TORM plc announces closing of secondary public offering of its class A common shares') === 'cap_offering_closed');
check('⚠️ and is never reported as an announcement',
  typeOf('TORM plc announces closing of secondary public offering') !== 'cap_offering_announced');
check('⚠️ a postponed offering is the OPPOSITE event',
  typeOf('Amaero Inc. Postpones U.S. Initial Public Offering') === 'cap_offering_withdrawn');
check('a registered direct is its own class',
  typeOf('Acme Announces $12 Million Registered Direct Offering') === 'cap_registered_direct');
check('an ATM programme is its own class',
  typeOf('Acme Establishes At-The-Market Sales Agreement for up to $50 Million') === 'cap_atm');
check('a reverse split',
  typeOf('Nauticus Robotics Announces 1-for-6 Reverse Stock Split') === 'cap_reverse_split');
check('⚠️ a reverse split is NOT read as a forward split',
  typeOf('Nauticus Robotics Announces 1-for-6 Reverse Stock Split') !== 'cap_forward_split');
check('⚠️ authorised is not repurchased',
  classifyCompanyEvent('Baozun Announces US$10 million Share Repurchase Program')?.label === 'Share repurchase authorised');
check('a dividend cut',
  typeOf('Lument Finance Trust Suspends Common Stock Dividend') === 'cap_dividend_cut');
check('⚠️ an ordinary quarterly declaration is NOT an event',
  typeOf('TXNM Energy Board Declares Quarterly Common Stock Dividend') === null);
check('a special dividend is',
  typeOf('Acme Declares Special Cash Dividend of $2.00 Per Share') === 'cap_special_dividend');
check('retired convertible debt is not a new convertible',
  typeOf('Zeo Energy Corp. Achieves Debt-Free Balance Sheet Following Early Retirement of Convertible Debt') !== 'cap_convertible');
check('a lock-up expiry is a disclosure about a date',
  typeOf('Acme Announces Expiration of Lock-Up Agreements for 328.4 Million Shares') === 'cap_lockup_expiration');
check('⚠️ and its label never says insiders sold',
  !/sold|sale by/i.test(classifyCompanyEvent('Acme Announces Expiration of Lock-Up Agreements')?.label || ''));

// ── 5. M&A SEMANTICS ─────────────────────────────────────────────────────────
sec('M&A — PROPOSAL, COMPLETION AND TERMINATION ARE THREE DIFFERENT EVENTS');

check('an agreement to acquire',
  typeOf('Vertiv Announces Agreement to Acquire King Environmental Services Ltd.') === 'ma_agreement');
check('⚠️ a completed acquisition is NOT an agreement',
  typeOf('Zymeworks Completes Acquisition of Theravance Biopharma') === 'ma_completed');
check('⚠️ a terminated merger is NOT an agreement',
  typeOf('Acme and Beta Mutually Agreed to End Their Merger Agreement') === 'ma_terminated');
check('⚠️ nor is it a completion',
  typeOf('Acme Terminates Merger Agreement With Beta Corp') === 'ma_terminated');
check('being acquired is distinguished from acquiring',
  typeOf('Acme Corp Agrees to be Acquired by Beta Holdings for $45 Per Share') === 'ma_to_be_acquired');
check('a strategic review is not a sale',
  classifyCompanyEvent('Acme Announces Review of Strategic Alternatives')?.label === 'Strategic alternatives review');
check('a tender offer',
  typeOf('Beretta Holding Commences Cash Tender Offer for Shares of Sturm, Ruger & Company') === 'ma_tender_offer');
check('a material contract needs a contract-scale number',
  typeOf('HawkEye 360 Secures Approximately $18 Million in Middle East Contract Awards') === 'ma_contract_award');
check('a government issuer also qualifies',
  typeOf('Acme Awarded Department of Defense Contract for Satellite Services') === 'ma_contract_award');
check('⚠️ a retail pre-order price does NOT',
  typeOf('Meta: Ray-Ban Meta Audio launches October 13, available for pre-order at $349') === null);

// ── 6. GUIDANCE ──────────────────────────────────────────────────────────────
sec('GUIDANCE — DIRECTION, AND WHOSE OUTLOOK IT IS');

check('guidance raised',
  typeOf('NN, Inc. Raises Full-Year 2026 Guidance Ranges for Net Sales and Adjusted EBITDA') === 'earn_guidance_raised');
check('guidance lowered',
  typeOf('KB Home Cuts Full-Year Margin Outlook as Housing Conditions Worsen') === 'earn_guidance_lowered');
check('⚠️ raised and lowered are never confused',
  typeOf('Acme Lowers Full-Year Revenue Guidance') !== 'earn_guidance_raised');
check('guidance withdrawn outranks lowered',
  typeOf('Acme Withdraws Full-Year Revenue Guidance Citing Uncertainty') === 'earn_guidance_withdrawn');
check("⚠️ a bank's view on Treasury yields is not issuer guidance",
  typeOf('BOFA RAISES 10-YEAR TREASURY YIELD TARGET TO 5%') === null);
check('⚠️ nor is a house oil forecast',
  typeOf('GOLDMAN SACHS RAISES BRENT OIL FORECAST TO $85') === null);
check('⚠️ nor a broker shipment outlook',
  typeOf('GOLDMAN CUTS SMARTPHONE SHIPMENT OUTLOOK') === null);
check('reported results',
  typeOf('RAVE Restaurant Group, Inc. Reports Fourth Quarter and Fiscal Year End 2026 Financial Results') === 'earn_results');

// ── 7. MANAGEMENT, LEGAL, LISTING, OPERATIONS ────────────────────────────────
sec('MANAGEMENT / LEGAL / LISTING / OPERATIONS');

check('a CFO transition is a departure',
  typeOf('TransUnion Announces Chief Financial Officer Transition to Retire in Q1') === 'mgmt_cfo_departure');
check('a CEO appointment',
  typeOf('Acme Corp Appoints Jane Roe as Chief Executive Officer') === 'mgmt_ceo_appointed');
check('⚠️ appointing another company\'s CEO to your board is not a CEO appointment',
  typeOf('Brighter Signals to Appoint Bill Russo, Founder and CEO of Automobility, as Independent Director') === null);
check('⚠️ a routine board nomination is not a proxy contest',
  typeOf('Lantronix Nominates Former Navy SEAL Jason Lamb to Board of Directors') === null);
check('an activist push is',
  typeOf('Activist Investor Jana Again Pushes Six Flags to Explore Sale') === 'mgmt_board_contest');
check('a delisting notice',
  typeOf('Sequans Receives Notice of Non-Compliance with NYSE Market Capitalization Listing Rules') === 'list_delisting_notice');
check('⚠️ "non-compliance" outside an exchange context is not a delisting',
  typeOf('Head of the Iranian Atomic Energy Organization: not a single report of non-compliance found') === null);
check('regaining compliance is the opposite event',
  typeOf('CytoSorbents Regains Compliance with Nasdaq Minimum Bid Price Requirement') === 'list_compliance_regained');
check('⚠️ and is not read as a deficiency',
  typeOf('CytoSorbents Regains Compliance with Nasdaq Minimum Bid Price Requirement') !== 'list_delisting_notice');
check('a going-concern disclosure',
  typeOf('Acme Discloses Substantial Doubt About Its Ability to Continue as a Going Concern') === 'legal_going_concern');
check('a restatement',
  typeOf('Acme Announces Restatement of Prior Period Financial Statements') === 'legal_restatement');
check('a settlement is direction-neutral',
  classifyCompanyEvent('Acme Settles Patent Litigation With Beta Corp')?.direction === DIRECTION.UNKNOWN);
check('an operational outage',
  typeOf('Oracle Sends Force Majeure Notice Over New Mexico Data Center') === 'oper_outage');
check('a workforce reduction',
  typeOf('Microsoft Starts a New Round of Job Cuts and the Next Phase of Its Xbox Reset') === 'oper_restructuring');
check("⚠️ a law firm's restructuring practice is not a restructuring",
  typeOf('Greenberg Traurig Adds Of Counsel to London Contentious Restructuring Team') === null);
check('⚠️ an ordinary product launch produces NOTHING',
  typeOf('Cricut Launches a New Category with the All-New Cricut StickerPix Line') === null);
check('⚠️ and so does a marketing launch with a partner',
  typeOf("Thirteen Lune Launches 'Studio 13' in Partnership with Helios & Partners") === null);
check('a scheduled mission does not',
  typeOf('SpaceX: Targeting to launch Starship flight 14 as early as Sep 28') === 'oper_scheduled_launch');
check('⚠️ a completed flight is history, not a schedule',
  typeOf('SpaceX Completes Starship Flight 13 With Successful Booster Landing') !== 'oper_scheduled_launch');

// ── 8. BIOTECH STILL WINS WHERE IT APPLIES ───────────────────────────────────
sec('BIOTECH REMAINS THE MORE SPECIFIC TAXONOMY');

check('an FDA approval stays an FDA approval, not a government approval',
  typeOf("U.S. Food and Drug Administration (FDA) approves Lilly's Onswik, a once-weekly basal insulin") === 'bio_fda_approval');
check('⚠️ priority review is not approval',
  typeOf("FDA Grants Priority Review to Insmed's sNDA for ARIKAYCE") === 'bio_priority_review');
check('⚠️ an IND submission is not an IND clearance',
  typeOf('Surrozen Announces Submission of IND Application for SZN-043') === 'bio_ind_submitted');
check('⚠️ nor is it an approval',
  typeOf('Surrozen Announces Submission of IND Application for SZN-043') !== 'bio_fda_approval');
check('⚠️ a mining "Phase 2" is not a clinical trial',
  typeOf('Blue Star Reports Completion of 2026 Phase 2 Drilling Program and Auma Results Including 4.3 m of 6.06 g/t Au') === null);
check('⚠️ a warrant amendment is not an FDA approval even when the body mentions one',
  classifyBiotechEvent('InspireMD Announces Amendments to Certain Series J and Series K Warrants',
    'The company previously received FDA approval for its CGuard stent system.') === null);
check('a non-FDA regulator is the general class',
  typeOf('AbbVie Announces European Commission Approval of RINVOQ for Children') === 'legal_gov_approval');

// ── 9. SCHEDULED FUTURE DATES ────────────────────────────────────────────────
sec('FUTURE EVENT EXTRACTION — WHAT, WHEN, WHO');

const SEP17 = Date.parse('2026-09-17T17:13:00Z');
check('⚠️ the SPCX case: WHAT + WHEN + WHO',
  extractScheduledDate('SpaceX: Targeting to launch Starship flight 14 as early as Sep 28.',
    'oper_scheduled_launch', SEP17) === '2026-09-28');
check('a year-bearing date parses',
  extractScheduledDate('Lock-up expires on December 15, 2026', 'cap_lockup_expiration', SEP17) === '2026-12-15');
check('a day-first date parses',
  extractScheduledDate('Tender offer expires on 30 October 2026', 'ma_tender_offer', SEP17) === '2026-10-30');
check('⚠️ an unstated year resolves FORWARD across the boundary',
  extractScheduledDate('Lock-up expires on January 12',
    'cap_lockup_expiration', Date.parse('2026-12-20T00:00:00Z')) === '2027-01-12');
check('⚠️ no date, no claim',
  extractScheduledDate('Lock-up expires soon', 'cap_lockup_expiration', SEP17) === null);
check('⚠️ a date with no scheduling cue is not a schedule',
  extractScheduledDate('Filed its definitive proxy statement September 23, 2026 with the SEC',
    'mgmt_board_contest', SEP17) === null);
check('⚠️ a same-day date carries nothing publicTime does not',
  extractScheduledDate('Meeting scheduled for September 17, 2026', 'mgmt_board_contest', SEP17) === null);
check('⚠️ a date years out is not this release\'s event',
  extractScheduledDate('Notes mature on March 1, 2031', 'cap_lockup_expiration', SEP17) === null);
check('⚠️ an unscheduled type never produces a date',
  extractScheduledDate('Guidance raised on September 30, 2026', 'earn_guidance_raised', SEP17) === null);
check('every scheduled type is a real type',
  [...SCHEDULED_TYPES].every((t) => t.startsWith('bio_') || COMPANY_EVENTS.some((s) => s.type === t)));

// ── 10. RELEVANCE WINDOWS ────────────────────────────────────────────────────
sec('RELEVANCE — HOW LONG AN EVENT STILL EXPLAINS A MOVE');

check('a merger explains a move for weeks', relevanceDays('ma_agreement') === 45);
check('an offering for a shorter time', relevanceDays('cap_offering_priced') === 21);
check('guidance shorter still', relevanceDays('earn_guidance_lowered') === 14);
check('an operational milestone is the shortest', relevanceDays('oper_scheduled_launch') === 5);
check('⚠️ biotech keeps its OWN windows', relevanceDays('bio_ind_submitted') === 30);
check('an unknown type gets the default', relevanceDays('something_else') === 2);
check('nothing claims more than the query bound',
  COMPANY_EVENTS.every((s) => relevanceDays(s.type) <= MAX_RELEVANCE_DAYS));

// ── 11. TAXONOMY INTEGRITY ───────────────────────────────────────────────────
sec('TAXONOMY INTEGRITY');

check('every type is unique', new Set(COMPANY_EVENTS.map((s) => s.type)).size === COMPANY_EVENTS.length);
check('every spec has at least one required term', COMPANY_EVENTS.every((s) => s.all?.length >= 1));
check('every materiality is a probability', COMPANY_EVENTS.every((s) => s.materiality > 0 && s.materiality <= 1));
check('every direction is a real direction',
  COMPANY_EVENTS.every((s) => Object.values(DIRECTION).includes(s.direction)));
check('every label states an event, none is a bare noun',
  COMPANY_EVENTS.every((s) => s.label.trim().split(/\s+/).length >= 2));
check('⚠️ no label claims a completion a proposal does not establish',
  COMPANY_EVENTS.filter((s) => /announced|authoris|proposed|disclosed|notice/i.test(s.label))
    .every((s) => !/completed|executed|repurchased|sold\b/i.test(s.label)));
check('classification returns no internal fields',
  !('all' in (classifyCompanyEvent('Acme Prices $50 Million Public Offering') || {})));

// ── 12. FORM 144 PARSING ─────────────────────────────────────────────────────
sec('FORM 144 — READ, NOT INFERRED');

// A real document body, trimmed to the fields we keep.
const XML144 = `<?xml version="1.0"?><edgarSubmission><headerData><submissionType>144</submissionType></headerData>
<formData><issuerInfo><issuerCik>0000080661</issuerCik><issuerName>PROGRESSIVE CORP/OH/</issuerName>
<nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>Broz Steven</nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>
<relationshipsToIssuer><relationshipToIssuer>Officer</relationshipToIssuer><relationshipToIssuer>Director</relationshipToIssuer></relationshipsToIssuer>
</issuerInfo><securitiesInformation><securitiesClassTitle>Common</securitiesClassTitle>
<noOfUnitsSold>1225</noOfUnitsSold><aggregateMarketValue>250255.25</aggregateMarketValue>
<noOfUnitsOutstanding>581371770</noOfUnitsOutstanding><approxSaleDate>09/24/2026</approxSaleDate>
<securitiesExchangeName>NYSE</securitiesExchangeName></securitiesInformation></formData></edgarSubmission>`;

const f144 = parseForm144(XML144);
check('the ISSUER cik is taken, not the filer\'s', f144.issuerCik === '80661');
check('the issuer name', f144.issuerName === 'PROGRESSIVE CORP/OH/');
check('the person whose account it is', f144.seller === 'Broz Steven');
check('⚠️ repeated relationships are all kept', f144.relationship === 'Officer, Director');
check('shares proposed', f144.shares === 1225);
check('aggregate value', f144.aggregateValue === 250255.25);
check('shares outstanding, for the denominator', f144.sharesOutstanding === 581371770);
check('⚠️ the PROPOSED SALE DATE is a future event date', f144.approxSaleDate === '2026-09-24');
check('the exchange', f144.exchange === 'NYSE');
check('XML entities are decoded',
  parseForm144('<issuerCik>1</issuerCik><nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>H&amp;S INVESTMENTS I LP</nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>').seller === 'H&S INVESTMENTS I LP');
check('a missing field is null, never zero',
  parseForm144('<issuerCik>1</issuerCik>').aggregateValue === null);
check('a zero value is null, not a number to divide by',
  parseForm144('<issuerCik>1</issuerCik><noOfUnitsOutstanding>0</noOfUnitsOutstanding>').sharesOutstanding === null);
check('US-order dates parse', parseSaleDate('12/31/2026') === '2026-12-31');
check('a malformed date is refused', parseSaleDate('2026-12-31') === null && parseSaleDate('') === null);

// ── 13. THE DAILY INDEX ──────────────────────────────────────────────────────
sec('EDGAR DAILY INDEX — THE COMPLETE RECORD');

check('the quarter is derived from the month',
  dailyIndexUrl('2026-09-23').endsWith('/2026/QTR3/form.20260923.idx'));
check('January is QTR1', dailyIndexUrl('2026-01-05').includes('/QTR1/'));
check('December is QTR4', dailyIndexUrl('2026-12-31').includes('/QTR4/'));
check('a malformed date has no url', dailyIndexUrl('23/09/2026') === null);

const LINE = '144              AE RED HOLDINGS, LLC                                          1880796     20260923    edgar/data/1880796/0001628280-26-063268.txt';
const row = parseIndexLine(LINE);
check('the form type', row.form === '144');
check('⚠️ a company name containing a comma survives', row.company === 'AE RED HOLDINGS, LLC');
check('the cik', row.cik === '1880796');
check('the accession', row.accession === '0001628280-26-063268');
check('the dissemination date', row.date === '2026-09-23');
const LINE25 = '25-NSE           Surrozen, Inc.                                                1824893     20260807    edgar/data/1824893/0001824893-26-000045.txt';
check('a hyphenated form type is not split', parseIndexLine(LINE25).form === '25-NSE');
// ⚠️ A FORM TYPE MAY CONTAIN A SPACE. Splitting on the first run of whitespace would make this
// "SC" filed by "13D Beta Holdings Inc." — the wrong form attributed to a company that does not
// exist. The parse reads the fixed-width column, not the first token.
const LINE13D = 'SC 13D           Beta Holdings Inc.                                            1111111     20260923    edgar/data/1111111/0001111111-26-000001.txt';
check('⚠️ a form type containing a space is not split',
  parseIndexLine(LINE13D).form === 'SC 13D' && parseIndexLine(LINE13D).company === 'Beta Holdings Inc.');
check('a header line is refused', parseIndexLine('Form Type   Company Name   CIK  Date Filed  File Name') === null);
check('a blank line is refused', parseIndexLine('') === null);
check('recentDays counts back from today',
  recentDays(3, Date.parse('2026-09-24T12:00:00Z')).join(',') === '2026-09-24,2026-09-23,2026-09-22');

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
