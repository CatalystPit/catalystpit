// Company name -> ticker, for ordinary headlines. PURE matching; the caller supplies the index.
//
// WHY THIS EXISTS. The existing resolver only ever saw a company when the headline printed its LEGAL
// name: companyPhrases() requires a corporate suffix, so "Amgen Inc. wins approval" resolved and
// "Costco raises motor oil prices", "Apple unveils M5 silicon", "Nvidia beats Q3 estimates" and
// "Tesla recalls 12,000 vehicles" all yielded nothing. Headlines almost never print the suffix.
// Measured on live data: 3,137 of 3,482 canonical events in 24 hours carried no ticker.
//
// The reference data is Catalyst Pit's own. SEC registrant names keyed by ticker already sit in
// insider_trades (5,537 symbols, e.g. COST -> "COSTCO WHOLESALE CORP /NEW"), supplemented by
// screener_stocks where its company column holds a real name rather than an SIC description.
//
// THE GOVERNING RULE IS THAT NO TICKER BEATS A WRONG TICKER. Every ambiguity resolves to nothing:
// two companies sharing a normalized name, two share classes that are not a prefix family, a name
// that is also an ordinary English word, a country, an agency, a currency. Each of those is a
// silent-wrong-answer generator, and a wrong cashtag on a public wire is worse than a missing one.

import { isSicDescription } from './sic-descriptions.mjs';

// ── normalisation ────────────────────────────────────────────────────────────
// Legal scaffolding carries no identity: "COSTCO WHOLESALE CORP /NEW" and "Costco Wholesale" are
// the same company. Dropped, punctuation removed, joined with no spaces, so spacing and commas
// cannot decide a match.
const LEGAL = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COMPANIES',
  'LTD', 'LIMITED', 'PLC', 'LLC', 'LLP', 'LP', 'NV', 'SA', 'SE', 'AG', 'AB', 'ASA', 'OYJ', 'THE',
  'HOLDINGS', 'HOLDING', 'HLDGS', 'HLDG', 'GROUP', 'GRP', 'CLASS', 'CL', 'ADR', 'ADS', 'SPONSORED',
  'ORD', 'ORDINARY', 'NEW', 'COMMON', 'STOCK', 'SHARES', 'SHARE', 'TRUST', 'REIT', 'NA', 'AND',
  // CONNECTORS. A headline span is built from CAPITALISED words only, so "Bank of America" arrives
  // as ["BANK","AMERICA"] with the lowercase "of" already gone, while the registrant name
  // "BANK OF AMERICA CORP /DE/" kept it and became ["BANK","OF","AMERICA"]. The two could never
  // match. Dropping connectors on BOTH sides makes the comparison symmetric — which is the only
  // reason it works — and Bank of America is not an edge case, it is the second-largest US bank.
  'OF', 'FOR', 'DE', 'DEL', 'DA', 'VON', 'VAN']);

// Runs of single letters are ONE token. "R F INDUSTRIES LTD" is how the registrant filed it and
// "RF Industries" is how every headline writes it; without this they tokenise differently and never
// meet. Collapsing the run preserves what single letters are for — "O-I Glass" stays ["OI","GLASS"],
// so the distinctive half of the name survives rather than being dropped.
// BOTH tokens must be single letters. Merging a single letter into any short token instead turned
// "AT&T" — which normalises to ["AT","T"] — into ["ATT"], changing a name the resolver already
// handles. Only an actual run of initials is joined.
function collapseInitials(toks) {
  const out = [];
  for (const t of toks) {
    const prev = out[out.length - 1];
    if (t.length === 1 && prev && /^[A-Z]+$/.test(prev) && prev.length === 1) out[out.length - 1] = prev + t;
    else out.push(t);
  }
  return out;
}

// The name as TOKENS, legal scaffolding removed. Matching happens on whole tokens, never on
// characters: a character prefix let "August" reach AUGG, "States" reach STT, "Illinois" reach ITW
// and "Payment" reach PAY, and turned "Wall Street Lunch: Tesla's Roadster" into WBX and RC instead
// of TSLA. A company reference has to begin at a word the company is actually called.
export function tokens(name) {
  const raw = String(name || '')
    .toUpperCase()
    .replace(/\/NEW\b|\/DE\b|\/MD\b|\/[A-Z]{2}\/?$/g, ' ')
    .replace(/'S\b|’S\b/g, '')                 // possessive: "Tesla's" is still Tesla
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t));
  return collapseInitials(raw);
}

export function core(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/'S\b|’S\b/g, '')
    .replace(/\/NEW\b|\/DE\b|\/MD\b|\/[A-Z]{2}\/?$/g, ' ')   // SEC state-of-incorporation suffixes
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    // Single letters are KEPT. Dropping them turned "O-I Glass, Inc." into "GLASS", so the private
    // startup Glass Imaging matched the public glass-container maker and the headline about OpenAI
    // buying it came out tagged $OI. A one-letter token is usually the distinctive half of the name.
    .filter((t) => t && !LEGAL.has(t))
    .join('');
}

// An SIC industry description is not a company name. screener_stocks carried these for 2,805 symbols
// (COST read "RETAIL-VARIETY STORES", GOOG "SERVICES-COMPUTER PROGRAMMING, DATA PROCESSING, ETC.")
// and indexing them maps a whole industry onto one arbitrary ticker.
//
// THE SHAPE PATTERN BELOW WAS NOT ENOUGH. Measured against the live table it caught 757 of those
// 2,805 — it needs an industry-ish head AND an industry-ish tail, so "PHARMACEUTICAL PREPARATIONS",
// "PETROLEUM REFINING" and "METAL CANS" all sailed through. 2,048 descriptions were indexed as
// company names, and 92 of them actually resolved to a ticker through the matcher: "MEAT PACKING
// PLANTS" returned $JBS, "HOSPITAL & MEDICAL SERVICE PLANS" returned $HUM. pickOne()'s ambiguity
// refusal absorbed the rest only because most descriptions are shared by hundreds of symbols; the
// ones held by a single ticker had nothing to be ambiguous against.
//
// So the primary test is now EXACT MEMBERSHIP in the EDGAR vocabulary rather than a guess at its
// shape — see sic-descriptions.mjs, where the zero-collision measurement is recorded. The pattern is
// kept beside it, not replaced by it: it costs nothing, it had no false positives against the live
// table, and it still covers a description that postdates the snapshot.
const SIC_SHAPED = /\b(?:SERVICES|RETAIL|WHOLESALE|MANUFACTURING|MFG|PRODUCTS|PREPACKAGED|ETC\.?)\b.*\b(?:STORES|SOFTWARE|PROGRAMMING|PROCESSING|EQUIPMENT|SUPPLIES|GOODS|NEC)\b|^\s*(?:BLANK CHECKS?|INVESTORS?, NEC)\s*$/i;
export const looksLikeIndustry = (name) =>
  isSicDescription(name) || SIC_SHAPED.test(String(name || ''));

// ── things that are never a company, however they are spelled ────────────────
// A wrong cashtag on a macro line is the most damaging failure available here, so these are refused
// before any lookup happens.
const NOT_A_COMPANY = new Set([
  // sovereigns, blocs, regions
  'US', 'USA', 'UNITEDSTATES', 'AMERICA', 'CHINA', 'RUSSIA', 'UKRAINE', 'IRAN', 'ISRAEL', 'INDIA',
  'JAPAN', 'GERMANY', 'FRANCE', 'ITALY', 'SPAIN', 'BRAZIL', 'MEXICO', 'CANADA', 'TURKEY', 'EGYPT',
  'SAUDIARABIA', 'SAUDI', 'YEMEN', 'IRAQ', 'SYRIA', 'QATAR', 'KUWAIT', 'VENEZUELA', 'NIGERIA',
  'KOREA', 'NORTHKOREA', 'SOUTHKOREA', 'TAIWAN', 'VIETNAM', 'POLAND', 'SWEDEN', 'NORWAY', 'DENMARK',
  'FINLAND', 'ICELAND', 'NETHERLANDS', 'BELGIUM', 'SWITZERLAND', 'AUSTRIA', 'GREECE', 'PORTUGAL',
  'EUROPE', 'EU', 'ASIA', 'AFRICA', 'MIDDLEEAST', 'GULF', 'BALTIC', 'NATO', 'BRICS', 'OPEC',
  'WASHINGTON', 'BEIJING', 'MOSCOW', 'BRUSSELS', 'LONDON', 'PARIS', 'BERLIN', 'TOKYO', 'KYIV',
  // institutions, regulators, central banks
  'FED', 'FEDERALRESERVE', 'TREASURY', 'ECB', 'BOE', 'BOJ', 'PBOC', 'IMF', 'WORLDBANK', 'SEC',
  'FDA', 'FTC', 'DOJ', 'CFTC', 'FCC', 'EPA', 'IRS', 'FBI', 'CIA', 'PENTAGON', 'CONGRESS', 'SENATE',
  'WHITEHOUSE', 'SUPREMECOURT', 'FOMC', 'FINRA', 'NYSE', 'NASDAQ', 'CBOE',
  // instruments and measures
  'BRENT', 'WTI', 'CRUDE', 'GOLD', 'SILVER', 'COPPER', 'BITCOIN', 'ETHEREUM', 'DOLLAR', 'EURO',
  'YEN', 'YUAN', 'STERLING', 'CPI', 'PPI', 'GDP', 'PCE', 'NFP', 'ISM', 'PMI',
  // desks and labels
  'MACRO', 'MARKETS', 'BREAKING', 'UPDATE', 'ALERT', 'EARNINGS', 'HALT',
  // US states: place names that several registrants also begin with (Illinois Tool Works).
  'ALABAMA', 'ALASKA', 'ARIZONA', 'ARKANSAS', 'CALIFORNIA', 'COLORADO', 'CONNECTICUT', 'DELAWARE',
  'FLORIDA', 'GEORGIA', 'HAWAII', 'IDAHO', 'ILLINOIS', 'INDIANA', 'IOWA', 'KANSAS', 'KENTUCKY',
  'LOUISIANA', 'MAINE', 'MARYLAND', 'MASSACHUSETTS', 'MICHIGAN', 'MINNESOTA', 'MISSISSIPPI',
  'MISSOURI', 'MONTANA', 'NEBRASKA', 'NEVADA', 'OHIO', 'OKLAHOMA', 'OREGON', 'PENNSYLVANIA',
  'TENNESSEE', 'TEXAS', 'UTAH', 'VERMONT', 'VIRGINIA', 'WISCONSIN', 'WYOMING',
]);

// Single-word names that are also ordinary English. A bare "Target", "Gap" or "Key" in a sentence is
// far more often the word than the company, and one wrong match discredits every right one.
const AMBIGUOUS_WORD = new Set([
  'TARGET', 'GAP', 'KEY', 'NOW', 'POST', 'OPEN', 'LIVE', 'NEXT', 'SQUARE', 'BLOCK', 'MATCH',
  'PEAK', 'SUMMIT', 'UNION', 'LIBERTY', 'SIGNAL', 'PROGRESS', 'ADVANCE', 'ALLY', 'ARENA', 'ASPEN',
  'AXIS', 'BOND', 'CENTER', 'CHOICE', 'CIRCLE', 'CORE', 'CROWN', 'EAGLE', 'ELEMENT', 'ENERGY',
  'FIRST', 'FLOW', 'FRONTIER', 'GLOBAL', 'GRAIL', 'HARMONY', 'HEALTH', 'HORIZON', 'IMPACT',
  'LEGACY', 'LIGHT', 'MAIN', 'MISSION', 'MOMENT', 'NATIONAL', 'ORIGIN', 'PACE', 'PARAMOUNT',
  'PIONEER', 'POWER', 'PRIME', 'PURE', 'RANGE', 'RISE', 'SAGE', 'SELECT', 'SHIFT', 'SOLO', 'SPARK',
  'SPIRIT', 'STAR', 'STERLING', 'STRIDE', 'SUMMIT', 'SUN', 'UNITY', 'VAIL', 'VALUE', 'VISION',
  'WAVE', 'WELL', 'ZEAL', 'ABOVE', 'AGAIN', 'AFTER', 'TRUMP', 'READY', 'WORK', 'WORKS', 'LUNCH',
  'FLIGHT', 'PACING', 'CITIZENS', 'PAYMENT', 'STATES', 'AUGUST', 'MARCH', 'MAY', 'HUMAN', 'MARKET',
  'FINANCIAL', 'INTERNATIONAL', 'CONSUMER', 'COMMISSION', 'COACHING', 'PROFESSIONAL', 'PROFESSIONALS',
  'GENERAL', 'AMERICAN', 'STANDARD', 'PREMIER', 'SUPERIOR', 'INDUSTRIES', 'PARTNERS', 'CAPITAL',
  'GERMAN', 'FRENCH', 'BRITISH', 'CHINESE', 'JAPANESE', 'INDIAN', 'CANADIAN', 'EUROPEAN', 'ASIAN',
  'CARBON', 'CAPTURE', 'VISION', 'SOURCE', 'FOUNDATION', 'STANLEY', 'MORGAN',
  // Companies whose registered name IS an ordinary word. MicroStrategy renamed itself "Strategy",
  // so every headline containing the word would otherwise be tagged MSTR.
  'STRATEGY', 'SOUND', 'EMPIRE', 'CREDIT', 'GROWTH', 'INNOVATION', 'DISCOVERY', 'ENTERPRISE',
  // PR wires publish in TITLE CASE, where every word is capitalised and capitalisation therefore
  // proves nothing. "The SEO Answer Rebrands as Rank & Revenue, Expanding Beyond SEO" was tagged
  // $BYON because Beyond, Inc. reduces to the single word BEYOND, and "EMILY Launches AI Strike
  // Workshop" was tagged $NWGL because CL Workshop Group Ltd reduces to WORKSHOP. Both went out on
  // the live account. A one-word name that is also an ordinary English word cannot be told apart
  // from the word itself, so it is refused — see the index guard below, which now also refuses to
  // store such a name at all.
  // 'Track Group, Inc.' reduces to TRACK, which put  on 'Rising oil prices put Fed on
  // track for September rate hike' and on a math-tutoring press release. Same class as BEYOND.
  'TRACK', 'TRACKING', 'BRIDGE', 'SIGNAL', 'MOTION', 'MOMENT', 'MARKER', 'MATTER', 'MATTERS',
  'MEASURE', 'MONITOR', 'MODERN', 'NATURAL', 'NOBLE', 'ORDER', 'PATTERN', 'PHASE', 'PLANET',
  'PROCESS', 'PROFILE', 'RECORD', 'REGION', 'REPORT', 'SAMPLE', 'SCALE', 'SECTOR', 'SEGMENT',
  'SERIES', 'SHIELD', 'SPHERE', 'STAGE', 'STREAM', 'STRUCTURE', 'SUMMIT', 'SURFACE', 'TARGET',
  'ANSWER', 'BEYOND', 'WORKSHOP', 'STRIKE', 'LAUNCH', 'REVENUE', 'RANK', 'CONNECTED', 'BUSINESS',
  'BUSINESSES', 'STRATEGIC', 'STRATEGICALLY', 'PARTNER', 'PROGRAM', 'MODEL', 'PLATFORM', 'NETWORK',
  'SYSTEM', 'SYSTEMS', 'SOLUTION', 'SOLUTIONS', 'SERVICE', 'SERVICES', 'PRODUCT', 'PRODUCTS',
  'BRAND', 'BRANDS', 'DEMAND', 'SUPPLY', 'OUTLOOK', 'REPORT', 'RESULTS', 'STUDY', 'TRIAL',
  'REVIEW', 'AWARD', 'AWARDS', 'LEADER', 'LEADERS', 'EXPERT', 'EXPERTS', 'INSIGHT', 'INSIGHTS',
  'ACCESS', 'ACTION', 'ALIGN', 'AMPLIFY', 'ANCHOR', 'APEX', 'ASCEND', 'ASSURE', 'ATLAS', 'BEACON',
  'BRIDGE', 'CASCADE', 'CATALYST', 'CHAMPION', 'CLARITY', 'COMPASS', 'CONCORD', 'CONNECT',
  'CORNERSTONE', 'CREST', 'CRUCIAL', 'DIRECT', 'ECLIPSE', 'ELEVATE', 'EMBARK', 'EMERGE', 'ENDURE',
  'ENGAGE', 'EVOLVE', 'FLAGSHIP', 'FOCUS', 'FORGE', 'FORTUNE', 'FOUNDER', 'FUSION', 'GATEWAY',
  'GENESIS', 'GRAVITY', 'HERITAGE', 'IGNITE', 'INSPIRE', 'INTEGRITY', 'KEYSTONE', 'LANDMARK',
  'LEGEND', 'LIFT', 'MERIDIAN', 'MOMENTUM', 'NAVIGATE', 'NEXUS', 'NOBLE', 'NORTH', 'SOUTH', 'EAST',
  'WEST', 'OASIS', 'ODYSSEY', 'PARAGON', 'PATHWAY', 'PATRIOT', 'PHOENIX', 'PILLAR', 'PINNACLE',
  'PIVOT', 'PLEDGE', 'PRECISION', 'PREMIUM', 'PROSPER', 'PROTECT', 'PURSUIT', 'QUEST', 'RADIANT',
  'REACH', 'RELIANCE', 'RENEW', 'RESOLVE', 'REVIVE', 'SAFEGUARD', 'SENTINEL', 'SHIELD', 'SIMPLE',
  'SOAR', 'SOLID', 'SPECTRUM', 'STELLAR', 'STRONG', 'SUMMIT', 'SURGE', 'SUSTAIN', 'THRIVE',
  'TRIBUTE', 'TRIUMPH', 'TRUST', 'VANGUARD', 'VELOCITY', 'VENTURE', 'VERITY', 'VIGOR', 'VITAL',
  'VOYAGE', 'ZENITH',
]);

// Brand and common names that differ from the legal name the filings carry. Each entry is a fact
// about one company, not a guess: the reference data simply files it under another name.
export const ALIASES = new Map(Object.entries({
  GOOGLE: 'GOOGL', ALPHABET: 'GOOGL', META: 'META', FACEBOOK: 'META', INSTAGRAM: 'META',
  WHATSAPP: 'META', YOUTUBE: 'GOOGL', AWS: 'AMZN', 'AMAZON WEB SERVICES': 'AMZN',
  IPHONE: 'AAPL', MACBOOK: 'AAPL', XBOX: 'MSFT',
  'KIRKLAND SIGNATURE': 'COST', 'COSTCO WHOLESALE': 'COST', COSTCO: 'COST', AMAZON: 'AMZN',
  'HOME DEPOT': 'HD', LOWES: 'LOW', KROGER: 'KR', 'TARGET CORP': 'TGT', CATERPILLAR: 'CAT',
  LOCKHEED: 'LMT', RAYTHEON: 'RTX', HONEYWELL: 'HON', DEERE: 'DE', UPS: 'UPS', FEDEX: 'FDX',
  VERIZON: 'VZ', COMCAST: 'CMCSA', CVS: 'CVS', CIGNA: 'CI', UNITEDHEALTH: 'UNH', ANTHEM: 'ELV',
  'BRISTOL MYERS': 'BMY', GILEAD: 'GILD', BIOGEN: 'BIIB', REGENERON: 'REGN', VERTEX: 'VRTX',
  'COCA COLA': 'KO', PEPSICO: 'PEP', PEPSI: 'PEP', KELLOGG: 'K', HERSHEY: 'HSY', TYSON: 'TSN', WALMART: 'WMT', 'SAMS CLUB': 'WMT',
  TESLA: 'TSLA', SPACEX: null, NVIDIA: 'NVDA', GEFORCE: 'NVDA', INTEL: 'INTC', AMD: 'AMD',
  BOEING: 'BA', AIRBUS: null, DELTA: 'DAL', UNITED: null, 'AMERICAN AIRLINES': 'AAL',
  JPMORGAN: 'JPM', 'JPMORGAN CHASE': 'JPM', CHASE: 'JPM', GOLDMAN: 'GS', 'GOLDMAN SACHS': 'GS',
  'MORGAN STANLEY': 'MS', 'BANK OF AMERICA': 'BAC', CITIGROUP: 'C', CITI: 'C', 'WELLS FARGO': 'WFC',
  BERKSHIRE: null, 'BERKSHIRE HATHAWAY': null, DISNEY: 'DIS', NETFLIX: 'NFLX', STARBUCKS: 'SBUX',
  MCDONALDS: 'MCD', NIKE: 'NKE', PFIZER: 'PFE', MODERNA: 'MRNA', 'JOHNSON AND JOHNSON': 'JNJ',
  'ELI LILLY': 'LLY', LILLY: 'LLY', MERCK: 'MRK', ABBOTT: 'ABT', ABBVIE: 'ABBV', AMGEN: 'AMGN',
  EXXON: 'XOM', 'EXXON MOBIL': 'XOM', CHEVRON: 'CVX', SHELL: 'SHEL', BP: 'BP',
  NEXTERA: 'NEE', 'NEXTERA ENERGY': 'NEE', KYNDRYL: 'KD', SALESFORCE: 'CRM', ORACLE: 'ORCL',
  ADOBE: 'ADBE', UBER: 'UBER', LYFT: 'LYFT', AIRBNB: 'ABNB', COINBASE: 'COIN', ROBINHOOD: 'HOOD',
  PAYPAL: 'PYPL', VISA: 'V', MASTERCARD: 'MA', QUALCOMM: 'QCOM', BROADCOM: 'AVGO', MICRON: 'MU',

  // Exchange-listed foreign issuers and ADRs absent from the reference universe. Verified one by
  // one; an issuer whose headline name is ambiguous is deliberately NOT here.
  'NOVO NORDISK': 'NVO', EMBRAER: 'ERJ', 'INTERNATIONAL GAME TECHNOLOGY': 'IGT', IGT: 'IGT',
  SAP: 'SAP', ASML: 'ASML', 'TAIWAN SEMICONDUCTOR': 'TSM', TSMC: 'TSM', INFOSYS: 'INFY',
  'RIO TINTO': 'RIO', 'BHP': 'BHP', 'ANGLOGOLD': 'AU', 'BARRICK': 'B', 'TEVA': 'TEVA',
  ASTRAZENECA: 'AZN', GLAXOSMITHKLINE: 'GSK', GSK: 'GSK', SANOFI: 'SNY', NOVARTIS: 'NVS',
  'ROCHE': null, BAYER: null, 'DEUTSCHE BANK': 'DB', 'CREDIT SUISSE': null, UBS: 'UBS',
  BARCLAYS: 'BCS', HSBC: 'HSBC', 'BANCO SANTANDER': 'SAN', SANTANDER: 'SAN', ING: 'ING',
  'MITSUBISHI UFJ': 'MUFG', SONY: 'SONY', TOYOTA: 'TM', HONDA: 'HMC', 'CANON': 'CAJ',
  'STMICROELECTRONICS': 'STM', 'ARM HOLDINGS': 'ARM', 'SHOPIFY': 'SHOP', 'ENBRIDGE': 'ENB',
  'CANADIAN NATIONAL': 'CNI', 'CANADIAN PACIFIC': 'CP', 'BROOKFIELD': null, 'TELUS': 'TU',
  'FEMSA': 'FMX', 'AMERICA MOVIL': 'AMX', 'GRUPO TELEVISA': 'TV', 'VALE': 'VALE',
  'PETROBRAS': 'PBR', 'ITAU': 'ITUB', 'ALIBABA': 'BABA', 'BAIDU': 'BIDU', 'JD': null,
  'NETEASE': 'NTES', 'PINDUODUO': 'PDD', 'NIO': 'NIO', 'XPENG': 'XPEV', 'LI AUTO': 'LI',
  'HUB GROUP': 'HUBG', 'ENVIRONMENTAL TECTONICS': 'ETCC',
  'AT&T': 'T', FORD: 'F', 'GENERAL MOTORS': 'GM', PALANTIR: 'PLTR', SNOWFLAKE: 'SNOW', ZOOM: 'ZM', SHOPIFY: 'SHOP', SPOTIFY: 'SPOT',
}).filter(([, v]) => v !== null));

// ── index ────────────────────────────────────────────────────────────────────
/**
 * Build the lookup from reference rows. PURE.
 * @param {Array<{ticker:string,company:string}>} rows
 */
export function buildIndex(rows) {
  // Keyed on the FIRST token of the name. A headline reference has to start where the company's
  // name starts, so this is both the lookup and the first filter.
  const byFirst = new Map();
  const add = (toks, ticker, curated = false) => {
    if (!toks.length) return;
    const head = toks[0];
    // A short head is only dangerous ALONE. "R F INDUSTRIES LTD" collapses to ["RF","INDUSTRIES"],
    // whose head is two characters, and the flat length floor dropped the company from the index
    // entirely. With a second token to match on, the pair carries the discrimination the head lacks.
    if (!head || (!curated && head.length < 4 && toks.length < 2)) return;
    if (NOT_A_COMPANY.has(head) || NOT_A_COMPANY.has(toks.join(''))) return;
    // A name that reduces to ONE ORDINARY ENGLISH WORD is not indexable. "CL Workshop Group Ltd"
    // reduces to WORKSHOP and "Beyond, Inc." to BEYOND, and a headline is far more likely to be
    // using the word than naming the company — decisively so on a PR wire, where Title Case
    // capitalises every word and the usual proof that a word is a name disappears. Refusing at
    // index time rather than at match time means Pit Wire and the X post both stop seeing it, so
    // the two surfaces cannot disagree about a symbol that should never have existed.
    if (!curated && toks.length === 1 && AMBIGUOUS_WORD.has(head)) return;
    if (!byFirst.has(head)) byFirst.set(head, []);
    byFirst.get(head).push({ toks, ticker: String(ticker).toUpperCase(), curated });
  };
  for (const r of rows) {
    const t = String(r.ticker || '').toUpperCase();
    if (!t || !/^[A-Z][A-Z0-9.\-]{0,6}$/.test(t)) continue;
    // EXACT EVIDENCE, when the caller can supply it. A row whose company is character-for-character
    // its own industry is a classification that leaked into a name column, not a coincidence. This
    // needs no vocabulary and cannot go stale, so it holds for any description EDGAR invents later.
    if (r.industry != null && r.company != null && String(r.company) === String(r.industry)) continue;
    if (looksLikeIndustry(r.company)) continue;
    add(tokens(r.company), t);
  }
  // Aliases are single-token facts, allowed below the derived-name floor (ATT, BP).
  for (const [name, t] of ALIASES) add(tokens(name), t, true);
  return byFirst;
}

// One ticker for a matched name, or nothing. Several symbols under one name resolve only when they
// are a share-class family (the shortest is a prefix of all: GOOG/GOOGL). BRK.A and BRK.B are not,
// so a headline naming Berkshire without a class gets no ticker rather than the wrong half.
export function pickOne(tickers) {
  const ts = [...tickers].sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (ts.length === 1) return ts[0];
  return ts.every((t) => t.startsWith(ts[0])) ? ts[0] : null;
}

// ── matching ─────────────────────────────────────────────────────────────────
// Candidate spans: runs of capitalised tokens, longest first, so "NextEra Energy" is tried before
// "NextEra". Headlines are often Title Case, which is why the blocklists above matter so much.
const TOKEN = /\b([A-Z][A-Za-z0-9&.'\-]*)/g;
const MAX_SPAN = 4;
// The real protection against a wrong prefix is UNIQUENESS, not length: "Glass" reaches three
// registrants and is refused on that basis. Four is the floor because a three-letter core is short
// enough to land uniquely on the wrong company: "AT&T" normalises to ATT, whose only prefix match
// is Attovia Therapeutics. Names that short are handled by an alias instead.
const MIN_PREFIX = 4;

// Words that describe an INDUSTRY rather than name a company. These are the tokens that change when
// an issuer rebrands and the ones headlines drop, so two names that differ only in these refer to
// the same company. Nothing here is distinctive on its own: "Therapeutics" identifies nobody.
const DESCRIPTOR = new Set([
  'THERAPEUTICS', 'THERAPEUTIC', 'THERAPIES', 'PHARMACEUTICALS', 'PHARMACEUTICAL', 'PHARMA',
  'PHARMACEUTICALS', 'BIOPHARMA', 'BIOPHARMACEUTICALS', 'BIOSCIENCES', 'BIOSCIENCE', 'BIOTECH',
  'BIO', 'ONCOLOGY', 'SCIENCES', 'SCIENCE', 'LABS', 'LABORATORIES', 'LABORATORY', 'MEDICAL',
  'MEDICINES', 'MEDICINE', 'HEALTH', 'HEALTHCARE', 'DIAGNOSTICS', 'GENETICS', 'GENOMICS',
  'TECHNOLOGIES', 'TECHNOLOGY', 'TECH', 'SYSTEMS', 'SOLUTIONS', 'SOFTWARE', 'NETWORKS',
  'COMMUNICATIONS', 'SEMICONDUCTOR', 'SEMICONDUCTORS', 'MICROSYSTEMS', 'ROBOTICS', 'DYNAMICS',
  'INDUSTRIES', 'INDUSTRIAL', 'MANUFACTURING', 'MATERIALS', 'CHEMICALS', 'ENERGY', 'RESOURCES',
  'MINING', 'MINERALS', 'PETROLEUM', 'EXPLORATION', 'UTILITIES', 'POWER',
  'FINANCIAL', 'FINANCE', 'BANCORP', 'BANCSHARES', 'BANKSHARES', 'CAPITAL', 'INVESTMENTS',
  'INVESTMENT', 'PARTNERS', 'ENTERPRISES', 'VENTURES', 'PROPERTIES', 'REALTY', 'ESTATE',
  'INTERNATIONAL', 'GLOBAL', 'WORLDWIDE', 'EQUITY', 'EQUITIES', 'ASSET', 'ASSETS', 'FUNDS', 'FUND', 'BRANDS', 'STORES', 'FOODS', 'MOTORS', 'AIRLINES',
  'AEROSPACE', 'DEFENSE', 'TRANSPORTATION', 'LOGISTICS', 'SERVICES', 'MANAGEMENT', 'CONSULTING',
]);

export function candidateSpans(headline) {
  const words = [];
  for (const m of String(headline || '').matchAll(TOKEN)) words.push(m[1]);
  const spans = [];
  for (let n = MAX_SPAN; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) spans.push(words.slice(i, i + n).join(' '));
  }
  return spans;
}

/**
 * Tickers a headline clearly names. Returns [] rather than a guess.
 * @param {string} headline
 * @param {Map<string,Set<string>>} index
 * @param {number} max how many distinct companies to attach
 */
// A bank that hosts a conference is a VENUE, not the subject. "Eli Lilly expands obesity push at
// Morgan Stanley healthcare conference" is an event about LLY; tagging MS as well would put a
// cashtag on a company that did nothing. Only the span introduced by "at" is dropped, so a genuine
// two-company headline keeps both.
const VENUE = /\bat\s+$/i;
const VENUE_EVENT = /\b(?:conference|summit|forum|symposium|expo|event|day)\b/i;

// UNITS WRITTEN AFTER A NUMBER ARE NOT NAMES. "STANDARD CHARTERED EXPECTS US FED TO DELIVER A 25 BP
// RATE HIKE" went out on the live account as $BP, because BP p.l.c.'s whole registered name reduces
// to the token BP and a capitalised token is exactly what a span is built from. "BP" straight after a
// figure is basis points. Only that position is neutralised: "BP shares fall", "Shell and BP report
// earnings" still resolve. Measured against the full reference index, BP was the only unit
// abbreviation (of ~55 rates, volumes, energy, time and currency units tried after a number) that
// collided with a company name, so the set stays that narrow until there is evidence for another.
const UNIT_AFTER_NUMBER = /(\d(?:[\d,.]*\d)?%?\s*-?\s*)(BPS?)\b/gi;
export const maskUnitsAfterNumbers = (s) => String(s || '').replace(UNIT_AFTER_NUMBER, (_, n, unit) => n + unit.toLowerCase());

export function resolveCompanies(headline, index, max = 3) {
  if (!index || !index.size) return [];
  headline = maskUnitsAfterNumbers(headline);
  const text = String(headline || '');
  const venueContext = VENUE_EVENT.test(text);
  const out = [];
  const claimed = new Set();
  for (const span of candidateSpans(headline)) {
    const spanToks = tokens(span);
    if (!spanToks.length) continue;
    const c = spanToks.join('');
    if (c.length < 2) continue;
    if (NOT_A_COMPANY.has(c) || NOT_A_COMPANY.has(spanToks[0])) continue;
    // A one-word span that is also an ordinary English word is refused outright.
    if (spanToks.length === 1 && AMBIGUOUS_WORD.has(c)) continue;
    // Introduced by "at" in a headline that names a conference: a venue, not the subject.
    if (venueContext && VENUE.test(text.slice(0, text.indexOf(span)))) { claimed.add(c); continue; }
    // Do not re-match inside a span already attributed, so "NextEra Energy" does not also yield
    // whatever "Energy" alone would.
    if ([...claimed].some((k) => k.includes(c) || c.includes(k))) continue;

    const entries = index.get(spanToks[0]);
    if (!entries) continue;
    // The span's tokens must be a WHOLE-TOKEN prefix of the company's name. "Costco" matches
    // ["COSTCO","WHOLESALE"]; "August" does not match ["AUGUSTA","GOLD"] because AUGUST is not
    // AUGUSTA. Every candidate that satisfies that is collected, and two distinct companies mean
    // the reference is ambiguous and resolves to nothing.
    // An EXACT name beats a longer name that merely starts the same way. "Apple" is Apple Inc, not
    // an ambiguity between Apple and Apple Hospitality REIT; without this the right answer loses to
    // a company that happens to extend it.
    const exact = new Set(), prefix = new Set(), curatedHit = new Set();
    for (const e of entries) {
      if (spanToks.length > e.toks.length) continue;
      if (!spanToks.every((t, i) => t === e.toks[i])) continue;
      if (e.curated && spanToks.length === e.toks.length) curatedHit.add(e.ticker);
      (spanToks.length === e.toks.length ? exact : prefix).add(e.ticker);
    }
    // A CURATED ALIAS OUTRANKS THE REFERENCE TABLE. The alias map states a fact about one listing;
    // the reference table is scraped and occasionally disagrees with itself. "BANK OF AMERICA" is
    // filed against BAC twice and, in one stale row, against VKI — a closed-end fund that happens to
    // hold the name — so the two collided and the second-largest US bank resolved to nothing. Where
    // a deliberate entry exists it is the answer, and ambiguity among the rest stops mattering.
    if (curatedHit.size) { exact.clear(); for (const t of curatedHit) exact.add(t); }
    // A SINGLE word identifies a company only when that word IS the company's whole name, or when
    // it is a curated alias. One word prefix-matching a longer name is where every remaining false
    // positive came from: "Take Flight" reached Take-Two, "Watchdog" reached a bank, "Space" reached
    // an ETF, "Trump's" reached T. Rowe. Two or more words may still prefix-match, because "NextEra
    // Energy" against "NEXTERA ENERGY INC" is a real reference and not a coincidence of vocabulary.
    // ── the same company under another name ───────────────────────────────────
    // A company's DISTINCTIVE HEAD survives a rename; what changes is the industry word after it.
    // Cullinan Oncology became Cullinan Therapeutics, and headlines still say the old name, so the
    // span ["CULLINAN","ONCOLOGY"] met the registrant's ["CULLINAN","THERAPEUTICS"] and was refused
    // on the second token. Nurix Therapeutics is written "Nurix", one token, and a single-token
    // span could only ever match a company whose WHOLE name was that word.
    //
    // Both resolve here, and only when every token AFTER the shared head — on both sides — is an
    // industry descriptor carrying no identity. That is what keeps "Take Flight" away from Take-Two
    // Interactive: the tail there is ["TWO","INTERACTIVE"], and "TWO" names something.
    // Gated on what is ACCEPTED, not on what was collected. A single-token span like "Nurix" does
    // populate `prefix` (NURIX does begin NURIX THERAPEUTICS) but that set is discarded below for
    // one-word spans, so keying off prefix.size meant the branch never ran for exactly the case it
    // was written for.
    const accepted = exact.size ? exact : (spanToks.length >= 2 ? prefix : new Set());
    const renamed = new Set();
    if (!accepted.size) {
      const head = spanToks[0];
      // THE HEAD MUST BE THE COMPANY'S OWN WORD. Sharing a head is not evidence of being the same
      // company when the head is a word many companies start with: "Alaris Equity Partners" reached
      // Equity Bancshares and "Primaris REIT" reached the same, because EQUITY + a descriptor tail
      // described both. So the head has to identify ONE issuer across the whole index — counting
      // every company filed under it, not just the ones with a descriptor tail, because a rival
      // with a distinctive tail is exactly the evidence that the head is generic.
      const sameHead = new Set(entries.filter((e) => e.toks[0] === head).map((e) => e.ticker));
      const distinct = pickOne(sameHead);             // collapses a share-class family to one
      // TWO TOKENS MINIMUM, the same bar every other path in this file holds a single word to. A
      // bare head is only unique in OUR universe, which is not the market: "Piedmont plans $200M
      // exchangeable notes offering" found exactly one Piedmont on file and resolved to Piedmont
      // Realty — while Piedmont Lithium, absent from the reference data, is the likelier subject of
      // a convertible-notes story. The span's own descriptor is what confirms the industry, and
      // without one there is nothing to confirm. This costs real matches; a wrong cashtag costs more.
      // A head that is ITSELF an industry word is not distinctive, by definition — and the
      // uniqueness test above cannot catch that, because uniqueness depends on how much reference
      // data happens to be loaded. "Equity Partners" reached Equity Bancshares whenever the index
      // held only one Equity-headed issuer. Requiring the head to carry identity of its own is a
      // property of the word, not of the data, so it holds however sparse the universe is.
      if (distinct && spanToks.length >= 2 && head.length >= MIN_PREFIX
          && !DESCRIPTOR.has(head) && !AMBIGUOUS_WORD.has(head)
          && spanToks.slice(1).every((t) => DESCRIPTOR.has(t))) {
        for (const e of entries) {
          if (e.toks[0] !== head) continue;
          if (!e.toks.slice(1).every((t) => DESCRIPTOR.has(t))) continue;
          renamed.add(e.ticker);
        }
      }
    }

    const hits = accepted;
    if (!hits.size && renamed.size) {
      const t2 = pickOne(renamed);
      if (t2) { claimed.add(c); if (!out.includes(t2)) out.push(t2); if (out.length >= max) break; }
      continue;
    }
    if (!hits.size) continue;
    const t = pickOne(hits);
    if (!t) continue;                                  // ambiguous: two companies, or two classes
    claimed.add(c);
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
