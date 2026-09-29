// TITLE, DESCRIPTION AND STRUCTURED DATA FOR ONE TICKER PAGE — pure functions over the public view.
//
// Separate from the route so it can be exercised in plain Node against real bundles: the thing worth
// testing is what the strings SAY, and a test that can only run inside Next tests nothing.
//
// ⚠️ IT SPEAKS ONLY FROM THE PUBLIC VIEW MODEL. Same object the visible page renders from, so the
// title, the meta description, the JSON-LD and the heading cannot name different companies — that
// agreement is structural here rather than a thing to remember.
//
// ⚠️ AND IT MAKES NO CLAIM ABOUT THE SECURITY. No performance, no valuation, no recommendation, no
// "best", no "should you buy". Every clause is either an identifier (who this is, where it lists,
// what sector it is in) or a statement about which of OUR datasets carry rows. A description that
// promises data we do not hold is worse than a short one, so the dataset clause is assembled from
// the coverage counts rather than from a fixed sentence.

// SITE_NAME comes from the one canonical definition beside the canonical() helper, not a second copy.
import { SITE_NAME } from './seo.js';

const DESC_MAX = 158;      // what Google renders before truncating on desktop; not a hard limit
const str = (v) => { const s = typeof v === 'string' ? v.trim() : ''; return s || null; };

/** The identity clause every string starts from: "Apple Inc. (AAPL)", or just "AAPL". */
export function identityLabel(view) {
  const sym = str(view?.symbol);
  const name = str(view?.identity?.companyName);
  if (!sym) return null;
  return name ? `${name} (${sym})` : sym;
}

// Which datasets actually carry rows, in the order a reader cares about them. Named for what they
// are, not for where they came from. The ORDER IS FIXED so a title is stable across rebuilds rather
// than reshuffling whenever a count changes.
const DATASETS = [
  ['insiders', 'insider trades', 'Insider Trades'],
  ['congress', 'congressional trades', 'Congress Trades'],
  ['institutions', 'institutional ownership', 'Institutional Holdings'],
  ['news', 'market news', 'News'],
  ['filings', 'SEC filings', 'SEC Filings'],
];

/** The categories this particular page can actually show. */
const present = (view) => DATASETS.filter(([k]) => (view?.coverage?.[k] ?? 0) > 0);

/**
 * Page title. The brand suffix is NOT added here — the root layout's title template appends it, and
 * adding it too produced "... · CatalystPit · CatalystPit" on the live page once already.
 *
 * ⚠️ THE SUFFIX NAMES WHAT THIS PAGE HAS, NOT WHAT THE PRODUCT HAS. Every ticker used to be titled
 * "· Stock Price, News, Insider & Congress Trades" whether or not it held a single insider filing, a
 * single congressional trade or one headline — 20,000 titles promising four categories, most of them
 * on pages carrying one. A reader arriving from a result that names insider trades and finding none is
 * the concrete harm; the identical boilerplate across the whole corpus is the SEO one.
 *
 * Capped at three categories: the identity is what has to survive truncation, and a title listing
 * five is a keyword list rather than a title.
 */
export function tickerTitle(view) {
  const label = identityLabel(view);
  if (!label) return null;
  const parts = present(view).map(([, , heading]) => heading);
  // "Stock Price" only where we hold price history — the page shows a last close and a chart there.
  if ((view?.coverage?.market ?? 0) > 0) parts.unshift('Stock Price');
  // Nothing to enumerate: say what the page is, claim nothing about what is on it.
  if (!parts.length) return `${label} · Stock Overview`;
  // THREE, TOTAL. Google truncates a title around sixty characters and the identity is what has to
  // survive that; four categories pushed the common case past ninety.
  return `${label} · ${parts.slice(0, 3).join(', ')}`;
}

const oxford = (parts) => (parts.length <= 1 ? (parts[0] || '')
  : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * Meta description: who it is, where it lists, and what we hold. Nothing else.
 *
 * Returns null when we cannot even name the symbol, so the caller keeps its own fallback rather than
 * publishing a sentence with a hole in it.
 */
export function tickerDescription(view) {
  const label = identityLabel(view);
  if (!label) return null;
  const id = view.identity || {};
  const where = [str(id.exchange), str(id.sector)].filter(Boolean).join(' · ');

  const have = present(view).map(([, l]) => l);
  // ⚠️ NOT A FIXED SENTENCE. A page with no congressional trades must not advertise congressional
  // trades; with nothing at all, the description stops after the identity rather than promising
  // coverage we cannot show.
  const holds = have.length ? `Latest ${oxford(have)}.` : null;

  // ⚠️ A DESCRIPTION MADE OF NOTHING IS WORSE THAN NO DESCRIPTION. With no name, no venue and no
  // rows, this produced the single word "AAPL." — a valid string that tells a crawler nothing and
  // displaces the caller's own fallback. Null hands the decision back.
  if (!str(id.companyName) && !where && !have.length) return null;

  // A named security with no venue and no rows: the identity alone is a 28-character description that
  // reads like a truncation. It gets one neutral clause saying what the page IS — not a claim that it
  // holds data, which is exactly what `holds` above refuses to fabricate.
  const tail = holds || (where ? null : `Symbol overview on ${SITE_NAME}.`);
  const out = [where ? `${label} on ${where}.` : `${label}.`, tail].filter(Boolean).join(' ');
  return out.length <= DESC_MAX ? out : `${out.slice(0, DESC_MAX - 1).replace(/[\s,·]+\S*$/, '')}…`;
}

/**
 * schema.org for the security, or null.
 *
 * ⚠️ DELIBERATELY THIN, AND DELIBERATELY NOT FORCED. Organization/Corporation carries `tickerSymbol`,
 * which is exactly the fact a ticker page exists to state, and `name`. That is all that is emitted.
 * There is no rating, no price, no offer, no aggregateRating and no financial claim — those
 * properties exist in the vocabulary and every one of them would be fabricated here.
 *
 * Gated on assetType === 'Stock' because Corporation is a claim about what the security IS. An ETF,
 * a unit, a warrant or a preferred line is not a corporation, and labelling one as its issuer would
 * be a worse error than emitting nothing. A symbol we cannot name gets nothing either: a Corporation
 * with no name says only "something exists", which is not worth a script tag.
 */
export function tickerStructuredData(view, url) {
  const name = str(view?.identity?.companyName);
  const sym = str(view?.symbol);
  const assetType = str(view?.identity?.assetType);
  if (!name || !sym || !url) return null;
  if ((assetType || '').toUpperCase() !== 'STOCK') return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Corporation',
    name,
    tickerSymbol: sym,
    url,
  };
}
