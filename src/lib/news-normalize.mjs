// Deterministic normalisation. PURE: no DB, no network, no AI.
//
// This module is what lets a Catalyst Pit event appear the instant it is captured. Everything here
// is rule-based and runs in microseconds, so an event never waits on a model to become displayable.
// Haiku enrichment refines the SAME canonical event afterwards; it is an upgrade, never a gate.
//
// Nothing here invents content. The canonical headline is a CLEANED form of a real source headline:
// wire prefixes, channel handles, trailing attributions and shouting are removed, and a resolved
// ticker is prefixed. No fact is added that the source did not state.

// ── headline cleaning ────────────────────────────────────────────────────────
const ENTITIES = [
  [/&amp;/g, '&'], [/&lt;/g, '<'], [/&gt;/g, '>'], [/&quot;/g, '"'],
  [/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'"], [/&nbsp;|&#160;/g, ' '],
  [/&mdash;|&#8212;/g, '—'], [/&ndash;|&#8211;/g, '–'], [/&hellip;/g, '…'],
  [/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))],
  [/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))],
];

// Wire operators stamp their own name on the front or back of a headline. That is branding, not
// fact, and it is exactly what makes the same story look different across sources.
const LEAD_JUNK = /^(?:financialjuice|breaking|breaking news|just in|update|alert|exclusive|live|watch|video|report)\s*[:\-–—]\s*/i;
const TRAIL_JUNK = [
  /\s*\(@[A-Za-z0-9_]+\)\s*$/,                       // telegram channel handle
  /\s*[-–—|]\s*(?:reuters|bloomberg|cnbc|marketwatch|yahoo finance|barron'?s|the wall street journal|wsj|financial times|ft|seeking alpha|investing\.com|globenewswire|pr newswire|prnewswire|business wire|ein presswire)\s*$/i,
  /\s*\|\s*[A-Za-z .]{2,28}\s*$/,                    // "... | Some Outlet"
  /\s*\.{3}\s*$/,
];

const deEntity = (s) => { let t = String(s || ''); for (const [re, to] of ENTITIES) t = t.replace(re, to); return t; };

// A headline in block capitals is a press-release formatting habit, not emphasis worth carrying.
// Converted to title case, with short all-caps tokens left alone because those are overwhelmingly
// tickers, exchanges and acronyms (ISS, FDA, CEO, NYSE) rather than shouting.
const TITLE_SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'for', 'of', 'to', 'in',
  'on', 'at', 'by', 'as', 'from', 'into', 'with', 'over', 'per', 'via', 'vs']);
// In a shouting headline every token is capitals, so "FDA" and "RARE" are indistinguishable by
// shape. An allowlist is used rather than a guess: these stay upper, everything else is title-cased.
// The failure mode is cosmetic in both directions, and this one is at least predictable.
const KEEP_CAPS = new Set(['FDA', 'SEC', 'FTC', 'DOJ', 'CFTC', 'FCC', 'EPA', 'IRS', 'DOE', 'DOT',
  'CEO', 'CFO', 'COO', 'CTO', 'CIO', 'CMO', 'CRO', 'EVP', 'SVP', 'IPO', 'ETF', 'REIT', 'SPAC',
  'GDP', 'CPI', 'PPI', 'PCE', 'FOMC', 'ECB', 'BOE', 'BOJ', 'IMF', 'OPEC', 'NATO', 'EPS', 'EBIT',
  'NYSE', 'AMEX', 'OTC', 'TSX', 'LSE', 'ASX', 'ISS', 'AI', 'EV', 'ESG', 'API', 'SaaS', 'IoT',
  'US', 'UK', 'EU', 'UAE', 'USA', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'FY', 'YOY', 'QOQ', 'M&A',
  'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'LNG', 'OEM', 'R&D', 'IP', 'PC', 'TV', 'HR', 'IT']);
function unshout(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return s;
  if ((s.match(/[A-Z]/g) || []).length / letters.length < 0.85) return s;
  let i = 0;
  return s.replace(/[A-Za-z][A-Za-z'’]*/g, (w) => {
    i++;
    const lower = w.toLowerCase();
    if (KEEP_CAPS.has(w)) return w;
    if (i > 1 && TITLE_SMALL.has(lower)) return lower;
    return lower[0].toUpperCase() + lower.slice(1);
  });
}

// The wires tag each flash with the desk it came from, as a trailing cashtag: "... $MACRO", and the
// channel suffix is already removed above. That tag is routing metadata, not part of the sentence,
// and Pit Wire renders the same word as the row's category label anyway — leaving it produced
// "MACRO  US 3-Month Bill High Yield ... $Macro". Only a TAXONOMY label is stripped: a trailing
// "$AAPL" is a real symbol the source is pointing at and it stays.
const trailingDeskTag = (s) => s.replace(/\s*\$([A-Za-z]{2,14})\s*$/, (m, sym) => (isTaxonomyLabel(sym) ? '' : m));

// ── economic releases ────────────────────────────────────────────────────────
// The calendar wires publish one rigid shape:
//   "US 3-MONTH BILL HIGH YIELD ACTUAL 4.06% (FORECAST -, PREVIOUS 3.97%)"
// which reads as machine output. This restates it as a sentence WITHOUT touching a single figure:
// every number below is copied from the source, a missing field (written "-") is dropped rather
// than filled in, and nothing that is not in the source is added.
//   → "US 3-Month Bill High Yield: 4.06% vs. 3.97% previous"
//   → "US 3-Month Bill High Yield: 4.06% vs. 4.00% forecast, 3.97% previous"
const RELEASE = /^(.*?)[\s,:-]*\bactual\b[\s:]*([^\s(]+)\s*(?:\(([^)]*)\))?\s*$/i;
const FIELD = (body, name) => {
  const m = new RegExp(`\\b${name}\\b[\\s:]*([^,)]*)`, 'i').exec(body || '');
  const v = (m?.[1] || '').trim().replace(/[.,;]+$/, '');
  return v && v !== '-' && v !== '--' && !/^n\/?a$/i.test(v) ? v : null;
};

export function formatEconomicRelease(headline) {
  const s = String(headline || '').trim();
  const m = RELEASE.exec(s);
  if (!m) return s;
  const name = m[1].trim().replace(/[\s,:-]+$/, '');
  const actual = m[2].trim().replace(/[.,;]+$/, '');
  if (!name || !actual) return s;
  const forecast = FIELD(m[3], 'forecast');
  const previous = FIELD(m[3], 'previous');
  const against = [forecast && `${forecast} forecast`, previous && `${previous} previous`].filter(Boolean);
  return against.length ? `${name}: ${actual} vs. ${against.join(', ')}` : `${name}: ${actual}`;
}

export function cleanHeadline(raw) {
  let s = deEntity(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(LEAD_JUNK, ''); } while (s !== prev);
  for (const re of TRAIL_JUNK) s = s.replace(re, '');
  s = trailingDeskTag(s).trim();
  s = unshout(s).replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  s = s.replace(/[\s\-–—:|]+$/, '').trim();
  return formatEconomicRelease(s);
}

// The canonical headline shown to users: a cleaned real headline, prefixed with the ticker when one
// was conservatively resolved. Truncation is on a word boundary so a headline is never cut mid-word.
export const MAX_DISPLAY = 140;

// ── shortening a long headline without breaking it ───────────────────────────
// This used to be `s.slice(0, 140)` with an ellipsis stuck on the end, which is how Pit Wire came to
// display "...(outside the liquidity agreement) from 7…". A character slice knows nothing about
// where a sentence can stop, so it cut mid-date, mid-phrase and after bare connectors, and the
// result was STORED — the canonical headline itself was broken, not merely clipped by the UI.
//
// A shortened headline must be a sentence that ends where a sentence can end. Two deterministic
// moves are allowed, in order of how little they cost the reader:
//   1. drop a trailing parenthetical, which is nearly always a qualifier rather than the fact
//   2. cut at a real clause boundary, keeping the leading clause that carries the subject and verb
// Whatever survives has to pass isCompletePhrase(). If nothing does, the FULL headline is kept and
// the UI ellipsises it visually — a complete headline the reader can hover is strictly better than
// a broken one nobody can complete.

// Words a headline cannot end on: it is still mid-thought.
const DANGLING_TAIL = new RegExp(String.raw`\b(?:${[
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'its', 'their', 'his', 'her', 'our', 'your',
  'and', 'or', 'but', 'nor', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'with', 'without',
  'into', 'onto', 'upon', 'over', 'under', 'within', 'between', 'among', 'across', 'through',
  'during', 'before', 'after', 'since', 'until', 'about', 'against', 'per', 'via', 'as', 'than',
  'up', 'down', 'off', 'out', 'plus', 'versus', 'vs', 'amid', 'ahead', 'following', 'including',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'must', 'does', 'did', 'no', 'not',
].join('|')})$`, 'i');
// A month with nothing after it, or a range opener with only its first number, is an unfinished date.
// A month with only its DAY. "Investors Alerted to September 21" is a date the sentence has not
// finished stating: the cut took the year that made it a deadline.
//
// A BARE trailing month is not this. "Canada inflation holds at 3.0% year-over-year in August" and
// "Fund reports results for September" are ordinary complete headlines, and rejecting them cost
// three real macro prints in the X suite before this was narrowed.
const MONTH = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const DANGLING_DATE = new RegExp(String.raw`\b(?:${MONTH})\.?\s+\d{1,2}(?:st|nd|rd|th)?$`, 'i');
// Only the OPENING half of a range is unfinished. "from 7" and "between 5" still owe a second
// number; "aged 18 to 59" has already closed, and rejecting it would have thrown away a complete
// headline about an approved label.
const DANGLING_RANGE = /\b(?:from|between)\s+\d[\d.,]*$/i;
const balanced = (s, open, close) =>
  (s.split(open).length - 1) === (s.split(close).length - 1);

/** Can a headline stop here? */
export function isCompletePhrase(text) {
  const s = String(text || '').trim();
  if (s.length < 12) return false;
  if (/[…]$|\.\.\.$/.test(s)) return false;
  if (/[,;:\-–—/&+]$/.test(s)) return false;           // trailing punctuation that joins clauses
  if (DANGLING_TAIL.test(s)) return false;
  if (DANGLING_DATE.test(s)) return false;
  if (DANGLING_RANGE.test(s)) return false;
  if (!balanced(s, '(', ')') || !balanced(s, '[', ']')) return false;
  if ((s.split('"').length - 1) % 2 !== 0) return false;
  if ((s.split('“').length - 1) !== (s.split('”').length - 1)) return false;
  return true;
}

// Clause boundaries, most natural stopping point first.
const BOUNDARIES = [/\.\s+/g, /;\s+/g, /\s+[–—]\s+/g, /\s+-\s+/g, /:\s+/g, /,\s+/g];
// A shortened headline that keeps less than this much of the original has thrown away the event.
const MIN_KEEP = 0.45;

export function shortenHeadline(raw, max = MAX_DISPLAY) {
  const s = String(raw || '').trim();
  if (s.length <= max) return s;

  // 1. Drop trailing parentheticals. "(outside the liquidity agreement)" qualifies the fact; the
  //    fact is the transactions and the dates.
  let trimmed = s;
  for (let i = 0; i < 3; i++) {
    const next = trimmed.replace(/\s*[([][^()[\]]*[)\]]\s*$/, ' ').replace(/\s+/g, ' ').trim();
    if (next === trimmed) break;
    trimmed = next;
    if (trimmed.length <= max && isCompletePhrase(trimmed)) return trimmed;
  }
  // A parenthetical in the MIDDLE is just as droppable when it is what pushes the line over.
  const inner = s.replace(/\s*\([^()]{0,60}\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (inner.length <= max && inner.length >= s.length * MIN_KEEP && isCompletePhrase(inner)) return inner;

  // 2. Cut at the last clause boundary that still fits, preferring the strongest break.
  const base = trimmed.length < s.length ? trimmed : s;
  for (const re of BOUNDARIES) {
    let best = -1;
    re.lastIndex = 0;
    for (const m of base.matchAll(re)) {
      if (m.index > 0 && m.index <= max) best = m.index;
    }
    if (best < 0) continue;
    const cut = base.slice(0, best).replace(/[\s,;:–—-]+$/, '').trim();
    if (cut.length >= base.length * MIN_KEEP && isCompletePhrase(cut)) return cut;
  }

  // 3. Nothing deterministic is safe. Keep the whole thing; the UI clamps it.
  return s;
}

export function canonicalHeadline(rawHeadline, tickers = []) {
  let s = cleanHeadline(rawHeadline);
  if (!s) return '';
  s = shortenHeadline(s, MAX_DISPLAY);
  const sym = (tickers || [])[0];
  // Only prefix when the headline does not already lead with that symbol.
  if (sym && !new RegExp(`^\\$?${sym}\\b`, 'i').test(s)) return `${sym}: ${s}`;
  return s;
}

// Enough factual substance to be worth showing. Deliberately permissive — the bar is "this says
// something", not "this is important". Importance ranks it; this only rejects empty shells.
export function isDisplayable(headline) {
  const s = cleanHeadline(headline);
  if (s.length < 12) return false;
  const words = s.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < 3) return false;
  if (/^(?:photo|video|image|podcast|newsletter|correction|test)\b/i.test(s)) return false;
  return true;
}

// ── numeric facts ────────────────────────────────────────────────────────────
// The figures that distinguish one event from another. "$500M buyback" and "$750M acquisition" are
// different events even though both concern the same company, and this is what proves it.
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, mn: 1e6, bn: 1e9, b: 1e9,
  billion: 1e9, t: 1e12, tn: 1e12, trillion: 1e12 };

export function numericFacts(text) {
  const s = deEntity(text || '').replace(/,/g, '');
  const out = new Set();

  // Money, with or without a written scale word: "$500 million", "$4.9bn", "$1,200", "USD 500M".
  for (const m of s.matchAll(/(?:\$|usd\s*|eur\s*|€|£)\s*(\d+(?:\.\d+)?)\s*(k|mm?|mn|bn?|tn?|thousand|million|billion|trillion)?\b/gi)) {
    const mult = SCALE[String(m[2] || '').toLowerCase()] || 1;
    out.add(`m${Math.round(Number(m[1]) * mult)}`);
  }
  // Scale words attached to a bare number near a money noun, e.g. "500 million share repurchase".
  for (const m of s.matchAll(/\b(\d+(?:\.\d+)?)\s*(million|billion|trillion|bn|mn)\b/gi)) {
    const mult = SCALE[String(m[2]).toLowerCase()] || 1;
    out.add(`m${Math.round(Number(m[1]) * mult)}`);
  }
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) out.add(`p${Number(m[1])}`);
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(?:bps|basis points?)\b/gi)) out.add(`b${Number(m[1])}`);
  return [...out].sort();
}

// A stable signature of the two largest magnitudes. Two reports of the same deal agree on the head
// figure even when one of them also mentions a secondary number the other omits.
export function factSignature(text) {
  const money = numericFacts(text).filter((f) => f.startsWith('m'))
    .map((f) => Number(f.slice(1))).sort((a, b) => b - a);
  if (money.length) return money.slice(0, 2).sort((a, b) => a - b).join('_');
  const rest = numericFacts(text);
  return rest.length ? rest.slice(0, 2).join('_') : '';
}

// ── stated tickers ───────────────────────────────────────────────────────────
// Symbols the SOURCE ITSELF prints, which press-release wires do constantly:
//   "Acme Corp (NASDAQ: ACME) announces..."   "Experian plc (EXPGY) presents..."   "$TSLA"
//
// This is reading, not inferring, so it needs no registrant lookup — but only EXCHANGE-QUALIFIED
// forms and cashtags are accepted. A bare "(EXPGY)" is left to the conservative SEC resolver,
// because bare parentheses also wrap things like "(AI)" and "(Q3)" and guessing there would be
// exactly the hallucinated ticker we refuse to produce.
const EXCHANGES = String.raw`NASDAQ|NYSE(?:\s*American|\s*Arca)?|NYSEAMERICAN|AMEX|OTC(?:QB|QX|MKTS)?|CBOE|TSX(?:-?V)?|LSE|ASX|Euronext|XETRA|FSE|BSE|NSE|SIX|JSE|HKEX|SGX|KRX|TASE|B3`;
const TICKER_STATED = new RegExp(String.raw`\(\s*(?:${EXCHANGES})\s*[:\-–]\s*([A-Z][A-Z0-9.\-]{0,6})\s*\)`, 'gi');
const CASHTAG = /(?:^|[\s(\[])\$([A-Z]{1,5})(?![A-Za-z0-9.])/g;
// Words that look like symbols but are not, so a cashtag-like token never becomes a ticker.
const NOT_TICKERS = new Set(['CEO', 'CFO', 'COO', 'CTO', 'USA', 'USD', 'EUR', 'GBP', 'JPY', 'CNY',
  'GDP', 'CPI', 'PPI', 'FED', 'FOMC', 'ECB', 'IMF', 'OPEC', 'EPS', 'IPO', 'ETF', 'SEC', 'FDA',
  'FTC', 'DOJ', 'AI', 'EV', 'ESG', 'API', 'CEOS', 'Q1', 'Q2', 'Q3', 'Q4', 'FY', 'YOY', 'NYSE']);

// TAXONOMY IS NOT A SECURITY. The breaking wires tag each flash with the DESK it belongs to, in
// cashtag form: "US 3-MONTH BILL HIGH YIELD ACTUAL 4.06% ... $MACRO". Read as a ticker, $MACRO
// became the event's ticker AND its entity, canonicalHeadline prefixed the headline with "MACRO: ",
// and clicking the row sent MACRO to TradingView, which has no such symbol.
//
// These are the product's OWN label vocabulary — Pit Wire categories, event types and source groups.
// scripts/verify-macro-labels.mjs asserts this set still covers every one of them, so adding a
// category to wire-taxonomy.mjs cannot silently reintroduce a label that resolves as a ticker.
//
// This applies to the CASHTAG form only. An exchange-qualified statement — "(NYSE: GOLD)" — is the
// source explicitly naming a listed security, and Barrick Gold is a real company whose real ticker
// is GOLD, so that form is still believed. A macro story that genuinely names a public company
// keeps its ticker.
export const TAXONOMY_LABELS = new Set([
  // Pit Wire categories
  'MACRO', 'MARKETS', 'EARNINGS', 'MA', 'PHARMA', 'REGULATORY', 'ENERGY', 'FILING', 'ANALYST',
  'CORPORATE', 'HALT',
  // event types
  'MERGER', 'APPROVAL', 'REJECTION', 'TRIAL', 'OFFERING', 'BUYBACK', 'DIVIDEND', 'SPLIT',
  'CONTRACT', 'LEADERSHIP', 'BANKRUPTCY', 'LAWSUIT', 'SETTLEMENT', 'UPGRADE', 'DOWNGRADE',
  'RATING', 'RATES', 'RECALL', 'OTHER',
  // desks and groups the wires tag with
  'WIRES', 'MEDIA', 'RESEARCH', 'BIOTECH', 'PR', 'GOV', 'EXCHANGE', 'APIS', 'CRYPTO', 'FOREX',
  'FX', 'BONDS', 'COMMODITIES', 'EQUITIES', 'STOCKS', 'INDICES', 'FUTURES', 'OPTIONS', 'NEWS',
  'BREAKING', 'ALERT', 'FLASH', 'UPDATE', 'DATA', 'CALENDAR', 'ECONOMY', 'ECON', 'POLITICS',
  'GEOPOLITICS', 'TECH', 'HEALTH', 'RETAIL', 'BANKS', 'HOUSING', 'JOBS', 'INFLATION',
]);

export const isTaxonomyLabel = (sym) => TAXONOMY_LABELS.has(String(sym || '').toUpperCase());

export function statedTickersIn(text) {
  const s = String(text || '');
  const out = [];
  // Exchange-qualified first, and it is NOT subject to the taxonomy filter: that form is the source
  // naming a listed security outright.
  TICKER_STATED.lastIndex = 0;
  for (const m of s.matchAll(TICKER_STATED)) {
    const sym = String(m[1] || '').toUpperCase();
    if (sym && !NOT_TICKERS.has(sym) && !out.includes(sym)) out.push(sym);
  }
  CASHTAG.lastIndex = 0;
  for (const m of s.matchAll(CASHTAG)) {
    const sym = String(m[1] || '').toUpperCase();
    if (sym && !NOT_TICKERS.has(sym) && !isTaxonomyLabel(sym) && !out.includes(sym)) out.push(sym);
  }
  return out.slice(0, 4);
}

// ── entity ───────────────────────────────────────────────────────────────────
// A normalized company token, used when no ticker has been resolved yet. Deliberately crude: it is
// a dedupe hint, never a displayed fact and never a ticker.
const CORP_TAIL = /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|lp|nv|sa|ag|gmbh|ab|asa|holdings?|group|plc's|sa's)\b\.?/gi;
// A generic leading word is not an entity. Measured on live data, "Updates to the Data Download
// Program…" yielded the token "updates", which then matched 65 unrelated Fed notices that shared
// boilerplate figures. An entity token must name something, or it is worse than nothing.
const ENTITY_STOP = new Set(['the', 'a', 'an', 'us', 'u.s.', 'new', 'breaking', 'update', 'updates',
  'report', 'reports', 'exclusive', 'stock', 'stocks', 'shares', 'market', 'markets', 'wall',
  'street', 'notice', 'upcoming', 'changes', 'improved', 'data', 'final', 'latest', 'live', 'watch',
  'video', 'why', 'how', 'what', 'when', 'where', 'who', 'top', 'best', 'worst', 'first', 'last',
  'more', 'danger', 'alert', 'warning', 'statement', 'remarks', 'speech', 'minutes', 'summary',
  'agencies', 'federal', 'government', 'president', 'chairman', 'governor', 'secretary']);

export function entityToken(headline, tickers = []) {
  if ((tickers || []).length) return String(tickers[0]).toUpperCase();
  const s = cleanHeadline(headline);
  const m = s.match(/^((?:[A-Z][A-Za-z0-9&.'\-]*)(?:\s+[A-Z][A-Za-z0-9&.'\-]*){0,3})/);
  if (!m) return '';
  const tok = m[1].replace(CORP_TAIL, ' ').replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/).map((w) => w.toLowerCase())
    .filter((w) => w.length >= 2 && !ENTITY_STOP.has(w));
  return tok.slice(0, 2).join('-');
}

// ── importance ───────────────────────────────────────────────────────────────
// 3 CRITICAL · 2 HIGH · 1 MEDIUM · 0 LOW. Rule-based on purpose: importance drives ranking, and a
// model that can silently promote a routine item is a model that can distort the product.
export const IMPORTANCE_LABEL = { 3: 'CRITICAL', 2: 'HIGH', 1: 'MEDIUM', 0: 'LOW' };

// Named so that a consumer can ask WHICH rule fired, not merely whether one did. The patterns and
// their order are unchanged — CRITICAL below is derived from this list, so scoring behaviour is
// identical and the names are purely for introspection and auditing.
export const CRITICAL_PREDICATES = [
  { name: 'halt', re: /\b(?:trading )?halt(?:ed|s)?\b/i },
  { name: 'circuit_breaker', re: /\bcircuit breaker\b/i },
  { name: 'chapter_7_11', re: /\bchapter (?:7|11)\b/i },
  { name: 'bankruptcy', re: /\bbankrupt\w*/i },
  { name: 'going_concern', re: /\bgoing concern\b/i },
  { name: 'delisting', re: /\bdelist\w*/i },
  { name: 'default', re: /\bdefaults?\b/i },
  { name: 'fda_decision', re: /\bfda (?:approv|clear|authoriz|reject|declin)\w*/i },
  { name: 'crl', re: /complete response letter/i },
  { name: 'breakthrough_therapy', re: /\bbreakthrough therapy\b/i },
  { name: 'phase3', re: /\b(?:phase (?:3|iii)) (?:results|data|trial)\b/i },
  { name: 'fomc', re: /\bfomc\b/i },
  { name: 'fomc_long', re: /federal open market committee/i },
  { name: 'rate_decision', re: /\brate (?:cut|hike|decision)\b/i },
  { name: 'emergency_action', re: /\bemergency (?:meeting|rate|action)\b/i },
  { name: 'ma', re: /\bacquir\w+|\bmerger\b|\bto buy\b|\btakeover\b|\bbuyout\b/i },
  { name: 'indictment', re: /\bindict\w*/i },
  { name: 'fraud_charges', re: /\bfraud charges\b/i },
  { name: 'sec_charges', re: /\bsec charges\b/i },
];
const CRITICAL = CRITICAL_PREDICATES.map((p) => p.re);

// Which CRITICAL rule a headline trips, for auditing. Read-only; changes no score.
export const criticalPredicate = (text) =>
  CRITICAL_PREDICATES.find((p) => p.re.test(String(text || '')))?.name ?? null;

// ── M&A significance ─────────────────────────────────────────────────────────
// CRITICAL has to mean immediate major market significance, and acquisition LANGUAGE is not that.
// Measured over 14 days: the bare `ma` predicate produced 95 of 276 CRITICAL events — 34% of the
// entire tier — and only 16% of them carried a resolved ticker. The rest were private-to-private
// deals, own-share buyback mechanics, real-estate purchases, lease announcements and survey
// headlines: "Tristela Capital Partners acquires Pediatric Group of Acadiana", "Machine Investment
// Group Acquires 490-Unit Multifamily Community in North Dallas", "71% of Advisers Plan to Buy More
// Active ETFs Within 2 Years, MSCI Survey Finds".
//
// So M&A now has to EARN the tier on evidence of public-market involvement, and where that evidence
// is absent it fails DOWNWARD. No ticker is ever guessed: the only accepted proofs are a symbol the
// conservative resolver already established, or one the source itself printed exchange-qualified.
const MA_LANGUAGE = /\bacquir\w+|\bmerger\b|\bmerge[sd]?\b|\bmerging\b|\bto buy\b|\btakeover\b|\bbuyout\b|\btender offer\b/i;

// Acquisition words that describe no transaction between companies.
//
// The first and most important of these is not a pattern at all but WHERE the word is allowed to
// appear: see maSignificance below. Three live CRITICAL rows tripped M&A on a word buried in a
// press-release body, and in none of them did it describe a transaction —
//   "purchasers or acquirers of Regeneron Pharmaceuticals common stock"  (class-action boilerplate)
//   "patients with acquired hypothalamic obesity"                        (a medical adjective)
//   "the Company has an option to acquire..."                            (a mining option)
// A transaction that belongs in the CRITICAL tier is stated in the headline.
const MA_NOT_A_DEAL = [
  // Treasury mechanics: "Coop Pank AS own shares acquisition transactions", "Schouw & Co. share
  // buy-back programme, week 37 2026", "Marimekko to start acquiring the company's own shares".
  /\bown shares?\b|\btreasury shares?\b|\bshare buy-?back\b|\bbuy-?back programme\b|\brepurchase programme\b/i,
  // Research and marketing: "71% of Advisers Plan to Buy More Active ETFs, MSCI Survey Finds".
  /\bsurvey\b|\bpoll\b|\bstudy finds\b|\breport finds\b|\bplan to buy\b|\bbest time to buy\b/i,
  // Analyst language that trips "to buy": "Straumann rises after Goldman Sachs upgrades to buy".
  /\bupgrad\w+ to buy\b|\bbuy rating\b|\breiterates? buy\b|\bto buy from (?:hold|neutral|sell)\b/i,
  // Property and premises, not corporate control.
  /\bmultifamily\b|\bsquare (?:feet|foot|metres|meters)\b|\bretail leases?\b|\bproperty portfolio\b|\bunit community\b/i,
  // A bond sale that merely funds a deal is not the deal.
  /\bbond sale\b|\bnotes offering\b|\bfinancing for\b/i,
  // "acquirers" meaning shareholders who bought stock, in securities-litigation notices.
  /\b(?:purchasers? or acquirers?|acquirers? of)\b|\bclass action\b|\bclass period\b|\blead plaintiff\b/i,
  // An OPTION to acquire is not an acquisition, and neither is an extension of one.
  /\boptions? to acquire\b|\boption agreement\b|\bright to acquire\b|\bextension of (?:the )?expiration\b/i,
  // "Inflection Point Acquisition Corp." is a company NAME, not a transaction. SPAC vehicles carry
  // the word in their title and would otherwise trip this on every announcement they ever make.
  /\bacquisition (?:corp|corporation|company|holdings|partners|group)\b/i,
  // Real property, not corporate control.
  /\bpropert(?:y|ies)\b|\bacres?\b|\bbuilding\b/i,
];

// Analysis about a deal is not the deal: "Devon Energy: The Coterra Merger Meets A Powerful Oil
// Price Tailwind" is a column, and a column must not occupy the tier reserved for the event itself.
const MA_COMMENTARY = /\b(?:meets?|tailwind|thesis|outlook|why |what (?:it|this) means|analysis|opinion|deep dive|take on|impact of|how the)\b|:\s*(?:the|a|an)\s/i;

// Talk is not a transaction. These stay out of CRITICAL whatever the companies involved.
const MA_UNCONFIRMED = /\b(?:in (?:advanced )?talks|nears? (?:a )?deal|consider(?:s|ing)|explor(?:es|ing)|weigh(?:s|ing)|mulls?|reportedly|rumou?r\w*|said to be|approach(?:es|ed)|potential(?:ly)? (?:acquisition|merger|takeover)|non-?binding|letter of intent)\b/i;

// Public-company identity, established rather than guessed:
//   - a symbol the conservative resolver already attached to the event, or
//   - one the source printed exchange-qualified, which is a statement of fact not an inference.
const EXCHANGE_QUALIFIED = /\((?:NASDAQ|NYSE|NYSE American|AMEX|OTC|LSE|TSX|TSXV|ASX|Euronext|XETRA|FRA|SIX|JSE|HKEX|SGX|BSE|NSE)\s*:\s*[A-Z0-9.\-]{1,6}\)/i;

// A deal big enough to matter to the market even when we cannot pin the symbol.
const MATERIAL_DEAL_USD = 1e9;

/**
 * How significant is an M&A headline?
 * @returns {'critical'|'high'|null} null means "no M&A boost at all".
 */
export function maSignificance({ headline = '', summary = '', tickers = [] } = {}) {
  const head = String(headline || '');
  const hay = `${head} ${summary || ''}`;
  // THE ASSERTION MUST BE IN THE HEADLINE. Supporting facts — a ticker, an exchange-qualified
  // symbol, a deal value — may come from anywhere, but the claim that a transaction happened has to
  // be the thing the headline says. Measured over 14 days this drops six CRITICAL rows and every
  // one of them is a false positive: a class-action notice, a medical adjective, a mining option, a
  // SPAC's own company name, a tender-offer extension notice and a market-commentary column.
  if (!MA_LANGUAGE.test(head)) return null;
  if (MA_COMMENTARY.test(head)) return null;
  for (const re of MA_NOT_A_DEAL) if (re.test(hay)) return null;

  const publicCompany = (tickers || []).length > 0 || EXCHANGE_QUALIFIED.test(hay);
  const unconfirmed = MA_UNCONFIRMED.test(hay);
  const value = numericFacts(hay).filter((f) => f.startsWith('m'))
    .map((f) => Number(f.slice(1))).reduce((a, b) => Math.max(a, b), 0);

  // CRITICAL: a confirmed transaction with an established public company in it.
  if (publicCompany && !unconfirmed) return 'critical';
  // HIGH: a public company but only reported talks, or a confirmed deal of material size whose
  // participants we cannot confidently identify. Visible, not shouted.
  if (publicCompany || value >= MATERIAL_DEAL_USD) return 'high';
  // Everything else — a private-to-private acquisition — gets no boost whatsoever.
  return null;
}
const HIGH = [
  /\bearnings\b/i, /\bguidance\b/i, /\bquarterly results\b/i, /\bpreliminary results\b/i,
  /\boutlook\b/i, /\bprofit warning\b/i, /\brevenue\b/i, /\beps\b/i,
  /\boffering\b/i, /\bpricing of\b/i, /\bdilut\w*/i, /\bipo\b/i, /\bdirect listing\b/i,
  /\bbuyback\b/i, /\bshare repurchase\b/i, /\brepurchase program\b/i,
  /\bdividend\b/i, /\bstock split\b/i, /\bspin-?off\b/i,
  /\b(?:ceo|cfo|coo|chief executive|chief financial)\b.*\b(?:resign|depart|step|appoint|name)\w*/i,
  /\b(?:resign|depart|step down)\w*\b.*\b(?:ceo|cfo|chief executive)\b/i,
  /\bupgrade[sd]?\b|\bdowngrade[sd]?\b|\bprice target\b|\binitiat\w+ coverage\b/i,
  /\bdoj\b|\bftc\b|\bantitrust\b|\bconsent (?:order|decree)\b|\bsettle\w*/i,
  /\bactivist\b|\bstake\b|\b13d\b/i, /\brestructur\w*/i, /\blayoffs?\b/i,
  /\bcontract award\b|\bwins? (?:a )?contract\b|\bsigns? (?:a )?(?:deal|agreement)\b/i,
  /\brecall\w*/i, /\bcyber ?attack\b|\bdata breach\b/i,
  /\bclinical (?:trial|study|data|results)\b/i, /\btopline\b/i,
];
const MEDIUM = [
  /\bspeech\b|\btestimony\b|\bremarks\b/i, /\bproposed rule\b|\bcomment period\b|\bguidance note\b/i,
  /\bconference call\b|\bwebcast\b|\bpresent(?:s|ation)\b/i, /\bjoint venture\b|\bpartnership\b/i,
  /\bappoint\w*|\bnames?\b.*\b(?:president|director|officer)\b/i, /\bpatent\b/i,
];
// ── macro / geopolitical impact ──────────────────────────────────────────────
// The tiers above are entirely corporate, which is why a live production event — Saudi Arabia's
// East-West pipeline taken offline by a drone attack — scored 0 from all eight sources that
// reported it and vanished from Market Moving. Oil moved; the tape did not.
//
// The rule is a CONJUNCTION, never a keyword. A headline must name something that moves a market
// AND assert that something happened to it. "Iran" alone is not an event; "Iran seizes tanker in
// the Strait of Hormuz" is. That conjunction is what keeps ordinary diplomacy out: our own tape
// carried "Trump urges Ukraine to halt refinery strikes", "Iran says US is main obstacle to
// diplomacy" and "Saudi Crown Prince meets US CENTCOM chief" in the same window, and none of them
// is a market event.
const ENERGY_ASSET = /\b(?:oil|crude|gas|lng|petroleum|diesel|fuel|refinery|refineries|refining|pipeline|oilfield|oil field|export terminal|oil terminal|gas terminal|tanker|power (?:plant|grid|station)|nuclear (?:plant|facility|site)|energy (?:infrastructure|targets?|facilities|facility|sites?|assets?|supply|supplies))\b/i;

// ── concrete geopolitical agreements ─────────────────────────────────────────
// A bilateral agreement to stop attacking energy infrastructure is a market event: it reprices
// supply risk the moment it is asserted. The scorer had no way to see one, because its geopolitical
// rules keyed on DISRUPTION — something being broken — and an agreement is the opposite.
//
// The test is the same conjunction used everywhere else: a concrete asserted development AND a
// subject that moves markets. It is emphatically NOT "a politician is mentioned":
//   "Russia and Ukraine agree to halt attacks on energy infrastructure"        CRITICAL
//   "Trump: Ukraine has agreed not to hit Russian energy targets"              CRITICAL (the
//                                                                             agreement is asserted)
//   "Russia and Ukraine are discussing an energy infrastructure ceasefire"     not critical
//   "Trump urges Russia and Ukraine to stop attacking energy targets"          not critical
//   "Trump: World's diesel price rise is caused by Russia-Ukraine war"         not critical
const AGREEMENT = /\b(?:agree(?:s|d)?|agreement|accord|ceasefire|truce|armistice|pact|deal (?:reached|struck|agreed)|reached a deal|signed? (?:a |an )?(?:deal|accord|agreement)|commits? to|committed to|pledge[sd]?)\b/i;
// Talking about an agreement is not having one.
// Talking about an agreement is not having one, and so is FORECASTING one. "Analysts expect Russia
// and Ukraine to agree an energy ceasefire" reached CRITICAL before the forecast verbs were added,
// which is a prediction being published as an event.
const NEGOTIATION = /\b(?:discuss\w+|negotiat\w+|in talks|talks (?:on|over|about|continue)|propos\w+|considering|seeking|hope[sd]? (?:to|for)|push(?:es|ing)? for|working (?:on|toward|towards)|draft\w*|framework for|prospects? for|expect\w*|forecast\w*|predict\w*|anticipat\w*|likely to|poised to|set to agree|would agree|may agree|could agree|might agree)\b/i;

// The agreement has to be about HOSTILITIES or ACCESS, which is what makes it geopolitical rather
// than commercial. Without this, "METLEN and PETRONAS sign long-term LNG supply agreement for
// Greece" scored CRITICAL three times: a supplier contract between two companies, carrying an
// energy word and the word "agreement", and nothing to do with supply risk.
const HOSTILITY_OR_ACCESS = /\b(?:ceasefire|truce|armistice|hostilities|war|attacks?|strikes?|striking|hitting|bombard\w*|shelling|blockad\w+|embargo|not to (?:hit|attack|strike|target)|stop (?:attack|strik|hit|targeting)\w*|halt(?:ing)? (?:attack|strik)\w*|cease (?:fire|attacks?)|reopen\w*|re-?open\w*|closure|closed|shut\w*|access|passage|transit|safe corridor|demilitaris\w+|demilitariz\w+|withdraw\w+)\b/i;
const CHOKEPOINT = /\b(?:strait of hormuz|hormuz|suez|bab[- ]?el[- ]?mandeb|panama canal|strait of malacca|bosphorus|dardanelles|red sea|kerch strait|taiwan strait)\b/i;
const PRODUCER = /\b(?:saudi|opec|iran|iraq|uae|emirates|kuwait|qatar|russia|russian|venezuela|libya|nigeria|kazakhstan|norway|algeria|angola)\b/i;

// Something actually happened to it — not that someone has opinions about it.
const DISRUPTION = /\b(?:attack(?:ed|s|ing)?|struck|strikes?|drones?|missiles?|bomb\w*|explosion|blast|sabotage\w*|seiz(?:e|es|ed|ure)|blockad\w+|shut\s?down|shuts?\b|shutting|halt(?:ed|s)?|offline|out of service|outage|suspend(?:ed|s)?|disrupt\w+|force majeure|evacuat\w+|destroyed|damag(?:e|ed|ing)|caught fire|ablaze|spill)\b/i;

const OPEC_ACTION = /\bopec\+?\b[\s\S]{0,70}?\b(?:cut|cuts|raise|raises|boost|increase|reduce|output|production|quota|target|agree|agrees|decide|decides|extend|extends|pause|unwind|taper)\w*/i;
const TRADE_INSTRUMENT = /\b(?:sanction(?:s|ed|ing)?|embargo|export (?:ban|controls?|restrictions?|licen[cs]e)|import ban|tariffs?|duties|price cap|blacklist|entity list)\b/i;
const TRADE_ACTION = /\b(?:impos(?:e|es|ed|ing)|announc(?:e|es|ed)|introduc(?:e|es|ed)|rais(?:e|es|ed)|hik(?:e|es|ed)|lift(?:s|ed)?|eas(?:e|es|ed)|expand(?:s|ed)?|slap(?:s|ped)?|enact\w*|take[s]? effect|effective|set[s]? at|doubl(?:e|es|ed)|extend(?:s|ed)?)\b/i;
const EMERGENCY_SOVEREIGN = /\b(?:emergency (?:meeting|rate|action|measures?|session|summit)|unscheduled meeting|interven(?:e|es|ed|tion)\b|capital controls|devalu\w+|currency peg|state of emergency|martial law|sovereign default|defaults? on (?:its )?debt|nationaliz\w+|bank holiday|deposit freeze)\b/i;
// The lookbehind is load-bearing: without it "escalat\w+" matches inside "DE-escalation", and
// "Japan and Yemen to work on Bab-el-Mandeb situation de-escalation" — diplomacy, and the opposite
// of the event — scored HIGH.
const MILITARY_ESCALATION = /\b(?:airstrikes?|air strikes?|invasion|invad(?:e|es|ed)|mobiliz\w+|ceasefire|declare[sd]? war|retaliat\w+|(?<![a-z]|de[- ])escalat\w+|nuclear test|missile (?:launch|test|strike|attack)|no[- ]fly zone|troops? (?:cross|enter|deploy)\w*)\b/i;

// Advocacy, not action. Someone wanting, urging or condemning a thing is not the thing happening.
// Deliberately narrow: hedges about DURATION or degree are fine, because "pipeline could remain
// offline for 3-5 weeks" is a material fact about a real outage.
const ADVOCACY = /\b(?:urge[sd]?|urging|calls? (?:on|for)|called (?:on|for)|demand(?:s|ed|ing)?|criticiz\w+|criticis\w+|condemn\w+|slam(?:s|med)?|denounc\w+|appeals? to|lobb(?:y|ies|ied|ying)|push(?:es|ed|ing)? for|wants? to see|hopes? (?:for|to)|should\b|must\b)/i;
// A question or an explainer is commentary about an event, not the event.
const COMMENTARY = /(?:\?\s*$|\b(?:what (?:it|this) means|explainer|analysis|opinion|column|why \w+ (?:is|are|will)|here'?s (?:what|why|how))\b)/i;
// Someone's account of an event is not the event. "Trump says Saudi crown prince is close ally,
// pipeline attack will work out fine" carries every word a real outage carries; what it asserts is
// a politician's view. Reported speech is capped at HIGH rather than discarded, because the event
// behind it is usually real — CRITICAL is reserved for the headline that states the event itself.
const REPORTED_SPEECH = /\b(?:says?|said|tells?|told|claims?|denies|denied|believes?|comments?|insists?|suggests?)\b/i;

// Scored on the HEADLINE ALONE, deliberately. The corporate tiers read headline + summary, and on
// live data that dragged unrelated rows to CRITICAL off boilerplate in a press-release body — "Live
// Oak Bank Named Official Business Bank of UNCW Athletics" among them. An impact badge has to be
// explicable from the row the trader is looking at.
export function macroImpact(text) {
  const s = String(text || '');
  if (!s) return 0;
  if (COMMENTARY.test(s)) return 0;
  const advocacy = ADVOCACY.test(s);
  const reported = REPORTED_SPEECH.test(s);

  const chokepoint = CHOKEPOINT.test(s);
  const energy = ENERGY_ASSET.test(s);
  const disrupted = DISRUPTION.test(s);

  // CRITICAL: a trade chokepoint or major energy infrastructure is actually disrupted, or a
  // sovereign takes an emergency action. These reprice crude, freight and risk within minutes.
  // A concrete agreement about energy or a chokepoint. Checked BEFORE the reported-speech cap,
  // deliberately: "Trump: Ukraine has agreed not to hit Russian energy targets" is reported speech
  // whose CONTENT is the event, and capping it at HIGH would miss a genuine supply-risk repricing.
  // Advocacy and negotiation still block it, which is what keeps "urges", "discussing", "proposes"
  // and "expected to agree" out.
  if (!advocacy && !NEGOTIATION.test(s) && AGREEMENT.test(s) && HOSTILITY_OR_ACCESS.test(s)
      && (energy || chokepoint || MILITARY_ESCALATION.test(s))) return 3;

  if (!advocacy && !reported) {
    if (chokepoint && disrupted) return 3;
    if (energy && disrupted && PRODUCER.test(s)) return 3;
    if (EMERGENCY_SOVEREIGN.test(s)) return 3;
  }

  // HIGH: energy infrastructure disrupted anywhere; an OPEC output decision; sanctions or tariffs
  // actually imposed or lifted; military escalation naming an energy producer or a chokepoint.
  if (!advocacy) {
    if (energy && disrupted) return 2;
    if (OPEC_ACTION.test(s)) return 2;
    if (TRADE_INSTRUMENT.test(s) && TRADE_ACTION.test(s)) return 2;
    if (MILITARY_ESCALATION.test(s) && (PRODUCER.test(s) || chokepoint)) return 2;
  }

  // MEDIUM: the subject matter is market-relevant but what is asserted is intent, advocacy or
  // proximity rather than an event. Visible in Everything, out of Market Moving.
  if (chokepoint || (energy && PRODUCER.test(s)) || TRADE_INSTRUMENT.test(s) || OPEC_ACTION.test(s)) return 1;
  return 0;
}

// Never let promotional noise outrank real news, whatever words it happens to contain.
const NOISE = [
  /\binvestors? (?:who|have) (?:suffered )?(?:losses|opportunity to lead)\b/i,
  /\bclass action\b.*\bdeadline\b/i, /\blaw (?:firm|offices)\b/i, /\breminds? investors\b/i,
  /\bmarket (?:research )?report\b|\bmarket size\b|\bcagr\b|\bforecast to 20\d\d\b/i,
  /\bwebinar\b|\btrade (?:show|fair)\b|\bexpo\b|\baward[s]?\b|\bnominated\b/i,
  /\bhoroscope\b|\brecipe\b|\bgift guide\b|\bdeals? of the day\b/i,
];

export function scoreImportance({ headline, summary = '', source = '', sourceType = '', tickers = [], macroEnabled = true }) {
  const hay = `${headline} ${summary || ''}`;
  if (NOISE.some((re) => re.test(hay))) return 0;
  if (sourceType === 'halt') return 3;
  // Event-based, publisher-independent. Checked alongside the corporate tiers rather than instead
  // of them, so a headline that is both stays at the higher of the two.
  const macro = macroEnabled ? macroImpact(headline) : 0;
  // Every CRITICAL predicate EXCEPT M&A is decisive on its own. A halt is a halt.
  if (CRITICAL_PREDICATES.some((p) => p.name !== 'ma' && p.re.test(hay))) return 3;
  if (macro === 3) return 3;
  // M&A must earn the tier on evidence of public-market involvement, and falls downward when that
  // evidence is missing rather than upward on acquisition vocabulary alone.
  const ma = maSignificance({ headline, summary, tickers });
  if (ma === 'critical') return 3;
  if (ma === 'high') return 2;
  if (HIGH.some((re) => re.test(hay))) return 2;
  if (macro === 2) return 2;
  if (MEDIUM.some((re) => re.test(hay))) return 1;
  if (macro === 1) return 1;
  // A confidently resolved ticker means it is at least about a specific listed company.
  return (tickers || []).length ? 1 : 0;
}
