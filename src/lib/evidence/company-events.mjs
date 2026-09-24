// COMPANY EVENT CLASSIFICATION — the general taxonomy, of which biotech is one branch.
//
// ── ⚠️ THE FAILURE THIS EXISTS FOR ──────────────────────────────────────────
//
// The previous fix taught the evidence engine to read company press releases, but it could only
// classify ONE domain: biotech. So the pipeline looked complete and was not —
//
//   SOURCE -> NORMALIZE -> TICKER RESOLVE -> [CLASSIFY] -> MATERIALITY -> CANONICAL -> EVIDENCE
//                                                ^
//                                       everything that was not a drug died here
//
// Measured on SPCX: "SpaceX: Targeting to launch Starship flight 14 as early as Sep 28" was
// ingested by two feeds, ticker-resolved to SPCX correctly, and then classified by nothing, because
// classifyBiotechEvent has no opinion about rockets. An offering, a buyback, a merger, a guidance
// cut, a CEO departure and a delisting notice all died at the same line. That is not a biotech gap
// and it is not an SPCX gap — it is the whole non-pharma economy.
//
// ── ⚠️ EVENTS, NOT VOCABULARY — AND THE GENERAL CASE IS HARDER ──────────────
//
// A drug taxonomy borrows rare words. THIS one borrows ordinary ones: agreement, milestone, launch,
// award, contract, offering. Every pattern here had to survive a measurement against 20,000
// ticker-resolved wire items, and the ones that did not are recorded in the comments rather than
// quietly deleted, because the next person will be tempted to add them back.
//
// Three gates stand in front of the taxonomy, in this order:
//
//   1. THE SOURCE MUST BE A RECORD, NOT A COLUMN. See EVIDENCE_SOURCES. An opinion piece titled
//      "SpaceX: Why I'm Turning Bullish After The Drop" is not an event no matter how it is parsed,
//      and the cheapest way to never misread it is to never read it.
//   2. NOISE, WHICH WINS. Conference invitations, award announcements, analyst ratings and
//      law-firm investor spam are refused before any event pattern is tried.
//   3. THE EVENT PATTERN ITSELF, first match wins, most specific first.
//
// ── ⚠️ SEMANTICS ARE THE PRODUCT ────────────────────────────────────────────
//
// Every label states WHAT THE SOURCE ESTABLISHES and stops:
//
//   offering announced        != offering completed
//   repurchase authorised     != shares repurchased
//   merger agreement signed   != merger completed
//   Form 144 filed            != shares sold
//   lock-up expiry disclosed  != insiders sold
//   strategic review started  != company for sale
//
// A reader acts on these. Collapsing a proposal into an outcome is the most damaging thing this
// file could do, so where a distinction exists it gets its own type, its own materiality and its
// own words — never a shared "corporate event".

import { DIRECTION } from './model.mjs';
import { classifyBiotechEvent, relevanceDays as bioRelevanceDays } from './biotech-events.mjs';

// ── GATE 1: WHOSE STATEMENT IS THIS? ─────────────────────────────────────────
//
// ⚠️ A HEADLINE IS ONLY EVIDENCE WHEN SOMEONE IS ON THE HOOK FOR IT.
//
// Two populations qualify. An ISSUER WIRE release is the company speaking under securities
// liability through a regulated distributor. A NEWS DESK item is a professional newsroom asserting
// a fact it will be corrected on. Everything else on the tape — aggregator columns, retail
// research, listicles, "3 Reasons To Buy" — is commentary ABOUT events, and promoting it would let
// an opinion become the record of the thing it has an opinion about.
//
// Measured on three days of tape: SEEKINGALPHA, YAHOO, INVESTING and BARCHART together publish
// 6,391 items, the great majority of them derivative. Excluding them is not a loss of coverage,
// because a real event reaching those sources reached a wire or a filing first — which is where we
// take it from, with the better provenance and the earlier timestamp.
export const ISSUER_WIRE = new Set([
  'GLOBENEWSWIRE', 'PRNEWSWIRE', 'BUSINESSWIRE', 'NEWSFILE', 'ACCESSWIRE', 'EINPRESSWIRE',
  'PRCOM', 'BIOTECHNEWSWIRE',
]);

export const NEWS_DESK = new Set([
  'BLOOMBERG', 'WALTERBLOOMBERG', 'FINANCIALJUICE', 'BREAKINGMARKETNEWS', 'REUTERS',
  'WSJ', 'CNBC', 'FT', 'MARKETWATCH', 'NASDAQ', 'SEC', 'DOJ', 'FDA', 'FTC', 'CFTC', 'BIOSPACE',
]);

/**
 * Quality for a classified release from this source, or null when the source may not produce
 * evidence at all.
 *
 * ⚠️ BOTH ARE BELOW A FILING'S 0.95, and the desk is below the issuer, because a company
 * describing its own news is a weaker record than a document filed under liability, and a
 * newsroom describing a company's news is weaker still. Confidence reads this number.
 */
export function sourceQuality(source) {
  const s = String(source || '').toUpperCase();
  if (ISSUER_WIRE.has(s)) return 0.80;
  if (NEWS_DESK.has(s)) return 0.72;
  return null;
}

/** Whether a wire item's source is allowed to become canonical evidence at all. */
export const isEvidenceSource = (source) => sourceQuality(source) != null;

// ── GATE 2: NOISE ────────────────────────────────────────────────────────────
//
// ⚠️ THIS LIST IS NOT SHARED WITH biotech-events.mjs, DELIBERATELY.
//
// That file refuses `\bappoints?\b` outright, which is correct for a drug taxonomy and wrong here:
// a CEO appointment is one of the classes this file exists to recognise. The two noise lists
// overlap in spirit and must stay separate in fact, and classifyCompanyEvent applies each to its
// own taxonomy rather than merging them.
export const GENERAL_NOISE = [
  // Calendar entries. The company will be somewhere on a date; nothing has happened.
  /\b(?:to\s+)?present(?:s|ing|ation)?\s+at\b/i,
  /\bwill\s+(?:present|participate|host|attend|showcase|exhibit)\b/i,
  /\b(?:fireside\s+chat|webcast|webinar|investor\s+(?:day|conference|presentation)|corporate\s+presentation|analyst\s+day)\b/i,
  /\bconference\s+(?:call|presentation)\b/i,
  /\bto\s+(?:participate|attend|host|exhibit|showcase|ring\s+the)\b/i,
  /\b(?:trade\s+show|summit|expo|symposium|roadshow)\b/i,
  /\bschedules?\s+(?:its\s+)?(?:.{0,20})?(?:call|webcast|conference)\b/i,
  /\b(?:to\s+)?(?:report|announce|release|host)\s+(?:.{0,40})?(?:results?|earnings)\s+(?:on|call)\b/i,
  /\bto\s+(?:report|announce|release)\s+(?:.{0,50})?(?:results?|earnings)\b/i,
  /\binvitation\s+to\b|^\s*invitation\b/i,
  /\bearnings\s+call\b/i,
  /\binducement\s+(?:grant|award)\b|\bnasdaq\s+listing\s+rule\s+5635/i,
  // The EU weekly buy-back disclosure is a regulatory formality with no new information in it.
  /\btransactions?\s+(?:in\s+own\s+shares|related\s+to\s+(?:.{0,20})?buy-?back)/i,
  /\bweek\s+\d{1,2},?\s+20\d\d\b/i,

  // ⚠️ A ROUNDUP IS ABOUT MANY COMPANIES AND IS THE RECORD OF NONE OF THEM. Measured, Bloomberg's
  // "Stock Movers" column classified as a merger agreement for DRI and SFIX at once, because the
  // column happened to describe somebody else's deal in its body text.
  // A Bloomberg column tail — "Paramount Settles Merger Lawsuit, AMD on Track to Top $1T, More" —
  // names three unrelated companies and is the record of none of them.
  /,\s*more\s*$/im,
  /\b(?:stock\s+movers?|market\s+wrap|movers?\s+and\s+shakers|what'?s\s+moving|midday\s+movers|premarket\s+movers|daily\s+(?:briefing|roundup)|week\s+ahead)\b/i,

  // Self-congratulation. A ranking, an award or a certification is not a corporate event, and the
  // vocabulary ("wins", "achieves", "milestone", "recognized") overlaps heavily with real ones.
  /\b(?:wins?|won|receives?|named|awarded|honou?red|recognized|recognised)\s+(?:.{0,30})?\b(?:award|prize|ranking|certification|accreditation|best\s+places?|top\s+\d+|fortune\s+\d+|great\s+place)\b/i,
  /\b(?:best\s+places?\s+to\s+work|employer\s+of\s+the\s+year|company\s+of\s+the\s+year)\b/i,
  /\b(?:esg|sustainability|csr|impact|diversity|inclusion)\s+report\b/i,
  /\bcelebrat(?:es?|ing)\b/i,
  /\bfinalist\b/i,
  /\bhighlights?\b/i,
  /\b(?:appoints?|names?|welcomes?)\s+(?:.{0,40})?\b(?:advisor|advisory\s+board|ambassador)\b/i,

  // Analyst opinion. A rating is a view about a company, not a thing the company did.
  /\b(?:strong\s+buy|price\s+target|initiates?\s+coverage|upgrade[sd]?\s+to|downgrade[sd]?\s+to|reiterates?\s+(?:buy|sell|hold|outperform))\b/i,
  /\b(?:analysts?|wall\s+street)\s+(?:say|says|expect|see|think)\b/i,

  // ⚠️ SECURITIES-LITIGATION SPAM IS THE LARGEST EVENT-SHAPED NOISE CLASS ON THE WIRE, and it is
  // written to look exactly like a company announcement. It quotes the offering, the merger or the
  // restatement it is suing about. See biotech-events.mjs for the measurement that produced this.
  //
  // ⚠️ CONSEQUENCE, ACCEPTED: `class action` in noise means a company announcing a genuine class
  // action against itself is refused too. That is the right trade — the spam outnumbers the real
  // announcements by orders of magnitude, and the real one files an 8-K, which we already read.
  /\b(?:class\s+action|securities\s+(?:fraud|litigation))\b/i,
  /\b(?:deadline|investor\s+notice|investigation\s+notice|shareholder\s+alert)\b/i,
  /\b(?:encourages?|alerts?|reminds?|notifies)\s+(?:.{0,30})?investors\b/i,
  /\b(?:hagens\s+berman|rosen\s+law|levi\s+&|faruqi|pomerantz|bronstein|glancy|kaplan\s+fox|schall\s+law|bragar|kahn\s+swick|robbins\s+geller|kirby\s+mcinerney|monteverde)\b/i,
  /\blead\s+plaintiff\b/i,
  /\bon\s+behalf\s+of\s+(?:shareholders|investors|purchasers)\b/i,

  // Funds and structured products are not the operating company. "Direxion Daily SpaceX Bull 2X ETF
  // declares quarterly distribution" is a fund action that would otherwise read as a dividend.
  /\b(?:etf|etn|closed-end\s+fund|mutual\s+fund|unit\s+trust|index\s+fund)\b/i,
  /\bexchange-?traded\s+(?:fund|receipts?|notes?|products?)\b/i,
  /\b(?:declares?|announces?)\s+(?:.{0,20})?(?:monthly|quarterly)\s+distribution\b/i,

  // Retail listicle and question grammar. A record states; it does not ask or advise.
  /\?\s*$/,
  /^\s*(?:here'?s|why\s+i\b|forget\b|is\s+it\s+time|the\s+case\s+(?:for|against)|should\s+you)\b/i,
  /\b(?:\d+|three|five|seven|ten)\s+(?:reasons?|things?|stocks?|charts?)\b/i,
];

// ── GATE 3: THE TAXONOMY ─────────────────────────────────────────────────────
//
// ⚠️ `all` MEANS EVERY TERM SOMEWHERE IN THE TEXT, NOT AN ORDERED PHRASE.
//
// Wires do not agree on word order — "Announces Pricing of Public Offering" and "Prices $50 Million
// Underwritten Offering" are the same event written two ways. `none` excludes a more specific
// sibling so a general rule cannot steal its match.
//
// ORDER IS SEMANTIC. First match wins, so within a class the OUTCOME comes before the PROPOSAL and
// the SPECIFIC before the GENERAL: "Completes Merger" must not be read as "Merger Agreement".

/** A fiscal period or a company financial metric — see the guidance rules that require it. */
const GUIDANCE_ANCHOR = /\b(?:fy\s?20\d\d|fiscal|full-?year|q[1-4]\b|(?:first|second|third|fourth)\s+quarter|revenue|sales|ebitda|eps|earnings|margins?|production|deliveries|bookings)\b/i;

export const COMPANY_EVENTS = Object.freeze([
  // ══ EXCHANGE / LISTING ═════════════════════════════════════════════════════
  // First, because these phrasings are unambiguous and several of them contain words ("compliance",
  // "notice", "bid") that later classes would otherwise absorb.
  { type: 'list_trading_halt', label: 'Trading halted or suspended', materiality: 0.95, direction: DIRECTION.NEGATIVE,
    all: [/\btrading\b/i, /\b(?:halt(?:ed|s)?|suspend(?:ed|s|sion))\b/i, /\b(?:nasdaq|nyse|exchange|sec|stock)\b/i] },
  // ⚠️ THE EXCHANGE TERM IS LOAD-BEARING. Measured without it, "not a single report of
  // non-compliance" from an IAEA story classified as a delisting notice — "deficiency",
  // "non-compliance" and "minimum bid" are ordinary English outside an exchange context.
  { type: 'list_delisting_notice', label: 'Delisting or listing-deficiency notice received', materiality: 0.88, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:delist(?:ing|ed)?|deficiency|non-?compliance|minimum\s+bid|listing\s+(?:rule|standard|requirement))\b/i,
          /\b(?:nasdaq|nyse|exchange|listing|listed|delist)\b/i],
    none: [/\bregain(?:ed|s)?\s+compliance\b|\bcompliance\s+regained\b|\bhas\s+regained\b/i] },
  { type: 'list_compliance_regained', label: 'Listing compliance regained', materiality: 0.75, direction: DIRECTION.POSITIVE,
    all: [/\bcompliance\b/i, /\bregain(?:ed|s|ing)?\b/i] },
  { type: 'list_uplisting', label: 'Uplisting to a national exchange approved', materiality: 0.80, direction: DIRECTION.POSITIVE,
    all: [/\b(?:uplist(?:ing|ed)?|approved\s+for\s+listing|commence\s+trading\s+on)\b/i, /\b(?:nasdaq|nyse|nyse\s+american)\b/i] },
  { type: 'list_symbol_change', label: 'Ticker symbol change', materiality: 0.55, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:ticker|trading)\s+symbol\b/i, /\bchang(?:e|es|ed|ing)\b/i] },

  // ══ CAPITAL STRUCTURE ══════════════════════════════════════════════════════
  //
  // ⚠️ SPLITS FIRST. A reverse split headline frequently also contains "offering" or "shares", and
  // reading it as a financing would be a materially wrong statement about the share count.
  { type: 'cap_reverse_split', label: 'Reverse stock split announced', materiality: 0.85, direction: DIRECTION.NEGATIVE,
    all: [/\breverse\s+(?:stock\s+)?split\b/i] },
  { type: 'cap_forward_split', label: 'Forward stock split announced', materiality: 0.70, direction: DIRECTION.POSITIVE,
    all: [/\b(?:forward\s+(?:stock\s+)?split|stock\s+split)\b/i], none: [/\breverse\b/i] },

  // ⚠️ PRICED IS NOT ANNOUNCED. Pricing fixes the dilution — size, price and discount are known —
  // and it is the event that moves the stock. An intention to offer is a weaker, earlier statement.
  { type: 'cap_offering_priced', label: 'Offering priced', materiality: 0.85, direction: DIRECTION.NEGATIVE,
    all: [/\bpricing\s+of\b|\bprices?\s+(?:\$|its|an?\b|us\$|upsized)|\bpriced\s+(?:at|its)\b/i,
          /\b(?:offering|placement|financing|units?|notes?|shares?\s+of\s+common)\b/i] },
  { type: 'cap_pipe', label: 'PIPE financing announced', materiality: 0.80, direction: DIRECTION.UNKNOWN,
    all: [/\bpipe\b/i, /\b(?:financing|investment|transaction|offering)\b/i] },
  { type: 'cap_registered_direct', label: 'Registered direct offering announced', materiality: 0.80, direction: DIRECTION.NEGATIVE,
    all: [/\bregistered\s+direct\b/i] },
  { type: 'cap_atm', label: 'At-the-market equity programme established', materiality: 0.65, direction: DIRECTION.NEGATIVE,
    all: [/\bat-?the-?market\b/i, /\b(?:offering|program(?:me)?|facility|agreement|sales\s+agreement)\b/i] },
  { type: 'cap_convertible', label: 'Convertible notes offering announced', materiality: 0.75, direction: DIRECTION.UNKNOWN,
    all: [/\bconvertible\b/i, /\b(?:notes?|debentures?|preferred|offering|financing)\b/i],
    // Retiring convertible debt REMOVES the dilution this class exists to flag.
    none: [/\b(?:retirement|retir(?:e|es|ed)|repaid|repay|redeem|eliminat|extinguish)/i] },
  { type: 'cap_debt_financing', label: 'Debt financing or credit facility announced', materiality: 0.62, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:senior\s+notes?|term\s+loan|credit\s+facility|debt\s+financing|bond\s+offering|revolving\s+credit)\b/i] },
  // ⚠️ A CLOSING IS AN OUTCOME, NOT AN ANNOUNCEMENT. Measured on TRMD, "TORM plc announces closing
  // of secondary public offering" was reported as "Offering announced" two days AFTER the same
  // offering had already been priced and reported — telling a reader dilution was coming when the
  // money was already in. The shares are issued and the transaction is over.
  { type: 'cap_offering_closed', label: 'Offering completed', materiality: 0.65, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:offering|placement|ipo)\b/i, /\b(?:clos(?:es|ed|ing)|complet(?:e|es|ed|ion)|consummat)/i] },
  // ⚠️ A POSTPONED OFFERING IS THE OPPOSITE STATEMENT. "Amaero Inc. Postpones U.S. Initial Public
  // Offering" was being reported as an offering announcement — telling a reader dilution is coming
  // on the day the company said it is not.
  { type: 'cap_offering_withdrawn', label: 'Offering postponed or withdrawn', materiality: 0.75, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:offering|ipo|placement)\b/i, /\b(?:postpone|withdraw|cancel|terminat|shelv)/i] },
  { type: 'cap_offering_announced', label: 'Offering announced', materiality: 0.72, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:public|underwritten|secondary|follow-?on|private\s+placement|equity)\s+offering\b|\bproposed\s+offering\b|\boffering\s+of\s+(?:common|ordinary)\s+(?:stock|shares)\b/i] },
  { type: 'cap_rights_offering', label: 'Rights offering announced', materiality: 0.72, direction: DIRECTION.NEGATIVE,
    all: [/\brights\s+offering\b/i] },
  { type: 'cap_warrant_exercise', label: 'Warrant exercise or inducement', materiality: 0.62, direction: DIRECTION.UNKNOWN,
    all: [/\bwarrants?\b/i, /\b(?:exercis(?:e|ed|es|ing)|inducement|repricing)\b/i] },

  // ⚠️ AUTHORISED IS NOT REPURCHASED. A board authorisation creates permission and nothing else;
  // companies routinely authorise programmes they never execute.
  { type: 'cap_buyback_authorized', label: 'Share repurchase authorised', materiality: 0.70, direction: DIRECTION.POSITIVE,
    all: [/\b(?:repurchase|buy-?back)\b/i, /\b(?:authoriz|authoris|approv|adopt|announc|expand|increas|renew)/i] },
  { type: 'cap_special_dividend', label: 'Special dividend declared', materiality: 0.75, direction: DIRECTION.POSITIVE,
    all: [/\bspecial\s+(?:cash\s+)?dividend\b/i] },
  // ⚠️ 'cap_stock_dividend' WAS MEASURED AND REMOVED. A stock dividend pays shareholders in shares,
  // but the phrase that identifies it — "stock dividend" — is also how issuers write an ORDINARY
  // cash dividend: "TXNM Energy Board Declares Quarterly Common Stock Dividend". All ten matches
  // over 30 days were ordinary declarations, and because it sorted above cap_dividend_cut,
  // "Lument Finance Trust Suspends Common Stock Dividend" was reported as a dividend being PAID.
  // Ordinary declarations already have their own product surface and are not catalysts.
  { type: 'cap_dividend_cut', label: 'Dividend reduced or suspended', materiality: 0.85, direction: DIRECTION.NEGATIVE,
    all: [/\bdividend\b/i, /\b(?:suspend|reduc|cut|elimin|omit|discontinu)/i] },
  { type: 'cap_dividend_initiated', label: 'Dividend initiated', materiality: 0.68, direction: DIRECTION.POSITIVE,
    all: [/\bdividend\b/i, /\b(?:initiat|institut|first-?ever|inaugural)/i] },

  // ⚠️ THE LOCK-UP CLASS IS A DISCLOSURE ABOUT A DATE, NOT A TRADE. See extractScheduledDate:
  // when the text states the day, it becomes eventTime and the filing date stays publicTime.
  { type: 'cap_lockup_expiration', label: 'Lock-up expiration disclosed', materiality: 0.70, direction: DIRECTION.NEGATIVE,
    all: [/\block-?up\b/i, /\b(?:expir|releas|waiv|end(?:s|ed|ing)?\b|terminat)/i] },
  { type: 'cap_share_unlock', label: 'Shares becoming eligible for sale', materiality: 0.68, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:eligible\s+for\s+(?:sale|trading|resale)|become\s+(?:freely\s+)?tradable|unlock(?:ed|ing)?)\b/i, /\bshares?\b/i] },
  { type: 'cap_registration_effective', label: 'Registration statement declared effective', materiality: 0.60, direction: DIRECTION.NEGATIVE,
    all: [/\bregistration\s+statement\b/i, /\beffective\b/i] },

  // ══ M&A / STRATEGIC ════════════════════════════════════════════════════════
  //
  // ⚠️ COMPLETION BEFORE AGREEMENT, TERMINATION BEFORE BOTH. "Terminates Merger Agreement" contains
  // every word that "Merger Agreement" does, and the three outcomes are opposites.
  { type: 'ma_terminated', label: 'Merger or acquisition agreement terminated', materiality: 0.92, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:merger|acquisition|business\s+combination|transaction)\b/i, /\b(?:terminat|abandon|call(?:ed|s)?\s+off|walks?\s+away|mutually\s+agreed\s+to\s+end)/i] },
  { type: 'ma_to_be_acquired', label: 'Agreement to be acquired', materiality: 0.95, direction: DIRECTION.POSITIVE,
    all: [/\bto\s+be\s+acquired\b|\bagrees?\s+to\s+be\s+acquired\b|\bwill\s+be\s+acquired\s+by\b/i] },
  { type: 'ma_completed', label: 'Acquisition or merger completed', materiality: 0.80, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:complet(?:e|es|ed|ion)|clos(?:es|ed|ing)|consummat)/i, /\b(?:acquisition|merger|business\s+combination|takeover)\b/i] },
  { type: 'ma_tender_offer', label: 'Tender offer', materiality: 0.88, direction: DIRECTION.UNKNOWN,
    all: [/\btender\s+offer\b|\bexchange\s+offer\b/i] },
  { type: 'ma_agreement', label: 'Definitive merger or acquisition agreement signed', materiality: 0.88, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:definitive\s+(?:merger\s+)?agreement|agreement\s+to\s+acquire|merger\s+agreement|agrees?\s+to\s+acquire|to\s+acquire\b)/i] },
  { type: 'ma_unsolicited', label: 'Unsolicited or revised acquisition proposal', materiality: 0.88, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:unsolicited|hostile|non-?binding)\b/i, /\b(?:proposal|offer|bid)\b/i] },
  { type: 'ma_strategic_review', label: 'Strategic alternatives review', materiality: 0.82, direction: DIRECTION.UNKNOWN,
    all: [/\bstrategic\s+(?:alternatives?|review|options?)\b/i] },
  { type: 'ma_asset_sale', label: 'Material asset or business sale', materiality: 0.72, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:sale|divest(?:iture|ment|s|ed)?|sells?|spin-?off)\b/i, /\b(?:business|division|subsidiar|segment|assets?|portfolio|unit)\b/i] },
  { type: 'ma_joint_venture', label: 'Joint venture formed', materiality: 0.62, direction: DIRECTION.POSITIVE,
    all: [/\bjoint\s+venture\b/i] },

  // ⚠️ A CONTRACT MUST CARRY A NUMBER OR AN ISSUING AUTHORITY. "Announces Partnership" without
  // either is a marketing statement; measured, the unqualified form matched constantly and meant
  // nothing. The size or the counterparty is what makes it a fact a trader can price.
  { type: 'ma_contract_award', label: 'Material contract or order award', materiality: 0.70, direction: DIRECTION.POSITIVE,
    // ⚠️ BARE "ORDER" AND A BARE DOLLAR SIGN WERE BOTH TOO CHEAP. Measured, "Ray-Ban Meta Audio
    // launches October 13, available for pre-order at $349" became a material contract award for
    // META. The size term now has to be a contract-scale number, and a retail price is not one.
    all: [/\b(?:contract|award(?:ed)?|task\s+order|purchase\s+order|supply\s+agreement)\b/i,
          /\$\s?\d[\d,.]*\s*(?:million|billion|bn\b|m\b)|\b(?:department\s+of|u\.?s\.?\s+(?:army|navy|air\s+force|space\s+force)|nasa|pentagon|ministry\s+of|government\s+of)\b/i] },
  { type: 'ma_contract_lost', label: 'Material contract terminated or lost', materiality: 0.82, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:contract|agreement|partnership|supply)\b/i, /\b(?:terminat|cancel|not\s+renew|lost|loses)/i] },
  { type: 'ma_licensing', label: 'Licensing or commercial agreement', materiality: 0.62, direction: DIRECTION.POSITIVE,
    all: [/\b(?:licens(?:e|ing)\s+agreement|exclusive\s+licen|royalty\s+agreement|distribution\s+agreement)\b/i] },

  // ══ EARNINGS / GUIDANCE ════════════════════════════════════════════════════
  //
  // ⚠️ DIRECTION FIRST. "Raises Guidance" and "Lowers Guidance" share every other word, so a
  // general guidance rule placed above them would erase the only part that matters.
  { type: 'earn_guidance_withdrawn', label: 'Guidance withdrawn', materiality: 0.92, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:guidance|outlook|forecast)\b/i, /\b(?:withdraw|suspend|pull(?:s|ed)?|no\s+longer\s+provid)/i,
    // ⚠️ THE FISCAL ANCHOR IS WHAT MAKES THIS THE COMPANY'S OWN GUIDANCE. Without it, "BOFA RAISES
    // 10-YEAR TREASURY YIELD TARGET TO 5%", "GOLDMAN SACHS RAISES BRENT OIL FORECAST TO $85" and
    // "GOLDMAN CUTS SMARTPHONE SHIPMENT OUTLOOK" all classified as issuer guidance — three banks'
    // opinions about the world, recorded as three companies' outlooks.
    GUIDANCE_ANCHOR] },
  { type: 'earn_warning', label: 'Revenue or profit warning', materiality: 0.90, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:profit|revenue|earnings|sales)\b/i, /\bwarn(?:s|ing|ed)\b|\bshortfall\b|\bwill\s+fall\s+(?:short|below)\b/i] },
  { type: 'earn_guidance_lowered', label: 'Guidance lowered', materiality: 0.88, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:guidance|outlook|forecast|expectations?)\b/i, /\b(?:lower|cut|reduc|trim|slash|downward|below\s+prior)/i, GUIDANCE_ANCHOR] },
  { type: 'earn_guidance_raised', label: 'Guidance raised', materiality: 0.85, direction: DIRECTION.POSITIVE,
    all: [/\b(?:guidance|outlook|forecast)\b/i, /\b(?:rais(?:e|es|ed)|increas|boost|upward|hik(?:e|es|ed))/i, GUIDANCE_ANCHOR] },
  { type: 'earn_preliminary', label: 'Preliminary results reported', materiality: 0.72, direction: DIRECTION.UNKNOWN,
    all: [/\bpreliminary\b/i, /\b(?:results?|revenue|sales|financial)\b/i] },
  { type: 'earn_guidance_issued', label: 'Guidance issued', materiality: 0.62, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:guidance|outlook)\b/i, /\b(?:provid(?:e|es|ed)|issu(?:e|es|ed)|initiat|introduc|announc)/i, GUIDANCE_ANCHOR] },
  { type: 'earn_results', label: 'Quarterly or annual results reported', materiality: 0.70, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:first|second|third|fourth|q[1-4]|fiscal|full-?year|annual)\b/i,
          /\b(?:results?|earnings)\b/i,
          /\breport(?:s|ed|ing)?\b|\bannounc(?:e|es|ed)\b|\bposts?\b/i] },

  // ══ MANAGEMENT ═════════════════════════════════════════════════════════════
  //
  // ⚠️ ONLY THE TWO SEATS THE MARKET PRICES. A VP of marketing changing jobs is not a corporate
  // event; measured, admitting general "executive" changes produced mostly promotional releases
  // about new hires two levels below the C-suite. Departure outranks appointment because the two
  // are usually announced together and the departure is the news.
  { type: 'mgmt_ceo_departure', label: 'CEO departure', materiality: 0.85, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:chief\s+executive|ceo)\b/i, /\b(?:resign|steps?\s+down|depart|terminat|dismiss|ous(?:t|ted)|transition(?:s|ing)?\s+out|to\s+retire|retires?\b)/i] },
  { type: 'mgmt_cfo_departure', label: 'CFO departure', materiality: 0.78, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:chief\s+financial|cfo)\b/i, /\b(?:resign|steps?\s+down|depart|terminat|dismiss|to\s+retire|retires?\b)/i] },
  { type: 'mgmt_ceo_appointed', label: 'CEO appointed', materiality: 0.70, direction: DIRECTION.UNKNOWN,
    // ⚠️ THE TRAILING \b HAD TO MOVE INSIDE. `(?:appoint|…)\b` cannot match "Appoints" — there is
    // no word boundary between the t and the s — so the rule silently required the summary to
    // carry the verb and the most common phrasing in the class never matched on its own.
    all: [/\b(?:chief\s+executive|ceo)\b/i, /\b(?:appoints?|appointed|names?|named|hir(?:e|es|ed)|succeed(?:s|ed)?|elect(?:s|ed)?)\b/i],
    // ⚠️ "Brighter Signals to Appoint Bill Russo, Founder and CEO of Automobility, as Independent
    // Director" names a CEO and appoints nobody to that job — the title belongs to another company.
    none: [/\b(?:independent\s+director|to\s+(?:the\s+)?board|board\s+of\s+directors|advisory\s+board)\b/i] },
  { type: 'mgmt_cfo_appointed', label: 'CFO appointed', materiality: 0.62, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:chief\s+financial|cfo)\b/i, /\b(?:appoints?|appointed|names?|named|hir(?:e|es|ed)|succeed(?:s|ed)?)\b/i],
    none: [/\b(?:independent\s+director|advisory\s+board)\b/i] },
  { type: 'mgmt_board_contest', label: 'Board change under activist or contested circumstances', materiality: 0.80, direction: DIRECTION.UNKNOWN,
    // ⚠️ NOMINATING A DIRECTOR IS ROUTINE GOVERNANCE. Only the contested forms belong here —
    // "Lantronix Nominates Former Navy SEAL Jason Lamb to Board of Directors" is a press release.
    all: [/\b(?:activist|proxy\s+(?:contest|fight|statement)|withhold\s+campaign|consent\s+solicitation|board\s+seats?)\b/i] },

  // ══ REGULATORY / LEGAL ═════════════════════════════════════════════════════
  { type: 'legal_enforcement', label: 'Regulatory enforcement action', materiality: 0.90, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:sec|doj|ftc|cftc|fda|epa|finra|attorney\s+general)\b/i, /\b(?:enforcement|charges?|indict|fine[ds]?\b|penalt|consent\s+order|cease\s+and\s+desist)\b/i] },
  { type: 'legal_investigation', label: 'Government investigation or subpoena disclosed', materiality: 0.85, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:subpoena|grand\s+jury|criminal\s+(?:probe|investigation)|formal\s+investigation|civil\s+investigative\s+demand)\b/i] },
  // ⚠️ DIRECTION IS UNKNOWN, NOT POSITIVE. A settlement removes an uncertainty and may cost a
  // fortune doing it: "Cardinal Health Loses Multiple Lawsuits ... and Pays Attorneys' Fees" is
  // a resolution and a defeat at the same time.
  { type: 'legal_settlement', label: 'Litigation settled', materiality: 0.75, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:settle(?:s|d|ment)?|resolv(?:e|es|ed))\b/i, /\b(?:lawsuit|litigation|claims?|dispute|patent|antitrust)\b/i] },
  { type: 'legal_ruling', label: 'Court ruling or verdict', materiality: 0.85, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:court|jury|judge|tribunal|appeals?)\b/i, /\b(?:rul(?:e|es|ed|ing)|verdict|judgment|injunction|dismiss(?:es|ed|al))\b/i] },
  { type: 'legal_gov_approval', label: 'Government or regulatory approval granted', materiality: 0.80, direction: DIRECTION.POSITIVE,
    all: [/\b(?:regulatory|antitrust|government|federal|hsr|cfius|ftc|doj|european\s+commission|ofcom|faa|fcc|ferc|usda|epa)\b/i,
          /\b(?:approv(?:al|es|ed)|clear(?:s|ed|ance)|authoriz(?:es|ed|ation)|licen[cs]e\s+granted|certif(?:ies|ied|ication))\b/i] },
  { type: 'legal_gov_rejection', label: 'Government or regulatory rejection', materiality: 0.88, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:regulatory|antitrust|government|federal|ftc|doj|european\s+commission|faa|fcc)\b/i,
          /\b(?:reject(?:s|ed|ion)|den(?:y|ies|ied|ial)|block(?:s|ed)|sues?\s+to\s+block|oppos(?:es|ed))\b/i] },
  { type: 'legal_bankruptcy', label: 'Bankruptcy or restructuring filing', materiality: 1.00, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:chapter\s+(?:7|11|15)|bankruptcy|receivership|insolvenc|administration|liquidation)\b/i,
          /\b(?:fil(?:e|es|ed|ing)|enter(?:s|ed)|commenc|petition)/i] },
  { type: 'legal_going_concern', label: 'Going-concern doubt disclosed', materiality: 0.92, direction: DIRECTION.NEGATIVE,
    all: [/\bgoing\s+concern\b/i] },
  { type: 'legal_restatement', label: 'Financial restatement or non-reliance', materiality: 0.95, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:restat(?:e|es|ed|ement)|non-?reliance|material\s+weakness|accounting\s+(?:error|irregularit))\b/i] },
  { type: 'legal_cyber', label: 'Cybersecurity incident disclosed', materiality: 0.82, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:cyber(?:security)?\s+(?:incident|attack|breach)|data\s+breach|ransomware|unauthorized\s+access)\b/i] },
  { type: 'legal_recall', label: 'Product recall', materiality: 0.80, direction: DIRECTION.NEGATIVE,
    all: [/\brecall(?:s|ed|ing)?\b/i, /\b(?:product|vehicle|device|lot|batch|units?)\b/i] },

  // ══ OPERATIONAL / COMMERCIAL ═══════════════════════════════════════════════
  //
  // ⚠️ THE HARDEST CLASS TO KEEP HONEST. "Launch", "milestone" and "production" are the vocabulary
  // of every marketing release ever written. Each pattern here demands a CONCRETE object — a named
  // facility, a quantity, a first-of-its-kind claim — because "Company Announces Exciting New
  // Milestone" must produce nothing.
  { type: 'oper_outage', label: 'Operational disruption or outage', materiality: 0.80, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:outage|shutdown|disruption|suspend(?:s|ed)?\s+(?:operations|production)|force\s+majeure|fire\s+at|explosion|derail|grounded)\b/i] },
  { type: 'oper_production_milestone', label: 'Production or commercial milestone reached', materiality: 0.65, direction: DIRECTION.POSITIVE,
    all: [/\b(?:commercial\s+production|first\s+(?:production|delivery|shipment|revenue|flight|launch)|full\s+(?:capacity|production)|production\s+(?:begins?|started|commenc))\b/i] },
  // ⚠️ THE ORDINARY PRODUCT LAUNCH WAS MEASURED AND REMOVED, NOT FORGOTTEN.
  //
  // A general `launch` rule was the single largest class this taxonomy produced — 133 of 935 hits
  // over 30 days — and reading them showed what they were: "Cricut Launches a New Category with
  // StickerPix", "Aithon Launches AWS Co-Sell", "Thirteen Lune Launches Studio 13". Marketing.
  // Promoting it would have been exactly the "turn ordinary corporate PR into evidence" failure,
  // and it would have buried the real events underneath it. A product launch that genuinely
  // repriced a company files an 8-K or reports revenue, and we read both.
  //
  // What survives is the SCHEDULED milestone, which is a different statement: it names an operation
  // AND a date, which is the WHAT + WHEN this file's future-event contract requires. SPCX's
  // "Targeting to launch Starship flight 14 as early as Sep 28" is one; StickerPix is not.
  { type: 'oper_scheduled_launch', label: 'Scheduled launch or mission', materiality: 0.62, direction: DIRECTION.UNKNOWN,
    all: [/\b(?:launch(?:es|ed|ing)?|flight|mission|deployment|lift-?off)\b/i,
          /\b(?:target(?:s|ing|ed)?|schedul(?:e|es|ed)|set\s+for|as\s+early\s+as|slated|planned\s+for|expected\s+(?:on|in)|no\s+earlier\s+than)\b/i],
    // A retrospective is not a schedule: "completed its 14th flight" states history.
    strict: true,
    none: [/\b(?:complet(?:e|es|ed)|successful(?:ly)?|return(?:s|ed)|land(?:s|ed)|abort(?:s|ed)|scrub(?:s|bed))\b/i] },
  { type: 'oper_expansion', label: 'Facility or capacity expansion announced', materiality: 0.58, direction: DIRECTION.POSITIVE,
    all: [/\b(?:new\s+(?:facility|plant|factory|site)|expand(?:s|ed|ing)?\s+(?:capacity|production|manufacturing)|break(?:s)?\s+ground|gigafactory)\b/i] },
  { type: 'oper_restructuring', label: 'Restructuring or workforce reduction', materiality: 0.78, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:layoffs?|workforce\s+reduction|job\s+cuts?|restructur(?:e|es|ing)|reduction\s+in\s+force|furlough)\b/i],
    // "Greenberg Traurig Adds Of Counsel to London Contentious Restructuring Team" is a law firm
    // naming a practice group.
    none: [/\b(?:law\s+firm|of\s+counsel|practice\s+(?:group|team)|attorneys?)\b/i] },
]);

// ── SCHEDULED FUTURE EVENTS ──────────────────────────────────────────────────
//
// ⚠️ THE EVIDENCE MODEL ALREADY SEPARATES publicTime FROM eventTime, and until now nothing on the
// press-release path ever set the second one. Some releases establish a date the market will care
// about LATER: a lock-up that expires on the 24th, a shareholder vote, a tender expiry, a launch
// window. Knowing it beforehand is the difference between context and hindsight.
//
// ⚠️ AND THIS IS NOT A GUESSING ENGINE. A date is extracted only when THREE things are explicit:
//
//   WHAT   the item already classified as one of SCHEDULED_TYPES — the event is named, not inferred
//   WHEN   a calendar date written in the text, parsed exactly, never "soon" or "later this year"
//   WHO    the ticker was resolved by the canonical resolver before this file ever saw the item
//
// Anything short of all three yields null, and the record keeps publicTime alone.
export const SCHEDULED_TYPES = new Set([
  'cap_lockup_expiration', 'cap_share_unlock', 'cap_registration_effective',
  'ma_tender_offer', 'mgmt_board_contest',
  'oper_production_milestone', 'oper_scheduled_launch',
  'bio_pdufa',
]);

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "September 28, 2026" / "Sep 28" / "28 September 2026" — the forms wires actually write. */
const DATE_PATTERNS = [
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/i,
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(20\d\d))?\b/i,
];

/** How far ahead a stated date may be and still plausibly be the event this release is about. */
export const MAX_SCHEDULE_AHEAD_DAYS = 400;

/**
 * ⚠️ A SCHEDULED EVENT IS IN THE FUTURE, OR IT IS NOT A SCHEDULE.
 *
 * Measured without this: "Gran Tierra Energy Announces Filing of Definitive Proxy Statement for
 * Special Meeting of Stockholders" produced a scheduled date equal to its own publication day —
 * the date in the text was the filing date, not the meeting. A same-day date carries no
 * information the publicTime does not already carry.
 */
export const MIN_SCHEDULE_AHEAD_DAYS = 1;

/**
 * ⚠️ AND THE DATE MUST BE INTRODUCED AS A SCHEDULE.
 *
 * A release is full of dates — when it was filed, when the quarter ended, when the company was
 * founded. Only a date a scheduling word points AT is a claim about the future, so the cue has to
 * sit immediately in front of it.
 */
const SCHEDULE_CUE = /(?:on|until|through|before|by|for|expires?(?:\s+on)?|scheduled(?:\s+for)?|set\s+for|as\s+early\s+as|targeting|slated(?:\s+for)?|effective|beginning|starting|commencing|no\s+earlier\s+than|expected(?:\s+(?:on|in))?|planned\s+for)\s*$/i;
/** How far back of the date the cue may sit — long enough for "scheduled to occur on". */
const CUE_WINDOW = 28;

/**
 * The scheduled date a release explicitly states, or null.
 *
 * @param {string} text     headline (+ summary) as published
 * @param {string} type     the classified event type; must be in SCHEDULED_TYPES
 * @param {number} publicMs when the release became public — the year is resolved relative to this
 * @returns {string|null} ISO date, or null when no date is explicitly stated
 */
export function extractScheduledDate(text, type, publicMs) {
  if (!SCHEDULED_TYPES.has(type)) return null;
  const s = String(text || '');
  if (!Number.isFinite(publicMs)) return null;
  for (const re of DATE_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    if (!SCHEDULE_CUE.test(s.slice(Math.max(0, m.index - CUE_WINDOW), m.index))) continue;
    const monthFirst = /^[a-z]/i.test(m[1]);
    const mon = MONTHS[String(monthFirst ? m[1] : m[2]).slice(0, 3).toLowerCase()];
    const day = Number(monthFirst ? m[2] : m[1]);
    if (mon == null || !(day >= 1 && day <= 31)) continue;
    const pub = new Date(publicMs);
    // ⚠️ AN UNSTATED YEAR IS RESOLVED FORWARD, NOT ASSUMED. "as early as Sep 28" published in
    // December means next year; taking the publication year would date the event nine months into
    // the past and invert its meaning.
    let year = m[3] ? Number(m[3]) : pub.getUTCFullYear();
    let t = Date.UTC(year, mon, day);
    if (!m[3] && t < publicMs) t = Date.UTC(++year, mon, day);
    const aheadDays = (t - publicMs) / 86_400_000;
    if (aheadDays > MAX_SCHEDULE_AHEAD_DAYS) continue;
    if (aheadDays < MIN_SCHEDULE_AHEAD_DAYS) continue;
    return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * Classify one wire item as a stated company event.
 *
 * ⚠️ BIOTECH IS TRIED FIRST because it is the more specific taxonomy: "FDA Approves ACME's Drug"
 * would otherwise land in legal_gov_approval, which is true but useless next to "FDA approval".
 * Each taxonomy applies its OWN noise list — see GENERAL_NOISE for why they are not merged.
 *
 * @returns {{type,label,materiality,direction}|null} null whenever this is not a stated event.
 */
export function classifyCompanyEvent(headline, summary = '') {
  const head = String(headline || '').trim();
  const text = `${head} ${String(summary || '')}`.trim();
  if (text.length < 12) return null;

  const bio = classifyBiotechEvent(headline, summary);
  if (bio) return bio;

  for (const n of GENERAL_NOISE) if (n.test(text)) return null;

  for (const spec of COMPANY_EVENTS) {
    // ⚠️ THE SUMMARY MAY CONFIRM AN EVENT. IT MAY NOT INTRODUCE ONE.
    //
    // The first `all` term is the SUBJECT of the event — offering, merger, guidance, CEO — and it
    // must appear in the HEADLINE. The remaining terms, which are usually the verb, may come from
    // either. Without this rule the summary silently decided the classification, and measured, that
    // is exactly what went wrong: "Frugal Fannie's Iconic Westwood Store is Closing" became an
    // asset sale, "DataMEDS AI Unveils New Corporate Website" became a litigation settlement, and
    // "Bob Chapek Is So Not Over Getting Fired From Disney" became a CEO departure at DIS — each
    // because some later sentence happened to contain the missing word.
    //
    // `strict` raises the bar to every term in the headline, for the classes whose terms are
    // individually ordinary and only mean something together.
    if (!spec.all[0].test(head)) continue;
    const rest = spec.strict ? head : text;
    if (!spec.all.slice(1).every((r) => r.test(rest))) continue;
    if (spec.none?.some((r) => r.test(text))) continue;
    const { all, none, strict, ...out } = spec;
    return out;
  }
  return null;
}

// ── relevance ────────────────────────────────────────────────────────────────
//
// ⚠️ HOW LONG A CATALYST EXPLAINS A MOVE DEPENDS ON WHAT IT IS, and the general classes need their
// own windows rather than biotech's. A merger agreement is the reason a stock trades where it does
// for months; a product launch stops explaining anything within days.

export const COMPANY_RELEVANCE_DAYS = Object.freeze({
  structural: 45,     // M&A, bankruptcy, delisting, strategic review — the company itself changed
  capital: 21,        // offerings, splits, buybacks, lock-ups — the share count changed
  disclosure: 14,     // guidance, results, restatements, legal outcomes
  operational: 5,     // launches, expansions, milestones
});

const STRUCTURAL = /^(?:ma_|legal_bankruptcy|legal_going_concern|list_delisting|list_uplisting|list_trading_halt)/;
const CAPITAL = /^cap_/;
const DISCLOSURE = /^(?:earn_|legal_|mgmt_|list_)/;

/** Days a classified event stays usable as context for a current move. */
export function relevanceDays(type) {
  if (!type) return 2;
  if (/^bio_/.test(type)) return bioRelevanceDays(type);
  if (STRUCTURAL.test(type)) return COMPANY_RELEVANCE_DAYS.structural;
  if (CAPITAL.test(type)) return COMPANY_RELEVANCE_DAYS.capital;
  if (DISCLOSURE.test(type)) return COMPANY_RELEVANCE_DAYS.disclosure;
  if (/^oper_/.test(type)) return COMPANY_RELEVANCE_DAYS.operational;
  return 2;
}

/** The longest window any type can claim — bounds the evidence query. */
export const MAX_RELEVANCE_DAYS = Math.max(
  ...Object.values(COMPANY_RELEVANCE_DAYS),
  ...[30, 21, 10, 2],   // biotech's windows; see RELEVANCE_DAYS in biotech-events.mjs
);
