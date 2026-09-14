// X RELEVANCE — deterministic catalyst classification. PURE: no DB, no network, no model call.
//
// The question this file answers is "what KIND of market event is this", and the X account posts
// only events it can positively name. Everything else is refused.
//
// WHY A TYPE AND NOT A SCORE. Pit Wire's importance score was the only thing gating the account,
// and it is saturated: measured over 24 hours, 60 of 61 posted events carried category MARKETS and
// nearly all carried importance HIGH — the same score as an FDA approval was given to "Fireplace
// expert discusses how remodeling can upgrade a home". A number that says HIGH about both of those
// cannot separate them, and no threshold on it ever will. What separates them is that one IS a
// recognised catalyst and the other is not, so that is what gets asked.
//
// This is a PUBLISHING filter and nothing else. Pit Wire keeps every event it has, scores it the
// same way, displays it at the same speed, and dedupes it with the same canonical clustering. An
// event that fails here stays on the tape; it just does not go out under the account's name.
//
// FAIL CLOSED. An event that matches no catalyst returns null and is not posted. That direction is
// deliberate: the cost of missing one real event is that a trader reads it on Pit Wire seconds
// later, and the cost of posting fluff is the account's credibility.

// ── scope ────────────────────────────────────────────────────────────────────
// COMPANY catalysts are about one listed issuer and REQUIRE a resolved ticker. A company-specific
// event whose company we cannot identify as listed has no trader value — "Environmental Tectonics
// awarded $11.7M in contracts" is a real contract award, but with no symbol attached a reader
// cannot act on it and cannot even tell whether it is investable.
//
// MARKET catalysts move the whole tape and carry no symbol by nature: a CPI print, an FOMC
// decision, a chokepoint closure. These are judged on US-market relevance instead.
export const COMPANY = 'company';
export const MARKET = 'market';

// ── disqualifiers ────────────────────────────────────────────────────────────
// Checked BEFORE any catalyst match, because these shapes can wear a catalyst's vocabulary while
// being the opposite of an event. Every example is verbatim from the live account.

// A DATE for a future event is not the event. "Host Hotels & Resorts to report Q3 2026 results on
// November 4, 2026" and "BioVie to host call on ADDRESS-LC Phase 2 data" both posted; neither
// contains a result. The trader wants the print, not the calendar.
const SCHEDULING = /\b(?:to (?:report|host|hold|present|participate|webcast|announce|release|discuss)\b|will (?:report|host|hold|present|announce|release|webcast)\b|schedule[sd]?\b|to be held\b|save the date|conference call (?:on|for|scheduled)|earnings (?:call|date|webcast)|invites? (?:you|investors)|register(?:ed|ing)? (?:now|for|today)|upcoming\b|date (?:set|announced))/i;

// Somebody's VIEW of an event is not the event. "Trump rejects warnings that AI could threaten
// humanity", "Anthropic and OpenAI urge caution on AI development pace", "World Bank's Banga wants
// Senegal to restructure debt faster" — three live posts, none of them a market event.
const OPINION = /\b(?:discusses?|discussing|explains?|explores?|weighs? in|shares? (?:insights?|thoughts?|tips?)|urges?|calls? (?:for|on)\b|wants?\b|warns? that|argues?|believes?|suggests?|opposes?|backs?\b|criticis\w+|slams?|praises?|defends?|disagrees?|rejects? (?:warnings?|claims?|concerns?|calls?)|comments? on|reacts? to|responds? to|opinion|commentary|perspective|viewpoint|interview|podcast|op-?ed|analysis of|outlook for|what (?:it|this|that) means|why \w+ (?:is|are|will|should)|here'?s (?:why|what|how)|how to\b|tips? (?:for|on)\b|guide to\b|things? to (?:know|watch)|experts? (?:say|discuss|weigh)|\bexpert\b)/i;

// Consumer, lifestyle and local-business PR. Wires carry an enormous amount of it and none of it
// is a security event. "Fireplace expert discusses how remodeling can upgrade a home" is the type
// specimen; it reached the live account at importance HIGH.
const LIFESTYLE = /\b(?:remodel\w*|renovat\w*|home ?owners?|homes?\b|kitchen|bathroom|fireplace|furniture|landscap\w+|roofing|plumb\w+|hvac|dentist\w*|chiropract\w*|salon|spa\b|restaurant|recipes?|menu|wedding|travel (?:tips|guide|deals)|vacation|holiday gift|gift guide|back.to.school|pet ?(?:owners?|care)|fitness|workout|skincare|beauty|fashion|apparel trends?|lawn|garden\w*|mattress|cleaning service|moving company|locksmith|tutoring|driving school)\b/i;

// Marketing, recognition and relationship announcements. Real companies issue these constantly and
// none of them changes a valuation.
//
// "Award" is deliberately NOT a bare term here. A prize and a contract award share the word, and
// the bare form blocked "Environmental Tectonics awarded $11.7M in contracts" — a genuine
// government contract — as promotional PR. Only the recognition senses are listed.
const PROMOTIONAL = /\b(?:wins? (?:an? )?(?:award|prize)|award-winning|honou?red|recogni[sz]ed (?:as|for|by)|named (?:to|among|one of|official|a )|ranks? (?:among|no\.|#)|best (?:places? to work|of)|top \d+\b|celebrat\w+|anniversary|milestone reached|proud to|excited to|thrilled to|pleased to announce (?:the )?(?:partnership|collaboration)|webinar|white ?paper|case study|survey (?:finds|reveals|shows)|study (?:finds|reveals|shows)|launches? (?:a )?(?:campaign|initiative|website|blog|podcast|newsletter)|rebrand\w*|new logo|grand opening|ribbon.cutting|groundbreaking|open house|sponsorship|charity|donat\w+|fundraiser|scholarship|volunteer)\b/i;

// A SCHEDULED or FORECAST macro event has not happened. "Fed rate hike expected this week following
// inflation data" is a calendar entry wearing a catalyst's words. Gated on no actual occurrence in
// the same sentence, so "Saudi pipeline struck, expected offline for weeks" still survives.
const ANTICIPATION = /\b(?:expect(?:s|ed|ing|ations?)?|anticipat\w+|forecasts? (?:to|that)|poised to|on track (?:for|to)|prices? in|priced in|ahead of|previews?|set to \w+ (?:this|next)|due (?:this|next)|awaits?|looms?|approach(?:es|ing)\b)\b/i;
const OCCURRED = /\b(?:struck|shut|shuts|closed|closes|halted|approved?|approves|cleared?|clears|rejected?|rejects|filed?|files|resigned?|resigns|seized?|seizes|attacked?|attacks|hit|holds|held|rose|rises|fell|falls|jumped?|jumps|climbs|dropped?|drops|sank|sinks|surged?|surges|gains|slides|cut|cuts|raised?|raises|hiked?|hikes|announced?|announces|agreed?|agrees|completed?|completes|launched?|launches|reported?|reports|delisted|defaulted|acquired?|acquires|damaged|destroyed|priced?|prices|settled?|settles|won|wins|awarded|secured?|secures|upgraded?|upgrades|downgraded?|downgrades)\b/i;

// A REQUEST is not a decision. "Consumer Watchdog asks court to halt new tariffs" is a petition
// nobody has granted; the tariffs are unchanged.
// "demands" only as a VERB. The bare noun blocked "Trex lifts outlook citing demand and growth
// plan" — a genuine guidance raise — because "citing demand" contains it.
const REQUEST = /\b(?:asks?|urges?|petitions?|requests?|calls? on|demands? that|demanding|seeks? (?:court|an injunction|approval|permission)|files? (?:a )?(?:petition|motion|complaint|lawsuit) (?:to|against|seeking)|lobb(?:y|ies|ying)|pushes? for|proposes?|proposal)\b/i;

// Plaintiff-firm solicitations. High volume on every wire, zero information content.
const LEGAL_MARKETING = /\b(?:class action|investor deadline|lead plaintiff|deadline (?:alert|reminder)|law (?:firm|offices)|robbins geller|pomerantz|rosen law|bragar|levi & korsinsky|glancy|kessler topaz|bernstein liebhard|encourages investors|investigat\w+ (?:claims|on behalf)|shareholder (?:alert|rights) (?:law)?)/i;

// Exchange and regulatory boilerplate: filings ABOUT holdings mechanics, not events.
const BOILERPLATE = /\bform (?:8\.[35]|3|4|144)\b|\brule 2\.9\b|\bdisclosure (?:table|notice)\b|\btr-1\b|\b(?:acquires?|purchase of) own shares\b|\btransactions? in own shares\b|\bshare buy-?back transactions?\b|\bweek \d{1,2},? 20\d\d\b|\btotal voting rights\b|\bnet asset value\b|\bnav\b|\bholding\(s\) in company\b/i;

// A deal that MIGHT happen is not a deal. Kept identical in spirit to the publication gate's own
// speculation rule so the two cannot drift.
const SPECULATIVE = /\b(?:consider(?:s|ing)|in (?:advanced )?talks|nears? (?:a )?deal|weigh(?:s|ing)|explor(?:es|ing)|mulls?|reportedly|rumou?r\w*|said to be|is said to|may (?:acquire|buy|sell)|could (?:acquire|buy|sell)|potential(?:ly)? (?:acquir|merg|buy)|non-?binding|letter of intent|preliminary (?:talks|discussions)|would make sense)\b/i;

export const DISQUALIFIERS = [
  ['scheduled announcement, not the event', SCHEDULING],
  ['opinion or commentary, not an event', OPINION],
  ['consumer or lifestyle PR', LIFESTYLE],
  ['promotional or recognition PR', PROMOTIONAL],
  ['plaintiff-firm solicitation', LEGAL_MARKETING],
  ['filing or exchange boilerplate', BOILERPLATE],
  ['a request, not a decision', REQUEST],
];

// An explicit FUTURE TIME MARKER settles it on its own. "Fed rate hike expected this week following
// inflation data" survived the test below because "hike" is in the occurrence list as a verb, and
// as a noun it named the very thing that had not happened yet. A dated expectation is never an
// event, whatever verbs the sentence also contains.
const FUTURE_MARKER = /\b(?:expected|due|scheduled|set|slated|forecast)\s+(?:this|next|later|on|in|for|to occur|to be)\b|\bahead of (?:the |a |next |this )?\w+|\bin the (?:coming|next|week|month)\b|\bnext (?:week|month|quarter|year)\b|\blater (?:this|next)\b/i;

// Applied separately from the list above because it only disqualifies when NOTHING has actually
// happened in the same sentence.
const anticipatedOnly = (h) => FUTURE_MARKER.test(h) || (ANTICIPATION.test(h) && !OCCURRED.test(h));

// ── grounded figures ─────────────────────────────────────────────────────────
// A money amount, a share count, a percentage, a per-share price. Used both to require substance on
// the catalysts that should always carry one, and to enrich the post text. NOTHING here generates a
// number; these only RECOGNISE one that the event already contains.
export const MONEY = /\$\s?\d[\d,.]*\s?(?:billion|bn|million|mn|m\b|k\b|thousand|trillion|tn)?|\b\d[\d,.]*\s?(?:billion|bn|million|mn|trillion)\b(?=[^%]|$)/i;
// NO TRAILING \b. "%" is not a word character, so a boundary after it can only match when the next
// character IS one — "3.0% year-over-year" matched, "holds at 3.0%" did not, and every macro print
// that ended on its percentage was refused as having no figure.
export const PERCENT = /\b\d+(?:\.\d+)?\s?(?:%|percent\b|basis points\b|bps\b)/i;
// Any number of class/type qualifiers may sit between the count and the noun: "9,000,000 Class A
// shares" is a share count, and a form that allowed only "common" refused it.
export const SHARE_COUNT = /\b[\d,.]+\s?(?:million|billion|bn|mn)?\s+(?:(?:common|ordinary|preferred|class|series|[A-Z])\s+){0,3}(?:shares|units|adss?|notes)\b/i;
export const hasFigure = (s) => MONEY.test(s) || PERCENT.test(s) || SHARE_COUNT.test(s);

// ── the catalysts ────────────────────────────────────────────────────────────
// Ordered: the first match wins, so the more specific patterns come first. `figure` marks a type
// that is only news WITH a number — a contract award with no value and an analyst note with no
// target are both too thin to carry.
//
// Each entry is one of the event classes the desk asked for, and nothing else is a catalyst.
export const CATALYSTS = [
  // ── hard corporate events: consequential the moment they are true ──────────
  // "Restructuring" alone is not distress: "American Coastal Insurance restructures managing agency
  // agreement with AmRisc" is a commercial contract being redrawn. Only the financial senses count.
  { type: 'bankruptcy', scope: COMPANY,
    re: /\bchapter (?:7|11)\b|\bbankrupt\w*|\bgoing concern\b|\bdelist\w*|\bdefaults? on\b|\breceivership\b|\binsolven\w+|\bliquidat\w+|\bwinding up\b|\bcreditor protection\b|\brestructur\w+\s+(?:its\s+)?(?:debt|notes|balance sheet|obligations|liabilities)\b|\bdebt restructur\w+|\bmissed (?:a )?(?:payment|coupon|interest)\b|\bforbearance\b/i },
  { type: 'fda', scope: COMPANY,
    re: /\bfda\b(?:[^.]|\.\d){0,40}\b(?:approv|clear|authoriz|reject|declin|grant|accept|issu)\w*|\bcomplete response letter\b|\bcrl\b|\bbreakthrough therapy\b|\bfast.track\b|\borphan drug\b|\bpriority review\b|\bpdufa\b|\bemergency use authoriz\w*|\b(?:ema|chmp|mhra)\b(?:[^.]|\.\d){0,30}\b(?:approv|recommend|reject)\w*|\bmarketing authoriz\w*/i },
  { type: 'clinical', scope: COMPANY,
    re: /\bphase\s?(?:1|2|3|i{1,3})\b(?:[^.]|\.\d){0,40}\b(?:results?|data|topline|top-?line|readout|met|missed|failed|succeed\w*|endpoint)|\b(?:topline|top-?line)\s+(?:results?|data)|\bprimary endpoint\b|\btrial (?:results?|data|halted|stopped|discontinued)|\bpivotal (?:trial|study)\b/i },
  // A settlement with a NAMED regulator is a legal event whether or not the figure made it into the
  // headline. Requiring a dollar sign split one story in two: "Abbott settles with DOJ for $385M"
  // classified as legal, while "Abbott reaches settlement with Department of Justice on 2022 infant
  // formula recall claims" fell through to `recall` — a different type, a different dedupe key, and
  // so both posted. Same event, two posts.
  { type: 'legal', scope: COMPANY,
    re: /\b(?:doj|department of justice|sec|ftc|cftc|attorney general)\b(?:[^.]|\.\d){0,40}\b(?:charg|sue[sd]?|suit|settle|fine[sd]?|penalt)\w*|\b(?:settle[sd]?|settlement|reaches? (?:a )?settlement)\b(?:[^.]|\.\d){0,40}\b(?:doj|department of justice|sec|ftc|cftc|attorney general)\b|\bindict\w*|\bfraud charges\b|\bpleads? guilty\b|\bconsent (?:order|decree)\b|\bsettles?\b(?:[^.]|\.\d){0,40}\$|\bsettlement\b(?:[^.]|\.\d){0,30}\$|\binjunction\b|\bjury (?:verdict|awards?)\b|\bfined \$/i },
  // An operating disruption is a hard corporate event: a plant that stops stops revenue. "Company
  // halts production at its main plant after fire" carried no catalyst at all before this.
  { type: 'operations', scope: COMPANY,
    re: /\b(?:halts?|halted|suspends?|suspended|stops?|stopped|shuts?|shut|closes?|closed|idles?|idled)\b(?:[^.]|\.\d){0,40}\b(?:production|operations?|output|plant|facility|refinery|mine|mill|factory|shipments?)\b|\b(?:plant|facility|refinery|mine|factory)\b(?:[^.]|\.\d){0,30}\b(?:fire|explosion|outage|shutdown|closure|accident)\b|\bcyber(?:attack|security incident)\b|\bdata breach\b|\bransomware\b|\bproduction (?:halt|suspension|cut)\b|\bforce majeure\b|\b(?:workers?|union|employees?) (?:strike|walkout)\b|\blabor strike\b|\blayoffs?\b|\bjob cuts?\b/i },
  { type: 'recall', scope: COMPANY,
    re: /\brecalls?\b|\brecalling\b|\bsafety (?:alert|notice|warning)\b|\bmarket withdrawal\b|\bclass (?:i|ii|1|2) recall\b/i },

  // ── capital structure ─────────────────────────────────────────────────────
  // "common stock offering" and "share offering" were missed by an earlier form that required a
  // qualifier from a fixed list, so "Sysco announces $1.0 billion common stock offering" — a
  // billion dollars of dilution — classified as nothing. Any word before "offering" now counts.
  { type: 'offering', scope: COMPANY, figure: true,
    // "TORM plc selling shareholder offers 9,000,000 Class A shares" is a secondary sale — real
    // supply hitting the market — and it carries neither the word "offering" nor a qualifier.
    re: /\b\w+\s+offering\b|\boffering of\b|\bprices?\b(?:[^.]|\.\d){0,30}\boffering\b|\bpricing of\b(?:[^.]|\.\d){0,30}\boffering\b|\bupsize[sd]?\b|\bshelf registration\b|\bipo\b|\binitial public offering\b|\bdirect listing\b|\bpipe (?:financing|deal)\b|\bprivate placement\b|\bconvertible notes?\b|\bdilut\w+|\bselling shareholders?\b|\bsecondary (?:sale|offering)\b|\boffers?\s+[\d,.]+\s*(?:million|billion)?\s*(?:common\s+|class\s+[a-z]\s+)*(?:shares|units|adss?)\b/i },
  { type: 'buyback', scope: COMPANY, figure: true,
    re: /\b(?:share |stock |securities )?(?:repurchase|buy-?back)\s*(?:program|programme|plan|authoriz\w+)?\b|\bauthoriz\w+(?:[^.]|\.\d){0,30}\brepurchase\b|\btender offer\b|\bdutch auction\b/i },
  { type: 'dividend', scope: COMPANY,
    // A ROUTINE quarterly declaration is not news — "TriNet declares quarterly dividend" posted and
    // said nothing. A dividend that STARTS, MOVES or STOPS is a capital-allocation decision.
    re: /\b(?:initiat\w+|declar\w+\s+(?:its\s+)?first|increase[sd]?|raises?|raised|boosts?|hikes?|cuts?|reduces?|reduced|slashes?|suspends?|suspended|eliminat\w+|omits?|reinstat\w+|special)\b(?:[^.]|\.\d){0,30}\bdividend\b|\bdividend\b(?:[^.]|\.\d){0,30}\b(?:increase[sd]?|raised|cut|reduced|suspended|eliminated|initiated|reinstated|special)\b/i },
  { type: 'split', scope: COMPANY,
    re: /\b(?:stock|share|reverse)\s+split\b|\bsplit-?adjusted\b/i },

  // ── ownership and control ─────────────────────────────────────────────────
  { type: 'ma', scope: COMPANY, figure: false,
    re: /\bacquir\w+|\bmerger\b|\bmerges? with\b|\bto buy\b|\btakeover\b|\bbuyout\b|\bgoing private\b|\btake-?private\b|\bdefinitive (?:merger |purchase )?agreement\b|\bdivest\w+|\bspin-?off\b|\bcarve-?out\b|\bsells? (?:its |the )?(?:stake|division|unit|business|subsidiary)\b/i },
  { type: 'activist', scope: COMPANY,
    re: /\bactivist\b|\b13-?d\b|\bschedule 13d\b|\bproxy (?:fight|contest|battle)\b|\bboard seats?\b|\bnominat\w+(?:[^.]|\.\d){0,30}\bdirectors?\b|\bstake in\b(?:[^.]|\.\d){0,30}\b(?:urges?|pushes?|demands?)|\bbuilds? (?:a )?stake\b|\bdiscloses? (?:a )?\d+(?:\.\d+)?% stake\b/i },
  { type: 'institutional', scope: COMPANY, figure: true,
    re: /\b13-?f\b|\bdiscloses?\b(?:[^.]|\.\d){0,30}\bstake\b|\b(?:increases?|raises?|trims?|cuts?|exits?)\b(?:[^.]|\.\d){0,30}\b(?:position|holding|stake)\b|\bnew position in\b/i },
  { type: 'insider', scope: COMPANY, figure: true,
    re: /\binsider\b(?:[^.]|\.\d){0,30}\b(?:buy|sell|purchase|sale|transaction)|\b(?:ceo|cfo|coo|chairman|director|officer)\b(?:[^.]|\.\d){0,40}\b(?:buys?|bought|sells?|sold|purchas\w+|acquires?)\b(?:[^.]|\.\d){0,20}(?:\$|\d+[,\d]*\s+shares)/i },
  { type: 'congress', scope: MARKET,
    re: /\b(?:congress\w*|senator|representative|house member|lawmakers?)\b(?:[^.]|\.\d){0,40}\b(?:trade[sd]?|trading|bought|sold|purchas\w+|disclos\w+)\b|\bperiodic transaction report\b|\bstock act\b/i },

  // ── operating results ─────────────────────────────────────────────────────
  { type: 'earnings', scope: COMPANY, figure: true,
    re: /\b(?:q[1-4]|first|second|third|fourth)[- ]quarter\b|\bquarterly results\b|\bfy\s?20\d\d\b|\bfull.year results\b|\b(?:gaap |non-?gaap |adjusted )?eps\b|\bearnings (?:per share|results?|beat|miss)\b|\breports?\b(?:[^.]|\.\d){0,30}\b(?:revenue|earnings|results|profit|loss|ebitda)\b|\brevenue (?:of|rose|fell|grew|increased|declined|up|down)\b|\b(?:beats?|misses?|tops?)\b(?:[^.]|\.\d){0,25}\b(?:estimates?|expectations?|consensus)\b|\bsame.store sales\b|\bcomparable sales\b/i },
  // A PRICE TARGET is an analyst's number, not the company's own outlook, so it is excluded here
  // and picked up by `analyst` below. Without that, "Freedom Broker cuts Copart stock price target"
  // classified as Copart issuing guidance, which is the wrong actor entirely.
  { type: 'guidance', scope: COMPANY,
    re: /\b(?:raises?|raised|lifts?|lifted|cuts?|lowers?|lowered|trims?|slashes?|withdraws?|suspends?|reaffirms?|reiterates?|narrows?|updates?|issues?|initiates?)\b(?:[^.]|\.\d){0,30}\b(?:guidance|outlook|forecast|projection)\w*\b|\b(?:guidance|outlook|forecast)\b(?:[^.]|\.\d){0,25}\b(?:raised|lifted|cut|lowered|withdrawn|suspended|above|below)\b|\bpre-?announce\w*|\bprofit warning\b/i,
    not: /\bprice target\b/i },
  // Every noun here is pluralised. Without that, "awarded $11.7M in contractS" matched nothing —
  // `contract\b` cannot match a word that continues into an "s" — and a real government contract
  // award classified as no catalyst at all.
  { type: 'contract', scope: COMPANY, figure: true,
    re: /\b(?:awarded|wins?|won|secures?|secured|receives?|lands?)\b(?:[^.]|\.\d){0,40}\b(?:contracts?|orders?|awards?|tenders?|deals?|agreements?|task orders?|idiq)\b|\bcontract (?:award|modification|extension|worth|valued)\b|\bpurchase orders?\b|\bsupply agreements?\b|\blicensing (?:deal|agreement)s?\b|\bbacklog\b/i },
  { type: 'exec', scope: COMPANY,
    re: /\b(?:ceo|cfo|coo|cto|president|chairman|chief (?:executive|financial|operating|technology|medical|commercial) officer)\b(?:[^.]|\.\d){0,50}\b(?:appoint\w*|names?|named|hires?|steps? down|resign\w*|retires?|retirement|departs?|departure|succeed\w*|transition|leaves?|ousted|terminated|fired|interim)\b|\b(?:appoints?|names?|hires?)\b(?:[^.]|\.\d){0,30}\b(?:ceo|cfo|coo|cto|president|chairman|chief \w+ officer)\b/i },
  { type: 'credit_rating', scope: COMPANY,
    re: /\b(?:s&p|standard & poor'?s|moody'?s|fitch|dbrs|kbra)\b(?:[^.]|\.\d){0,50}\b(?:upgrad\w*|downgrad\w*|raises?|lowers?|cuts?|affirms?|revises?|places?|assigns?|outlook)\b|\bcredit rating\b(?:[^.]|\.\d){0,30}\b(?:upgrad|downgrad|rais|lower|cut)\w*/i },
  { type: 'analyst', scope: COMPANY,
    // A rating CHANGE or a price target with a NUMBER. "maintains" and "reiterates" are not events.
    re: /\b(?:upgrade[sd]?|downgrade[sd]?)\b|\b(?:raises?|lowers?|cuts?|boosts?|lifts?|trims?)\b(?:[^.]|\.\d){0,30}\bprice target\b|\bprice target\b(?:[^.]|\.\d){0,20}\bto \$[\d.,]+|\binitiate[sd]?\s+coverage\b|\bstarts? coverage\b|\b(?:to|from)\s+(?:buy|sell|hold|overweight|underweight|neutral|outperform|underperform)\b/i },

  // ── market-wide ───────────────────────────────────────────────────────────
  // What the market EXPECTS a central bank to do is not what it did. "August mortgage lock volume
  // falls as Fed rate hike expectations build" is mortgage data with a Fed clause attached, and it
  // classified as a monetary decision — and earned BREAKING doing it.
  { type: 'monetary', scope: MARKET,
    re: /\b(?:fomc|federal open market committee)\b|\bfed\b(?:[^.]|\.\d){0,40}\b(?:cuts?|raises?|hikes?|holds?|leaves?|decision|minutes)\b|\brate (?:cut|hike|decision)\b|\b(?:ecb|boj|boe|pboc|rba|rbnz|snb)\b(?:[^.]|\.\d){0,40}\b(?:cuts?|raises?|hikes?|holds?|decision)\b|\bpowell\b|\bbasis points?\b(?:[^.]|\.\d){0,30}\b(?:cut|hike|rate)|\bquantitative (?:easing|tightening)\b|\bbalance sheet runoff\b/i,
    not: /\bexpectations?\b|\bbets?\b|\bodds\b|\bpricing in\b|\bpriced in\b|\bspeculation\b|\bwagers?\b|\bprobabilit\w+/i },
  { type: 'macro_data', scope: MARKET, figure: true,
    re: /\b(?:cpi|ppi|pce|gdp|inflation|unemployment|nonfarm|non-?farm payrolls?|jobless claims?|retail sales|ism|pmi|consumer confidence|housing starts|durable goods|trade (?:balance|deficit)|industrial production|jolts)\b/i },
  // A bare "yield" is not a rates event: "AGNC dividend yield reaches 9.15%" is one stock's payout
  // ratio, and it classified as a credit-market move. The yield has to belong to a rates instrument.
  { type: 'rates_credit', scope: MARKET, figure: true,
    re: /\b(?:treasury|treasuries|(?:2|5|10|30)-?year yield|bond yields?|sovereign yields?|gilt|bund|jgb|bond auction|bill auction|note auction|high.yield spreads?|credit spreads?|yield curve|inversion)\b/i },
  { type: 'geopolitical', scope: MARKET,
    // Only where a US-market transmission channel is named. A foreign domestic story is not one.
    //
    // Energy INFRASTRUCTURE is its own clause. An earlier form required the word "oil" or "crude"
    // within 40 characters of the asset, so "Saudi Arabia shuts East-West pipeline after drone
    // damage" — a producer closing an export artery — classified as nothing at all. A pipeline,
    // refinery, terminal or field being shut, struck or damaged IS the transmission channel; no
    // second word has to say so.
    re: /\b(?:tariffs?|sanctions?|export controls?|embargo|entity list|trade war|section 232|section 301)\b|\b(?:strait of hormuz|suez|red sea|panama canal|nord stream|taiwan strait)\b|\b(?:opec|opec\+)\b(?:[^.]|\.\d){0,40}\b(?:cuts?|raises?|output|quota|production)\b|\b(?:pipelines?|refiner(?:y|ies)|oil ?fields?|gas ?fields?|export terminals?|lng terminals?|tankers?|oil facilit\w+)\b(?:[^.]|\.\d){0,50}\b(?:shut\w*|clos\w+|halt\w*|struck|strikes?|attack\w*|damag\w+|explo\w+|fire|outage|offline|disrupt\w*|seiz\w+|blockad\w+|sabotag\w+)\b|\b(?:shut\w*|clos\w+|halt\w*|struck|strikes?|attack\w*|damag\w+|seiz\w+)\b(?:[^.]|\.\d){0,50}\b(?:pipelines?|refiner(?:y|ies)|oil ?fields?|export terminals?|lng terminals?|tankers?)\b|\b(?:oil|crude|lng|natural gas)\b(?:[^.]|\.\d){0,40}\b(?:export|supply|disrupt\w*|shut\w*|attack\w*|strike[sd]?)\b|\b(?:invasion|blockade|airstrikes?|missile strikes?|war)\b(?:[^.]|\.\d){0,40}\b(?:oil|energy|supply|shipping|trade|market)\b|\bgovernment shutdown\b|\bdebt ceiling\b|\bdefault(?:s|ed)? on (?:its )?debt\b/i },
  // A measured level on an instrument the whole market watches. This is what a flash account carries
  // between scheduled releases, and it is the reason a Walter print with no ticker is not noise:
  // "Spot gold falls nearly 1% to $4,306.19" is a market fact. Repetition is handled downstream by
  // the instrument-keyed story guard, which already allows one post per instrument per move.
  { type: 'market_price', scope: MARKET, figure: true,
    re: /\b(?:crude|wti|brent|oil futures?|natural gas|spot gold|gold|silver|copper|bitcoin|ethereum|s&p 500|nasdaq|dow jones|russell 2000|vix|dollar index|dxy|treasury yields?|10-?year yield|2-?year yield|euro|yen|yuan|sterling)\b(?:[^.]|\.\d){0,40}\b(?:hits?|hit|reach\w*|climbs?|rises?|rose|falls?|fell|drops?|jumps?|surges?|slides?|sinks?|gains?|loses?|settles?|closes?|tops?|breaks?|session (?:high|low)|record (?:high|low))\b/i },
  { type: 'market_structure', scope: MARKET,
    re: /\bcircuit breaker\b|\bmarket.wide halt\b|\blimit (?:up|down)\b|\bexchange outage\b|\btrading suspended\b|\bshort.selling ban\b|\bindex (?:rebalance|addition|deletion)\b|\bjoins? the s&p 500\b|\badded to the (?:s&p|nasdaq|dow)\b/i },
];

// ── US-market relevance for market-scope events ──────────────────────────────
// A MARKET catalyst still has to reach US equities. "World Bank's Banga wants Senegal to restructure
// debt faster than prior cases" trips no transmission channel and posted anyway; a Senegalese debt
// timetable is not a US market event.
// A US trader watches the major economies' prints because they move US futures; a minor economy's
// domestic timetable does not. That is the whole distinction the desk asked for — "international
// stories with little or no meaningful impact on U.S. markets" — so the major economies are named
// and everything else falls outside. Senegal's debt schedule is out; Canadian CPI is in.
const US_NEXUS = /\b(?:u\.?s\.?|america\w*|federal reserve|fed\b|fomc|treasury|treasuries|wall street|s&p|nasdaq|dow|russell|vix|nyse|dollar|greenback|washington|congress|white house|powell|tariffs?|sanctions?|opec|crude|oil|brent|wti|natural gas|lng|gold|bitcoin|yields?|equities|stocks?|futures?|global markets?|china|chinese|japan|japanese|germany|german|eurozone|euro area|ecb|euro\b|united kingdom|uk\b|britain|british|boe|canada|canadian|india|indian|mexico|brazil|south korea|taiwan)\b/i;

// Which types have to pass it. A geopolitical or price catalyst has ALREADY named its channel — a
// chokepoint, a pipeline, a traded instrument — and demanding a second US word on top of that
// refused "Houthis seize Red Sea islands in offensive", where the Red Sea IS the relevance. Only
// the data-release types, where a foreign print may genuinely not reach US markets, are tested.
const NEEDS_NEXUS = new Set(['macro_data', 'monetary', 'rates_credit', 'congress']);

// ── SEC 8-K items ────────────────────────────────────────────────────────────
// An 8-K headline is not prose — "CHIPOTLE MEXICAN GRILL INC · 8-K (5.02,9.01)" is the EDGAR index
// line — so the catalyst patterns above, which read sentences, find nothing in it. But the ITEM
// NUMBERS are a materiality taxonomy the SEC itself publishes, and they are already in the row.
// Reading them is not interpretation: item 5.02 IS "Departure of Directors or Certain Officers",
// by definition, and mapping it to `exec` says nothing the filing did not.
//
// This is a CLASSIFICATION of an already-ingested row. No filing is fetched, parsed or stored
// differently, and nothing in the SEC pipeline is touched.
// Ordered most consequential first: a filing reporting both an acquisition and an exhibit index is
// an acquisition, and the first match wins.
const EIGHT_K_ITEMS = new Map([
  ['1.03', ['bankruptcy', 'files for bankruptcy or receivership']],
  ['4.02', ['legal', 'says previously issued financial statements cannot be relied on']],
  ['5.01', ['ma', 'reports a change in control']],
  ['2.01', ['ma', 'completes an acquisition or disposition of assets']],
  ['3.01', ['bankruptcy', 'receives a delisting or listing-rule notice']],
  ['2.04', ['bankruptcy', 'triggers acceleration of a financial obligation']],
  ['2.02', ['earnings', 'reports results of operations']],
  ['5.02', ['exec', 'reports a departure or appointment of directors or officers']],
  ['3.02', ['offering', 'reports unregistered sales of equity securities']],
  ['2.03', ['offering', 'takes on a direct financial obligation']],
  ['2.06', ['operations', 'records a material impairment']],
  ['2.05', ['operations', 'books costs for exit or disposal activities']],
  ['4.01', ['legal', 'changes its certifying accountant']],
  ['1.01', ['contract', 'enters a material definitive agreement']],
  ['1.02', ['contract', 'terminates a material definitive agreement']],
]);

// Items that are administrative by design. 9.01 is the exhibit index and accompanies almost every
// filing; 7.01 is Reg FD, usually a press release the wires already carried; 8.01 is the catch-all.
// A filing carrying ONLY these is not an event.
const ROUTINE_ITEMS = new Set(['1.04', '3.03', '5.03', '5.04', '5.05', '5.06', '5.07', '5.08',
  '6.01', '6.02', '6.03', '6.04', '6.05', '7.01', '8.01', '9.01']);

/** The item codes an 8-K headline carries, e.g. "... · 8-K (5.02,9.01)" -> ['5.02','9.01']. */
export function eightKItems(headline) {
  const m = String(headline || '').match(/·\s*8-K[^(]*\(([\d.,\s]+)\)/i);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** The registrant name, i.e. everything before the form separator. */
export const filingRegistrant = (headline) => String(headline || '').split('·')[0].trim();

/**
 * Classify an SEC filing row by its item codes. Returns the most material item only — a filing
 * reporting both an acquisition and an exhibit index is an acquisition.
 * @returns {{type:string, scope:string, item:string, phrase:string}|null}
 */
export function classifyFiling(ev) {
  if (String(ev?.source_type || '') !== 'filing') return null;
  const items = eightKItems(ev?.headline);
  if (!items.length) return null;
  // Ordered by the map's own order, which runs from most to least consequential.
  for (const [code, [type, phrase]] of EIGHT_K_ITEMS) {
    if (items.includes(code)) return { type, scope: COMPANY, item: code, phrase };
  }
  return null;            // every item present is routine
}

/**
 * Classify a canonical event as a tradeable catalyst, or refuse it.
 *
 * Reads only what the pipeline already produced — headline, summary, tickers, category, source_type
 * and the extracted `facts` — and makes no model call of its own.
 *
 * @param {object} ev canonical event
 * @returns {{type:string, scope:string, hasTicker:boolean, figure:boolean}|null} null = do not post
 */
export function classifyCatalyst(ev) {
  const headline = String(ev?.headline || '');
  if (!headline) return null;
  const summary = String(ev?.summary || '');
  // The headline decides the TYPE. The summary may only supply a supporting figure: letting it
  // decide the type lets a boilerplate paragraph reclassify an unrelated headline.
  const hay = `${headline} ${summary}`;

  // An SEC filing is classified by its item codes, not by its index line. The prose disqualifiers
  // below are written for sentences and would read an EDGAR header as noise either way.
  const filing = classifyFiling(ev);
  if (filing) {
    // The same company rule as any other company catalyst: no symbol, no post. SEC rows carry the
    // registrant's own ticker, so in practice this always holds.
    if (!(ev?.tickers || []).filter(Boolean).length) return null;
    return { ...filing, hasTicker: true, figure: false };
  }
  if (String(ev?.source_type || '') === 'filing') return null;   // routine or unrecognised filing

  for (const [, re] of DISQUALIFIERS) if (re.test(headline)) return null;
  if (anticipatedOnly(headline)) return null;

  const tickers = (ev?.tickers || []).filter(Boolean);
  const hasTicker = tickers.length > 0;
  const factValue = String(ev?.facts?.value || '');
  const figure = hasFigure(headline) || hasFigure(factValue) || hasFigure(summary);

  for (const c of CATALYSTS) {
    if (!c.re.test(headline)) continue;
    if (c.not && c.not.test(headline)) continue;         // routed to a later, more specific type
    // A deal that might happen is not a deal, and the same goes for any catalyst hedged this way.
    if (SPECULATIVE.test(headline)) return null;
    if (c.figure && !figure) return null;
    if (c.scope === COMPANY && !hasTicker && !issuerEvidence(headline)) return null;
    if (NEEDS_NEXUS.has(c.type) && !US_NEXUS.test(hay)) return null;
    return { type: c.type, scope: c.scope, hasTicker, figure };
  }
  return null;
}

// A COMPANY catalyst normally needs a resolved ticker, because a reader cannot act on a company
// they cannot identify. The exception is a hard reporting print: "Children's Place reports Non-GAAP
// EPS of -$0.82, revenue of $241.8M" is issued only by a reporting issuer, and the numbers ARE the
// news whether or not the symbol resolved. Eleven real earnings reports in one day were refused for
// a missing symbol, which is a worse outcome than posting them uncashtagged.
//
// Deliberately narrow: an EPS figure or a reported revenue figure. PR fluff never carries either.
const ISSUER_PRINT = /\b(?:gaap|non-?gaap|adjusted|diluted|basic)?\s?eps\b(?:[^.]|\.\d){0,20}[-−]?\$?\d|\beps of\b|\bearnings per share\b(?:[^.]|\.\d){0,20}\$?\d|\brevenue (?:of|rose|fell|grew|increased|declined)\b(?:[^.]|\.\d){0,20}[\d$]/i;
export const issuerEvidence = (headline) => ISSUER_PRINT.test(String(headline || ''));

// ── one post per underlying event ────────────────────────────────────────────
// The canonical clustering already collapses two reports of one event into one canonical row, and
// x_post_candidates has UNIQUE(event_seq) so a canonical event can produce exactly one candidate.
// NOTHING BELOW CHANGES EITHER OF THOSE. This is a third, narrower guard for the case clustering
// cannot see: two reports worded so differently that they stay separate canonical events.
//
// Measured example, both canonical, both would have posted:
//   "High Tide reports non-GAAP EPS of C$0.12 and revenue of C$198.82M"   (Seeking Alpha)
//   "High Tide reports third quarter 2026 revenue of $199 million"        (PR Newswire)
// The engine's own fact_key for the two is "high-tide|earnings|…" in both cases — same subject,
// same event type, different number. That pair IS the signal, so it is what gets keyed on.
//
// Only types where a repeat within the window is DEFINITIONALLY the same event are listed. A
// company reports earnings once a quarter and is acquired once, so a second one is the same story.
// Two banks downgrading the same stock are genuinely two events, and `analyst` is therefore absent
// — as are the market-wide types, where separate developments share a subject all day.
export const ONE_PER_EVENT = new Set(['earnings', 'guidance', 'offering', 'ma', 'fda', 'clinical',
  'bankruptcy', 'exec', 'split', 'buyback', 'dividend', 'recall', 'credit_rating', 'activist',
  'contract', 'legal']);
export const SAME_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, 3).join('-');

/**
 * A stable key for the underlying event, or null when this type may legitimately repeat.
 * Subject preference: the resolved ticker (exact), then the extracted actor, then the entity the
 * engine derived, then the headline's opening words. Never the number — the number is precisely
 * what differs between two reports of one event.
 */
export function catalystKey(ev, catalyst) {
  if (!catalyst || !ONE_PER_EVENT.has(catalyst.type)) return null;
  const ticker = (ev?.tickers || []).filter(Boolean)[0];
  const subject = ticker ? String(ticker).toUpperCase()
    : slug(ev?.facts?.actor) || slug(ev?.entity) || slug(ev?.headline);
  return subject ? `${subject}|${catalyst.type}` : null;
}

// ── grounded figures ─────────────────────────────────────────────────────────
// The numbers that make a post worth reading: an offering's size and price, a contract's value, an
// earnings surprise, a stake. "$BUR: Burford Capital prices share offering" says a financing
// happened; "$300 million of 8.000% senior secured notes" says what it costs.
//
// EVERY FIGURE IS COPIED VERBATIM FROM THE EVENT'S OWN TEXT. Nothing here computes, converts,
// rounds, annualises or infers — there is no arithmetic in this file at all. A number that is not
// written in the source, in those words, cannot appear in a post. That is why each pattern captures
// a span INCLUDING its units and qualifier ("approximately $300 million", "8.000%"): a bare number
// lifted out of its phrasing is how a figure changes meaning.
//
// Patterns are ordered per type, most informative first, and at most two are carried so the post
// stays a headline rather than becoming a paragraph.
const FIGURE_PATTERNS = {
  offering: [
    /(?:aggregate principal amount of\s+)?\$[\d,.]+\s*(?:million|billion|bn|mn)?\s+aggregate principal amount/i,
    /\$[\d,.]+\s*(?:million|billion|bn|mn)?\s+(?:of\s+)?(?:its\s+)?(?:common stock|shares|senior (?:secured |unsecured )?notes|convertible notes)/i,
    /[\d,.]+\s*(?:million|billion)?\s+(?:common\s+)?shares?\s+(?:of\s+)?(?:common stock\s+)?at\s+\$[\d,.]+/i,
    /at\s+(?:a\s+(?:public\s+)?offering\s+price\s+of\s+)?\$[\d,.]+\s+per\s+(?:share|unit|ads)/i,
    /(?:gross|net)\s+proceeds\s+of\s+(?:approximately\s+)?\$[\d,.]+\s*(?:million|billion|bn|mn)?/i,
    /\b\d+(?:\.\d+)?%\s+(?:senior\s+)?(?:secured\s+|unsecured\s+)?notes?/i,
  ],
  earnings: [
    /(?:gaap|non-?gaap|adjusted|diluted)?\s?eps\s+of\s+[-−]?\$[\d,.]+/i,
    /revenue\s+of\s+\$[\d,.]+\s*(?:million|billion|bn|mn)?/i,
    /(?:beat|missed|topped)\s+(?:by\s+)?\$[\d,.]+|(?:beats?|misses?)\s+(?:estimates?|consensus)\s+by\s+[\d,.]+%?/i,
  ],
  contract: [/(?:valued at|worth|totalling|totaling|up to)\s+(?:approximately\s+)?\$[\d,.]+\s*(?:million|billion|bn|mn)?/i,
    /\$[\d,.]+\s*(?:million|billion|bn|mn)?\s+contracts?/i],
  ma: [/(?:for|valued at|worth)\s+(?:approximately\s+)?\$[\d,.]+\s*(?:million|billion|bn|mn)?/i,
    /\$[\d,.]+\s+per\s+share\s+in\s+cash/i],
  buyback: [/\$[\d,.]+\s*(?:million|billion|bn|mn)?\s+(?:share\s+)?(?:repurchase|buy-?back)/i,
    /(?:repurchase|buy-?back)\s+(?:program|programme|plan)\s+of\s+(?:up to\s+)?\$[\d,.]+\s*(?:million|billion)?/i],
  dividend: [/\$[\d,.]+\s+per\s+share/i, /(?:increase[sd]?|raised|cut|reduced)\s+(?:by\s+)?[\d,.]+%/i],
  guidance: [/(?:to|of)\s+\$[\d,.]+\s*(?:million|billion|bn|mn)?\s*(?:to|[-–])\s*\$[\d,.]+\s*(?:million|billion|bn|mn)?/i,
    /(?:from|versus|vs\.?)\s+\$[\d,.]+\s*(?:million|billion|bn|mn)?/i],
  institutional: [/[\d,.]+(?:\.\d+)?%\s+stake/i, /\$[\d,.]+\s*(?:million|billion|bn|mn)?\s+(?:stake|position)/i],
  activist: [/[\d,.]+(?:\.\d+)?%\s+stake/i, /\$[\d,.]+\s*(?:million|billion|bn|mn)?\s+(?:stake|position)/i],
  insider: [/\$[\d,.]+\s*(?:million|billion)?\s+(?:in\s+)?(?:shares|stock)/i, /[\d,.]+\s+shares/i],
  legal: [/\$[\d,.]+\s*(?:million|billion|bn|mn)?\s+(?:settlement|fine|penalty)/i,
    /(?:settle[sd]?|fined|penalty of)\s+(?:for\s+)?\$[\d,.]+\s*(?:million|billion|bn|mn)?/i],
  clinical: [/\bp\s?[=<]\s?0?\.\d+/i, /[\d,.]+(?:\.\d+)?%\s+(?:reduction|improvement|response|survival)/i],
  macro_data: [/[\d,.]+(?:\.\d+)?%\s+(?:year-over-year|yoy|annual|month-over-month|mom)?/i],
};
const MAX_FIGURES = 2;

/**
 * Grounded figures the headline does not already carry, in the source's own words.
 * @returns {string[]} verbatim spans, possibly empty
 */
export function groundedFigures(ev, catalyst) {
  const pats = FIGURE_PATTERNS[catalyst?.type];
  if (!pats) return [];
  const headline = String(ev?.headline || '');
  // Only the event's OWN text is searched: its summary and the figure the extractor already pulled.
  const source = `${ev?.summary || ''} ${ev?.facts?.value || ''}`;
  if (!source.trim()) return [];
  // A number the headline already prints is not added again. Compared as digits, so "$2 billion"
  // and "$2B" are recognised as the same figure written two ways.
  const said = new Set((headline.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(/,/g, '')));
  const out = [];
  for (const re of pats) {
    if (out.length >= MAX_FIGURES) break;
    const m = source.match(re);
    if (!m) continue;
    const span = m[0].replace(/\s+/g, ' ').trim();
    const nums = (span.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(/,/g, ''));
    if (!nums.length || nums.every((n) => said.has(n))) continue;      // adds nothing new
    if (out.some((p) => p.toLowerCase() === span.toLowerCase())) continue;
    for (const n of nums) said.add(n);
    out.push(span);
  }
  return out;
}

// ── who the post is ABOUT ────────────────────────────────────────────────────
// On a rating story the sentence names two companies, and only one of them is the subject.
// "Hewlett Packard Enterprise stock falls 11% following Evercore ISI downgrade" went out as
// "$HPE $EVR" and "Freedom Broker cuts Copart stock price target" as "$FRHC $CPRT" — in both the
// research firm got a cashtag for work it did about somebody else, which reads as news about the
// bank. Position cannot separate them: the rater is named first in one and last in the other.
//
// This is a list of RESEARCH AND RATING FIRMS, not a company→symbol map. It never resolves a
// ticker; the canonical resolver still does all of that. It only answers "is this symbol here
// because it acted as an analyst", and that question has no deterministic answer in the pipeline's
// own fields — the rater and the rated are both just companies in the sentence.
const RATING_FIRMS = new Set([
  // credit agencies
  'SPGI', 'MCO', 'FDS',
  // brokers and banks whose research desks issue ratings
  'EVR', 'GS', 'MS', 'JPM', 'BAC', 'C', 'WFC', 'RJF', 'SF', 'JEF', 'PIPR', 'HLI', 'LAZ', 'PJT',
  'BMO', 'RY', 'TD', 'CM', 'BNS', 'NMR', 'UBS', 'DB', 'BCS', 'HSBC', 'MUFG', 'SMFG',
  'FRHC', 'IBKR', 'SCHW', 'COWN', 'BTIG', 'OPY', 'LPLA', 'VIRT',
]);

/**
 * The tickers a post should carry, with any symbol that is only present as the RATER removed.
 * Applies to rating stories only; every other catalyst keeps what the resolver produced.
 */
export function subjectTickers(ev, catalyst) {
  const tickers = (ev?.tickers || []).filter(Boolean).map((t) => String(t).toUpperCase());
  if (!catalyst || (catalyst.type !== 'analyst' && catalyst.type !== 'credit_rating')) return tickers;
  const kept = tickers.filter((t) => !RATING_FIRMS.has(t));
  // If every symbol on the event is a research firm, the resolver never found the rated company.
  // Keeping the firm would be worse than posting untagged, so the post goes out with no cashtag.
  return kept;
}

/** The auditable reason an event was refused, for the candidate record. */
export function refusalReason(ev) {
  const headline = String(ev?.headline || '');
  if (!headline) return 'no headline';
  for (const [why, re] of DISQUALIFIERS) if (re.test(headline)) return why;
  if (anticipatedOnly(headline)) return 'anticipated, has not happened';
  const hit = CATALYSTS.find((c) => c.re.test(headline) && !(c.not && c.not.test(headline)));
  if (!hit) return 'no recognised market catalyst';
  if (SPECULATIVE.test(headline)) return `speculative ${hit.type}`;
  const factValue = String(ev?.facts?.value || '');
  const figure = hasFigure(headline) || hasFigure(factValue) || hasFigure(String(ev?.summary || ''));
  if (hit.figure && !figure) return `${hit.type} with no figure`;
  if (hit.scope === COMPANY && !(ev?.tickers || []).filter(Boolean).length && !issuerEvidence(headline)) {
    return `${hit.type} with no listed company`;
  }
  if (NEEDS_NEXUS.has(hit.type)) return `${hit.type} with no US-market relevance`;
  return 'no recognised market catalyst';
}
