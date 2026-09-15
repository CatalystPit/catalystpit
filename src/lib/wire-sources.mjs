// INTERNAL SOURCE MAPPING AND WIRE DECORATION. NEVER import this file from a client component or
// from any module a client component imports — it carries the full vendor roster. App code must go
// through wire-sources.server.mjs, whose `server-only` guard fails the BUILD if that rule is
// broken. This unguarded file exists so the verification scripts, which run in plain Node, can
// exercise decorate(); `server-only` throws outside a React Server Component and would block them.
//
// The vendor identities are an internal implementation detail: Pit Wire presents ONE canonical event
// per real-world story and deliberately never tells the browser which feed found it. That is separate
// from, and does not affect, the attribution Catalyst Pit shows on purpose — SEC rows still carry
// their source and filing link, and /api/news still names the publisher of a story it links to.
// Exported so the verification suite can assert no source lands in two groups. Server-side only —
// this module is reachable from app code solely through wire-sources.server.mjs.
export const SOURCE_GROUP_MEMBERS = {
  wires:    ['FINANCIALJUICE', 'BREAKINGMARKETNEWS', 'WALTERBLOOMBERG'],
  media:    ['BLOOMBERG', 'WSJ', 'CNBC', 'YAHOO', 'MARKETWATCH', 'FT', 'ECONOMIST', 'AXIOS', 'TECHCRUNCH'],
  research: ['SEEKINGALPHA', 'INVESTING', 'ZEROHEDGE'],
  biotech:  ['BIOSPACE', 'BIOTECHNEWSWIRE'],
  pr:       ['GLOBENEWSWIRE', 'PRNEWSWIRE', 'EINPRESSWIRE', 'PRCOM', 'NEWSFILE'],
  gov:      ['FED', 'ECB', 'CFTC', 'FDA', 'FTC', 'DOJ', 'EIA'],
  sec:      ['SEC'],
  exchange: ['NASDAQ'],
  apis:     ['MARKETAUX', 'STOCKDATA'],
};

const GROUP_OF = (() => {
  const m = new Map();
  for (const [group, members] of Object.entries(SOURCE_GROUP_MEMBERS)) {
    for (const s of members) m.set(s, group);
  }
  return m;
})();

/** Group key for a source code. Unknown sources fall to 'other', exactly as before. */
export const sourceGroupOf = (source) => GROUP_OF.get(String(source || '').toUpperCase()) || 'other';

// ── event decoration (server-only) ───────────────────────────────────────────
// Moved verbatim out of wire-taxonomy.mjs, which PitWire.jsx imports and which therefore ships to
// browsers. decorate() was the only consumer there of the source->group mapping and the
// trusted-source list, so keeping it client-side published both. The predicates below are the same
// source text as before; nothing about classification changed.
import { eventTypeOf, categoryOf, capBucketOf } from './wire-taxonomy.mjs';
import { isTaxonomyLabel } from './news-normalize.mjs';
import { isTrustedSource } from './trusted-sources.mjs';

const CRYPTO = /\b(bitcoin|btc|ethereum|eth|crypto|blockchain|token|stablecoin|defi|nft|altcoin|binance|coinbase)\b/i;
const FOREIGN = /\b(nikkei|hang seng|shanghai composite|ftse|dax|cac 40|ibex|sensex|nifty|kospi|asx 200|tadawul|bovespa|tsx|euro stoxx|shenzhen)\b/i;
const ADVICE = [
  /\?\s*$/,                                                        // a news headline states; it does not ask
  /\b(?:should|shouldn't|can|could|do|does|will|is|are)\s+you\b/i,
  /\byour\s+(?:portfolio|retirement|money|savings|401\s?\(?k\)?|nest egg)\b/i,
  /^\s*(?:forget|here'?s why|here is why|why i\b|my top|the case (?:for|against)|is it time|time to buy)/i,
  // A COUNT of things, not a money amount. The lookbehind is load-bearing: without it "Amerigo
  // declares CAD 0.21 dividend" and "Trump's $5,000 dividend checks" read as listicles and seven
  // real dividend declarations vanished from Market Moving in testing.
  /(?<![\d.,$])(?:[1-9]|10|three|five|seven|ten)\s+(?:best|top|great|cheap|reasons?|stocks|etfs|dividend)\b/i,
  // Plural only. "Piper Sandler names Q2 Holdings top pick" is an analyst call, not a listicle.
  /\b(?:best|top)\s+\d*\s*(?:stocks|etfs|picks|ideas|buys)\b/i,
  /\bworth\s+(?:by|in)\s+20\d\d\b/i,
  /\bprice (?:prediction|target for 20\d\d)\b/i,
  /\b(?:set(?:ting)? up well|looks? (?:attractive|cheap)|screaming buy|still a buy|buy or sell)\b/i,
  /\b(?:retirees?|retirement)\b[^.]*\b(?:should|own|buy|need)\b/i,
];
const isAdvice = (e) => {
  // Anything the engine itself called a primary record cannot be a column. This keeps the shape
  // patterns away from filings, halts and wire flashes entirely.
  if (e.source_kind === 'sec' || e.source_type === 'halt' || e.source_type === 'wire') return false;
  const h = String(e.headline || '');
  return ADVICE.some((re) => re.test(h));
};

// Keys match NOISE_FILTERS in wire-taxonomy.mjs, which carries the same keys with their labels for
// the filter chips.
const NOISE_TESTS = [
  { key: 'advice',      test: isAdvice },
  { key: 'lowPr',       test: (e) => e.source_type === 'press_release' && (e.importance ?? 0) <= 1 },
  { key: 'transcripts', test: (e) => e.source_type === 'transcript' },
  { key: 'commentary',  test: (e) => e.source_type === 'analysis' && (e.importance ?? 0) <= 1 },
  { key: 'papers',      test: (e) => e.source_type === 'research' },
  { key: 'govRoutine',  test: (e) => (e.source_type === 'data' || e.source_type === 'speech') && (e.importance ?? 0) <= 1 },
  { key: 'crypto',      test: (e) => CRYPTO.test(`${e.headline} ${e.summary || ''}`) },
  { key: 'foreign',     test: (e) => FOREIGN.test(`${e.headline} ${e.summary || ''}`) },
];

// Decorate a raw canonical event with its display facets. Called once per event on arrival, then
// cached on the object, so filtering never re-runs classification.
export function decorate(ev) {
  const type = eventTypeOf(ev);
  return {
    ...ev,
    // A CATEGORY LABEL IS NOT A SYMBOL, and this is the single point every wire row passes through
    // on its way to the browser — so no stored row, however old, can hand "MACRO" to the chart. The
    // label itself is untouched: it is wireCategory below, which is what paints the green chip.
    tickers: (ev.tickers || []).filter((t) => t && !isTaxonomyLabel(t)),
    wireType: type,
    wireCategory: categoryOf(ev, type),
    wireGroup: sourceGroupOf(ev.source),
    wireCap: capBucketOf(ev.market_cap),
    // A trusted source is never classified as noise. These filters exist to keep commentary out of
    // the useful presets, and a breaking-news wire the operator has designated high-signal must not
    // be capable of being discarded by them — a flash about crypto or a foreign index is still a
    // flash. Nothing else about the row changes, and it remains fully filterable by impact,
    // category, event type, ticker and source group like every other event.
    wireNoise: isTrustedSource(ev.source) ? []
      : NOISE_TESTS.filter((n) => { try { return n.test(ev); } catch { return false; } }).map((n) => n.key),
  };
}

