// ── THE HOMEPAGE'S VIEW MODEL, AS A PURE FUNCTION ──────────────────────────
//
// ⚠️ EXTRACTED SO THE SERVER AND THE BROWSER CANNOT DISAGREE ABOUT THE FRONT DOOR.
//
// This mapping used to live inside CatalystPit's fetchAll, which only ever ran in an effect — so
// the server rendered the shell and every card, row, ticker and timestamp on the most important
// page on the site existed only after JavaScript executed. Measured on production: the homepage
// served 192 words of navigation and headings and not one symbol.
//
// The fix is to run the SAME mapping on the server from the SAME cached blob. That only works if
// there is one mapping, so this module is it: no imports from a 'use client' file, no fetching, no
// clock of its own. Both callers pass their inputs and their `now`.
//
// ⚠️ IT IS PURE, AND THAT IS LOAD-BEARING. The server renders with a `now` fixed at generation
// time and serialises the result into the page; the browser's first render reuses those exact
// numbers, which is what makes hydration byte-identical. A `Date.now()` hidden in here would make
// the server's "2h ago" and the client's "2h ago" different strings on a slow connection, and React
// would discard the server HTML — losing the very content this exists to publish.
//
// ⚠️ NO PRICES ARE REQUIRED. `tape` and `marketSnap` are optional and the server deliberately
// passes neither: quotes arrive under a market-data licence and are resolved per-viewer by
// /api/quotes, so they stay client-side exactly as before. Everything else here is public
// disclosure evidence — SEC filings, Form 4s, STOCK Act disclosures, published headlines.

import { maybeN, safeN } from './num.mjs';
import { isRenderableTicker, firstRenderable } from './security-identity.mjs';

/** Minutes since `publishedStr`, against an explicit clock. Null when there is no usable date. */
export const minsSince = (publishedStr, now = Date.now()) => {
  if (!publishedStr) return null;
  const d = new Date(publishedStr);
  if (isNaN(d.getTime())) return null;
  const ms = now - d.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / 60000);
};

/** The same date as an ISO instant, for a <time dateTime> attribute. Null rather than invented. */
export const isoOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

export const toArr = (val, ...wrapperKeys) => {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') {
    for (const k of wrapperKeys) if (Array.isArray(val[k])) return val[k];
    for (const k of Object.keys(val)) if (Array.isArray(val[k])) return val[k];
  }
  return [];
};

const fmtInsiderValue = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString('en-US')}`;
};

/**
 * Does this model have anything to show?
 *
 * ⚠️ THIS EXISTS BECAUSE buildHomeModel SUCCEEDS EVEN WHEN EVERY FETCH FAILED. Given all nulls it
 * returns a perfectly well-formed object full of empty arrays — truthy, structurally valid, and a
 * statement that there is no insider buying, no congressional disclosure and no news. Before the
 * server rendered anything that only cost a skeleton; now it would REPLACE a page full of real
 * filings with a blank one the moment a client refresh failed, which is a worse page than the one
 * this whole change exists to fix, and it would look like our data had gone away rather than our
 * request having failed.
 *
 * Prices are excluded from the test on purpose: the server never renders them, so a model that has
 * only a tape in it is still "nothing to show" as far as the research sections are concerned.
 */
export function isEmptyModel(m) {
  if (!m) return true;
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  return !(len(m.news) || len(m.insiders) || len(m.politicians) || len(m.catalysts) || len(m.filingCards));
}

/**
 * Shape the cached blobs into exactly what CatalystPit renders.
 *
 * @param {object} inputs
 * @param {any}    inputs.tape            catalystpit:ticker_tape, or null to render no prices
 * @param {any}    inputs.marketSnap      catalystpit:market_snapshot, or null
 * @param {any}    inputs.stories         pit_snapshot.stories, or /api/news's array
 * @param {any}    inputs.insiderData     pit_snapshot.insiders, or /api/insiders's payload
 * @param {any}    inputs.politicianData  pit_snapshot.congress, or /api/politicians's payload
 * @param {any}    inputs.clusterData     /api/insiders?view=cluster_buys, only off-snapshot
 * @param {any}    inputs.snapCatalysts   pit_snapshot.catalysts — pre-built, when on-snapshot
 * @param {boolean} inputs.usingSnapshot  true when the blob supplied the catalysts
 * @param {any[]}  inputs.filings         /api/eightk rows, or [] when none were read
 * @param {{now?: number}} clock
 */
export function buildHomeModel({
  tape = null, marketSnap = null, stories = null,
  insiderData = null, politicianData = null, clusterData = null,
  snapCatalysts = null, usingSnapshot = false, filings = [],
} = {}, { now = Date.now() } = {}) {
  const tapeArr = toArr(tape, 'tickers', 'ticker_tape', 'data');
  const tickers = tapeArr.map(t => ({
    sym: t.symbol || t.sym || t.ticker || '?',
    price: safeN(t.price ?? t.last ?? t.close ?? t.current_price ?? t.regularMarketPrice),
    // ⚠️ safeN TURNED "UNKNOWN" INTO 0, AND THAT IS HOW A MISSING CHANGE BECAME 0.00% IN RED.
    //
    // safeN returns 0 for anything unparseable, so a null percentage — which is now what the API
    // sends when a settled close has no intraday move to report — arrived here as a hard zero and
    // rendered as a real, flat, red 0.00%. Fixing the API alone would have changed nothing on the
    // page: this line would have flattened it again.
    //
    // Zero is a real market outcome and must keep rendering as 0.00%. Unknown is null and renders
    // as a dash. maybeN preserves the difference that safeN destroys.
    chg: maybeN(t.changePct ?? t.change_pct ?? t.pct_change ?? t.chg ?? t.changePercent ?? t.percentChange),
    // Which session the percentage describes, so the tape can say so rather than implying "now".
    chgBasis: t.changeBasis ?? null,
  }));

  const storiesArr = toArr(stories, 'stories', 'top_stories', 'articles', 'items', 'data');
  const news = storiesArr.map(s => ({
    headline: s.title || s.headline || s.summary || s.description || '',
    source:   s.source || s.outlet || s.publisher || 'Market News',
    mins:     minsSince(s.published || s.published_at || s.date || s.pubDate, now),
    // ⚠️ THE MACHINE-READABLE INSTANT, CARRIED BESIDE THE HUMAN ONE. `mins` is a number of
    // minutes computed at render; an AI answer engine quoting this page needs the actual
    // timestamp, and a <time dateTime> attribute is the only form that survives being read
    // without a clock. Never synthesised — null when the publisher gave us no date.
    published: isoOrNull(s.published || s.published_at || s.date || s.pubDate),
    tag:      (s.category || s.tag || s.sector || 'MARKETS').toUpperCase(),
    sym:      (s.ticker && s.ticker !== 'N/A' && s.ticker !== 'null') ? s.ticker : (s.symbol || s.sym || null),
    summary:  s.summary || s.description || '',
    // ⚠️ NO PUBLISHER PHOTOGRAPHS ON THE FRONT DOOR. A desk is not a magazine: these cards
    // carry a ticker, a type and an age, and the gradient card already renders a null image.
    // Dropping the field also means no WSJ/MW/Benzinga artwork is ever requested from, or
    // cached on, our origin — which is a licensing question we do not need to have.
    imageUrl: null,
    url:      s.url || null,
  }));

  const insidersArr = toArr(insiderData, 'trades');
  const insidersAll = insidersArr.map(i => ({
    sym:   i.ticker || '?',
    name:  i.executive || '',
    role:  i.title || '',
    type:  i.action === 'BUY' ? 'BUY' : i.action === 'SELL' ? 'SELL' : 'OTHER',
    value: fmtInsiderValue(i.totalValue),
    valueNum: safeN(i.totalValue),          // numeric, for the value floor
    filed: i.filingDate || '',
  }));
  // A1 filter: P/S only (already via view=transactions) + value ≥ $100k.
  // Relax to $25k when a hard floor would leave too few rows to fill the tape.
  const MIN_HI = 100000, MIN_LO = 25000;
  const hiRows = insidersAll.filter(i => i.valueNum >= MIN_HI);
  const insiders = hiRows.length >= 5 ? hiRows : insidersAll.filter(i => i.valueNum >= MIN_LO);

  const politiciansArr = toArr(politicianData, 'trades');
  const politicians = politiciansArr.map(p => ({
    sym:    p.ticker || '?',
    name:   p.representative || '',
    party:  p.party || '',
    state:  p.state || '',
    slug:   p.memberSlug || '',
    type:   p.action === 'BUY' ? 'BUY' : p.action === 'SELL' ? 'SELL' : 'OTHER',
    amount: p.amountRange || '—',
    // ⚠️ BOTH DATES, EACH UNDER ITS OWN NAME. `traded` is when the member dealt; `disclosed` is
    // when the filing made it public, and that is the date the homepage shows and sorts by — the
    // transaction date is not actionable information until it has been disclosed. Collapsing the
    // two into one field is what let a transaction date ten months in the future render as though
    // it were news. /api/politicians?view=feed already refuses rows where the two contradict.
    traded: p.transactionDate || '',
    disclosed: p.disclosureDate || '',
  }));

  // ⚠️ THE 1.2 WAS A FABRICATED MARKET MOVE. When SPY's change was missing, this fell back to the
  // literal 1.2 — a plausible-looking percentage presented as the market's actual return, which is
  // the same class of defect as the 18.3 VIX fallback noted below and removed for the same reason.
  // Unknown is null, and the surfaces that read it render a dash.
  const spy_chg = maybeN(marketSnap?.SPY?.changePct ?? marketSnap?.SPY?.chg ?? marketSnap?.SPY?.change_pct);
  // The VIX value that used to be derived here is gone with the VIX card. It was computed, carried
  // through the return object, and consumed by nothing — and its fallback was the literal 18.3, a
  // fabricated index level that would have been displayed as real had anything ever rendered it.

  // NEVER WHITE (Rule 0): if the news feed is empty, synthesize up to 5 headlines
  // from the real insider filings we already fetched — no invented content.
  const newsFinal = news.length ? news : insiders
    .filter(i => i.type === 'BUY' || i.type === 'SELL')
    .slice(0, 5)
    .map(i => ({
      headline: `${i.sym}: ${i.name || 'Insider'} ${i.type === 'BUY' ? 'bought' : 'sold'} ${i.value}`,
      source: 'SEC Form 4', mins: null, tag: 'SEC',
      sym: i.sym, summary: '', imageUrl: null, url: `/ticker/${i.sym}`,
    }));

  // TODAY IN THE PIT — pre-built in the snapshot; otherwise build locally from fetched data.
  // Same eligibility rule as the snapshot builder, applied to the local fallback path so the two
  // cannot disagree about what counts as a ticker. A snapshot built before this shipped may still
  // carry an ineligible card, so the cached array is filtered too — the fix must not wait for the
  // next cron run to take effect.
  let catalysts;
  if (usingSnapshot) {
    catalysts = (Array.isArray(snapCatalysts) ? snapCatalysts : []).filter((c) => isRenderableTicker(c?.sym));
  } else {
    const topBuys = insiders.filter(i => i.type === 'BUY' && isRenderableTicker(i.sym)).sort((a, b) => b.valueNum - a.valueNum);
    const clusters = toArr(clusterData);
    catalysts = [];
    if (topBuys[0]) catalysts.push({ kind:'BUY', label:'LARGEST OPEN-MARKET BUY',
      sym: topBuys[0].sym, line: `${topBuys[0].name || 'Insider'} bought`, value: topBuys[0].value, date: topBuys[0].filed });
    const cluster = firstRenderable(clusters);
    if (cluster) catalysts.push({ kind:'BUY', label:'CLUSTER BUY · 30D',
      sym: cluster.ticker, line: `${cluster.buyers} insiders bought`,
      value: fmtInsiderValue(cluster.totalValue), date: cluster.lastBuy });
    // Dated by disclosure, and only if we have one — a hero card with no date beats a hero card
    // with the wrong date. Matches buildCatalysts() in api/cron/pit-snapshot.
    const pol = firstRenderable(politicians, (p) => p?.sym && p?.disclosed);
    if (pol) catalysts.push({ kind: pol.type, label:'LATEST CONGRESS TRADE',
      sym: pol.sym, line: `${pol.name} ${pol.type === 'BUY' ? 'bought' : 'sold'}`,
      value: pol.amount, date: pol.disclosed });
    if (topBuys[1]) catalysts.push({ kind:'BUY', label:'OPEN-MARKET BUY',
      sym: topBuys[1].sym, line: `${topBuys[1].name || 'Insider'} bought`, value: topBuys[1].value, date: topBuys[1].filed });
  }

  // Canonical filings in the story-card shape. No image, deliberately: the gradient card
  // already handles a null photo, and there is no publisher artwork for an SEC filing to
  // borrow — a ticker, a type and an age is the whole card.
  const filingCards = (filings || [])
    .filter((f) => isRenderableTicker(f?.ticker))
    .map((f) => ({
      headline: `${f.ticker} · ${f.primaryLabel || 'Filing'}`,
      source: 'SEC 8-K',
      mins: minsSince(f.filedAt, now),
      published: isoOrNull(f.filedAt),
      tag: 'SEC',
      sym: f.ticker,
      summary: '',
      imageUrl: null,
      url: f.url || `/ticker/${f.ticker}`,
      material: f.material,
      // The SEC item label, so deskSelection can tell a delisting notice from an earnings
      // release. Both are material: true, and that flag is all this card used to carry.
      secLabel: f.primaryLabel || 'Filing',
    }));
    return { tickers, news: newsFinal, insiders, politicians, catalysts, spy_chg, filingCards };
}
