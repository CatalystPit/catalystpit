// Pit Wire display taxonomy. PURE and DISPLAY-ONLY.
//
// This module classifies a canonical event into the facets the Pit Wire filter UI needs. It is
// strictly a READ-SIDE view: it changes nothing about ingestion, dedupe, clustering or storage, and
// nothing here is ever written back to primary_events.
//
// It reuses the engine's own deterministic actionClass() as its input rather than inventing a
// second classifier, so the wire's notion of "this is a buyback" is the same one dedupe already
// uses. The only additions are display refinements the dedupe layer has no need for (splitting an
// analyst rating into upgrade vs downgrade, for example) — all read directly from the text, never
// guessed.

import { actionClass } from './event-cluster.mjs';

// ── event types ──────────────────────────────────────────────────────────────
// Keyed to what the engine can actually establish. There is deliberately no "guidance" type
// separate from earnings and no "investigation" separate from lawsuit, because the underlying
// classifier does not draw those lines and inventing them would be a fabricated classification.
export const EVENT_TYPES = [
  { key: 'earnings',   label: 'Earnings & Guidance' },
  { key: 'merger',     label: 'M&A' },
  { key: 'approval',   label: 'FDA / Approvals' },
  { key: 'rejection',  label: 'Rejections / CRLs' },
  { key: 'trial',      label: 'Clinical Data' },
  { key: 'offering',   label: 'Offerings / Dilution' },
  { key: 'buyback',    label: 'Buybacks' },
  { key: 'dividend',   label: 'Dividends' },
  { key: 'split',      label: 'Splits' },
  { key: 'contract',   label: 'Contracts' },
  { key: 'halt',       label: 'Halts' },
  { key: 'leadership', label: 'Management Changes' },
  { key: 'bankruptcy', label: 'Bankruptcy / Distress' },
  { key: 'lawsuit',    label: 'Legal / Investigations' },
  { key: 'settlement', label: 'Settlements / Fines' },
  { key: 'upgrade',    label: 'Analyst Upgrades' },
  { key: 'downgrade',  label: 'Analyst Downgrades' },
  { key: 'rating',     label: 'Other Analyst Actions' },
  { key: 'rates',      label: 'Rates / Policy' },
  { key: 'recall',     label: 'Recalls' },
  { key: 'other',      label: 'Other' },
];

const UP = /\b(upgrade[sd]?|raises? (?:price )?target|initiates? (?:coverage )?(?:at|with) (?:buy|outperform|overweight)|to (?:buy|outperform|overweight))\b/i;
const DOWN = /\b(downgrade[sd]?|cuts? (?:price )?target|lowers? (?:price )?target|to (?:sell|underperform|underweight))\b/i;

// An explicit analyst verb is decisive and is checked BEFORE the engine's class. "Analyst upgrades
// Acme to buy" contains the literal phrase "to buy", which the dedupe classifier reads as a merger
// — correct for its purpose, wrong for a wire filter. Resolving it here keeps the dedupe classifier
// untouched while the tape still files the event under Analyst Actions.
const ANALYST_VERB = /\b(upgrade[sd]?|downgrade[sd]?|upgrading|downgrading|price target|initiat\w+ coverage|reiterate[sd]?|maintains? (?:buy|sell|hold|neutral))\b/i;

// The engine's class, plus display-only refinements read straight from the text.
export function eventTypeOf(ev) {
  if (ev?.source_type === 'halt') return 'halt';
  const hay = `${ev?.headline || ''} ${ev?.summary || ''}`;
  const cls = actionClass(hay);
  if (cls === 'rating' || ANALYST_VERB.test(hay)) {
    if (DOWN.test(hay)) return 'downgrade';     // checked first: "cuts target" is unambiguous
    if (UP.test(hay)) return 'upgrade';
    return 'rating';
  }
  return cls || 'other';
}

// ── categories ───────────────────────────────────────────────────────────────
// Built from the engine's stored `category` plus the event type, so the labels a trader expects
// (EARNINGS, M&A, ANALYST) exist without renaming anything the engine stores.
export const CATEGORIES = [
  { key: 'MARKETS',    label: 'Markets' },
  { key: 'EARNINGS',   label: 'Earnings' },
  { key: 'MA',         label: 'M&A' },
  { key: 'PHARMA',     label: 'Pharma / FDA' },
  { key: 'MACRO',      label: 'Macro / Fed' },
  { key: 'REGULATORY', label: 'Regulatory' },
  { key: 'ENERGY',     label: 'Energy' },
  { key: 'FILING',     label: 'Filings' },
  { key: 'ANALYST',    label: 'Analyst Actions' },
  { key: 'CORPORATE',  label: 'Corporate News' },
  { key: 'HALT',       label: 'Halts' },
];

const CORPORATE_TYPES = new Set(['offering', 'buyback', 'dividend', 'split', 'contract',
  'leadership', 'bankruptcy', 'lawsuit', 'settlement', 'recall']);

export function categoryOf(ev, type = eventTypeOf(ev)) {
  const stored = String(ev?.category || '').toUpperCase();
  if (stored === 'HALT' || type === 'halt') return 'HALT';
  if (stored === 'FILING') return 'FILING';
  if (type === 'earnings') return 'EARNINGS';
  if (type === 'merger') return 'MA';
  if (type === 'upgrade' || type === 'downgrade' || type === 'rating') return 'ANALYST';
  if (stored === 'PHARMA' || type === 'approval' || type === 'rejection' || type === 'trial') return 'PHARMA';
  if (stored === 'MACRO' || type === 'rates') return 'MACRO';
  if (stored === 'REGULATORY') return 'REGULATORY';
  if (stored === 'ENERGY') return 'ENERGY';
  if (CORPORATE_TYPES.has(type)) return 'CORPORATE';
  return 'MARKETS';
}

// ── source groups ────────────────────────────────────────────────────────────
// 61 individual feeds is an unusable filter list, so sources are grouped by what a trader actually
// thinks in terms of. Individual sources stay addressable underneath for anyone who wants them.
export const SOURCE_GROUPS = [
  { key: 'wires',    label: 'Breaking Wires',      sources: ['FINANCIALJUICE', 'BREAKINGMARKETNEWS'] },
  { key: 'media',    label: 'Financial Media',     sources: ['BLOOMBERG', 'WSJ', 'CNBC', 'YAHOO', 'MARKETWATCH', 'FT', 'ECONOMIST', 'AXIOS', 'TECHCRUNCH'] },
  { key: 'research', label: 'Research & Analysis', sources: ['SEEKINGALPHA', 'INVESTING', 'ZEROHEDGE'] },
  { key: 'biotech',  label: 'Biotech Trade Press', sources: ['BIOSPACE'] },
  { key: 'pr',       label: 'PR Wires',            sources: ['GLOBENEWSWIRE', 'PRNEWSWIRE', 'EINPRESSWIRE'] },
  { key: 'gov',      label: 'Government / Regulatory', sources: ['FED', 'ECB', 'CFTC', 'FDA', 'FTC', 'DOJ', 'EIA'] },
  { key: 'sec',      label: 'SEC Filings',         sources: ['SEC'] },
  { key: 'exchange', label: 'Exchange / Halts',    sources: ['NASDAQ'] },
  { key: 'apis',     label: 'News APIs',           sources: ['MARKETAUX', 'STOCKDATA'] },
];
const GROUP_OF = (() => {
  const m = new Map();
  for (const g of SOURCE_GROUPS) for (const s of g.sources) m.set(s, g.key);
  return m;
})();
export const sourceGroupOf = (source) => GROUP_OF.get(String(source || '').toUpperCase()) || 'other';

// ── market cap buckets ───────────────────────────────────────────────────────
// Thresholds in dollars. `null` when we hold no reliable cap for the ticker — such events are
// EXCLUDED from a cap filter rather than guessed into a bucket.
export const CAP_BUCKETS = [
  { key: 'mega',  label: 'Mega ($200B+)',        min: 200e9, max: Infinity },
  { key: 'large', label: 'Large ($10B–$200B)',   min: 10e9,  max: 200e9 },
  { key: 'mid',   label: 'Mid ($2B–$10B)',       min: 2e9,   max: 10e9 },
  { key: 'small', label: 'Small ($300M–$2B)',    min: 300e6, max: 2e9 },
  { key: 'micro', label: 'Micro (<$300M)',       min: 0,     max: 300e6 },
];
export function capBucketOf(marketCap) {
  const v = Number(marketCap);
  if (!Number.isFinite(v) || v <= 0) return null;
  return CAP_BUCKETS.find((b) => v >= b.min && v < b.max)?.key ?? null;
}

// ── noise controls ───────────────────────────────────────────────────────────
// Each returns true when the event matches that noise class. These only ever hide rows from ONE
// user's view — the engine keeps ingesting everything regardless.
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|crypto|blockchain|token|stablecoin|defi|nft|altcoin|binance|coinbase)\b/i;
const FOREIGN = /\b(nikkei|hang seng|shanghai composite|ftse|dax|cac 40|ibex|sensex|nifty|kospi|asx 200|tadawul|bovespa|tsx|euro stoxx|shenzhen)\b/i;

export const NOISE_FILTERS = [
  { key: 'lowPr',       label: 'Low-impact PR',        test: (e) => e.source_type === 'press_release' && (e.importance ?? 0) <= 1 },
  { key: 'transcripts', label: 'Transcripts',          test: (e) => e.source_type === 'transcript' },
  { key: 'commentary',  label: 'General commentary',   test: (e) => e.source_type === 'analysis' && (e.importance ?? 0) <= 1 },
  { key: 'papers',      label: 'Working papers',       test: (e) => e.source_type === 'research' },
  { key: 'govRoutine',  label: 'Routine gov notices',  test: (e) => (e.source_type === 'data' || e.source_type === 'speech') && (e.importance ?? 0) <= 1 },
  { key: 'crypto',      label: 'Crypto',               test: (e) => CRYPTO.test(`${e.headline} ${e.summary || ''}`) },
  { key: 'foreign',     label: 'Foreign markets',      test: (e) => FOREIGN.test(`${e.headline} ${e.summary || ''}`) },
];

// ── impact ───────────────────────────────────────────────────────────────────
export const IMPACT = [
  { key: 3, label: 'CRITICAL' }, { key: 2, label: 'HIGH' },
  { key: 1, label: 'MEDIUM' },   { key: 0, label: 'LOW' },
];

// Decorate a raw canonical event with its display facets. Called once per event on arrival, then
// cached on the object, so filtering never re-runs classification.
export function decorate(ev) {
  const type = eventTypeOf(ev);
  return {
    ...ev,
    wireType: type,
    wireCategory: categoryOf(ev, type),
    wireGroup: sourceGroupOf(ev.source),
    wireCap: capBucketOf(ev.market_cap),
    wireNoise: NOISE_FILTERS.filter((n) => { try { return n.test(ev); } catch { return false; } }).map((n) => n.key),
  };
}
